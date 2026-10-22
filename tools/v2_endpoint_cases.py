#!/usr/bin/env python3
"""Synthetic cases against a real v2 Apps Script deployment (docs/V2_CONTRACT.md).

    python3 tools/v2_endpoint_cases.py run <exec_url> <out_dir> --synthetic-rows-ok
    (SELECTION below must match the deployment's ACTIVE_SELECTIONS.)
    python3 tools/v2_endpoint_cases.py check <out_dir> <pre.csv> <post.csv>

run   sends fixed synthetic submissions (codes 91Z-97Z) and the rejection cases,
      and writes results.json and expected.json to out_dir. Every write lands in
      the deployment's own Sheet, in the tabs Pre-Test v2 / Post-Test v2; the
      --synthetic-rows-ok flag says you know that. It refuses the live
      deployment named in config-v2.js (endpoints.prod).
check reads the two v2 tabs exported as CSV (File > Download > CSV, one per
      tab) and checks every row against the contract and the server MANIFEST,
      and each run row against what was sent. Rows from other sources (e.g. a
      browser run) get the contract checks and are listed.
"""
import csv
import hashlib
import json
import re
import sys
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
EXEC_URL = re.compile(r'^https://script\.google\.com/macros/s/([A-Za-z0-9_-]+)/exec$')
ASSENT_VERSION = 'FA2601-Assent-2026-10-22'
SELECTION = 'B8'  # must equal ACTIVE_SELECTIONS on the deployment
INACTIVE = 'C6'
SERVER_TZ = ZoneInfo('America/New_York')
UUID_V4 = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
CODE = re.compile(r'^([0-9]|[1-9][0-9]|100)[A-Z]$')
# A complete run: doGet, 7 rejections, 6 sequential cases, a burst of 5.
PLANNED_CASES = 19
EXPECTED_ROWS = {'pre': 8, 'post': 1}
PAIR_COLUMNS = ['J1', 'J3', 'C1', 'C3', 'P2', 'P3', 'G1', 'G2']
HEADER = [
    'submission_id', 'fingerprint', 'receipt', 'server_received_at', 'server_date',
    'client_started_at', 'client_submitted_at', 'schema', 'instrument_version',
    'bank_sha256', 'selection', 'stage', 'participant_id', 'order', 'form',
    'assent', 'assent_version', 'coding_background', 'n_items', 'n_answered',
    'n_skipped', 'n_not_reached', 'n_correct', 'dup_code_same_day_stage',
] + [f'{p}_{c}' for p in PAIR_COLUMNS for c in ('item', 'choice', 'score', 'status')]
BUSY_RETRY_DELAYS = [1, 2, 4]


def manifest():
    script = (ROOT / 'apps-script.js').read_text(encoding='utf-8')
    m = re.search(r'var MANIFEST = (\{.*?\});\n// END GENERATED MANIFEST', script, re.S)
    return json.loads(m.group(1))


def live_deployment_id():
    config = (ROOT / 'config-v2.js').read_text(encoding='utf-8')
    m = re.search(r"prod:\s*'https://script\.google\.com/macros/s/([A-Za-z0-9_-]+)/exec'", config)
    if not m:
        raise SystemExit('config-v2.js has no production endpoint to refuse; stopping.')
    return m.group(1)


def fa2601_order(code):
    # Same as fa2601Order in the app and the script.
    h = 0x811c9dc5
    for ch in code:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xffffffff
    h ^= h >> 16
    h = (h * 0x85ebca6b) & 0xffffffff
    h ^= h >> 13
    h = (h * 0xc2b2ae35) & 0xffffffff
    h ^= h >> 16
    return 'AB' if h & 1 == 0 else 'BA'


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.') + f'{dt.microsecond // 1000:03d}Z'


def fingerprint(body):
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def body_for(man, code, stage, answers_by_pair, background=''):
    """answers_by_pair: {pair: 'A'-'D' | None}; a pair left out is not reached."""
    order = fa2601_order(code)
    form = order[0 if stage == 'pre' else 1]
    now = datetime.now(timezone.utc)
    return {
        'schema': 'fa2601-v2',
        'instrument_version': man['instrument_version'],
        'bank_sha256': man['bank_sha256'],
        'selection': SELECTION,
        'submission_id': str(uuid.uuid4()),
        'stage': stage,
        'participant_id': code,
        'order': order,
        'form': form,
        'assent': 'yes',
        'assent_version': ASSENT_VERSION,
        'coding_background': background if stage == 'pre' else '',
        'answers': {f'{p}-{form}': v for p, v in answers_by_pair.items()},
        'client_started_at': iso(now - timedelta(minutes=4)),
        'client_submitted_at': iso(now),
    }


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST',
                                 headers={'Content-Type': 'text/plain;charset=utf-8'})
    return read_json(req)


