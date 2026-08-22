#!/usr/bin/env python3
"""Static verification for the FA2601 electronic assent and submission flow."""

from __future__ import annotations

import html
from html.parser import HTMLParser
import difflib
import os
from pathlib import Path
import re
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / "index.html"
APPS_SCRIPT_PATH = ROOT / "apps-script.js"
ASSENT_FIXTURE_PATH = ROOT / "tests" / "fixtures" / "fa2601_assent_authority.txt"
ASSENT_VERSION = "FA2601-Assent-2026-08-21"
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

    subprocess.run(
        ["node", "--check", str(APPS_SCRIPT_PATH)], check=True, capture_output=True
    )


def main() -> None:
    index_source = INDEX_PATH.read_text(encoding="utf-8")
    apps_source = APPS_SCRIPT_PATH.read_text(encoding="utf-8")

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

    payload = extract(r"const payload = \{(.*?)\n  \};", index_source, "payload")
    require("assent: 'yes'" in payload, "Payload lacks affirmative assent")
    require(
        "assent_version: ASSENT_VERSION" in payload,
        "Payload lacks the approved assent version",
    )
    require(not re.search(r"\bconsent\s*:", payload), "Payload still conflates consent and assent")
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

    check_javascript_syntax(index_source)
    if checked_word_authority:
        print("PASS: committed assent fixture matches the saved Word authority")
    else:
        print("SKIP: local Word authority unavailable; verified committed fixture instead")
    print("PASS: embedded canonical text matches the committed assent fixture")
    print("PASS: accepted-view assent text and identifiers")
    print("PASS: once-per-session assent routing and browser-storage limits")
    print("PASS: versioned affirmative payload without redundant consent")
    print("PASS: withdrawal and confirmed-submission safeguards")
    print("PASS: Apps Script validation order and row schemas")
    print("PASS: JavaScript syntax")


if __name__ == "__main__":
    main()
