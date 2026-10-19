#!/usr/bin/env python3
"""Static verification for the FA2601 electronic assent and submission flow."""

from __future__ import annotations

import html
import json
from html.parser import HTMLParser
import difflib
import os
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
# The legacy (v1) Apps Script keeps its header, row-schema and validation-order checks here.
# The v2 apps-script.js is covered by the node tests in tests/apps_script_v2.test.mjs.
APPS_SCRIPT_V1_PATH = ROOT / "legacy" / "apps-script-v1.js"
ITEMS_PATH = ROOT / "items-v2.js"
CONFIG_PATH = ROOT / "config-v2.js"
ASSENT_FIXTURE_PATH = ROOT / "tests" / "fixtures" / "fa2601_assent_authority.txt"
ASSENT_VERSION = "FA2601-Assent-2026-08-21"
# Request fields from docs/V2_CONTRACT.md; any other field is rejected by the server.
CONTRACT_PAYLOAD_FIELDS = {
    "schema",
    "instrument_version",
    "bank_sha256",
    "selection",
    "submission_id",
    "stage",
    "participant_id",
    "order",
    "form",
    "assent",
    "assent_version",
    "coding_background",
    "answers",
    "client_started_at",
    "client_submitted_at",
}
FORBIDDEN_INDEX_STRINGS = (
    "Likert",
    "likert_confidence",
    "open_response",
    "total_score",
    "Best answer",
    "Correct!",
)
ORDER_TEST_VECTORS = {"57R": "BA", "7A": "BA", "100Z": "BA", "0A": "AB"}
PROD_EXEC_URL = (
    "https://script.google.com/macros/s/"
    "AKfycbw0T56lxoJSiozLd3eW14gPWfg-9qJa6wexN49OrnWqwbXmLgW7vRlRVD11WxVBo678uQ/exec"
)
WORD_AUTHORITY_ENV = os.environ.get("FA2601_ASSENT_DOCX")
WORD_AUTHORITY_PATH = Path(
    WORD_AUTHORITY_ENV
    or "/Users/oreo/Dropbox/isec26-HS-IRB/FA2601 (Qu) Revised Response 8.21.2026.docx"
)


class VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def normalize(value: str) -> str:
    value = html.unescape(value).replace("•", " ")
    return re.sub(r"\s+", " ", value).strip()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract(pattern: str, source: str, label: str) -> str:
    match = re.search(pattern, source, flags=re.DOTALL)
    require(match is not None, f"Could not find {label}")
    return match.group(1)


def extract_function(name: str, source: str) -> str:
    match = re.search(
        rf"(?:async\s+)?function\s+{re.escape(name)}\s*\([^)]*\)\s*\{{",
        source,
    )
    require(match is not None, f"Could not find function {name}")
    body_start = match.end() - 1
    depth = 1
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False

    index = body_start + 1
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""

        if line_comment:
            if char == "\n":
                line_comment = False
        elif block_comment:
            if char == "*" and next_char == "/":
                block_comment = False
                index += 1
        elif quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char == "/" and next_char == "/":
            line_comment = True
            index += 1
        elif char == "/" and next_char == "*":
            block_comment = True
            index += 1
        elif char in ("'", '"', "`"):
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[body_start + 1 : index]
        index += 1

    raise AssertionError(f"Function {name} has no matching closing brace")


def check_javascript_syntax(index_source: str) -> None:
    inline_scripts = re.findall(
        r"<script(?:\s[^>]*)?>(.*?)</script>", index_source, flags=re.DOTALL
    )
    require(inline_scripts, "No inline JavaScript found in index.html")
    inline_source = "\n".join(script for script in inline_scripts if script.strip())

    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8") as temp:
        temp.write(inline_source)
        temp.flush()
        subprocess.run(["node", "--check", temp.name], check=True, capture_output=True)

    for path in (APPS_SCRIPT_V1_PATH, ITEMS_PATH, CONFIG_PATH):
        subprocess.run(["node", "--check", str(path)], check=True, capture_output=True)


def run_node(source: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".js", encoding="utf-8") as temp:
        temp.write(source)
        temp.flush()
        return subprocess.run(
            ["node", temp.name], check=True, capture_output=True, text=True
        ).stdout


