# FA2601 assessment v2: contract between the app and the Apps Script

Status: draft on branch `fa2601-v2`. **Not deployed.** Nothing here goes live before the FA2601 modification is approved and Q approves the cutover.

## Items

- `tools/build_items.py <bank.json>` generates two things:
  - `items-v2.js` for the browser. It sets `window.FA2601_ITEMS`, holds **no keys**, and contains:
    - `instrument_version`;
    - `bank_sha256` (sha256 of the bank file's bytes);
    - `selections`: `{ "C6": ["J1","G1","C1","P2","C3","G2"], "B8": ["J1","G1","C1","P2","J3","G2","C3","P3"] }` (pair IDs, in presentation order);
    - `items` for each member of each selected pair: `{ "J1-A": { "stem": "…", "options": ["…","…","…","…"] }, … }`.
  - The block between `// BEGIN GENERATED MANIFEST` and `// END GENERATED MANIFEST` in `apps-script.js`. It sets `var MANIFEST = { instrument_version, bank_sha256, selections, keys: { "J1-A": "B", … } }`.
- Option letters are positions A–D in bank order. Option order is fixed (not shuffled).
- A form's item IDs are `<pair>-<form>` for each pair in the selection, in selection order.

## Form order from the Private Code (identical in the app and the script)

```js
function fa2601Order(code) {            // code already normalized: trim().toUpperCase()
  var h = 0x811c9dc5 >>> 0;
  for (var i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return ((h >>> 0) & 1) === 0 ? 'AB' : 'BA';
}
```

- The pre-test uses `order[0]` as its form and the post-test `order[1]`.
- Test vectors: `57R→BA`, `7A→BA`, `100Z→BA`, `0A→AB`.
- Over all 2,626 valid codes, 49.2% get AB.
- Stated limit: balance over all possible codes is not balance within a cohort. A student could pick a code to get a particular order.

## Request: POST, body is `text/plain` JSON

| Field | Rule |
|---|---|
| `schema` | `"fa2601-v2"` |
| `instrument_version`, `bank_sha256` | Must equal the server MANIFEST |
| `selection` | `"C6"` or `"B8"`. Must be in the server's active selection set (Script Property `ACTIVE_SELECTIONS`, comma-separated; production holds exactly one) |
| `submission_id` | A lower-case UUID v4, created when the stage starts. Retries reuse it and send the **identical** frozen body. |
| `stage` | `"pre"` or `"post"` |
| `participant_id` | Matches `^([0-9]\|[1-9][0-9]\|100)[A-Z]$` after normalization |
| `order`, `form` | Must equal `fa2601Order(code)` and `order[stage==='pre'?0:1]` |
| `assent`, `assent_version` | `"yes"` and `"FA2601-Assent-2026-08-21"` |
| `coding_background` | Pre: one of `""` (skipped), `none`, `beginner`, `intermediate`, `advanced`, `prefer_not`. Post: `""` |
| `answers` | An object whose keys are a subset of the form's item IDs. Each value is `"A"`–`"D"` (answered) or `null` (skipped). A missing key means not reached. No extra keys. |
| `client_started_at`, `client_submitted_at` | ISO-8601 UTC strings, e.g. `2026-11-07T14:03:00.000Z`. Stored as text, never used for ordering. |

Any other field is rejected.

## Server order of operations

No spreadsheet is touched before step 7.

1. Parse the JSON. If that fails → `error`/`bad_json`.
2. Assent. Anything other than yes → `not_assented`.
3. No `schema` field, i.e. a v1 payload → `closed`.
4. `schema` and `assent_version` check.
5. `stage`.
6. `participant_id`.
7. Every remaining field validated against MANIFEST, including order and form.
8. `SpreadsheetApp.getActiveSpreadsheet()`, then the destination check: sha256(`getId()`) must equal `ALLOWED_SHEET_SHA256[ENV]`. `ENV` is a Script Property (`test` or `prod`); the allowlist of hashes is hard-coded, so the repo never contains a Sheet ID. A missing or mismatched value → `error`/`destination` (fail closed).
9. `LockService.getScriptLock().tryLock(10000)`. If that fails → `busy`. Release in `finally`.
10. Idempotency. Look up `submission_id` in both v2 tabs.
    - Found with the same `fingerprint` (sha256 of the canonical JSON of the body, keys sorted) → `success` with `duplicate:true` and the original receipt.
    - Found with a different fingerprint → `conflict`. Nothing is written.
11. Score on the server from `MANIFEST.keys`.
12. Find or create the tab `Pre-Test v2` or `Post-Test v2`.
    - A new tab gets the header.
    - An existing tab whose row 1 differs from the header → `error`/`schema_mismatch`, with no write.
    - Append one row. The target range is formatted `'@'` (plain text) before `setValues`.
13. `SpreadsheetApp.flush()`, release the lock, return `success`.

The script **never** calls the legacy header, Paired or Rubric code, and never reads or writes the legacy tabs.

## Row columns (same header for both tabs)

`submission_id, fingerprint, receipt, server_received_at, server_date, client_started_at, client_submitted_at, schema, instrument_version, bank_sha256, selection, stage, participant_id, order, form, assent, assent_version, coding_background, n_items, n_answered, n_skipped, n_not_reached, n_correct, dup_code_same_day_stage`, followed by, for each of the 8 candidate pairs in fixed order J1 J3 C1 C3 P2 P3 G1 G2: `<pair>_item, <pair>_choice, <pair>_score, <pair>_status`.

- `server_date` is in `America/New_York`.
- `receipt` = `submission_id`.
- For a pair not in the selection: `_item` = `""` and `_status` = `not_in_form`.
- `_status` is one of `answered`, `skipped`, `not_reached`, `not_in_form`. `_score` is `1`, `0`, or `""` when there is no answer.
- `dup_code_same_day_stage` counts earlier rows in the same tab with the same `participant_id` and `server_date`. It is a flag only; nothing pairs automatically.

## Responses (JSON)

| `status` | Meaning | App behavior |
|---|---|---|
| `success` | Stored, or a duplicate of a stored body. Includes `receipt` and `duplicate` | Show the done screen |
| `busy` | Lock timeout | Retry automatically, at most 3 times (1, 2, 4 s), then show "Save not confirmed — Try again" |
| `conflict` | Same ID, different body | "Please tell the presenter." No automatic retry. |
| `closed` | v1 payload | "This version of the test is closed. Please tell the presenter." |
| `not_assented` | — | Nothing is stored |
| `error` | Includes a `code` and a short `message` | "Please tell the presenter." No retry. **Exception:** `code:"internal"` (the script's catch-all, which can fire after the row was written) is treated like a network failure: "Save not confirmed — Try again", manual only. A retry is safe because the server deduplicates by `submission_id`. |

`doGet` returns `{status:"ok", schema:"fa2601-v2"}` and nothing else.

## Checklist compatibility (Cui's checklist embeds the app in a same-origin iframe)

- Decline: `#non-assent-info.active`, unchanged.
- Pre saved: `#screen-pre-done.active`, set **only** after a confirmed `success`.
- Post saved: a `#btn-submit` element whose text is `Submitted!`, present **only** on the post-done screen after a confirmed `success`.
- New: `document.body.dataset.fa2601Saved = 'pre' | 'post'`.
- The assent flag in sessionStorage, `fa2601_assent_<version>`, is unchanged.
