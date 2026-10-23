# Student assent revision: direct use of free ChatGPT

Status: local revision for Q's review; not published. `FA2601-Assent-2026-10-22` identifies this wording, not an IRB approval. Q requested the student assessment form; the parental Google Form and its URL are unchanged.

The revision replaces the named two courses and Dr. Qu's demonstration with choosing one of five courses, AI-generated narration, and students using free ChatGPT themselves. It explains possible account sign-in, age and parent-permission requirements, prompt privacy, and incorrect or upsetting responses. A paid plan, payment information, software installation, or personal API key is not required for these ChatGPT activities.

## Review before publication

- Q must reconcile this procedure with the parental permission wording, which still describes a demonstration using Dr. Qu's account and no student AI account/login. This patch does not change that Form or claim that prior parental permission covers the new procedure.
- The existing IRB record reports Q's approval confirmation for the bundled modification. This revision does not independently establish approval of students' direct use of personal ChatGPT accounts. Q should confirm coverage of this specific procedure and the final wording before release.
- The previous 2026-08-21 text is preserved in `tests/fixtures/fa2601_assent_authority.txt` and Git history. The new dated fixture is a regression baseline, not an approval document. `FA2601_ASSENT_DOCX` still checks only the historical fixture against the historical Word file.
- This focused revision leaves the existing study-code range and survey/test times unchanged. They still say 0–100 plus a letter and about five minutes; the study's later checklist plan uses 10–99, three-minute surveys, and ten-minute tests. Resolve those existing differences before using the materials together.

## Coordinated release

The client and Apps Script strictly require the same assent version. Pushing or merging the website alone will not update the Apps Script deployment and will cause submissions to be rejected.

1. After Q approves publication, pause collection between sessions. Do not cut over while a student is completing a pre/post pair.
2. Verify the matching frontend and backend with synthetic data in a separate local/test destination. Never submit test records to the production response Sheet.
3. Deploy the revised `apps-script.js` to the existing production Apps Script deployment and publish the matching website. Keep collection paused until both are confirmed. Preserve the production endpoint and script properties; do not recreate or edit response data.
4. Have students close existing assessment tabs and reopen the page. The new version requires fresh assent; old in-progress or frozen drafts are cleared with a notice and cannot be retried under the new version. Previously confirmed submissions remain unchanged.
5. Record both deployment versions and the cutover time in the fidelity log before resuming collection. If rollback is necessary, pause collection and restore the matching client/backend pair; do not relabel previously recorded assent.

## Verification

Run `node --test tests/apps_script_v2.test.mjs tests/assent_version.test.mjs` and `python3 tests/verify_assent_flow.py`. Browser scenarios remain in `tests/e2e/v2_flow.playwright.js`; use the local synthetic server and a temporary local config, then restore production config before publishing.

## Provider references

Checked 2026-10-22: [ChatGPT access and possible login](https://help.openai.com/en/articles/9125172-the-chatgpt-home-page), [age and account requirements](https://openai.com/policies/terms-of-use/), and [OpenAI privacy policy](https://openai.com/policies/privacy-policy/). These describe provider requirements; they do not establish study approval or parental permission.
