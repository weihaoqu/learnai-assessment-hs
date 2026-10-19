// In-memory fake of the Google Apps Script services that apps-script.js uses.
// Loads the REAL apps-script.js into a node:vm context. Synthetic data only;
// nothing here talks to Google or the network.
//
//   const gas = createFakeGas({ props: { ENV: 'local', ACTIVE_SELECTIONS: 'C6,B8' } });
//   gas.post(bodyObject)      -> { raw, json, mime }   (calls the real doPost)
//   gas.rows('Pre-Test v2')   -> 2-D array of stored values, or null if no tab
//   gas.inject.failBeforeWrite = 1   // next data-row setValues throws, writes nothing
//   gas.inject.failAfterWrite = 1    // next data-row setValues writes, then throws
//   gas.inject.busy = 1              // next tryLock returns false
//   gas.lock.held = true             // lock held elsewhere: every tryLock fails
//
// Sheets behavior mimicked on purpose: setValues/appendRow turn a string that
// starts with '=' into a formula, a numeric string into a number, and a
// yyyy-MM-dd string into a Date, UNLESS the cell's number format is '@'
// (plain text). Tests use this to prove the server never stores a formula.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT_PATH = path.join(ROOT, 'apps-script.js');
export const LOCAL_SHEET_ID = 'LOCAL-FAKE-SHEET';
export const LEGACY_TABS = ['Pre-Test', 'Post-Test', 'Paired', 'Rubric'];
export const V2_TABS = ['Pre-Test v2', 'Post-Test v2'];

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

const RealDate = Date;

function isEmptyCell(cell) {
  return !cell || ((cell.value === '' || cell.value === null) && !cell.formula);
}