def load_browser_global(path: Path, name: str) -> dict:
    """Evaluate a browser settings/data file in node and return window.<name>."""
    output = run_node(
        "global.window = {};\n"
        f"require({json.dumps(str(path))});\n"
        f"process.stdout.write(JSON.stringify(window.{name}));\n"
    )
    value = json.loads(output)
    require(isinstance(value, dict), f"{path.name} does not set window.{name}")
    return value


def strip_scripts(source: str) -> str:
    return re.sub(r"<script(?:\s[^>]*)?>.*?</script>", "", source, flags=re.DOTALL)


def main() -> None:
    index_source = INDEX_PATH.read_text(encoding="utf-8")
    apps_source = APPS_SCRIPT_V1_PATH.read_text(encoding="utf-8")

    assent_html = extract(
        r"const ASSENT_FORM_HTML = `(.*?)`;", index_source, "ASSENT_FORM_HTML"
    ).replace("${ASSENT_VERSION}", ASSENT_VERSION)
    parser = VisibleTextParser()
    parser.feed(assent_html)
    visible_assent = normalize("".join(parser.parts))

    expected_assent = normalize(ASSENT_FIXTURE_PATH.read_text(encoding="utf-8"))
    if expected_assent not in visible_assent:
        expected_words = expected_assent.split()
        visible_words = visible_assent.split()
        matcher = difflib.SequenceMatcher(a=expected_words, b=visible_words)
        difference = next(
            (item for item in matcher.get_opcodes() if item[0] != "equal"), None
        )
        if difference:
            _, expected_start, expected_end, visible_start, visible_end = difference
            expected_context = " ".join(
                expected_words[max(0, expected_start - 8) : expected_end + 8]
            )
            visible_context = " ".join(
                visible_words[max(0, visible_start - 8) : visible_end + 8]
            )
            raise AssertionError(
                "Accepted-view mismatch. "
                f"Expected near: {expected_context!r}; visible near: {visible_context!r}"
            )
        raise AssertionError(
            "ASSENT_FORM_HTML does not contain the complete normalized accepted-view assent"
        )

    checked_word_authority = False
    if WORD_AUTHORITY_PATH.exists():
        word_text = subprocess.run(
            ["textutil", "-convert", "txt", "-stdout", str(WORD_AUTHORITY_PATH)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        word_text = re.sub(
            r"\[In all sections below,.*?age\]\s*",
            "",
            word_text,
            count=1,
            flags=re.DOTALL,
        )
        normalized_word = normalize(word_text)
        require(
            expected_assent in normalized_word,
            "Committed assent fixture does not match the saved Word authority",
        )
        checked_word_authority = True
    elif WORD_AUTHORITY_ENV:
        raise AssertionError(
            f"FA2601_ASSENT_DOCX points to a missing Word authority: {WORD_AUTHORITY_PATH}"
        )
    require("IRB Protocol: FA2601" in visible_assent, "FA2601 protocol is not displayed")
    require(
        f"Assent Version: {ASSENT_VERSION}" in visible_assent,
        "Approved assent version is not displayed",
    )

    for forbidden in (
        "If you electronically sign below",
        "FA2562",
        "https://weihaoqu.github.io/learnai-course/",
    ):
        require(forbidden not in visible_assent, f"Participant assent displays {forbidden!r}")

    choose_type = extract_function("chooseType", index_source)
    require("assentGiven = null" not in choose_type, "chooseType resets assent")
    require("assentGiven === true" in choose_type, "chooseType lacks affirmative route")
    require("assentGiven === false" in choose_type, "chooseType lacks decline route")
    require("showConsent(type)" in choose_type, "chooseType lacks undecided route")

    require(
        "sessionStorage.getItem(ASSENT_SESSION_KEY)" in index_source
        and "sessionStorage.setItem(ASSENT_SESSION_KEY, 'yes')" in index_source,
        "Version-scoped session assent is not read and written",
    )
    require("localStorage" not in index_source, "Assessment source still uses localStorage")
    require(
        "sessionStorage.removeItem(ASSENT_SESSION_KEY)" in index_source,
        "Withdrawal does not clear the session assent",
    )
    require(
        "function withdrawFromStudy()" in index_source
        and "resetResearchFlow()" in extract_function("withdrawFromStudy", index_source),
        "Withdrawal does not clear the in-memory research flow",
    )
    require(
        "that submission may already have been recorded" in index_source,
        "Withdrawal notice overpromises control of an in-flight submission",
    )
    require(
        "leaveButton.hidden = assentGiven !== true" in extract_function(
            "syncLeaveButton", index_source
        ),
        "The leave-study control is not available from every assented screen",
    )
    require(
        ".btn[hidden]{display:none!important}" in index_source,
        "A hidden leave-study button can be exposed by the general .btn display rule",
    )

    payload = extract(r"const payload = \{(.*?)\n  \};", index_source, "payload")
    require("assent: 'yes'" in payload, "Payload lacks affirmative assent")
    require(
        "assent_version: ASSENT_VERSION" in payload,
        "Payload lacks the approved assent version",
    )
    require(not re.search(r"\bconsent\s*:", payload), "Payload still conflates consent and assent")
    require("schema: 'fa2601-v2'" in payload, "Payload does not declare the v2 schema")
    payload_fields = set(re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:", payload, flags=re.MULTILINE))
    require(
        payload_fields == CONTRACT_PAYLOAD_FIELDS,
        "Payload fields differ from the v2 contract: "
        f"extra={sorted(payload_fields - CONTRACT_PAYLOAD_FIELDS)} "
        f"missing={sorted(CONTRACT_PAYLOAD_FIELDS - payload_fields)}",
    )
    require(
        not re.search(r"score|total|likert|open_response|analysis|test_type", payload, flags=re.I),
        "Payload still carries client-side totals, scores, or v1 fields",
    )
    require("data.consent" not in apps_source, "Backend still treats consent as child assent")
    submit_data = extract_function("submitData", index_source)
    require("mode: 'no-cors'" not in submit_data, "Submission response is still opaque")
    require("await fetch" in submit_data, "Submission does not await the backend")
    require("await response.json()" in submit_data, "Submission does not read backend JSON")
    require(
        "result.status !== 'success'" in submit_data,
        "Submission does not reject backend error responses",
    )
    require(
        "method: 'POST'" in submit_data
        and "'Content-Type': 'text/plain;charset=utf-8'" in submit_data
        and "body: body" in submit_data,
        "Submission is not a text/plain POST of the frozen body",
    )
    require(
        "activeSubmissionController = submissionController" in submit_data,
        "Submission is not abortable by withdrawal",
    )
    require(
        "result.receipt !== submissionId" in submit_data,
        "Success is accepted without a matching receipt",
    )

    # Frozen once, retried byte-identical, statuses handled per contract.
    finish = extract_function("finishAndSave", index_source)
    require(
        "if(!draft.frozen)" in finish and "draft.frozen = buildFrozenBody()" in finish,
        "Finish does not freeze the payload exactly once",
    )
    require(
        finish.index("resolveEndpoint()") < finish.index("buildFrozenBody()"),
        "Finish freezes before checking that this page may save",
    )
    save_loop = extract_function("saveFrozenDraft", index_source)
    require(
        "const body = draft.frozen" in save_loop
        and "submitData(endpoint.url, body, submissionId)" in save_loop,
        "Retries do not resend the identical frozen body",
    )
    require(
        save_loop.count("generation !== flowGeneration || assentGiven !== true") >= 3,
        "A late response can act after withdrawal or reset",
    )
    require(
        "const BUSY_RETRY_DELAYS_MS = [1000, 2000, 4000];" in index_source,
        "Busy retries do not follow the 1, 2, 4 second schedule",
    )
    outcome = extract_function("applySaveOutcome", index_source)
    require(
        "outcome.kind === 'busy' || outcome.kind === 'unconfirmed'" in outcome
        and "showSaveState('unconfirmed')" in outcome
        and "showSaveState('closed')" in outcome
        and "showSaveState('presenter'" in outcome,
        "Save outcomes are not mapped to the contract's app behavior",
    )
    require(
        "const UNCONFIRMED_ERROR_CODES = ['internal'];" in index_source
        and "outcome.kind === 'error' && UNCONFIRMED_ERROR_CODES.includes(outcome.code)" in outcome,
        "error/internal (outcome unknown, safe to resend) does not offer Try again",
    )
    require("Save not confirmed" in index_source, "Unconfirmed saves are not labelled")
    require(
        "This version of the test is closed. Please tell the presenter." in index_source,
        "Closed responses do not use the contract wording",
    )

    # Checklist markers appear only after a confirmed success.
    mark_saved = extract_function("markSaved", index_source)
    require(
        "showScreen('screen-pre-done')" in mark_saved
        and "submitted.id = 'btn-submit'" in mark_saved
        and "submitted.textContent = 'Submitted!'" in mark_saved
        and "document.body.dataset.fa2601Saved = stage" in mark_saved,
        "Saved screens do not expose the checklist markers",
    )
    require(
        index_source.count("btn-submit") == 1 and index_source.count("Submitted!") == 1,
        "#btn-submit / Submitted! appears outside the confirmed-success path",
    )
    require(
        index_source.count("showScreen('screen-pre-done')") == 1,
        "The pre-test done screen can be shown outside the confirmed-success path",
    )
    require(
        "markSaved(stage)" in outcome and "outcome.kind === 'success'" in outcome,
        "markSaved is not gated on a success outcome",
    )
    require('id="screen-pre-done"' in index_source, "#screen-pre-done is missing")

    # Drafts: version-free per-stage keys, cleared by withdrawal/reset.
    require("const DRAFT_KEY_PREFIX = 'fa2601_v2_draft_';" in index_source, "Draft key changed")
    reset_flow = extract_function("resetResearchFlow", index_source)
    require(
        "flowGeneration++" in reset_flow and "STAGES.forEach(removeDraft)" in reset_flow,
        "Withdrawal/reset does not delete both drafts and invalidate in-flight saves",
    )
    require(
        "crypto.randomUUID()" in index_source,
        "submission_id is not a browser-generated UUID",
    )

    # No scores, keys, or v1 analysis anywhere in the app.
    for forbidden in FORBIDDEN_INDEX_STRINGS:
        require(forbidden not in index_source, f"index.html still contains {forbidden!r}")
    require(
        not re.search(r"score", index_source, flags=re.I),
        "index.html still mentions a score",
    )
    for forbidden in ("SCENARIOS", "CAT_INSIGHTS", "generateAnalysis", "LEVELS", "images/scenarios"):
        require(forbidden not in index_source, f"index.html still contains v1 {forbidden!r}")

    # Generated items and settings.
    items = load_browser_global(ITEMS_PATH, "FA2601_ITEMS")
    require("keys" not in items, "items-v2.js exposes answer keys to the browser")
    require(
        "keys" not in ITEMS_PATH.read_text(encoding="utf-8").split("\n", 1)[1],
        "items-v2.js mentions answer keys",
    )
    version = items.get("instrument_version")
    require(isinstance(version, str) and version, "items-v2.js has no instrument_version")
    config = load_browser_global(CONFIG_PATH, "FA2601_CONFIG")
    # main publishes 'prod'; 'local' is for local test runs. 'test' is never committed.
    require(config.get("mode") in ("local", "prod"), "Committed config-v2.js is not in local or prod mode")
    require(config.get("selection") in items.get("selections", {}), "Configured selection is missing")
    endpoints = config.get("endpoints", {})
    require(
        endpoints.get("local") == "/exec"
        and endpoints.get("test") == "REPLACE_WITH_TEST_EXEC_URL"
        and endpoints.get("prod") == PROD_EXEC_URL,
        "config-v2.js endpoints differ from the agreed values",
    )
    script_tags = re.findall(r"<script(?:\s[^>]*)?>", index_source)
    sha12 = str(items.get("bank_sha256", ""))[:12]
    items_tag = f'<script src="items-v2.js?v={version}&amp;h={sha12}">'
    config_tag = f'<script src="config-v2.js?v={version}&amp;h={sha12}">'
    require(
        script_tags[:3] == [items_tag, config_tag, "<script>"],
        f"items-v2.js and config-v2.js must load first with ?v={version}: {script_tags[:3]}",
    )
    require(
        "const ITEMS = window.FA2601_ITEMS;" in index_source
        and "if(!INSTRUMENT.ready) return;" in index_source,
        "The app does not refuse to start without its items",
    )

    # Form order matches the contract vectors.
    order_body = extract_function("fa2601Order", index_source)
    order_output = run_node(
        f"function fa2601Order(code) {{{order_body}}}\n"
        f"const vectors = {json.dumps(ORDER_TEST_VECTORS)};\n"
        "const out = {};\n"
        "for (const code of Object.keys(vectors)) out[code] = fa2601Order(code);\n"
        "process.stdout.write(JSON.stringify(out));\n"
    )
    require(
        json.loads(order_output) == ORDER_TEST_VECTORS,
        f"fa2601Order disagrees with the contract vectors: {order_output}",
    )

    # Submission guard: local only on loopback, test never prod, prod only on Pages.
    endpoint_guard = extract_function("resolveEndpoint", index_source)
    for token in (
        "CONFIG.mode === 'local'",
        "LOCAL_HOSTNAMES.includes(host)",
        "CONFIG.mode === 'test'",
        "url === TEST_ENDPOINT_PLACEHOLDER",
        "url === PROD_EXEC_URL",
        "CONFIG.mode === 'prod'",
        "host !== PROD_HOSTNAME",
    ):
        require(token in endpoint_guard, f"Submission guard lacks {token!r}")
    require(
        "TEST — synthetic data only" in index_source,
        "Local/test builds do not show the synthetic-data banner",
    )
    require(
        "btn-submit" not in strip_scripts(index_source),
        "#btn-submit exists in the static page before any save",
    )

    require(
        apps_source.count("'assent', 'assent_version'") == 2,
        "Pre/Post headers do not append assent_version after assent",
    )
    require(
        apps_source.count("assent, assentVersion") == 2,
        "Pre/Post rows do not append the validated assent version",
    )
    ensure_headers = extract_function("ensureHeaderRow", apps_source)
    require(
        "headers.length" in ensure_headers and "setValues([headers])" in ensure_headers,
        "Existing sheet headers are not extended to include assent_version",
    )

    order_tokens = [
        "var assent = normalizeAssent",
        "if (assent !== 'yes')",
        "var assentVersion =",
        "if (assentVersion !== ASSENT_VERSION)",
        "if (data.test_type !== 'pre'",
        "var participantId = normalizeParticipantId",
        "SpreadsheetApp.getActiveSpreadsheet()",
    ]
    positions = [apps_source.index(token) for token in order_tokens]
    require(positions == sorted(positions), "Apps Script validation order is unsafe")

    save_draft = extract_function("saveDraft", index_source)
    load_draft = extract_function("loadDraft", index_source)
    save_frozen = extract_function("saveFrozenDraft", index_source)
    require("identity: draft.identity" in save_draft, "Drafts do not record their instrument and destination")
    require("sameIdentity(saved.identity, draftIdentity())" in load_draft, "Drafts resume without an identity check")
    require("sameIdentity(draft.identity, draftIdentity())" in save_frozen, "Frozen drafts are resent without an identity check")
    same_identity = extract_function("sameIdentity", index_source)
    for field in ("instrument_version", "bank_sha256", "selection", "mode", "endpoint"):
        require(f"'{field}'" in same_identity, f"Draft identity does not compare {field}")
    check_javascript_syntax(index_source)
    if checked_word_authority:
        print("PASS: committed assent fixture matches the saved Word authority")
    else:
        print("SKIP: local Word authority unavailable; verified committed fixture instead")
    print("PASS: embedded canonical text matches the committed assent fixture")
    print("PASS: accepted-view assent text and identifiers")
    print("PASS: once-per-session assent routing and browser-storage limits")
    print("PASS: v2 payload fields, versioned affirmative assent, no consent or totals")
    print("PASS: withdrawal, frozen-body retries, and confirmed-submission safeguards")
    print("PASS: checklist markers only after confirmed success; no scores in the app")
    print("PASS: items/config load order, committed mode (local or prod), and form-order vectors")
    print("PASS: legacy v1 Apps Script validation order and row schemas")
    print("PASS: JavaScript syntax")


if __name__ == "__main__":
    main()
