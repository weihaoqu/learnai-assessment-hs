// Execute the actual browser functions with synthetic session state, without a browser or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const CURRENT = 'FA2601-Assent-2026-10-22';
const PREVIOUS = 'FA2601-Assent-2026-08-21';
const declaration = source.match(/const ASSENT_VERSION = '[^']+';\nconst ASSENT_SESSION_KEY = [^\n]+;/)?.[0];
assert.ok(declaration, 'assent version and session namespace declarations exist');
function actualFunction(name) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `actual ${name} implementation exists`);
  return match[0];
}

function harness() {
  const stored = new Map();
  const calls = { validations: 0, submissions: 0, states: [] };
  const context = vm.createContext({
    sessionStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key),
    },
    ITEMS: { instrument_version: 'synthetic', bank_sha256: 'synthetic-hash' },
    CONFIG: { selection: 'B8', mode: 'local' },
    resolveEndpoint: () => ({ ok: true, url: '/exec' }),
    DRAFT_KEY_PREFIX: 'fa2601_v2_draft_',
    draftNotice: '', draft: null, assentGiven: true, saveInFlight: false,
    isValidDraft: () => { calls.validations++; return true; },
    showSaveState: (...args) => calls.states.push(args),
    submitData: () => { calls.submissions++; throw new Error('must not submit stale answers'); },
  });
  vm.runInContext(declaration + '\n' + [
    'hasSessionAssent', 'draftIdentity', 'sameIdentity', 'draftKey', 'removeDraft', 'loadDraft', 'saveFrozenDraft',
  ].map(actualFunction).join('\n'), context);
  return { context, stored, calls };
}

test('old assent does not authorize the revised wording; current assent survives reload', () => {
  const { context, stored } = harness();
  stored.set(`fa2601_assent_${PREVIOUS}`, 'yes');
  assert.equal(context.hasSessionAssent(), false);
  stored.set(`fa2601_assent_${CURRENT}`, 'yes');
  assert.equal(context.hasSessionAssent(), true);
  assert.equal(context.draftIdentity().assent_version, CURRENT);
});

test('current-version draft resumes; old or unversioned frozen drafts are cleared before validation', () => {
  const { context, stored, calls } = harness();
  const current = context.draftIdentity();
  stored.set('fa2601_v2_draft_pre', JSON.stringify({ identity: current }));
  assert.equal(context.loadDraft('pre').identity.assent_version, CURRENT);
  assert.equal(calls.validations, 1);
  for (const version of [PREVIOUS, undefined]) {
    stored.set('fa2601_v2_draft_pre', JSON.stringify({
      identity: { ...current, assent_version: version },
      frozen: JSON.stringify({ assent: 'yes', assent_version: PREVIOUS }),
    }));
    assert.equal(context.loadDraft('pre'), null);
    assert.equal(stored.has('fa2601_v2_draft_pre'), false);
    assert.match(context.draftNotice, /different version.*assent form/);
  }
  assert.equal(calls.validations, 1, 'stale drafts never reach current-answer validation');
  assert.equal(calls.submissions, 0);
});

test('retry refuses an already loaded old-version draft even after new assent', async () => {
  const { context, calls } = harness();
  context.draft = {
    identity: { ...context.draftIdentity(), assent_version: PREVIOUS },
    frozen: JSON.stringify({ assent: 'yes', assent_version: PREVIOUS }),
  };
  await context.saveFrozenDraft();
  assert.equal(calls.states[0][0], 'refused');
  assert.equal(calls.submissions, 0);
});