// Converts a value the way Sheets would on write, given the cell's format.
function coerce(value, format) {
  if (value === undefined) throw new Error('FakeSheets: undefined cell value');
  if (value === null) return { value: '', formula: '' };
  if (typeof value === 'string') {
    if (format === '@') return { value, formula: '' };
    if (value.startsWith('=')) return { value: '#FORMULA', formula: value };
    if (/^[+-]?\d+(\.\d+)?$/.test(value.trim())) return { value: Number(value), formula: '' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { value: new RealDate(value + 'T00:00:00Z'), formula: '' };
    return { value, formula: '' };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { value, formula: '' };
  if (Object.prototype.toString.call(value) === '[object Date]') return { value: new RealDate(+value), formula: '' };
  throw new Error('FakeSheets: unsupported cell value type ' + typeof value);
}

function serializeValue(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return { date: new RealDate(+v).toISOString() };
  return v;
}

export function createFakeGas(opts = {}) {
  const gas = {
    calls: [],               // every service call: { service, method, sheet? }
    logs: [],                // Logger.log lines
    consoleLines: [],        // console.* lines from the script
    props: Object.assign({}, opts.props === undefined ? { ENV: 'local', ACTIVE_SELECTIONS: 'C6,B8' } : opts.props),
    sheetId: opts.sheetId === undefined ? LOCAL_SHEET_ID : opts.sheetId,
    inject: { failBeforeWrite: 0, failAfterWrite: 0, busy: 0 },
    lock: { held: false, acquired: 0, released: 0, attempts: 0 },
    clock: { now: opts.now === undefined ? RealDate.parse('2026-11-07T14:05:00.000Z') : opts.now },
    sheets: new Map(),       // name -> FakeSheet (insertion order = tab order)
  };

  const rec = (service, method, sheet) => gas.calls.push(sheet ? { service, method, sheet } : { service, method });

  class FakeRange {
    constructor(sheet, row, col, numRows, numCols) {
      for (const [label, n] of [['row', row], ['column', col], ['rows', numRows], ['columns', numCols]]) {
        if (!Number.isInteger(n) || n < 1) throw new Error(`FakeSheets: invalid ${label} ${n}`);
      }
      Object.assign(this, { sheet, row, col, numRows, numCols });
    }
    #each(fn) {
      const out = [];
      for (let r = 0; r < this.numRows; r++) {
        const line = [];
        for (let c = 0; c < this.numCols; c++) line.push(fn(this.row + r, this.col + c));
        out.push(line);
      }
      return out;
    }
    getNumRows() { rec('Range', 'getNumRows', this.sheet.name); return this.numRows; }
    getNumColumns() { rec('Range', 'getNumColumns', this.sheet.name); return this.numCols; }
    getValues() {
      rec('Range', 'getValues', this.sheet.name);
      return this.#each((r, c) => {
        const cell = this.sheet.cell(r, c);
        if (!cell) return '';
        return cell.value instanceof RealDate ? new RealDate(+cell.value) : cell.value;
      });
    }
    getFormulas() {
      rec('Range', 'getFormulas', this.sheet.name);
      return this.#each((r, c) => (this.sheet.cell(r, c) || {}).formula || '');
    }
    getNumberFormats() {
      rec('Range', 'getNumberFormats', this.sheet.name);
      return this.#each((r, c) => (this.sheet.cell(r, c) || {}).format || '');
    }
    setNumberFormat(format) {
      rec('Range', 'setNumberFormat', this.sheet.name);
      this.#each((r, c) => { this.sheet.ensure(r, c).format = String(format); });
      return this;
    }
    setValues(values) {
      rec('Range', 'setValues', this.sheet.name);
      if (!Array.isArray(values) || values.length !== this.numRows) {
        throw new Error('FakeSheets: setValues row count does not match the range');
      }
      for (const line of values) {
        if (!Array.isArray(line) || line.length !== this.numCols) {
          throw new Error('FakeSheets: setValues column count does not match the range');
        }
      }
      const dataRow = this.row >= 2;
      if (dataRow && gas.inject.failBeforeWrite > 0) {
        gas.inject.failBeforeWrite--;
        throw new Error('Injected failure before write');
      }
      // Validate every cell before writing any, like a single batch call.
      const coerced = values.map((line, r) => line.map((v, c) => {
        const existing = this.sheet.cell(this.row + r, this.col + c);
        return coerce(v, existing ? existing.format : '');
      }));
      coerced.forEach((line, r) => line.forEach((cv, c) => {
        const cell = this.sheet.ensure(this.row + r, this.col + c);
        cell.value = cv.value;
        cell.formula = cv.formula;
      }));
      if (dataRow && gas.inject.failAfterWrite > 0) {
        gas.inject.failAfterWrite--;
        throw new Error('Injected failure after write');
      }
      return this;
    }
  }

  class FakeSheet {
    constructor(name) { this.name = name; this.cells = new Map(); }
    key(r, c) { return r + ',' + c; }
    cell(r, c) { return this.cells.get(this.key(r, c)); }
    ensure(r, c) {
      const k = this.key(r, c);
      if (!this.cells.has(k)) this.cells.set(k, { value: '', formula: '', format: '' });
      return this.cells.get(k);
    }
    lastRow() {
      let max = 0;
      for (const [k, cell] of this.cells) if (!isEmptyCell(cell)) max = Math.max(max, Number(k.split(',')[0]));
      return max;
    }
    lastColumn() {
      let max = 0;
      for (const [k, cell] of this.cells) if (!isEmptyCell(cell)) max = Math.max(max, Number(k.split(',')[1]));
      return max;
    }
    getName() { rec('Sheet', 'getName', this.name); return this.name; }
    getLastRow() { rec('Sheet', 'getLastRow', this.name); return this.lastRow(); }
    getLastColumn() { rec('Sheet', 'getLastColumn', this.name); return this.lastColumn(); }
    getRange(row, col, numRows = 1, numCols = 1) {
      rec('Sheet', 'getRange', this.name);
      if (typeof row === 'string') throw new Error('FakeSheets: A1 notation is not supported');
      return new FakeRange(this, row, col, numRows, numCols);
    }
    appendRow(values) {
      rec('Sheet', 'appendRow', this.name);
      const r = this.lastRow() + 1;
      values.forEach((v, i) => {
        const cell = this.ensure(r, i + 1);
        const cv = coerce(v, cell.format);
        cell.value = cv.value;
        cell.formula = cv.formula;
      });
      return this;
    }
  }

  const spreadsheet = {
    getId() { rec('Spreadsheet', 'getId'); return gas.sheetId; },
    getSheetByName(name) { rec('Spreadsheet', 'getSheetByName', name); return gas.sheets.get(name) || null; },
    getSheets() { rec('Spreadsheet', 'getSheets'); return Array.from(gas.sheets.values()); },
    insertSheet(name) {
      rec('Spreadsheet', 'insertSheet', name);
      if (gas.sheets.has(name)) throw new Error('FakeSheets: a sheet named ' + name + ' already exists');
      const sheet = new FakeSheet(name);
      gas.sheets.set(name, sheet);
      return sheet;
    },
  };

  const SpreadsheetApp = {
    getActiveSpreadsheet() { rec('SpreadsheetApp', 'getActiveSpreadsheet'); return spreadsheet; },
    flush() { rec('SpreadsheetApp', 'flush'); },
  };

  const LockService = {
    getScriptLock() {
      rec('LockService', 'getScriptLock');
      let mine = false;
      return {
        tryLock(timeoutMs) {
          rec('Lock', 'tryLock');
          gas.lock.attempts++;
          gas.lock.lastTimeout = timeoutMs;
          if (gas.inject.busy > 0) { gas.inject.busy--; return false; }
          if (gas.lock.held) return false;
          gas.lock.held = true;
          gas.lock.acquired++;
          mine = true;
          return true;
        },
        releaseLock() {
          rec('Lock', 'releaseLock');
          if (mine) { mine = false; gas.lock.held = false; gas.lock.released++; }
        },
        hasLock() { return mine; },
      };
    },
  };

  const ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput(content) {
      rec('ContentService', 'createTextOutput');
      let mime = 'TEXT';
      const text = String(content);
      return {
        setMimeType(m) { mime = m; return this; },
        getMimeType() { return mime; },
        getContent() { return text; },
      };
    },
  };

  const PropertiesService = {
    getScriptProperties() {
      rec('PropertiesService', 'getScriptProperties');
      return {
        getProperty(key) {
          rec('Properties', 'getProperty');
          return Object.prototype.hasOwnProperty.call(gas.props, key) ? gas.props[key] : null;
        },
      };
    },
  };

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5', SHA_1: 'SHA_1' },
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
    // Like Google: returns signed bytes (-128..127).
    computeDigest(algorithm, value, charset) {
      if (algorithm !== 'SHA_256') throw new Error('FakeUtilities: only SHA_256 is faked');
      if (charset !== undefined && charset !== 'UTF_8') throw new Error('FakeUtilities: only UTF_8 is faked');
      const input = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(Array.from(value, (b) => b & 0xff));
      return Array.from(crypto.createHash('sha256').update(input).digest(), (b) => (b > 127 ? b - 256 : b));
    },
    formatDate(date, timeZone, pattern) {
      const supported = ['yyyy-MM-dd', "yyyy-MM-dd'T'HH:mm:ss"];
      if (!supported.includes(pattern)) throw new Error('FakeUtilities: unsupported pattern ' + pattern);
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new RealDate(+date)).map((p) => [p.type, p.value]));
      const day = `${parts.year}-${parts.month}-${parts.day}`;
      return pattern === 'yyyy-MM-dd' ? day : `${day}T${parts.hour}:${parts.minute}:${parts.second}`;
    },
  };

  const Logger = { log(...args) { gas.logs.push(args.map(String).join(' ')); return Logger; } };
  const fakeConsole = Object.fromEntries(['log', 'info', 'warn', 'error'].map((level) => [
    level, (...args) => gas.consoleLines.push(level + ': ' + args.map(String).join(' ')),
  ]));

  const clock = gas.clock;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }

  const sandbox = { SpreadsheetApp, LockService, ContentService, PropertiesService, Utilities, Logger, console: fakeConsole, Date: FakeDate };
  gas.context = vm.createContext(sandbox);
  const source = opts.source === undefined ? fs.readFileSync(opts.scriptPath || SCRIPT_PATH, 'utf8') : opts.source;
  vm.runInContext(source, gas.context, { filename: 'apps-script.js' });

  // ---- test helpers (outer realm) ----
  gas.post = (body) => {
    const contents = typeof body === 'string' ? body : JSON.stringify(body);
    const out = gas.context.doPost({ postData: { contents, type: 'text/plain', length: contents.length }, parameter: {} });
    const raw = out.getContent();
    return { raw, json: JSON.parse(raw), mime: out.getMimeType() };
  };
  gas.get = () => {
    const out = gas.context.doGet({ parameter: {} });
    const raw = out.getContent();
    return { raw, json: JSON.parse(raw), mime: out.getMimeType() };
  };
  gas.sheet = (name) => gas.sheets.get(name) || null;
  gas.rows = (name) => {
    const sheet = gas.sheets.get(name);
    if (!sheet) return null;
    const rows = [];
    for (let r = 1; r <= sheet.lastRow(); r++) {
      const line = [];
      for (let c = 1; c <= sheet.lastColumn(); c++) {
        const cell = sheet.cell(r, c);
        line.push(cell ? cell.value : '');
      }
      rows.push(line);
    }
    return rows;
  };
  gas.formulas = (name) => {
    const sheet = gas.sheets.get(name);
    if (!sheet) return [];
    return Array.from(sheet.cells.values()).map((cell) => cell.formula).filter(Boolean);
  };
  // Exact, order-independent snapshot of a tab: every cell's value, formula, format.
  gas.snapshot = (name) => {
    const sheet = gas.sheets.get(name);
    if (!sheet) return null;
    const cells = Array.from(sheet.cells.entries())
      .map(([k, cell]) => [k, serializeValue(cell.value), cell.formula, cell.format])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify(cells);
  };
  // Seeds a tab directly (no coercion, no call records). A cell may be
  // { formula: '=...', value: x } to store a formula.
  gas.seed = (name, rows, format = '') => {
    const sheet = gas.sheets.get(name) || new FakeSheet(name);
    gas.sheets.set(name, sheet);
    rows.forEach((line, r) => line.forEach((v, c) => {
      const cell = sheet.ensure(r + 1, c + 1);
      if (v && typeof v === 'object' && 'formula' in v) { cell.value = v.value; cell.formula = v.formula; }
      else { cell.value = v; cell.formula = ''; }
      cell.format = format;
    }));
    return sheet;
  };
  gas.resetCalls = () => { gas.calls.length = 0; };
  gas.callsTo = (...services) => gas.calls.filter((c) => services.includes(c.service));
  gas.sheetNamesTouched = () => new Set(gas.calls.filter((c) => c.sheet).map((c) => c.sheet));
  return gas;
}

