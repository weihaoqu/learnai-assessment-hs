// FA2601 assessment v2 settings (see docs/V2_CONTRACT.md). Loaded before the app script.
// mode 'local': saves only on 127.0.0.1/localhost, to the same-origin path endpoints.local.
// mode 'test':  saves to endpoints.test; refused while it is the placeholder or the prod URL.
// mode 'prod':  saves to endpoints.prod; refused unless the page is on weihaoqu.github.io.
// main publishes this file, so after the cutover (2026-10-19) it is committed in 'prod'.
// To run the local tests, set 'local' in your working copy and do not commit it.
window.FA2601_CONFIG = {
  mode: 'prod',
  selection: 'C6',
  endpoints: {
    local: '/exec',
    test: 'REPLACE_WITH_TEST_EXEC_URL',
    prod: 'https://script.google.com/macros/s/AKfycbw0T56lxoJSiozLd3eW14gPWfg-9qJa6wexN49OrnWqwbXmLgW7vRlRVD11WxVBo678uQ/exec'
  }
};
