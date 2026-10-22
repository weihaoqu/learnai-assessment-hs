// FA2601 assessment v2: end-to-end browser scenario (synthetic data only).
//
// This file is ONE async function expression, (page, base) => summary, so it can be
//   - passed as-is to a Playwright "run code" tool, which calls it with (page);
//   - or loaded from node:  const fn = require('vm').runInThisContext(fs.readFileSync(path, 'utf8'));
//                           const summary = await fn(page, 'http://127.0.0.1:8799');
//
// It expects the local dev server (tests/dev_server.mjs) at `base`, which serves the app with
// config-v2.js in mode 'local' and provides:
//   POST /exec            -> the real v2 Apps Script running against a fake spreadsheet
//   GET  /debug/rows      -> the fake spreadsheet's rows (JSON)
//   POST /debug/inject    -> {mode: 'fail_before'|'fail_after'|'busy'|'none', times}
// It never contacts any other service. Scenarios H and I stub /exec in the browser (page.route) and
// therefore never reach even the local server.
//
// Returns a JSON-serializable summary: {ok, passed, failed, failures, checks, errors, submissions, rows_shape}.
(async function fa2601V2Flow(page, base = 'http://127.0.0.1:8799') {
  base = String(base).replace(/\/+$/, '');
  const LETTERS = ['A', 'B', 'C', 'D'];
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const CONTRACT_FIELDS = [
    'answers', 'assent', 'assent_version', 'bank_sha256', 'client_started_at', 'client_submitted_at',
    'coding_background', 'form', 'instrument_version', 'order', 'participant_id', 'schema',
    'selection', 'stage', 'submission_id'
  ];
  const SCORE_TEXT = /\bscore\b|\bcorrect\b|best answer|\blevel\b|out of \d+|\d+\s*\/\s*\d+/i;
  const SAVE_TIMEOUT = 25000;

  const checks = [];
  const errors = [];
  const submissions = {};
  let rowsShape = null;
  const check = (name, pass, detail) => {
    const entry = { name, pass: Boolean(pass) };
    if (detail !== undefined) entry.detail = detail;
    checks.push(entry);
    return Boolean(pass);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // ── Record every POST /exec the page makes, with its response ──────────────
  const execRecords = [];
  const isExec = request => {
    try { return request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/exec'); }
    catch (e) { return false; }
  };
  page.on('request', request => {
    if (!isExec(request)) return;
    let parsed = null;
    try { parsed = JSON.parse(request.postData() || ''); } catch (e) { parsed = null; }
    execRecords.push({
      request,
      body: request.postData(),
      submission_id: parsed && parsed.submission_id,
      stage: parsed && parsed.stage,
      contentType: request.headers()['content-type'] || '',
      at: Date.now(),
      httpStatus: null,
      json: null,
      failed: null
    });
  });
  page.on('response', async response => {
    const record = execRecords.find(r => r.request === response.request());
    if (!record) return;
    record.httpStatus = response.status();
    try { record.json = await response.json(); } catch (e) { record.json = null; }
  });
  page.on('requestfailed', request => {
    const record = execRecords.find(r => r.request === request);
    if (record) record.failed = (request.failure() && request.failure().errorText) || 'failed';
  });
  const recordsFor = id => execRecords.filter(r => r.submission_id === id);

  // ── Dev-server helpers ─────────────────────────────────────────────────────
  async function inject(mode, times) {
    const res = await page.request.post(`${base}/debug/inject`, { data: { mode, times } });
    if (!res.ok()) throw new Error(`inject ${mode} failed: HTTP ${res.status()}`);
  }
  async function fetchRows() {
    const res = await page.request.get(`${base}/debug/rows`);
    if (!res.ok()) throw new Error(`GET /debug/rows failed: HTTP ${res.status()}`);
    const data = await res.json();
    if (rowsShape === null) {
      rowsShape = Array.isArray(data) ? `array(${data.length})` : Object.keys(data || {}).slice(0, 12);
    }
    return data;
  }
  // Shape-agnostic: a "row" is any array/object that holds the id as a direct value.
  function countRowsWith(data, id, tabName) {
    let scope = data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data[tabName] !== undefined) scope = data[tabName];
      else if (data.tabs && data.tabs[tabName] !== undefined) scope = data.tabs[tabName];
      else if (data.sheets && data.sheets[tabName] !== undefined) scope = data.sheets[tabName];
    }
    let count = 0;
    (function walk(node) {
      if (Array.isArray(node)) {
        if (node.includes(id)) { count++; return; }
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        const values = Object.values(node);
        if (values.includes(id)) { count++; return; }
        values.forEach(walk);
      }
    })(scope);
    return count;
  }
  async function rowCount(id, stage) {
    return countRowsWith(await fetchRows(), id, stage === 'pre' ? 'Pre-Test v2' : 'Post-Test v2');
  }

  // ── App helpers ────────────────────────────────────────────────────────────
  const activeScreen = () => page.evaluate(() => {
    const el = document.querySelector('.screen.active');
    return el ? el.id : null;
  });
  const btnSubmitCount = () => page.locator('#btn-submit').count();
  const savedFlag = () => page.evaluate(() => document.body.dataset.fa2601Saved || null);
  const storage = () => page.evaluate(() => {
    const out = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      out[key] = sessionStorage.getItem(key);
    }
    return out;
  });
  const instrument = () => page.evaluate(() => {
    const config = window.FA2601_CONFIG;
    const items = window.FA2601_ITEMS;
    return {
      selection: config.selection,
      pairs: items.selections[config.selection],
      items: items.items,
      instrument_version: items.instrument_version,
      bank_sha256: items.bank_sha256
    };
  });
  async function noScoreText(label) {
    const text = await page.evaluate(() => document.body.innerText);
    const hit = text.match(SCORE_TEXT);
    check(`no score/level/correctness text (${label})`, !hit, hit ? hit[0] : undefined);
  }
  async function noStatusButtonYet(label) {
    check(`#btn-submit absent before a confirmed post save (${label})`, (await btnSubmitCount()) === 0);
  }
  async function freshSession(path) {
    await page.goto(`${base}/`);
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`${base}${path}`);
  }
  async function agree() {
    await page.waitForSelector('#assent-overlay:not(.hidden)', { timeout: 10000 });
    await page.click('#assent-content button[onclick="handleConsent(true)"]');
  }
  async function startStage(code, background) {
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    await page.fill('#inp-code', code);
    if (background !== undefined) await page.selectOption('#inp-background', background);
    await page.click('#btn-start');
    await page.waitForSelector('#screen-question.active', { timeout: 10000 });
  }
  async function expectQuestion(index, total, itemId, items) {
    await page.waitForSelector('#screen-question.active', { timeout: 10000 });
    const counter = ((await page.textContent('#q-counter')) || '').trim();
    const stem = ((await page.textContent('#q-text')) || '').trim();
    const options = await page.$$eval('#q-choices [role="radio"] .choice-text', els => els.map(e => e.textContent));
    return check(
      `Question ${index + 1}: shows ${itemId}`,
      counter === `Question ${index + 1} of ${total}` && stem === items[itemId].stem.trim()
        && JSON.stringify(options) === JSON.stringify(items[itemId].options),
      counter === `Question ${index + 1} of ${total}` ? undefined : counter
    );
  }
  async function choose(letter) {
    await page.locator('#q-choices [role="radio"]').nth(LETTERS.indexOf(letter)).click();
    const checked = await page.$$eval('#q-choices [role="radio"]', els => els.map(e => e.getAttribute('aria-checked')));
    return checked[LETTERS.indexOf(letter)] === 'true' && checked.filter(v => v === 'true').length === 1;
  }
  // plan[i] is a letter (answer, then Next) or null (Skip this question).
  async function answerAll(itemIds, items, plan, start = 0) {
    for (let i = start; i < itemIds.length; i++) {
      await expectQuestion(i, itemIds.length, itemIds[i], items);
      if (plan[i] === null) {
        await page.click('#btn-skip');
      } else {
        check(`Next disabled before choosing (Q${i + 1})`, await page.isDisabled('#btn-next'));
        check(`choice ${plan[i]} marked aria-checked (Q${i + 1})`, await choose(plan[i]));
        check(`Next enabled after choosing (Q${i + 1})`, !(await page.isDisabled('#btn-next')));
        await page.click('#btn-next');
      }
    }
    await page.waitForSelector('#screen-review.active', { timeout: 10000 });
  }
  const reviewStatuses = () => page.$$eval('#review-list .review-status', els => els.map(e => e.textContent.trim()));
  const expectedStatuses = (itemIds, answers) => itemIds.map(id => (
    answers[id] === undefined ? 'Not answered' : answers[id] === null ? 'Skipped' : 'Answered'
  ));
  function checkBody(label, body, expected) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
    if (!check(`${label}: body is JSON`, parsed !== null)) return null;
    check(`${label}: exactly the contract fields`, JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify(CONTRACT_FIELDS),
      Object.keys(parsed).sort());
    check(`${label}: schema/assent/version`, parsed.schema === 'fa2601-v2' && parsed.assent === 'yes'
      && parsed.assent_version === 'FA2601-Assent-2026-10-22'
      && parsed.instrument_version === expected.instrument_version && parsed.bank_sha256 === expected.bank_sha256
      && parsed.selection === expected.selection);
    check(`${label}: stage/code/order/form`, parsed.stage === expected.stage && parsed.participant_id === expected.code
      && parsed.order === expected.order && parsed.form === expected.form,
      { stage: parsed.stage, participant_id: parsed.participant_id, order: parsed.order, form: parsed.form });
    check(`${label}: coding_background`, parsed.coding_background === expected.background, parsed.coding_background);
    check(`${label}: answers`, JSON.stringify(parsed.answers) === JSON.stringify(expected.answers), parsed.answers);
    check(`${label}: submission_id is lower-case UUID v4`, UUID_V4.test(parsed.submission_id || ''), parsed.submission_id);
    check(`${label}: client timestamps are ISO-8601 UTC`, ISO_UTC.test(parsed.client_started_at || '')
      && ISO_UTC.test(parsed.client_submitted_at || ''));
    return parsed;
  }
  function planAnswers(itemIds, plan) {
    const answers = {};
    itemIds.forEach((id, i) => { answers[id] = plan[i]; });
    return answers;
  }
  async function scenario(name, fn) {
    try {
      await fn();
    } catch (error) {
      errors.push({ scenario: name, error: String((error && error.stack) || error) });
      check(`${name}: completed without error`, false, String((error && error.message) || error));
    }
  }

  // ── Scenarios ──────────────────────────────────────────────────────────────
  let inst = null;

  await scenario('A pre 57R (form B), answers + skips incl. last', async () => {
    await inject('none', 0);
    await freshSession('/?type=pre');
    inst = await instrument();
    const n = inst.pairs.length;
    const banner = ((await page.textContent('#mode-banner')) || '').trim();
    check('TEST banner is visible in local mode', banner.includes('TEST — synthetic data only') && await page.isVisible('#mode-banner'), banner);
    await noStatusButtonYet('first load');
    await agree();
    await page.waitForSelector('#screen-welcome.active');
    check('welcome subtitle shows the item count', ((await page.textContent('#welcome-sub')) || '').trim() === `${n} short questions`);
    check('coding background shown on pre', await page.isVisible('#inp-background'));
    const bgOptions = await page.$$eval('#inp-background option', els => els.map(e => [e.value, e.textContent.trim()]));
    check('coding background options', JSON.stringify(bgOptions) === JSON.stringify([
      ['', 'Select one…'], ['none', 'No experience'], ['beginner', 'Beginner'],
      ['intermediate', 'Intermediate'], ['advanced', 'Advanced'], ['prefer_not', 'Prefer not to say']
    ]), bgOptions);

    // Invalid code is refused; lower-case with spaces is normalized.
    await page.fill('#inp-code', '101A');
    await page.click('#btn-start');
    check('invalid code 101A is refused', (await activeScreen()) === 'screen-welcome');
    // The app takes only 10 to 99 plus a letter (Cui, 2026-10-22).
    await page.fill('#inp-code', '7A');
    await page.click('#btn-start');
    check('code 7A (below 10) is refused', (await activeScreen()) === 'screen-welcome');
    await startStage(' 57r', 'beginner');

    const itemIds = inst.pairs.map(pair => `${pair}-B`); // 57R -> BA, so pre uses form B
    const plan = itemIds.map((_, i) => (i === n - 1 ? null : (i % 3 === 1 ? null : LETTERS[i % 4])));
    const draftBefore = (await storage())['fa2601_v2_draft_pre'];
    check('draft written at stage start', Boolean(draftBefore));

    // Question 1 by hand: Back is hidden, Next waits for a choice, and Back from Q2 keeps it.
    await expectQuestion(0, n, itemIds[0], inst.items);
    check('Back hidden on question 1', (await page.$eval('#btn-back', el => getComputedStyle(el).visibility)) === 'hidden');
    check('Next disabled before choosing (Q1)', await page.isDisabled('#btn-next'));
    check(`choice ${plan[0]} marked aria-checked (Q1)`, await choose(plan[0]));
    await page.click('#btn-next');
    await expectQuestion(1, n, itemIds[1], inst.items);
    await page.click('#btn-back');
    await expectQuestion(0, n, itemIds[0], inst.items);
    const keptChoice = await page.$$eval('#q-choices [role="radio"]', els => els.map(e => e.getAttribute('aria-checked')));
    check('Back shows the earlier choice', keptChoice[LETTERS.indexOf(plan[0])] === 'true');
    check('Next enabled for an answered question', !(await page.isDisabled('#btn-next')));
    await page.click('#btn-next');
    await answerAll(itemIds, inst.items, plan, 1);

    // Refresh on the review screen resumes the draft.
    await page.reload();
    await page.waitForSelector('#screen-review.active', { timeout: 10000 });
    check('refresh resumes the review screen', true);
    const answers = planAnswers(itemIds, plan);
    check('review lists Answered/Skipped per question', JSON.stringify(await reviewStatuses()) === JSON.stringify(expectedStatuses(itemIds, answers)),
      await reviewStatuses());
    await noScoreText('pre review');
    await noStatusButtonYet('pre review');

    // Change question 2 (skipped) to an answer; Next returns to the review.
    await page.locator('#review-list .review-change').nth(1).click();
    await expectQuestion(1, n, itemIds[1], inst.items);
    await choose('D');
    await page.click('#btn-next');
    await page.waitForSelector('#screen-review.active', { timeout: 10000 });
    answers[itemIds[1]] = 'D';
    check('Change then Next returns to review with the new status', JSON.stringify(await reviewStatuses()) === JSON.stringify(expectedStatuses(itemIds, answers)));
    check('last item is still skipped', answers[itemIds[n - 1]] === null);

    await page.click('#btn-finish');
    await page.waitForSelector('#screen-pre-done.active', { timeout: SAVE_TIMEOUT });
    await page.waitForSelector('body[data-fa2601-saved="pre"]', { timeout: 5000 });
    check('pre saved: #screen-pre-done.active and body[data-fa2601-saved=pre]', true);
    const store = await storage();
    check('pre draft cleared after confirmed save', !('fa2601_v2_draft_pre' in store));
    check('assent flag unchanged', store['fa2601_assent_FA2601-Assent-2026-10-22'] === 'yes');
    await noScoreText('pre done');
    await noStatusButtonYet('pre done');

    const id = JSON.parse(draftBefore).submission_id;
    submissions.pre_57R = id;
    const recs = recordsFor(id);
    check('pre: one POST, text/plain', recs.length === 1 && recs[0].contentType.startsWith('text/plain'), recs.map(r => r.contentType));
    checkBody('pre 57R', recs[0] && recs[0].body, {
      ...inst, stage: 'pre', code: '57R', order: 'BA', form: 'B', background: 'beginner', answers
    });
    check('pre: server said success', recs[0] && recs[0].json && recs[0].json.status === 'success', recs[0] && recs[0].json);
    check('pre 57R: exactly one row', (await rowCount(id, 'pre')) === 1);
  });

  await scenario('B post 57R (form A), fail_after once -> Try again -> one row', async () => {
    await page.goto(`${base}/?type=post`);
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    check('post: assent not asked again in this session', await page.isHidden('#assent-overlay'));
    check('coding background hidden on post', await page.isHidden('#inp-background'));
    await noStatusButtonYet('post welcome');
    await startStage('57R');
    const n = inst.pairs.length;
    const itemIds = inst.pairs.map(pair => `${pair}-A`); // 57R -> BA, so post uses form A
    const plan = itemIds.map((_, i) => LETTERS[(i + 1) % 4]);
    await answerAll(itemIds, inst.items, plan);
    await noStatusButtonYet('post review');

    await inject('fail_after', 1);
    await page.click('#btn-finish');
    // Wait for either outcome so a misconfigured injection is reported instead of timing out.
    await page.waitForFunction(() => (document.getElementById('save-title') || {}).textContent === 'Save not confirmed'
      || document.body.dataset.fa2601Saved === 'post', null, { timeout: SAVE_TIMEOUT });
    if ((await savedFlag()) === 'post') {
      // Chromium silently re-sends a POST whose reused keep-alive socket is reset before any
      // response bytes; the server then answers duplicate:true. The app behaved correctly, but
      // the Try-again path was not exercised. The dev server's fail_after should reply with an
      // HTTP 5xx (or a `Connection: close` response) after the write instead of a bare reset.
      check('fail_after reached the app as a failure (dev server must answer 5xx, not reset the socket)', false,
        'browser transparently re-sent the POST; app saved via duplicate:true');
      return;
    }
    check('fail_after: "Save not confirmed" with Try again', await page.isVisible('#btn-retry'));
    await noStatusButtonYet('post unconfirmed');
    check('fail_after: not marked saved', (await savedFlag()) === null);
    const draft = JSON.parse((await storage())['fa2601_v2_draft_post'] || 'null');
    check('fail_after: frozen body kept in the draft', Boolean(draft && typeof draft.frozen === 'string'));
    const id = draft && draft.submission_id;
    submissions.post_57R = id;
    check('fail_after: the server stored the row anyway', (await rowCount(id, 'post')) === 1);

    // Refresh: the frozen, unconfirmed save is resumed and is NOT re-sent automatically.
    const sentBefore = recordsFor(id).length;
    await page.reload();
    await page.waitForSelector('#screen-save.active', { timeout: 10000 });
    await sleep(1500);
    check('refresh resumes the frozen save with Try again', await page.isVisible('#btn-retry')
      && ((await page.textContent('#save-title')) || '').trim() === 'Save not confirmed');
    check('refresh does not auto-send', recordsFor(id).length === sentBefore);

    await page.click('#btn-retry');
    await page.waitForSelector('#screen-post-done.active', { timeout: SAVE_TIMEOUT });
    await page.waitForSelector('body[data-fa2601-saved="post"]', { timeout: 5000 });
    const status = await page.$eval('#btn-submit', el => ({ text: el.textContent.trim(), disabled: el.disabled }));
    check('post saved: #btn-submit says Submitted! and is disabled', status.text === 'Submitted!' && status.disabled, status);
    check('post saved: #btn-submit is inside the post-done screen', (await page.locator('#screen-post-done #btn-submit').count()) === 1);
    check('post draft cleared after confirmed save', !('fa2601_v2_draft_post' in (await storage())));
    await noScoreText('post done');

    const recs = recordsFor(id);
    check('post: two POSTs (failed + retry)', recs.length === 2, recs.length);
    check('post: retry body is byte-identical', recs.length >= 2 && recs.every(r => r.body === recs[0].body));
    const last = recs[recs.length - 1];
    check('post: retry answered success with duplicate:true', last && last.json && last.json.status === 'success' && last.json.duplicate === true,
      last && last.json);
    check('post: receipt equals submission_id', last && last.json && last.json.receipt === id);
    checkBody('post 57R', recs[0] && recs[0].body, {
      ...inst, stage: 'post', code: '57R', order: 'BA', form: 'A', background: '', answers: planAnswers(itemIds, plan)
    });
    check('post 57R: exactly one row', (await rowCount(id, 'post')) === 1);
  });

  await scenario('C busy x2 -> automatic retries -> saved', async () => {
    await inject('none', 0);
    await freshSession('/?type=pre');
    await agree();
    await startStage('17A'); // 17A -> AB (the app takes 10 to 99 only), pre uses form A; background left unselected
    const itemIds = inst.pairs.map(pair => `${pair}-A`);
    const plan = itemIds.map((_, i) => (i === 0 ? 'C' : null));
    await answerAll(itemIds, inst.items, plan);
    const id = JSON.parse((await storage())['fa2601_v2_draft_pre']).submission_id;
    submissions.pre_17A = id;
    await inject('busy', 2);
    const started = Date.now();
    await page.click('#btn-finish');
    let sawBusy = false;
    try {
      await page.waitForFunction(() => /busy/i.test((document.getElementById('save-message') || {}).textContent || ''), null, { timeout: 4000 });
      sawBusy = true;
    } catch (e) { sawBusy = false; }
    check('busy: student sees a busy/retrying message', sawBusy);
    await page.waitForSelector('#screen-pre-done.active', { timeout: SAVE_TIMEOUT });
    const elapsed = Date.now() - started;
    const recs = recordsFor(id);
    check('busy x2: three POSTs (2 busy + 1 success)', recs.length === 3, recs.map(r => r.json && r.json.status));
    check('busy: every retry body is byte-identical', recs.every(r => r.body === recs[0].body));
    check('busy: backoff waited ~1 s then ~2 s', elapsed >= 2800, elapsed);
    checkBody('pre 17A', recs[0].body, {
      ...inst, stage: 'pre', code: '17A', order: 'AB', form: 'A', background: '', answers: planAnswers(itemIds, plan)
    });
    check('pre 17A: exactly one row', (await rowCount(id, 'pre')) === 1);
  });

  await scenario('D busy x4 -> retries exhausted -> Save not confirmed -> Try again', async () => {
    await page.goto(`${base}/?type=post`);
    await startStage('17a');
    const itemIds = inst.pairs.map(pair => `${pair}-B`); // 17A -> AB, post uses form B
    const plan = itemIds.map(() => 'B');
    await answerAll(itemIds, inst.items, plan);
    await inject('busy', 4);
    await page.click('#btn-finish');
    await page.waitForFunction(() => (document.getElementById('save-title') || {}).textContent === 'Save not confirmed', null, { timeout: SAVE_TIMEOUT });
    const id = JSON.parse((await storage())['fa2601_v2_draft_post']).submission_id;
    submissions.post_17A = id;
    check('busy x4: four POSTs then stop (1 + 3 retries)', recordsFor(id).length === 4, recordsFor(id).length);
    await sleep(1500);
    check('busy x4: no further automatic retry', recordsFor(id).length === 4);
    await noStatusButtonYet('post busy exhausted');
    await inject('none', 0);
    await page.click('#btn-retry');
    await page.waitForSelector('#screen-post-done.active', { timeout: SAVE_TIMEOUT });
    check('busy x4: Try again saved', ((await page.textContent('#btn-submit')) || '').trim() === 'Submitted!');
    check('busy x4: all bodies identical', recordsFor(id).every(r => r.body === recordsFor(id)[0].body));
    check('post 17A: exactly one row', (await rowCount(id, 'post')) === 1);
  });

  await scenario('E no leave-study control on any screen', async () => {
    // Removed (Cui 2026-10-13, Q 2026-10-19): students took it for the next step.
    // Students can still stop at any time by closing the page, as the assent says.
    await freshSession('/?type=pre');
    const noLeave = async where => check(`no leave control: ${where}`,
      (await page.locator('#btn-leave-study').count()) === 0
      && !((await page.textContent('body')) || '').includes('Leave Research Study'));
    await noLeave('assent');
    await agree();
    await startStage('10A');
    await noLeave('question');
    const n = inst.pairs.length;
    for (let i = 0; i < n; i++) await page.click('#btn-skip');
    await page.waitForSelector('#screen-review.active');
    await noLeave('review');
    await page.click('#btn-finish');
    await page.waitForSelector('#screen-pre-done.active', { timeout: SAVE_TIMEOUT });
    await noLeave('pre done');
  });

  // H and I stub /exec inside the browser (page.route), so nothing reaches any server.
  await scenario('H network failure -> Save not confirmed -> Try again resends the identical body', async () => {
    await freshSession('/?type=pre');
    await agree();
    await startStage('33C');
    for (let i = 0; i < inst.pairs.length; i++) await page.click('#btn-skip');
    await page.waitForSelector('#screen-review.active');
    const id = JSON.parse((await storage())['fa2601_v2_draft_pre']).submission_id;
    submissions.pre_33C = id;
    const abortAll = route => route.abort('connectionreset');
    await page.route('**/exec', abortAll);
    try {
      await page.click('#btn-finish');
      await page.waitForFunction(() => (document.getElementById('save-title') || {}).textContent === 'Save not confirmed', null, { timeout: SAVE_TIMEOUT });
      check('network failure: Save not confirmed with Try again', await page.isVisible('#btn-retry'));
      check('network failure: not marked saved', (await savedFlag()) === null);
    } finally {
      await page.unroute('**/exec', abortAll);
    }
    await page.click('#btn-retry');
    await page.waitForSelector('#screen-pre-done.active', { timeout: SAVE_TIMEOUT });
    const recs = recordsFor(id);
    check('network failure: retry body is byte-identical', recs.length === 2 && recs[0].body === recs[1].body, recs.length);
    check('pre 33C: exactly one row', (await rowCount(id, 'pre')) === 1);
  });

  await scenario('I response-status mapping (stubbed in the browser)', async () => {
    await freshSession('/?type=post');
    await agree();
    await startStage('44D');
    for (let i = 0; i < inst.pairs.length; i++) await page.click('#btn-skip');
    await page.waitForSelector('#screen-review.active');
    const id = JSON.parse((await storage())['fa2601_v2_draft_post']).submission_id;
    submissions.post_44D_stubbed = id;
    let reply = null;
    const stub = route => route.fulfill(reply);
    const json = obj => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
    const title = async () => ((await page.textContent('#save-title')) || '').trim();
    const message = async () => ((await page.textContent('#save-message')) || '').trim();
    const settle = async () => {
      await page.waitForFunction(() => !/^Saving/.test((document.getElementById('save-title') || {}).textContent || '')
        || document.body.dataset.fa2601Saved, null, { timeout: SAVE_TIMEOUT });
    };
    const resend = async () => {
      if (!(await page.isVisible('#btn-retry'))) {
        await page.reload(); // a frozen, unconfirmed draft resumes with Try again
        await page.waitForSelector('#btn-retry:not([hidden])', { timeout: 10000 });
      }
      await page.click('#btn-retry');
      await settle();
    };
    await page.route('**/exec', stub);
    try {
      reply = { status: 500, contentType: 'text/plain', body: 'server error' };
      await page.click('#btn-finish');
      await settle();
      check('HTTP 500 -> Save not confirmed + Try again', (await title()) === 'Save not confirmed' && await page.isVisible('#btn-retry'));

      reply = { status: 200, contentType: 'application/json', body: 'not json' };
      await resend();
      check('invalid JSON -> Save not confirmed + Try again', (await title()) === 'Save not confirmed' && await page.isVisible('#btn-retry'));

      reply = json({ status: 'error', code: 'internal', message: 'Server error.' });
      await resend();
      check('error/internal -> Save not confirmed + Try again (outcome unknown, resend is safe)',
        (await title()) === 'Save not confirmed' && await page.isVisible('#btn-retry'));

      reply = json({ status: 'conflict' });
      const beforeConflict = recordsFor(id).length;
      await resend();
      await sleep(1500);
      check('conflict -> tell the presenter, no Try again, no auto-retry',
        (await message()).includes('Please tell the presenter') && await page.isHidden('#btn-retry')
          && recordsFor(id).length === beforeConflict + 1, await message());

      reply = json({ status: 'closed' });
      await resend();
      check('closed -> contract wording, no Try again',
        (await message()) === 'This version of the test is closed. Please tell the presenter.' && await page.isHidden('#btn-retry'));

      reply = json({ status: 'error', code: 'destination', message: 'blocked' });
      await resend();
      check('error -> tell the presenter with its code, no Try again',
        (await message()).includes('Please tell the presenter') && (await message()).includes('destination') && await page.isHidden('#btn-retry'));

      reply = json({ status: 'not_assented' });
      await resend();
      check('not_assented -> tell the presenter, not saved', (await message()).includes('Please tell the presenter') && (await savedFlag()) === null);

      reply = json({ status: 'success', receipt: 'not-the-submission-id', duplicate: false });
      await resend();
      check('success with a wrong receipt is not accepted', (await savedFlag()) === null && (await btnSubmitCount()) === 0, await message());
      await noScoreText('status mapping');

      reply = json({ status: 'success', receipt: id, duplicate: true });
      await resend();
      await page.waitForSelector('#screen-post-done.active', { timeout: 5000 });
      check('success with matching receipt -> post-done + Submitted!', ((await page.textContent('#btn-submit')) || '').trim() === 'Submitted!');
    } finally {
      await page.unroute('**/exec', stub);
    }
    const recs = recordsFor(id);
    check('every attempt (across reloads) sent the identical frozen body', recs.length === 9 && recs.every(r => r.body === recs[0].body), recs.length);
    check('stubbed submission never reached the server', (await rowCount(id, 'post')) === 0);
  });

  await scenario('J drafts from another instrument or destination are cleared, never sent', async () => {
    await freshSession('/?type=pre');
    await agree();
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    const current = await page.evaluate(() => ({
      instrument_version: window.FA2601_ITEMS.instrument_version,
      bank_sha256: window.FA2601_ITEMS.bank_sha256,
      selection: window.FA2601_CONFIG.selection,
      mode: window.FA2601_CONFIG.mode,
      endpoint: window.FA2601_CONFIG.endpoints.local
    }));
    const makeDraft = (stage, identity, frozen) => {
      const id = 'aaaaaaaa-bbbb-4ccc-8ddd-' + (stage === 'pre' ? '111111111111' : '222222222222');
      return JSON.stringify({ identity, submission_id: id, client_started_at: '2026-10-18T12:00:00.000Z',
        code: '57R', background: '', cursor: 0, answers: {},
        frozen: frozen ? JSON.stringify({ submission_id: id, stage }) : null });
    };
    // (a) Same structure, but another bank version: cleared with a notice.
    await page.evaluate(d => sessionStorage.setItem('fa2601_v2_draft_pre', d),
      makeDraft('pre', { ...current, bank_sha256: 'f'.repeat(64) }, false));
    await page.goto(`${base}/?type=pre`);
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    check('other-bank draft: cleared', !('fa2601_v2_draft_pre' in (await storage())));
    check('other-bank draft: notice shown', await page.isVisible('#draft-notice')
      && /different version/.test((await page.textContent('#draft-notice')) || ''));
    // (b) A frozen test-mode draft aimed at another endpoint: cleared, and nothing is sent.
    const before = execRecords.length;
    await page.evaluate(d => sessionStorage.setItem('fa2601_v2_draft_post', d),
      makeDraft('post', { ...current, mode: 'test', endpoint: 'https://script.google.com/macros/s/TESTDEPLOYMENT/exec' }, true));
    await page.goto(`${base}/?type=post`);
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    await sleep(1000);
    check('test-mode frozen draft: cleared', !('fa2601_v2_draft_post' in (await storage())));
    check('test-mode frozen draft: nothing sent', execRecords.length === before, execRecords.length - before);
    check('test-mode frozen draft: no Try again offered', (await activeScreen()) === 'screen-welcome');
    // (d) A draft from the other selection (B8 answers, cursor past six) on this C6 page: cleared WITH the notice.
    const otherSelection = current.selection === 'C6' ? 'B8' : 'C6';
    await page.evaluate(d => sessionStorage.setItem('fa2601_v2_draft_pre', d),
      JSON.stringify({ identity: { ...current, selection: otherSelection }, submission_id: 'aaaaaaaa-bbbb-4ccc-8ddd-333333333333',
        client_started_at: '2026-10-18T12:00:00.000Z', code: '57R', background: '', cursor: 8, answers: { 'J3-B': 'A' }, frozen: null }));
    await page.goto(`${base}/?type=pre`);
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    check('other-selection draft: cleared', !('fa2601_v2_draft_pre' in (await storage())));
    check('other-selection draft: notice shown', await page.isVisible('#draft-notice')
      && /different version/.test((await page.textContent('#draft-notice')) || ''));
    // (c) A draft with no identity at all (older build): cleared.
    await page.evaluate(d => sessionStorage.setItem('fa2601_v2_draft_pre', d), makeDraft('pre', undefined, false));
    await page.goto(`${base}/?type=pre`);
    await page.waitForSelector('#screen-welcome.active', { timeout: 10000 });
    check('identity-free draft: cleared', !('fa2601_v2_draft_pre' in (await storage())));
  });

  await scenario('G page source has no score/answer strings', async () => {
    const res = await page.request.get(`${base}/index.html`);
    const html = await res.text();
    const hits = ['Likert', 'likert_confidence', 'open_response', 'total_score', 'Best answer', 'Correct!', 'localStorage']
      .filter(token => html.includes(token));
    check('index.html has no score/answer/v1 strings', hits.length === 0 && !/score/i.test(html), hits);
    const items = await (await page.request.get(`${base}/items-v2.js?v=${inst ? inst.instrument_version : ''}`)).text();
    check('items-v2.js carries no answer keys', !/"keys"\s*:/.test(items));
  });

  try { await inject('none', 0); } catch (e) { errors.push({ scenario: 'cleanup', error: String(e) }); }

  const failures = checks.filter(c => !c.pass);
  return {
    ok: failures.length === 0 && errors.length === 0,
    passed: checks.length - failures.length,
    failed: failures.length,
    failures,
    errors,
    submissions,
    rows_shape: rowsShape,
    checks
  };
})