// Synthetic legacy tabs, shaped like the v1 tabs. No real data.
export function seedLegacy(gas) {
  gas.seed('Pre-Test', [
    ['participant_id', 'timestamp', 'date', 'coding_background', 'total_score', 'level', 'assent', 'assent_version'],
    ['12Q', '2026-09-01T14:00:00.000Z', new Date('2026-09-01T00:00:00Z'), 'none', 14, 'L2: Developing User', 'yes', 'FA2601-Assent-2026-08-21'],
    ['88K', '2026-09-01T14:02:00.000Z', new Date('2026-09-01T00:00:00Z'), 'beginner', 9, 'L1: Passive Consumer', 'yes', 'FA2601-Assent-2026-08-21'],
  ]);
  gas.seed('Post-Test', [
    ['participant_id', 'timestamp', 'date', 'total_score', 'level', 'assent', 'assent_version'],
    ['12Q', '2026-09-01T15:30:00.000Z', new Date('2026-09-01T00:00:00Z'), 19, 'L3: Proficient Creator', 'yes', 'FA2601-Assent-2026-08-21'],
  ]);
  gas.seed('Paired', [
    ['participant_id', 'pre_total', 'post_total', 'gain'],
    ['12Q', 14, 19, 5],
    [],
    ['SUMMARY', { formula: '=AVERAGE(B2:B2)', value: 14 }, { formula: '=AVERAGE(C2:C2)', value: 19 }, { formula: '=AVERAGE(D2:D2)', value: 5 }],
  ]);
  gas.seed('Rubric', [
    ['LearnAI HS Assessment - Scoring Rubric'],
    [],
    ['Score Range', 'Level', 'Label'],
    ['6-11', 'L1', 'Passive Consumer'],
  ]);
}

// sha256 of each legacy tab's values, the same way selfCheck() hashes them.
export function legacyHashes(gas) {
  const out = {};
  for (const name of LEGACY_TABS) {
    const sheet = gas.sheet(name);
    if (!sheet) { out[name] = null; continue; }
    out[name] = sha256Hex(JSON.stringify(gas.rows(name)));
  }
  return out;
}
