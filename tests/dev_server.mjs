// Local dev server for the v2 app. No dependencies, synthetic data only.
//
//   PORT=8799 node tests/dev_server.mjs        (default port 8799)
//
// - Binds 127.0.0.1 only.
// - Serves the worktree's static app files (index.html, items-v2.js,
//   config-v2.js, images/...). Never serves apps-script.js (it holds the answer
//   keys), dotfiles, or the docs/, legacy/, tests/, tools/ folders.
// - POST /exec runs the REAL doPost from apps-script.js on the fake Google
//   environment (tests/fake_gas.mjs): ENV=local, ACTIVE_SELECTIONS='C6,B8',
//   Sheet ID LOCAL-FAKE-SHEET, with synthetic legacy tabs pre-populated.
//   GET /exec runs the real doGet. Like Apps Script, /exec answers with
//   Access-Control-Allow-Origin: * and does not answer CORS preflight, so the
//   app must send its body as text/plain, as it must in production.
// - Debug endpoints (localhost only, same-origin only):
//     GET  /debug/rows         both v2 tabs as JSON (header row first)
//     POST /debug/inject       {"mode":"none"|"fail_before"|"fail_after"|"busy","times":n}
//     GET  /debug/legacy-hash  sha256 of each legacy tab now, and at startup
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeGas, seedLegacy, legacyHashes, ROOT, V2_TABS } from './fake_gas.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8799);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
if (PORT === 8766) throw new Error('Port 8766 is reserved; pick another PORT.');

const MAX_BODY_BYTES = 64 * 1024;
const BLOCKED_TOP_DIRS = new Set(['docs', 'legacy', 'tests', 'tools', 'node_modules']);
const BLOCKED_FILES = new Set(['apps-script.js']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

const gas = createFakeGas({
  props: { ENV: 'local', ACTIVE_SELECTIONS: 'C6,B8' },
  sheetId: 'LOCAL-FAKE-SHEET',
  now: null,
});
// Real time for a dev server; the fake Date reads gas.clock.now.
Object.defineProperty(gas.clock, 'now', { get: () => Date.now() });
seedLegacy(gas);
const startupLegacyHash = legacyHashes(gas);

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra));
  res.end(body);
}
const sendJson = (res, status, obj, extra) => send(res, status, JSON.stringify(obj, null, 1), 'application/json; charset=utf-8', extra);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Debug endpoints: loopback peer, our own Host header (no DNS rebinding), and
// no cross-origin Origin header (no other web page can drive them).
function debugAllowed(req) {
  const peer = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)) return false;
  const hosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!hosts.includes(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  return origin === undefined || hosts.some((h) => origin === `http://${h}`);
}

function v2Rows() {
  return Object.fromEntries(V2_TABS.map((name) => [name, gas.rows(name)]));
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad path', 'text/plain; charset=utf-8'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0')) ||
      BLOCKED_TOP_DIRS.has(parts[0]) || (parts.length === 1 && BLOCKED_FILES.has(parts[0]))) {
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const file = path.resolve(ROOT, ...parts);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    if (url.pathname === '/exec') {
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (req.method === 'POST') {
        const contents = await readBody(req);
        const out = gas.context.doPost({ postData: { contents, type: req.headers['content-type'] || '', length: contents.length }, parameter: {} });
        const text = out.getContent();
        let status = '?';
        try { status = JSON.parse(text).status; } catch { /* keep '?' */ }
        console.log(`POST /exec -> ${status}`);
        return send(res, 200, text, 'application/json; charset=utf-8', cors);
      }
      if (req.method === 'GET') return send(res, 200, gas.context.doGet({ parameter: {} }).getContent(), 'application/json; charset=utf-8', cors);
      return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
    }

    if (url.pathname.startsWith('/debug/')) {
      if (!debugAllowed(req)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
      if (route === 'GET /debug/rows') return sendJson(res, 200, v2Rows());
      if (route === 'GET /debug/legacy-hash') {
        const now = legacyHashes(gas);
        return sendJson(res, 200, { now, at_startup: startupLegacyHash, unchanged: JSON.stringify(now) === JSON.stringify(startupLegacyHash) });
      }
      if (route === 'POST /debug/inject') {
        let cmd;
        try { cmd = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'body must be JSON' }); }
        const modes = ['none', 'fail_before', 'fail_after', 'busy'];
        const times = cmd && cmd.times !== undefined ? cmd.times : 1;
        if (!cmd || !modes.includes(cmd.mode) || !Number.isInteger(times) || times < 0 || times > 100) {
          return sendJson(res, 400, { error: 'expected {"mode":"none|fail_before|fail_after|busy","times":0-100}' });
        }
        gas.inject.failBeforeWrite = 0;
        gas.inject.failAfterWrite = 0;
        gas.inject.busy = 0;
        if (cmd.mode === 'fail_before') gas.inject.failBeforeWrite = times;
        if (cmd.mode === 'fail_after') gas.inject.failAfterWrite = times;
        if (cmd.mode === 'busy') gas.inject.busy = times;
        console.log(`inject ${cmd.mode} x${cmd.mode === 'none' ? 0 : times}`);
        return sendJson(res, 200, { ok: true, inject: Object.assign({}, gas.inject) });
      }
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }

    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, url.pathname);
    return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  } catch (err) {
    if (err && err.status === 413) return send(res, 413, 'Payload too large', 'text/plain; charset=utf-8');
    console.error(`${route} failed: ${err && err.message}`);
    return send(res, 500, 'Server error', 'text/plain; charset=utf-8');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`FA2601 v2 dev server: http://${HOST}:${PORT}/  (POST /exec -> real doPost on the fake Sheet)`);
  console.log(`legacy tab hashes at startup: ${JSON.stringify(startupLegacyHash)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