def read_json(req):
    # Apps Script answers with a 302 to googleusercontent.com; urllib follows it as a GET.
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            text = res.read().decode('utf-8', 'replace')
    except Exception as err:  # network or HTTP error: record it, never retry blindly
        return {'_transport_error': f'{type(err).__name__}: {err}'}
    try:
        obj = json.loads(text)
    except ValueError:
        return {'_not_json': text[:300]}
    return obj if isinstance(obj, dict) else {'_not_object': text[:300]}


def post_like_app(url, body):
    """Retries only on busy, with the app's delays, sending the identical body."""
    res = post(url, body)
    for delay in BUSY_RETRY_DELAYS:
        if res.get('status') != 'busy':
            break
        time.sleep(delay)
        res = post(url, body)
    return res


def answers(man, code, stage, choices):
    """choices: per C6 pair, 'right', 'wrong', 'skip' or 'stop' (this and later: not reached)."""
    form = fa2601_order(code)[0 if stage == 'pre' else 1]
    out = {}
    for pair, how in zip(man['selections'][SELECTION], choices):
        if how == 'stop':
            break
        key = man['keys'][f'{pair}-{form}']
        out[pair] = None if how == 'skip' else key if how == 'right' else 'ABCD'[('ABCD'.index(key) + 1) % 4]
    return out


def run(url, out_dir):
    m = EXEC_URL.match(url)
    if not m:
        raise SystemExit('Expected https://script.google.com/macros/s/<id>/exec')
    if m.group(1) == live_deployment_id():
        raise SystemExit('Refused: that is the live deployment in config-v2.js. Use the trial deployment.')
    man = manifest()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    results, expected = [], []

    def case(name, body, want_status, want_code=None, writes=False, dup=None, retry=False):
        res = post_like_app(url, body) if retry else post(url, body)
        ok = res.get('status') == want_status and (want_code is None or res.get('code') == want_code)
        if ok and want_status == 'success':
            ok = res.get('receipt') == body['submission_id'] and res.get('duplicate') is (dup is True)
        results.append({'case': name, 'ok': ok, 'want': [want_status, want_code],
                        'got': res, 'submission_id': body.get('submission_id')})
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {json.dumps(res)}")
        if writes and ok:
            expected.append({'case': name, 'body': body, 'fingerprint': fingerprint(body)})
        return res

    g = read_json(urllib.request.Request(url, method='GET'))
    ok = g == {'status': 'ok', 'schema': 'fa2601-v2'}
    results.append({'case': 'doGet', 'ok': ok, 'got': g})
    print(f"{'PASS' if ok else 'FAIL'}  doGet: {json.dumps(g)}")
    if not ok:
        # Not a v2 deployment. Old code would store the v1 probe in the legacy tabs.
        (out_dir / 'results.json').write_text(json.dumps(results, indent=1), encoding='utf-8')
        raise SystemExit('Stopped before any POST: the deployment does not identify as fa2601-v2.')

    n = len(man['selections'][SELECTION])
    all_right = ['right'] * n
    # Rejections: none of these may write a row.
    b = body_for(man, '91Z', 'pre', answers(man, '91Z', 'pre', all_right), 'beginner')
    case('not assented', dict(b, assent='no', submission_id=str(uuid.uuid4())), 'not_assented')
    v1 = {'test_type': 'pre', 'participant_id': '91Z', 'assent': 'yes', 'assent_version': ASSENT_VERSION,
          'timestamp': b['client_submitted_at'], 'total_score': 0}
    case('v1 payload is closed', v1, 'closed')
    case('code 101A', dict(b, participant_id='101A', submission_id=str(uuid.uuid4())), 'error', 'bad_participant_id')
    case(f'{INACTIVE} not active', dict(b, selection=INACTIVE, submission_id=str(uuid.uuid4())), 'error', 'selection_inactive')
    wrong_form = 'B' if b['form'] == 'A' else 'A'
    case('form does not match code', dict(b, form=wrong_form, submission_id=str(uuid.uuid4())), 'error', 'bad_form')
    case('wrong bank hash', dict(b, bank_sha256='0' * 64, submission_id=str(uuid.uuid4())), 'error', 'manifest_mismatch')
    case('unknown field', dict(b, total_score=6, submission_id=str(uuid.uuid4())), 'error', 'unknown_field')

    # Writes.
    w1 = body_for(man, '91Z', 'pre', answers(man, '91Z', 'pre', (['right', 'wrong', 'right', 'right', 'wrong', 'right'] + ['right', 'wrong'])[:n]), 'beginner')
    case('pre 91Z, all answered', w1, 'success', writes=True, retry=True)
    case('pre 91Z resent, same body', w1, 'success', dup=True, retry=True)
    first = next(iter(w1['answers']))
    changed = dict(w1, answers=dict(w1['answers'], **{first: 'C' if w1['answers'][first] == 'D' else 'D'}))
    case('pre 91Z, same ID, different answers', changed, 'conflict', retry=True)
    w2 = body_for(man, '92Z', 'pre', answers(man, '92Z', 'pre', ['right', 'skip', 'wrong', 'right'] + ['stop'] * (n - 4)))
    case('pre 92Z, one skipped, the rest not reached', w2, 'success', writes=True, retry=True)
    w3 = body_for(man, '91Z', 'post', answers(man, '91Z', 'post', all_right))
    case('post 91Z, all answered', w3, 'success', writes=True, retry=True)
    w4 = body_for(man, '91Z', 'pre', answers(man, '91Z', 'pre', ['skip'] * n), 'prefer_not')
    case('pre 91Z again, new ID (duplicate-code flag)', w4, 'success', writes=True, retry=True)

    # Five different students at the same moment.
    def burst_case(name, body):
        try:
            case(name, body, 'success', writes=True, retry=True)
        except Exception as err:  # a dead thread must count as a failed case
            results.append({'case': name, 'ok': False, 'want': ['success', None],
                            'got': {'_exception': repr(err)}, 'submission_id': body['submission_id']})

    burst = [body_for(man, f'{n}Z', 'pre', answers(man, f'{n}Z', 'pre', all_right), 'none') for n in range(93, 98)]
    threads = [threading.Thread(target=burst_case, args=(f"burst pre {bb['participant_id']}", bb)) for bb in burst]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    (out_dir / 'results.json').write_text(json.dumps(results, indent=1), encoding='utf-8')
    (out_dir / 'expected.json').write_text(json.dumps(expected, indent=1), encoding='utf-8')
    failed = [r['case'] for r in results if not r['ok']]
    if len(results) != PLANNED_CASES:
        failed.append(f'{len(results)} results recorded, {PLANNED_CASES} planned')
    print(f"\n{len(results) - len(failed)}/{len(results)} cases passed; {len(expected)} rows expected "
          f"({sum(e['body']['stage'] == 'pre' for e in expected)} pre, {sum(e['body']['stage'] == 'post' for e in expected)} post).")
    if failed:
        raise SystemExit('FAILED: ' + '; '.join(failed))


