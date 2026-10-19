// Tests for the v2 Apps Script (apps-script.js) running on the fake Google
// environment in tests/fake_gas.mjs. Synthetic data only.
//   node --test tests/apps_script_v2.test.mjs
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  createFakeGas, seedLegacy, legacyHashes, sha256Hex, SCRIPT_PATH, ROOT, LEGACY_TABS, V2_TABS,
} from './fake_gas.mjs';

const ASSENT_VERSION = 'FA2601-Assent-2026-08-21';
const SOURCE = fs.readFileSync(SCRIPT_PATH, 'utf8');

// Copied verbatim from docs/V2_CONTRACT.md, so the script is checked against the contract.
function contractOrder(code) {            // code already normalized: trim().toUpperCase()
  var h = 0x811c9dc5 >>> 0;
  for (var i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return ((h >>> 0) & 1) === 0 ? 'AB' : 'BA';
}

// Header written out by hand from the contract's "Row columns" section.
const EXPECTED_HEADER = [
  'submission_id', 'fingerprint', 'receipt', 'server_received_at', 'server_date',
  'client_started_at', 'client_submitted_at', 'schema', 'instrument_version', 'bank_sha256',
  'selection', 'stage', 'participant_id', 'order', 'form', 'assent', 'assent_version',
  'coding_background', 'n_items', 'n_answered', 'n_skipped', 'n_not_reached', 'n_correct',
  'dup_code_same_day_stage',
  'J1_item', 'J1_choice', 'J1_score', 'J1_status',
  'J3_item', 'J3_choice', 'J3_score', 'J3_status',
  'C1_item', 'C1_choice', 'C1_score', 'C1_status',
  'C3_item', 'C3_choice', 'C3_score', 'C3_status',
  'P2_item', 'P2_choice', 'P2_score', 'P2_status',
  'P3_item', 'P3_choice', 'P3_score', 'P3_status',
  'G1_item', 'G1_choice', 'G1_score', 'G1_status',
  'G2_item', 'G2_choice', 'G2_score', 'G2_status',
];

const MANIFEST = JSON.parse(JSON.stringify(createFakeGas().context.MANIFEST));
const NEXT = { A: 'B', B: 'C', C: 'D', D: 'A' };
const wrong = (letter) => NEXT[letter];

// A valid v2 body. Order and form follow the (possibly overridden) code and
// stage; any field can then be overridden.
function body(overrides = {}) {
  const code = 'participant_id' in overrides ? overrides.participant_id : '0A';
  const stage = 'stage' in overrides ? overrides.stage : 'pre';
  const order = contractOrder(String(code).trim().toUpperCase());
  const form = order[stage === 'pre' ? 0 : 1];
  return Object.assign({
    schema: 'fa2601-v2',
    instrument_version: MANIFEST.instrument_version,
    bank_sha256: MANIFEST.bank_sha256,
    selection: 'C6',
    submission_id: crypto.randomUUID(),
    stage,
    participant_id: code,
    order,
    form,
    assent: 'yes',
    assent_version: ASSENT_VERSION,
    coding_background: stage === 'pre' ? 'beginner' : '',
    answers: {},
    client_started_at: '2026-11-07T14:00:00.000Z',
    client_submitted_at: '2026-11-07T14:04:30.000Z',
  }, overrides);
}

// Answers by pattern, one letter per pair in selection order:
// c = correct (the key), w = wrong (the next letter), s = skipped (null), n = not reached (omitted).
function answersFor(selection, form, pattern) {
  const pairs = MANIFEST.selections[selection];
  assert.equal(pattern.length, pairs.length);
  const answers = {};
  pairs.forEach((pair, i) => {
    const id = `${pair}-${form}`;
    if (pattern[i] === 'c') answers[id] = MANIFEST.keys[id];
    else if (pattern[i] === 'w') answers[id] = wrong(MANIFEST.keys[id]);
    else if (pattern[i] === 's') answers[id] = null;
  });
  return answers;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function rowObjects(gas, tab) {
  const rows = gas.rows(tab);
  if (!rows) return [];
  assert.deepEqual(rows[0], EXPECTED_HEADER);
  return rows.slice(1).map((r) => Object.fromEntries(EXPECTED_HEADER.map((h, i) => [h, r[i]])));
}

function pairCells(row, pair) {
  return [row[`${pair}_item`], row[`${pair}_choice`], row[`${pair}_score`], row[`${pair}_status`]];
}

const SHEET_SERVICES = ['SpreadsheetApp', 'Spreadsheet', 'Sheet', 'Range', 'LockService', 'Lock'];
function assertNoSheetOrLock(gas) {
  assert.deepEqual(gas.callsTo(...SHEET_SERVICES), [], 'no spreadsheet or lock call expected');
  assert.equal(gas.sheets.size, 0);
}
function assertOnlyContentService(gas) {
  assert.deepEqual(gas.calls.filter((c) => c.service !== 'ContentService'), [], 'only ContentService expected');
}
function assertSuccess(res, duplicate = false) {
  assert.equal(res.json.status, 'success', res.raw);
  assert.equal(res.json.duplicate, duplicate);
  assert.equal(res.mime, 'JSON');
}

// ---------------------------------------------------------------------------
describe('contract constants', () => {
  test('header equals the contract exactly (56 columns)', () => {
    const gas = createFakeGas();
    assert.equal(EXPECTED_HEADER.length, 56);
    assert.deepEqual(Array.from(gas.context.HEADER), EXPECTED_HEADER);
    gas.post(body({ answers: {} }));
    assert.deepEqual(gas.rows('Pre-Test v2')[0], EXPECTED_HEADER);
  });

  test('fa2601Order matches the contract test vectors', () => {
    const { context } = createFakeGas();
    for (const [code, order] of [['57R', 'BA'], ['7A', 'BA'], ['100Z', 'BA'], ['0A', 'AB']]) {
      assert.equal(context.fa2601Order(code), order, code);
      assert.equal(contractOrder(code), order, code);
    }
  });

  test('fa2601Order is balanced over the 0-100 x A-Z code space', () => {
    const { context } = createFakeGas();
    let ab = 0;
    let total = 0;
    for (let n = 0; n <= 100; n++) {
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        const code = `${n}${letter}`;
        const order = context.fa2601Order(code);
        assert.equal(order, contractOrder(code), code);
        if (order === 'AB') ab++;
        total++;
      }
    }
    const fraction = ab / total;
    console.log(`# fa2601Order balance: ${ab}/${total} codes get AB = ${(fraction * 100).toFixed(2)}%`);
    assert.equal(total, 2626);
    assert.ok(fraction >= 0.45 && fraction <= 0.55, `AB fraction ${fraction}`);
    assert.equal((fraction * 100).toFixed(1), '49.2', 'contract states 49.2%');
  });

  test('MANIFEST agrees with items-v2.js, and items-v2.js holds no keys', () => {
    const itemsSource = fs.readFileSync(path.join(ROOT, 'items-v2.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(itemsSource, sandbox);
    const items = JSON.parse(JSON.stringify(sandbox.window.FA2601_ITEMS));
    assert.equal(items.instrument_version, MANIFEST.instrument_version);
    assert.equal(items.bank_sha256, MANIFEST.bank_sha256);
    assert.deepEqual(items.selections, MANIFEST.selections);
    assert.equal('keys' in items, false);
    assert.doesNotMatch(itemsSource, /"key"\s*:/);
    for (const selection of Object.keys(MANIFEST.selections)) {
      for (const pair of MANIFEST.selections[selection]) {
        for (const form of 'AB') assert.match(MANIFEST.keys[`${pair}-${form}`], /^[ABCD]$/);
      }
    }
  });

  test('source hygiene: one manifest block, no legacy code, no Sheet ID', () => {
    assert.equal(SOURCE.split('// BEGIN GENERATED MANIFEST').length - 1, 1);
    assert.equal(SOURCE.split('// END GENERATED MANIFEST').length - 1, 1);
    for (const name of ['ensureHeaderRow', 'updatePairedSheet', 'ensureRubricSheet', 'appendRow', 'clearGeneratedSheet']) {
      assert.equal(SOURCE.includes(name), false, name);
    }
    // Any long ID-like token must be a 64-hex hash, never a Sheet ID.
    for (const token of SOURCE.match(/[A-Za-z0-9_-]{30,}/g) || []) {
      assert.match(token, /^([0-9a-f]{64}|REPLACE_WITH_SHA256_OF_TEST_SHEET_ID)$/, token);
    }
    const allowed = createFakeGas().context.ALLOWED_SHEET_SHA256;
    assert.match(allowed.prod, /^[0-9a-f]{64}$/);
    assert.equal(allowed.local, sha256Hex('LOCAL-FAKE-SHEET'));
    assert.equal(allowed.test, 'REPLACE_WITH_SHA256_OF_TEST_SHEET_ID');
  });

  test('fake computeDigest returns signed bytes and the script hex matches node', () => {
    const gas = createFakeGas();
    const bytes = gas.context.Utilities.computeDigest('SHA_256', 'LOCAL-FAKE-SHEET', 'UTF_8');
    assert.ok(bytes.some((b) => b < 0), 'expected some negative bytes');
    for (const text of ['', 'LOCAL-FAKE-SHEET', 'é—🙂 57R', '{"a":1}']) {
      assert.equal(gas.context.sha256Hex_(text), sha256Hex(text), text);
    }
  });
});

// ---------------------------------------------------------------------------
describe('valid submissions and scoring', () => {
  test('pre, C6, code 0A (form A): hand-computed pattern c w c s c n', () => {
    const gas = createFakeGas();
    const b = body({
      participant_id: '0A', stage: 'pre', selection: 'C6', coding_background: 'beginner',
      answers: answersFor('C6', 'A', ['c', 'w', 'c', 's', 'c', 'n']),
    });
    assert.equal(b.order, 'AB');
    assert.equal(b.form, 'A');
    const res = gas.post(b);
    assertSuccess(res);
    assert.equal(res.json.receipt, b.submission_id);
    assert.deepEqual(Object.keys(res.json).sort(), ['duplicate', 'receipt', 'status']);

    const [row] = rowObjects(gas, 'Pre-Test v2');
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
    assert.equal(row.submission_id, b.submission_id);
    assert.equal(row.receipt, b.submission_id);
    assert.equal(row.fingerprint, sha256Hex(canonical(b)));
    assert.equal(row.server_received_at, '2026-11-07T14:05:00.000Z');
    assert.equal(row.server_date, '2026-11-07');
    assert.equal(row.client_started_at, b.client_started_at);
    assert.equal(row.client_submitted_at, b.client_submitted_at);
    assert.equal(row.schema, 'fa2601-v2');
    assert.equal(row.instrument_version, MANIFEST.instrument_version);
    assert.equal(row.bank_sha256, MANIFEST.bank_sha256);
    assert.equal(row.selection, 'C6');
    assert.equal(row.stage, 'pre');
    assert.equal(row.participant_id, '0A');
    assert.equal(row.order, 'AB');
    assert.equal(row.form, 'A');
    assert.equal(row.assent, 'yes');
    assert.equal(row.assent_version, ASSENT_VERSION);
    assert.equal(row.coding_background, 'beginner');
    // C6 = J1 G1 C1 P2 C3 G2 with pattern c w c s c n:
    // answered J1 G1 C1 C3 (4), correct J1 C1 C3 (3), skipped P2, not reached G2.
    assert.deepEqual([row.n_items, row.n_answered, row.n_skipped, row.n_not_reached, row.n_correct], [6, 4, 1, 1, 3]);
    assert.equal(row.dup_code_same_day_stage, 0);
    const k = MANIFEST.keys;
    assert.deepEqual(pairCells(row, 'J1'), ['J1-A', k['J1-A'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'J3'), ['', '', '', 'not_in_form']);
    assert.deepEqual(pairCells(row, 'C1'), ['C1-A', k['C1-A'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'C3'), ['C3-A', k['C3-A'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'P2'), ['P2-A', '', '', 'skipped']);
    assert.deepEqual(pairCells(row, 'P3'), ['', '', '', 'not_in_form']);
    assert.deepEqual(pairCells(row, 'G1'), ['G1-A', wrong(k['G1-A']), 0, 'answered']);
    assert.deepEqual(pairCells(row, 'G2'), ['G2-A', '', '', 'not_reached']);
    assert.equal(gas.sheet('Post-Test v2'), null);
    assert.equal(gas.lock.held, false);
    assert.equal(gas.lock.acquired, 1);
    assert.equal(gas.lock.released, 1);
    assert.equal(gas.lock.lastTimeout, 10000);
    assert.ok(gas.calls.some((c) => c.service === 'SpreadsheetApp' && c.method === 'flush'));
  });

  test('post, B8, code 0A (form B): hand-computed pattern c c w c c w s n', () => {
    const gas = createFakeGas();
    const b = body({
      participant_id: '0A', stage: 'post', selection: 'B8', coding_background: '',
      answers: answersFor('B8', 'B', ['c', 'c', 'w', 'c', 'c', 'w', 's', 'n']),
    });
    assert.equal(b.form, 'B');
    assertSuccess(gas.post(b));
    const [row] = rowObjects(gas, 'Post-Test v2');
    // B8 = J1 G1 C1 P2 J3 G2 C3 P3: answered 6, correct J1 G1 P2 J3 (4), skipped C3, not reached P3.
    assert.deepEqual([row.n_items, row.n_answered, row.n_skipped, row.n_not_reached, row.n_correct], [8, 6, 1, 1, 4]);
    assert.equal(row.stage, 'post');
    assert.equal(row.form, 'B');
    assert.equal(row.coding_background, '');
    const k = MANIFEST.keys;
    assert.deepEqual(pairCells(row, 'J1'), ['J1-B', k['J1-B'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'J3'), ['J3-B', k['J3-B'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'C1'), ['C1-B', wrong(k['C1-B']), 0, 'answered']);
    assert.deepEqual(pairCells(row, 'C3'), ['C3-B', '', '', 'skipped']);
    assert.deepEqual(pairCells(row, 'P2'), ['P2-B', k['P2-B'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'P3'), ['P3-B', '', '', 'not_reached']);
    assert.deepEqual(pairCells(row, 'G1'), ['G1-B', k['G1-B'], 1, 'answered']);
    assert.deepEqual(pairCells(row, 'G2'), ['G2-B', wrong(k['G2-B']), 0, 'answered']);
    assert.equal(gas.sheet('Pre-Test v2'), null);
  });

  test('code 57R (BA): pre B8 uses form B, post C6 uses form A', () => {
    const gas = createFakeGas();
    const pre = body({ participant_id: '57R', stage: 'pre', selection: 'B8', answers: answersFor('B8', 'B', 'cccccccc'.split('')) });
    const post = body({ participant_id: '57R', stage: 'post', selection: 'C6', answers: answersFor('C6', 'A', 'ssssss'.split('')) });
    assert.deepEqual([pre.order, pre.form, post.order, post.form], ['BA', 'B', 'BA', 'A']);
    assertSuccess(gas.post(pre));
    assertSuccess(gas.post(post));
    const [preRow] = rowObjects(gas, 'Pre-Test v2');
    const [postRow] = rowObjects(gas, 'Post-Test v2');
    assert.deepEqual([preRow.n_items, preRow.n_answered, preRow.n_skipped, preRow.n_not_reached, preRow.n_correct], [8, 8, 0, 0, 8]);
    assert.deepEqual([postRow.n_items, postRow.n_answered, postRow.n_skipped, postRow.n_not_reached, postRow.n_correct], [6, 0, 6, 0, 0]);
    for (const pair of ['J3', 'P3']) assert.deepEqual(pairCells(postRow, pair), ['', '', '', 'not_in_form']);
    assert.deepEqual(pairCells(preRow, 'P3'), ['P3-B', MANIFEST.keys['P3-B'], 1, 'answered']);
  });

  test('literal draft-0.3 keys: hand-computed answers and scores', (t) => {
    if (MANIFEST.instrument_version !== 'draft-0.3') {
      t.skip(`MANIFEST is ${MANIFEST.instrument_version}; these literals are for draft-0.3`);
      return;
    }
    // draft-0.3 keys, C6 form A in order J1 G1 C1 P2 C3 G2: A B C D B C (bank.json, independent of MANIFEST).
    assert.deepEqual(['J1-A', 'G1-A', 'C1-A', 'P2-A', 'C3-A', 'G2-A'].map((id) => MANIFEST.keys[id]), ['A', 'B', 'C', 'D', 'B', 'C']);
    assert.deepEqual(['J1-B', 'G1-B', 'C1-B', 'P2-B', 'C3-B', 'G2-B'].map((id) => MANIFEST.keys[id]), ['C', 'A', 'D', 'B', 'D', 'A']);
    const gas = createFakeGas();
    const b = body({ participant_id: '0A', stage: 'pre', selection: 'C6',
      answers: { 'J1-A': 'A', 'G1-A': 'A', 'C1-A': 'C', 'P2-A': 'A', 'C3-A': null } });
    assertSuccess(gas.post(b));
    const [row] = rowObjects(gas, 'Pre-Test v2');
    assert.deepEqual([row.J1_score, row.G1_score, row.C1_score, row.P2_score, row.C3_score, row.G2_score], [1, 0, 1, 0, '', '']);
    assert.deepEqual([row.C3_status, row.G2_status], ['skipped', 'not_reached']);
    assert.deepEqual([row.n_answered, row.n_correct], [4, 2]);
  });

  test('skipped (null) and not reached (missing key) are distinct', () => {
    const gas = createFakeGas();
    assertSuccess(gas.post(body({ participant_id: '1A', answers: {} })));
    assertSuccess(gas.post(body({ participant_id: '2A', answers: answersFor('C6', contractOrder('2A')[0], 'ssssss'.split('')) })));
    const [none, skipped] = rowObjects(gas, 'Pre-Test v2');
    for (const pair of MANIFEST.selections.C6) {
      assert.equal(none[`${pair}_status`], 'not_reached');
      assert.equal(skipped[`${pair}_status`], 'skipped');
      for (const row of [none, skipped]) {
        assert.equal(row[`${pair}_choice`], '');
        assert.equal(row[`${pair}_score`], '');
        assert.notEqual(row[`${pair}_item`], '');
      }
    }
    assert.deepEqual([none.n_skipped, none.n_not_reached], [0, 6]);
    assert.deepEqual([skipped.n_skipped, skipped.n_not_reached], [6, 0]);
  });

  test('participant code is normalized (trim, upper case) before order and storage', () => {
    const gas = createFakeGas();
    const b = body({ participant_id: ' 57r ' });
    assert.equal(b.order, 'BA');
    assertSuccess(gas.post(b));
    assert.equal(rowObjects(gas, 'Pre-Test v2')[0].participant_id, '57R');
  });

  test('timestamps without milliseconds are accepted and stored as given', () => {
    const gas = createFakeGas();
    assertSuccess(gas.post(body({ client_started_at: '2026-11-07T14:03:00Z' })));
    assert.equal(rowObjects(gas, 'Pre-Test v2')[0].client_started_at, '2026-11-07T14:03:00Z');
  });

  test('every pre coding_background value is accepted', () => {
    const gas = createFakeGas();
    for (const value of ['', 'none', 'beginner', 'intermediate', 'advanced', 'prefer_not']) {
      assertSuccess(gas.post(body({ coding_background: value })));
    }
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 6);
  });
});

// ---------------------------------------------------------------------------
describe('assent and v1 come first', () => {
  test('non-assent returns not_assented with zero service calls', () => {
    for (const assent of ['no', 'No', 'YES', 'Yes', 'I agree', 'y', true, null, undefined]) {
      const gas = createFakeGas();
      const b = body({ assent });
      if (assent === undefined) delete b.assent;
      const res = gas.post(b);
      assert.deepEqual(res.json, { status: 'not_assented', message: 'No affirmative assent. Nothing was recorded.' });
      assertOnlyContentService(gas);
    }
  });

  test('non-assent wins over every other problem (even a v1 or broken body)', () => {
    for (const b of [
      { assent: 'no' },
      { test_type: 'pre', participant_id: '57R', assent: 'no', assent_version: ASSENT_VERSION },
      body({ assent: 'no', schema: 'nope', stage: 'x', participant_id: 'bad', extra: 1 }),
    ]) {
      const gas = createFakeGas({ props: {} });
      assert.equal(gas.post(b).json.status, 'not_assented');
      assertOnlyContentService(gas);
    }
  });

  test('v1 payload (no schema) returns closed with zero service calls', () => {
    const gas = createFakeGas();
    seedLegacy(gas);
    const res = gas.post({
      participant_id: '57R', timestamp: '2026-11-07T14:00:00.000Z', test_type: 'pre',
      coding_background: 'none', total_score: 18, s01_score: 4, s01_choice: 'A',
      assent: 'yes', assent_version: ASSENT_VERSION,
    });
    assert.deepEqual(res.json, { status: 'closed', message: 'This version of the test is closed.' });
    assertOnlyContentService(gas);
  });
});

// ---------------------------------------------------------------------------
describe('validation rejections (one test each; no spreadsheet or lock call)', () => {
  // [name, expected code, list of bodies (object, raw string, or function(gas) => response)]
  const rawPost = (contents) => (gas) => {
    const out = gas.context.doPost(contents === undefined ? undefined : { postData: { contents } });
    return { raw: out.getContent(), json: JSON.parse(out.getContent()) };
  };
  const without = (field) => { const b = body(); delete b[field]; return b; };
  const formAItem = (pair) => `${pair}-A`;
  const cases = [
    ['bad_json: unparseable body', 'bad_json', ['not json{', '{"assent":"yes",}', '']],
    ['bad_json: JSON that is not an object', 'bad_json', ['[]', 'null', '"yes"', '42', '[{"assent":"yes"}]']],
    ['bad_json: missing postData', 'bad_json', [rawPost(undefined), (gas) => {
      const out = gas.context.doPost({});
      return { raw: out.getContent(), json: JSON.parse(out.getContent()) };
    }]],
    ['bad_schema', 'bad_schema', [body({ schema: 'fa2601-v1' }), body({ schema: 2 }), body({ schema: null })]],
    ['bad_assent_version', 'bad_assent_version', [body({ assent_version: 'FA2601-Assent-2026-01-01' }), without('assent_version')]],
    ['bad_stage', 'bad_stage', [body({ stage: 'mid' }), body({ stage: 'PRE' }), without('stage')]],
    ['bad_participant_id', 'bad_participant_id', ['101A', '00A', '-1A', 'A1', '57', '57RR', '5 7R', '', 57, null]
      .map((participant_id) => Object.assign(body(), { participant_id }))],
    ['unknown_field', 'unknown_field', [
      body({ name: 'Synthetic Student' }),
      JSON.stringify(body()).replace(/^\{/, '{"__proto__":{"x":1},'),
      body({ test_type: 'pre' }),
    ]],
    ['missing_field', 'missing_field', ['client_started_at', 'answers', 'order', 'submission_id', 'coding_background'].map(without)],
    ['bad_submission_id', 'bad_submission_id', [
      body({ submission_id: crypto.randomUUID().toUpperCase() }),
      body({ submission_id: '3f2b8c1e-9a4d-1c3b-8d2e-0123456789ab' }), // version 1
      body({ submission_id: '3f2b8c1e-9a4d-4c3b-cd2e-0123456789ab' }), // bad variant
      body({ submission_id: '3f2b8c1e9a4d4c3b8d2e0123456789ab' }),
      body({ submission_id: 12345 }),
    ]],
    ['manifest_mismatch', 'manifest_mismatch', [
      body({ instrument_version: 'draft-9.9' }),
      body({ bank_sha256: '0'.repeat(64) }),
      body({ bank_sha256: null }),
    ]],
    ['bad_selection', 'bad_selection', [body({ selection: 'Z9' }), body({ selection: 'toString' }), body({ selection: 6 })]],
    ['bad_order', 'bad_order', [body({ participant_id: '0A', order: 'BA' }), body({ order: 'AA' }), body({ order: null })]],
    ['bad_form', 'bad_form', [
      body({ participant_id: '0A', stage: 'pre', form: 'B' }),
      body({ participant_id: '0A', stage: 'post', form: 'A' }),
      body({ form: 'a' }),
    ]],
    ['bad_coding_background', 'bad_coding_background', [
      body({ stage: 'pre', coding_background: 'expert' }),
      body({ stage: 'pre', coding_background: null }),
      body({ stage: 'post', coding_background: 'none' }),
      body({ stage: 'pre', coding_background: 'Beginner' }),
    ]],
    ['bad_answers', 'bad_answers', [
      body({ participant_id: '0A', answers: { 'J1-B': 'A' } }),          // other form
      body({ participant_id: '0A', answers: { [formAItem('J3')]: 'A' } }), // pair not in C6
      body({ participant_id: '0A', answers: { 'X9-A': 'A' } }),
      body({ answers: ['A', 'B'] }),
      body({ answers: null }),
      body({ answers: 'A' }),
    ]],
    ['bad_answer_value', 'bad_answer_value', ['E', 'a', '', 1, true, ['A'], { v: 'A' }]
      .map((v) => body({ participant_id: '0A', answers: { 'J1-A': v } }))],
    ['bad_timestamp', 'bad_timestamp', [
      body({ client_started_at: '2026-11-07T14:03:00.000' }),
      body({ client_started_at: '2026-11-07T14:03:00.000+00:00' }),
      body({ client_started_at: '2026-11-07 14:03:00.000Z' }),
      body({ client_started_at: '2026-02-30T14:03:00.000Z' }),
      body({ client_started_at: '2026-11-07T24:00:00.000Z' }),
      body({ client_submitted_at: '2026-11-07T14:03:00.00Z' }),
      body({ client_submitted_at: 1762524180000 }),
      body({ client_submitted_at: '' }),
    ]],
  ];

  for (const [name, code, inputs] of cases) {
    test(name, () => {
      for (const input of inputs) {
        const gas = createFakeGas();
        const res = typeof input === 'function' ? input(gas) : gas.post(input);
        assert.equal(res.json.status, 'error', `${name}: ${res.raw}`);
        assert.equal(res.json.code, code, `${name}: ${JSON.stringify(input)} -> ${res.raw}`);
        assert.equal(typeof res.json.message, 'string');
        assert.deepEqual(Object.keys(res.json).sort(), ['code', 'message', 'status']);
        assertNoSheetOrLock(gas);
      }
    });
  }

  test('config: ACTIVE_SELECTIONS missing, blank, or naming an unknown selection', () => {
    for (const value of [undefined, '', ' , ', 'C6,Q1', 'c6']) {
      const props = { ENV: 'local' };
      if (value !== undefined) props.ACTIVE_SELECTIONS = value;
      const gas = createFakeGas({ props });
      const res = gas.post(body());
      assert.equal(res.json.code, 'config', String(value));
      assertNoSheetOrLock(gas);
    }
  });

  test('selection_inactive: a known selection that is not in ACTIVE_SELECTIONS', () => {
    const gas = createFakeGas({ props: { ENV: 'local', ACTIVE_SELECTIONS: 'C6' } });
    const res = gas.post(body({ selection: 'B8' }));
    assert.equal(res.json.code, 'selection_inactive');
    assertNoSheetOrLock(gas);
    assertSuccess(gas.post(body({ selection: 'C6' })));
  });

  test('error responses never echo the request', () => {
    const marker = 'SYNTHETIC-MARKER-9f3c';
    const inputs = [
      body({ [marker]: marker }),
      body({ participant_id: marker }),
      body({ selection: marker }),
      body({ answers: { [marker]: 'A' } }),
      body({ client_started_at: marker }),
      `{"assent":"yes","schema":"fa2601-v2","x":"${marker}"`,
    ];
    for (const input of inputs) {
      const res = createFakeGas().post(input);
      assert.equal(res.json.status, 'error');
      assert.equal(res.raw.includes(marker), false, res.raw);
    }
  });
});

// ---------------------------------------------------------------------------
describe('destination guard', () => {
  const cases = [
    ['missing ENV', { ACTIVE_SELECTIONS: 'C6,B8' }, 'LOCAL-FAKE-SHEET', false],
    ['placeholder hash (ENV=test)', { ENV: 'test', ACTIVE_SELECTIONS: 'C6,B8' }, 'LOCAL-FAKE-SHEET', false],
    ['unknown ENV', { ENV: 'staging', ACTIVE_SELECTIONS: 'C6,B8' }, 'LOCAL-FAKE-SHEET', false],
    ['ENV=prod on a different Sheet', { ENV: 'prod', ACTIVE_SELECTIONS: 'C6,B8' }, 'LOCAL-FAKE-SHEET', true],
    ['ENV=local on a different Sheet', { ENV: 'local', ACTIVE_SELECTIONS: 'C6,B8' }, 'SOME-OTHER-FAKE-SHEET', true],
    ['ENV that is an Object prototype key', { ENV: 'toString', ACTIVE_SELECTIONS: 'C6,B8' }, 'LOCAL-FAKE-SHEET', false],
  ];
  for (const [name, props, sheetId, readsId] of cases) {
    test(`${name} -> error destination, no write`, () => {
      const gas = createFakeGas({ props, sheetId });
      seedLegacy(gas);
      const before = LEGACY_TABS.map((t) => gas.snapshot(t));
      const res = gas.post(body());
      assert.deepEqual(res.json, { status: 'error', code: 'destination', message: 'Submission destination is not configured.' });
      const sheetCalls = gas.callsTo(...SHEET_SERVICES).map((c) => `${c.service}.${c.method}`);
      assert.deepEqual(sheetCalls, readsId ? ['SpreadsheetApp.getActiveSpreadsheet', 'Spreadsheet.getId'] : []);
      for (const tab of V2_TABS) assert.equal(gas.sheet(tab), null);
      assert.deepEqual(LEGACY_TABS.map((t) => gas.snapshot(t)), before);
    });
  }

  test('ENV=test works once the test hash replaces the placeholder', () => {
    const gas = createFakeGas({ props: { ENV: 'test', ACTIVE_SELECTIONS: 'C6' }, sheetId: 'SYNTHETIC-TEST-SHEET' });
    gas.context.ALLOWED_SHEET_SHA256.test = sha256Hex('SYNTHETIC-TEST-SHEET');
    assertSuccess(gas.post(body()));
  });
});

// ---------------------------------------------------------------------------
describe('tabs and header', () => {
  test('schema_mismatch: target tab header differs -> error, tab unchanged', () => {
    const variants = [
      [EXPECTED_HEADER.slice(0, -1).concat(['G2_state'])],
      [EXPECTED_HEADER.concat(['notes'])],
      [EXPECTED_HEADER.slice(0, 10)],
      [['participant_id', 'timestamp'], ['57R', '2026-11-07T14:00:00.000Z']],
    ];
    for (const rows of variants) {
      const gas = createFakeGas();
      gas.seed('Pre-Test v2', rows, '@');
      const before = gas.snapshot('Pre-Test v2');
      gas.resetCalls();
      const res = gas.post(body());
      assert.deepEqual(res.json, { status: 'error', code: 'schema_mismatch', message: 'Sheet header does not match.' });
      assert.equal(gas.snapshot('Pre-Test v2'), before);
      assert.equal(gas.calls.some((c) => ['setValues', 'setNumberFormat', 'insertSheet'].includes(c.method)), false);
      assert.equal(gas.lock.held, false);
    }
  });

  test('schema_mismatch on the OTHER v2 tab also fails closed (idempotency lookup cannot trust it)', () => {
    const gas = createFakeGas();
    gas.seed('Post-Test v2', [['something', 'else']], '@');
    const res = gas.post(body({ stage: 'pre' }));
    assert.equal(res.json.code, 'schema_mismatch');
    assert.equal(gas.sheet('Pre-Test v2'), null);
  });

  test('an existing but completely empty v2 tab gets the header', () => {
    const gas = createFakeGas();
    gas.seed('Pre-Test v2', []);
    assertSuccess(gas.post(body()));
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
  });

  test('header is written only once; rows append below it', () => {
    const gas = createFakeGas();
    assertSuccess(gas.post(body({ participant_id: '0B' })));
    assert.equal(gas.calls.filter((c) => c.method === 'setValues').length, 2, 'header + first row');
    for (let i = 1; i < 3; i++) {
      gas.resetCalls();
      assertSuccess(gas.post(body({ participant_id: `${i}B` })));
      assert.equal(gas.calls.filter((c) => c.method === 'setValues').length, 1, 'existing tab: one row write only');
      assert.equal(gas.calls.filter((c) => c.method === 'setNumberFormat').length, 1);
    }
    const rows = gas.rows('Pre-Test v2');
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], EXPECTED_HEADER);
    assert.equal(rows.filter((r) => r[0] === 'submission_id').length, 1);
  });

  test('no formula is ever stored; every written cell is plain text (@)', () => {
    const gas = createFakeGas();
    for (let i = 0; i < 5; i++) {
      gas.post(body({ participant_id: `${i}C`, answers: answersFor('C6', contractOrder(`${i}C`)[0], 'cwsncw'.split('')) }));
      gas.post(body({ participant_id: `${i}C`, stage: 'post', selection: 'B8', coding_background: '' }));
    }
    for (const tab of V2_TABS) {
      assert.deepEqual(gas.formulas(tab), [], tab);
      const sheet = gas.sheet(tab);
      for (const cell of sheet.cells.values()) assert.equal(cell.format, '@');
      // Text stays text: the date column is not turned into a Date.
      for (const row of rowObjects(gas, tab)) assert.equal(typeof row.server_date, 'string');
    }
  });

  test("a value starting with '=' is stored as literal text, not a formula", () => {
    const gas = createFakeGas();
    gas.context.MANIFEST.instrument_version = '=HYPERLINK("http://example.invalid","x")';
    const res = gas.post(body({ instrument_version: '=HYPERLINK("http://example.invalid","x")' }));
    assertSuccess(res);
    assert.deepEqual(gas.formulas('Pre-Test v2'), []);
    assert.equal(rowObjects(gas, 'Pre-Test v2')[0].instrument_version, '=HYPERLINK("http://example.invalid","x")');
  });

  test('the fake really turns =strings into formulas without @ (sanity check of the fake)', () => {
    const gas = createFakeGas();
    const sheet = gas.seed('Scratch', []);
    sheet.getRange(1, 1, 1, 3).setValues([['=1+1', '42', '2026-11-07']]);
    sheet.getRange(2, 1, 1, 3).setNumberFormat('@').setValues([['=1+1', '42', '2026-11-07']]);
    assert.deepEqual(gas.formulas('Scratch'), ['=1+1']);
    const rows = gas.rows('Scratch');
    assert.equal(rows[0][1], 42);
    assert.ok(rows[0][2] instanceof Date);
    assert.deepEqual(rows[1], ['=1+1', '42', '2026-11-07']);
  });
});

// ---------------------------------------------------------------------------
describe('idempotency, conflict, failures, lock', () => {
  test('same body twice -> one row, same receipt, duplicate:true', () => {
    const gas = createFakeGas();
    const b = body({ answers: answersFor('C6', 'A', 'cwcscn'.split('')) });
    const first = gas.post(b);
    const second = gas.post(b);
    assertSuccess(first, false);
    assertSuccess(second, true);
    assert.equal(second.json.receipt, first.json.receipt);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
    assert.equal(gas.lock.acquired, 2);
    assert.equal(gas.lock.released, 2);
  });

  test('same body with keys reordered and whitespace -> still a duplicate (canonical fingerprint)', () => {
    const gas = createFakeGas();
    const b = body({ answers: { 'J1-A': 'A', 'G1-A': null } });
    assertSuccess(gas.post(b));
    const reordered = Object.fromEntries(Object.entries(b).reverse());
    reordered.answers = { 'G1-A': null, 'J1-A': 'A' };
    assertSuccess(gas.post(JSON.stringify(reordered, null, 2)), true);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
  });

  test('same submission_id, different body -> conflict, row unchanged', () => {
    const gas = createFakeGas();
    const b = body({ answers: { 'J1-A': 'A' } });
    assertSuccess(gas.post(b));
    const before = gas.snapshot('Pre-Test v2');
    for (const changed of [
      Object.assign({}, b, { answers: { 'J1-A': 'B' } }),
      Object.assign({}, b, { client_submitted_at: '2026-11-07T14:04:31.000Z' }),
      Object.assign({}, b, { coding_background: 'none' }),
    ]) {
      const res = gas.post(changed);
      assert.deepEqual(res.json, { status: 'conflict', message: 'This submission ID was already used with different answers.' });
      assert.equal(gas.snapshot('Pre-Test v2'), before);
    }
    assert.equal(gas.lock.held, false);
  });

  test('a submission_id stored in Pre-Test v2 conflicts when reused for post', () => {
    const gas = createFakeGas();
    const pre = body({ stage: 'pre' });
    assertSuccess(gas.post(pre));
    const post = body({ stage: 'post', submission_id: pre.submission_id });
    assert.equal(gas.post(post).json.status, 'conflict');
    assert.equal(gas.sheet('Post-Test v2'), null);
  });

  test('failure injected before write -> error, no row; retry succeeds once', () => {
    const gas = createFakeGas();
    const b = body();
    gas.inject.failBeforeWrite = 1;
    const res = gas.post(b);
    assert.deepEqual(res.json, { status: 'error', code: 'internal', message: 'Server error.' });
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 0);
    assert.equal(gas.lock.held, false, 'lock released after an exception');
    assert.equal(gas.consoleLines.some((l) => l.includes(b.submission_id)), false, 'log never holds the request');
    const retry = gas.post(b);
    assertSuccess(retry, false);
    assert.equal(retry.json.receipt, b.submission_id);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
  });

  test('failure injected after write, before reply -> one row; retry returns duplicate with the original receipt', () => {
    const gas = createFakeGas();
    const b = body();
    gas.inject.failAfterWrite = 1;
    const res = gas.post(b);
    assert.equal(res.json.code, 'internal');
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
    assert.equal(gas.lock.held, false);
    const retry = gas.post(b);
    assertSuccess(retry, true);
    assert.equal(retry.json.receipt, b.submission_id);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
  });

  test('lock held elsewhere -> busy, no row, lock not released by the script', () => {
    const gas = createFakeGas();
    gas.lock.held = true;
    const res = gas.post(body());
    assert.deepEqual(res.json, { status: 'busy', message: 'Server busy. Try again.' });
    assert.equal(gas.sheet('Pre-Test v2'), null);
    assert.equal(gas.lock.held, true);
    assert.equal(gas.lock.lastTimeout, 10000);
    assert.equal(gas.calls.some((c) => c.method === 'releaseLock'), false);
  });

  test('busy once, then the same body succeeds', () => {
    const gas = createFakeGas();
    const b = body();
    gas.inject.busy = 1;
    assert.equal(gas.post(b).json.status, 'busy');
    assertSuccess(gas.post(b), false);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 1);
  });
});

// ---------------------------------------------------------------------------
describe('dup_code_same_day_stage and server_date', () => {
  test('counts earlier rows with the same code and New York date, per tab', () => {
    const gas = createFakeGas();
    const at = (iso) => { gas.clock.now = Date.parse(iso); };
    const post = (overrides) => {
      const res = gas.post(body(overrides));
      assertSuccess(res);
    };
    at('2026-11-07T14:05:00.000Z'); post({ participant_id: '57R' });
    at('2026-11-07T15:00:00.000Z'); post({ participant_id: '57R' });
    at('2026-11-07T16:00:00.000Z'); post({ participant_id: ' 57r' });
    at('2026-11-07T16:30:00.000Z'); post({ participant_id: '12Q' });
    at('2026-11-07T17:00:00.000Z'); post({ participant_id: '57R', stage: 'post', coding_background: '' });
    // 03:30Z on Nov 8 is 22:30 on Nov 7 in New York (EST, UTC-5).
    at('2026-11-08T03:30:00.000Z'); post({ participant_id: '57R' });
    // 05:30Z on Nov 8 is 00:30 on Nov 8 in New York.
    at('2026-11-08T05:30:00.000Z'); post({ participant_id: '57R' });

    const pre = rowObjects(gas, 'Pre-Test v2');
    assert.deepEqual(pre.map((r) => [r.participant_id, r.server_date, r.dup_code_same_day_stage]), [
      ['57R', '2026-11-07', 0],
      ['57R', '2026-11-07', 1],
      ['57R', '2026-11-07', 2],
      ['12Q', '2026-11-07', 0],
      ['57R', '2026-11-07', 3],
      ['57R', '2026-11-08', 0],
    ]);
    assert.deepEqual(pre.map((r) => r.server_received_at).slice(-2), ['2026-11-08T03:30:00.000Z', '2026-11-08T05:30:00.000Z']);
    const post2 = rowObjects(gas, 'Post-Test v2');
    assert.deepEqual(post2.map((r) => r.dup_code_same_day_stage), [0]);
  });

  test('server_date follows New York daylight time in summer (UTC-4)', () => {
    const gas = createFakeGas({ now: Date.parse('2026-07-01T03:30:00.000Z') });
    assertSuccess(gas.post(body()));
    assert.equal(rowObjects(gas, 'Pre-Test v2')[0].server_date, '2026-06-30');
  });
});

// ---------------------------------------------------------------------------
describe('legacy tabs', () => {
  test('legacy tabs are byte-identical and never accessed after many v2 writes', () => {
    const gas = createFakeGas();
    seedLegacy(gas);
    const before = Object.fromEntries(LEGACY_TABS.map((t) => [t, gas.snapshot(t)]));
    const hashesBefore = legacyHashes(gas);
    gas.resetCalls();

    const statuses = {};
    const count = (res) => { statuses[res.json.status] = (statuses[res.json.status] || 0) + 1; };
    for (let i = 0; i < 40; i++) {
      const code = `${i}${'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]}`;
      const order = contractOrder(code);
      const selection = i % 2 ? 'B8' : 'C6';
      const pre = body({ participant_id: code, selection, answers: answersFor(selection, order[0], (selection === 'C6' ? 'cwscnc' : 'cwscncww').split('')) });
      count(gas.post(pre));
      if (i % 5 === 0) count(gas.post(pre));                                         // duplicate
      if (i % 7 === 0) count(gas.post(Object.assign({}, pre, { coding_background: 'none' }))); // conflict
      if (i % 9 === 0) count(gas.post(Object.assign({}, pre, { form: order[1] })));  // error
      if (i % 11 === 0) { gas.inject.failAfterWrite = 1; }
      count(gas.post(body({ participant_id: code, stage: 'post', selection, coding_background: '' })));
      count(gas.post({ assent: 'no' }));
      count(gas.post({ assent: 'yes', test_type: 'post', participant_id: code }));
    }
    assert.ok(statuses.success >= 80 && statuses.conflict >= 1 && statuses.error >= 1 && statuses.closed === 40, JSON.stringify(statuses));

    assert.deepEqual(Object.fromEntries(LEGACY_TABS.map((t) => [t, gas.snapshot(t)])), before);
    assert.deepEqual(legacyHashes(gas), hashesBefore);
    const touched = gas.sheetNamesTouched();
    for (const name of LEGACY_TABS) assert.equal(touched.has(name), false, `${name} was accessed`);
    assert.deepEqual(Array.from(gas.sheets.keys()), [...LEGACY_TABS, 'Pre-Test v2', 'Post-Test v2']);
    assert.equal(rowObjects(gas, 'Pre-Test v2').length, 40);
    assert.equal(rowObjects(gas, 'Post-Test v2').length, 40);
  });
});

// ---------------------------------------------------------------------------
describe('doGet and selfCheck', () => {
  test('doGet returns only {status:"ok", schema:"fa2601-v2"}', () => {
    const gas = createFakeGas();
    const res = gas.get();
    assert.equal(res.raw, '{"status":"ok","schema":"fa2601-v2"}');
    assert.equal(res.mime, 'JSON');
    assertOnlyContentService(gas);
  });

  test('selfCheck refuses to run unless ENV is test', () => {
    for (const props of [{ ENV: 'local' }, { ENV: 'prod' }, {}, { ENV: 'TEST' }]) {
      const gas = createFakeGas({ props });
      seedLegacy(gas);
      assert.throws(() => gas.context.selfCheck(), /ENV must be test/);
      assert.deepEqual(gas.callsTo('SpreadsheetApp', 'Spreadsheet', 'Sheet', 'Range'), []);
    }
  });

  test('selfCheck with ENV=test refuses while the test hash is a placeholder or mismatched', () => {
    const gas = createFakeGas({ props: { ENV: 'test' }, sheetId: 'SYNTHETIC-TEST-SHEET' });
    assert.throws(() => gas.context.selfCheck(), /does not match the test Sheet hash/);
    gas.context.ALLOWED_SHEET_SHA256.test = sha256Hex('A-DIFFERENT-SHEET');
    assert.throws(() => gas.context.selfCheck(), /does not match the test Sheet hash/);
  });

  test('selfCheck on the test Sheet reports v2 rows, no formulas, and legacy hashes (read only)', () => {
    const gas = createFakeGas({ props: { ENV: 'test', ACTIVE_SELECTIONS: 'C6' }, sheetId: 'SYNTHETIC-TEST-SHEET' });
    gas.context.ALLOWED_SHEET_SHA256.test = sha256Hex('SYNTHETIC-TEST-SHEET');
    seedLegacy(gas);
    const before = LEGACY_TABS.map((t) => gas.snapshot(t));
    assertSuccess(gas.post(body()));
    assertSuccess(gas.post(body({ participant_id: '9Z' })));
    const report = JSON.parse(JSON.stringify(gas.context.selfCheck()));
    assert.deepEqual(report.v2['Pre-Test v2'], { present: true, rows: 3, data_rows: 2, header_ok: true, formulas_empty: true });
    assert.deepEqual(report.v2['Post-Test v2'], { present: false });
    const expected = legacyHashes(gas);
    for (const name of LEGACY_TABS) assert.equal(report.legacy[name].sha256, expected[name], name);
    assert.deepEqual(LEGACY_TABS.map((t) => gas.snapshot(t)), before);
    assert.ok(gas.logs.some((l) => l.startsWith('Pre-Test v2: rows=3 data_rows=2 header_ok=true formulas_empty=true')));
    assert.ok(gas.logs.some((l) => l.startsWith('Paired: rows=4 cols=4 sha256=')));
    const writes = gas.calls.filter((c) => LEGACY_TABS.includes(c.sheet) && /^(set|insert|append)/.test(c.method));
    assert.deepEqual(writes, []);
  });
});