def check(out_dir, pre_csv, post_csv):
    man = manifest()
    out_dir = Path(out_dir)
    results = json.loads((out_dir / 'results.json').read_text())
    expected_list = json.loads((out_dir / 'expected.json').read_text())
    expected = {e['body']['submission_id']: e for e in expected_list}
    # Only a complete, passing run can be checked against the Sheet.
    if len(results) != PLANNED_CASES or not all(r['ok'] for r in results):
        raise SystemExit('The run did not pass all planned cases; rerun it before checking rows.')
    per_stage = {s: sum(e['body']['stage'] == s for e in expected_list) for s in EXPECTED_ROWS}
    if len(expected) != len(expected_list) or per_stage != EXPECTED_ROWS \
            or len(expected_list) != sum(EXPECTED_ROWS.values()):
        raise SystemExit(f'expected.json does not match the plan: {len(expected_list)} rows {per_stage}, '
                         f'wanted {sum(EXPECTED_ROWS.values())} rows {EXPECTED_ROWS}.')
    rejected = {r['submission_id'] for r in results
                if r.get('submission_id') and r['submission_id'] not in expected}
    problems, seen, others = [], set(), []

    for stage, path in (('pre', pre_csv), ('post', post_csv)):
        with open(path, newline='', encoding='utf-8') as f:
            rows = list(csv.reader(f))
        if not rows or rows[0] != HEADER:
            problems.append(f'{stage}: header differs from the contract')
            continue
        earlier = []
        for n, values in enumerate(rows[1:], start=2):
            if len(values) != len(HEADER):
                problems.append(f'{stage} row {n}: {len(values)} cells, expected {len(HEADER)}')
                continue
            r = dict(zip(HEADER, values))
            where = f"{stage} row {n} ({r['participant_id']})"
            bad = lambda msg: problems.append(f'{where}: {msg}')
            sid = r['submission_id']
            if not UUID_V4.match(sid) or r['fingerprint'] == '' or not CODE.match(r['participant_id']):
                bad('submission_id, fingerprint or code is malformed')
            try:
                received = datetime.strptime(r['server_received_at'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
            except ValueError:
                bad(f"server_received_at {r['server_received_at']!r} is not an ISO UTC time")
            else:
                if iso(received) != r['server_received_at']:
                    bad(f"server_received_at {r['server_received_at']!r} is not in the server's format")
                if received.astimezone(SERVER_TZ).strftime('%Y-%m-%d') != r['server_date']:
                    bad(f"server_date {r['server_date']!r} is not the New York date of server_received_at")
            if sid in seen:
                bad('submission_id appears twice')
            seen.add(sid)
            if sid in rejected:
                bad('a rejected case was written')
            if r['stage'] != stage:
                bad('stage does not match the tab')
            if r['receipt'] != sid:
                bad('receipt is not the submission_id')
            for field, want in (('schema', 'fa2601-v2'), ('instrument_version', man['instrument_version']),
                                ('bank_sha256', man['bank_sha256']), ('selection', SELECTION),
                                ('assent', 'yes'), ('assent_version', ASSENT_VERSION)):
                if r[field] != want:
                    bad(f'{field} is {r[field]!r}, expected {want!r}')
            order = fa2601_order(r['participant_id'])
            if r['order'] != order or r['form'] != order[0 if stage == 'pre' else 1]:
                bad('order/form do not match the code')
            counts = {'answered': 0, 'skipped': 0, 'not_reached': 0}
            correct = 0
            for pair in PAIR_COLUMNS:
                item, choice, score, status = (r[f'{pair}_{c}'] for c in ('item', 'choice', 'score', 'status'))
                if pair not in man['selections'][SELECTION]:
                    if (item, choice, score, status) != ('', '', '', 'not_in_form'):
                        bad(f'{pair} should be not_in_form')
                    continue
                if item != f"{pair}-{r['form']}" or status not in counts:
                    bad(f'{pair} item/status wrong')
                    continue
                counts[status] += 1
                if status == 'answered':
                    want = '1' if choice == man['keys'][item] else '0'
                    if choice not in ('A', 'B', 'C', 'D') or score != want:
                        bad(f'{pair} scored {score!r}, expected {want!r}')
                    correct += score == '1'
                elif choice or score:
                    bad(f'{pair} {status} but has a choice or score')
            if [r['n_items'], r['n_answered'], r['n_skipped'], r['n_not_reached'], r['n_correct']] != \
                    [str(len(man['selections'][SELECTION])), str(counts['answered']), str(counts['skipped']),
                     str(counts['not_reached']), str(correct)]:
                bad('totals do not match the item cells')
            dup = sum(1 for e in earlier if e['participant_id'] == r['participant_id'] and e['server_date'] == r['server_date'])
            if r['dup_code_same_day_stage'] != str(dup):
                bad(f"duplicate-code flag is {r['dup_code_same_day_stage']}, expected {dup}")
            earlier.append(r)

            e = expected.get(sid)
            if e is None:
                others.append(f"{where}: form {r['form']}, answered {counts['answered']}, skipped {counts['skipped']}, "
                              f"not reached {counts['not_reached']}, correct {correct}")
                continue
            body = e['body']
            if r['fingerprint'] != e['fingerprint']:
                bad('fingerprint differs from the body sent')
            for field in ('participant_id', 'order', 'form', 'coding_background', 'client_started_at', 'client_submitted_at'):
                if r[field] != body[field]:
                    bad(f'{field} is {r[field]!r}, sent {body[field]!r}')
            for pair in man['selections'][SELECTION]:
                item = f"{pair}-{body['form']}"
                sent = body['answers'].get(item, 'missing')
                want = 'not_reached' if sent == 'missing' else 'skipped' if sent is None else 'answered'
                if r[f'{pair}_status'] != want or (want == 'answered' and r[f'{pair}_choice'] != sent):
                    bad(f'{pair} stored {r[pair + "_status"]}/{r[pair + "_choice"]!r}, sent {sent!r}')

    for sid, e in expected.items():
        if sid not in seen:
            problems.append(f"missing row: {e['case']}")
    print(f'{len(seen)} rows checked; {len(expected)} expected from the run; {len(others)} from elsewhere.')
    for line in others:
        print('  other: ' + line)
    for p in problems:
        print('PROBLEM ' + p)
    if problems:
        raise SystemExit(f'{len(problems)} problem(s)')
    print('PASS: every row matches the contract and the server keys; every run row matches what was sent.')


def main():
    args = sys.argv[1:]
    if len(args) == 4 and args[0] == 'run' and args[3] == '--synthetic-rows-ok':
        run(args[1], args[2])
    elif len(args) == 4 and args[0] == 'check':
        check(args[1], args[2], args[3])
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
