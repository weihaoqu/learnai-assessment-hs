/**
 * LearnAI Assessment — Google Apps Script (v2)
 *
 * SETUP INSTRUCTIONS:
 * 1. Create a new Google Sheet (this will be your data store)
 * 2. Go to Extensions → Apps Script
 * 3. Paste this entire file into Code.gs (replace any existing code)
 * 4. Click "Deploy" → "New deployment"
 * 5. Select type: "Web app"
 * 6. Set "Execute as": "Me"
 * 7. Set "Who has access": "Anyone"
 * 8. Click "Deploy" and copy the URL
 * 9. Paste that URL into assessment-v2.html (replace YOUR_GOOGLE_SCRIPT_URL)
 *
 * SHEETS AUTO-CREATED:
 *   "Pre-Test"  — 6 question scores (S1-S6) + category scores
 *   "Post-Test" — 6 question scores (S7-S12) + category scores + feedback
 *   "Paired"    — auto-matched pre/post by session date, with gain scores
 *   "Rubric"    — scoring rubric reference (auto-generated once)
 *
 * SCORING (per test):
 *   6 questions × 4 pts max = 24 pts
 *   Level 1 (6-11):  Passive Consumer
 *   Level 2 (12-15): Developing User
 *   Level 3 (16-20): Proficient Creator
 *   Level 4 (21-24): Process Partner
 *
 * PAIRING LOGIC:
 *   Since participant_id is auto-generated (timestamp-based), pairing is done
 *   by matching pre and post submissions from the SAME calendar date.
 *   If multiple pre or post exist on the same date, uses the latest of each.
 */

// ─── Column definitions ─────────────────────────────────────────────────
var PRE_HEADERS = [
  'participant_id', 'timestamp', 'date', 'consent', 'coding_background',
  'total_score', 'level',
  'cat_foundations', 'cat_prompt', 'cat_evaluation', 'cat_ethics', 'cat_collaboration', 'cat_tool',
  's01_score', 's01_choice',
  's02_score', 's02_choice',
  's03_score', 's03_choice',
  's04_score', 's04_choice',
  's05_score', 's05_choice',
  's06_score', 's06_choice',
  'analysis'
];

var POST_HEADERS = [
  'participant_id', 'timestamp', 'date', 'consent',
  'total_score', 'level',
  'cat_foundations', 'cat_prompt', 'cat_evaluation', 'cat_ethics', 'cat_collaboration', 'cat_tool',
  's07_score', 's07_choice',
  's08_score', 's08_choice',
  's09_score', 's09_choice',
  's10_score', 's10_choice',
  's11_score', 's11_choice',
  's12_score', 's12_choice',
  'analysis',
  'likert_confidence', 'open_response'
];

var PAIRED_HEADERS = [
  'date', 'coding_background',
  'pre_id', 'post_id',
  'pre_total', 'post_total', 'gain', 'pre_level', 'post_level',
  'pre_foundations', 'post_foundations', 'gain_foundations',
  'pre_prompt', 'post_prompt', 'gain_prompt',
  'pre_evaluation', 'post_evaluation', 'gain_evaluation',
  'pre_ethics', 'post_ethics', 'gain_ethics',
  'pre_collaboration', 'post_collaboration', 'gain_collaboration',
  'pre_tool', 'post_tool', 'gain_tool',
  'likert_confidence', 'open_response'
];

// ─── Level calculation ──────────────────────────────────────────────────
function getLevel(score) {
  if (score >= 21) return 'L4: Process Partner';
  if (score >= 16) return 'L3: Proficient Creator';
  if (score >= 12) return 'L2: Developing User';
  return 'L1: Passive Consumer';
}

// ─── Extract date string from ISO timestamp ─────────────────────────────
function extractDate(isoString) {
  if (!isoString) return '';
  return String(isoString).substring(0, 10); // "2025-03-10"
}

// ─── POST handler ───────────────────────────────────────────────────────
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var date = extractDate(data.timestamp);
    var level = getLevel(data.total_score);

    var sheetName = data.test_type === 'pre' ? 'Pre-Test' : 'Post-Test';
    var sheet = getOrCreateSheet(ss, sheetName,
      data.test_type === 'pre' ? PRE_HEADERS : POST_HEADERS);

    // Build row based on test type
    var row;
    if (data.test_type === 'pre') {
      row = [
        data.participant_id, data.timestamp, date, data.consent || '', data.coding_background,
        data.total_score, level,
        data.cat_foundations, data.cat_prompt, data.cat_evaluation, data.cat_ethics, data.cat_collaboration, data.cat_tool,
        data.s01_score, data.s01_choice,
        data.s02_score, data.s02_choice,
        data.s03_score, data.s03_choice,
        data.s04_score, data.s04_choice,
        data.s05_score, data.s05_choice,
        data.s06_score, data.s06_choice,
        data.analysis || ''
      ];
    } else {
      row = [
        data.participant_id, data.timestamp, date, data.consent || '',
        data.total_score, level,
        data.cat_foundations, data.cat_prompt, data.cat_evaluation, data.cat_ethics, data.cat_collaboration, data.cat_tool,
        data.s07_score, data.s07_choice,
        data.s08_score, data.s08_choice,
        data.s09_score, data.s09_choice,
        data.s10_score, data.s10_choice,
        data.s11_score, data.s11_choice,
        data.s12_score, data.s12_choice,
        data.analysis || '',
        data.likert_confidence || '',
        data.open_response || ''
      ];
    }

    sheet.appendRow(row);

    // Rebuild paired analysis
    updatePairedSheet(ss);

    // Ensure rubric sheet exists
    ensureRubricSheet(ss);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', level: level }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ─── GET handler (health check) ─────────────────────────────────────────
function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: 'ok',
      message: 'LearnAI Assessment v2 endpoint is active. Use POST to submit data.'
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── Sheet helpers ──────────────────────────────────────────────────────
function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ─── Paired analysis ────────────────────────────────────────────────────
function updatePairedSheet(ss) {
  var preSheet = ss.getSheetByName('Pre-Test');
  var postSheet = ss.getSheetByName('Post-Test');
  if (!preSheet || !postSheet) return;
  if (preSheet.getLastRow() < 2 || postSheet.getLastRow() < 2) return;

  var preData = preSheet.getRange(2, 1, preSheet.getLastRow() - 1, preSheet.getLastColumn()).getValues();
  var postData = postSheet.getRange(2, 1, postSheet.getLastRow() - 1, postSheet.getLastColumn()).getValues();

  // Index by date — keep latest entry per date
  // Pre: participant_id(0), timestamp(1), date(2), consent(3), coding_bg(4), total(5), level(6),
  //       cat_foundations(7), cat_prompt(8), cat_evaluation(9), cat_ethics(10), cat_collaboration(11), cat_tool(12)
  var preMap = {};
  preData.forEach(function(row) {
    var date = String(row[2]);
    if (!preMap[date] || String(row[1]) > String(preMap[date].timestamp)) {
      preMap[date] = {
        id: row[0], timestamp: row[1], coding_bg: row[4],
        total: row[5], level: row[6],
        foundations: row[7], prompt: row[8], evaluation: row[9], ethics: row[10], collaboration: row[11], tool: row[12]
      };
    }
  });

  // Post: participant_id(0), timestamp(1), date(2), consent(3), total(4), level(5),
  //        cat_foundations(6), cat_prompt(7), cat_evaluation(8), cat_ethics(9), cat_collaboration(10), cat_tool(11),
  //        s07_score(12)..s12_choice(23), analysis(24), likert(25), open(26)
  var postMap = {};
  postData.forEach(function(row) {
    var date = String(row[2]);
    if (!postMap[date] || String(row[1]) > String(postMap[date].timestamp)) {
      postMap[date] = {
        id: row[0], timestamp: row[1],
        total: row[4], level: row[5],
        foundations: row[6], prompt: row[7], evaluation: row[8], ethics: row[9], collaboration: row[10], tool: row[11],
        analysis: row[24], likert: row[25], open: row[26]
      };
    }
  });

  // Create or clear Paired sheet
  var pairedSheet = ss.getSheetByName('Paired');
  if (!pairedSheet) {
    pairedSheet = ss.insertSheet('Paired');
  } else {
    pairedSheet.clearContents();
  }

  // Headers
  pairedSheet.appendRow(PAIRED_HEADERS);
  pairedSheet.getRange(1, 1, 1, PAIRED_HEADERS.length).setFontWeight('bold');
  pairedSheet.setFrozenRows(1);

  // Match by date
  var dates = Object.keys(preMap).filter(function(d) { return postMap[d]; }).sort();
  dates.forEach(function(date) {
    var pre = preMap[date];
    var post = postMap[date];
    pairedSheet.appendRow([
      date, pre.coding_bg,
      pre.id, post.id,
      pre.total, post.total, post.total - pre.total, pre.level, post.level,
      pre.foundations, post.foundations, post.foundations - pre.foundations,
      pre.prompt, post.prompt, post.prompt - pre.prompt,
      pre.evaluation, post.evaluation, post.evaluation - pre.evaluation,
      pre.ethics, post.ethics, post.ethics - pre.ethics,
      pre.collaboration, post.collaboration, post.collaboration - pre.collaboration,
      pre.tool, post.tool, post.tool - pre.tool,
      post.likert, post.open
    ]);
  });

  // Summary statistics
  var lastRow = pairedSheet.getLastRow();
  if (lastRow >= 2) {
    var n = lastRow - 1;
    var r = lastRow; // last data row
    pairedSheet.appendRow([]); // blank separator

    // Row labels for summary
    // Columns: E=pre_total, F=post_total, G=gain, J-L=foundations, M-O=prompt,
    //          P-R=evaluation, S-U=ethics, V-X=collaboration, Y-AA=tool, AB=likert
    pairedSheet.appendRow([
      'SUMMARY', 'N=' + n, '', '',
      '=AVERAGE(E2:E' + r + ')', '=AVERAGE(F2:F' + r + ')', '=AVERAGE(G2:G' + r + ')', '', '',
      '=AVERAGE(J2:J' + r + ')', '=AVERAGE(K2:K' + r + ')', '=AVERAGE(L2:L' + r + ')',
      '=AVERAGE(M2:M' + r + ')', '=AVERAGE(N2:N' + r + ')', '=AVERAGE(O2:O' + r + ')',
      '=AVERAGE(P2:P' + r + ')', '=AVERAGE(Q2:Q' + r + ')', '=AVERAGE(R2:R' + r + ')',
      '=AVERAGE(S2:S' + r + ')', '=AVERAGE(T2:T' + r + ')', '=AVERAGE(U2:U' + r + ')',
      '=AVERAGE(V2:V' + r + ')', '=AVERAGE(W2:W' + r + ')', '=AVERAGE(X2:X' + r + ')',
      '=AVERAGE(Y2:Y' + r + ')', '=AVERAGE(Z2:Z' + r + ')', '=AVERAGE(AA2:AA' + r + ')',
      '=AVERAGE(AB2:AB' + r + ')'
    ]);
    pairedSheet.appendRow([
      '', 'Median', '', '',
      '=MEDIAN(E2:E' + r + ')', '=MEDIAN(F2:F' + r + ')', '=MEDIAN(G2:G' + r + ')', '', '',
      '=MEDIAN(J2:J' + r + ')', '=MEDIAN(K2:K' + r + ')', '=MEDIAN(L2:L' + r + ')',
      '=MEDIAN(M2:M' + r + ')', '=MEDIAN(N2:N' + r + ')', '=MEDIAN(O2:O' + r + ')',
      '=MEDIAN(P2:P' + r + ')', '=MEDIAN(Q2:Q' + r + ')', '=MEDIAN(R2:R' + r + ')',
      '=MEDIAN(S2:S' + r + ')', '=MEDIAN(T2:T' + r + ')', '=MEDIAN(U2:U' + r + ')',
      '=MEDIAN(V2:V' + r + ')', '=MEDIAN(W2:W' + r + ')', '=MEDIAN(X2:X' + r + ')',
      '=MEDIAN(Y2:Y' + r + ')', '=MEDIAN(Z2:Z' + r + ')', '=MEDIAN(AA2:AA' + r + ')',
      '=MEDIAN(AB2:AB' + r + ')'
    ]);
    pairedSheet.appendRow([
      '', 'Std Dev', '', '',
      '=STDEV(E2:E' + r + ')', '=STDEV(F2:F' + r + ')', '=STDEV(G2:G' + r + ')', '', '',
      '=STDEV(J2:J' + r + ')', '=STDEV(K2:K' + r + ')', '=STDEV(L2:L' + r + ')',
      '=STDEV(M2:M' + r + ')', '=STDEV(N2:N' + r + ')', '=STDEV(O2:O' + r + ')',
      '=STDEV(P2:P' + r + ')', '=STDEV(Q2:Q' + r + ')', '=STDEV(R2:R' + r + ')',
      '=STDEV(S2:S' + r + ')', '=STDEV(T2:T' + r + ')', '=STDEV(U2:U' + r + ')',
      '=STDEV(V2:V' + r + ')', '=STDEV(W2:W' + r + ')', '=STDEV(X2:X' + r + ')',
      '=STDEV(Y2:Y' + r + ')', '=STDEV(Z2:Z' + r + ')', '=STDEV(AA2:AA' + r + ')',
      '=STDEV(AB2:AB' + r + ')'
    ]);
    pairedSheet.appendRow([
      '', 'Effect Size (d)', '', '',
      '', '', '=IF(STDEV(G2:G' + r + ')=0,"N/A",AVERAGE(G2:G' + r + ')/STDEV(G2:G' + r + '))'
    ]);

    // Bold summary rows
    pairedSheet.getRange(lastRow + 2, 1, 4, PAIRED_HEADERS.length).setFontWeight('bold');
  }
}

// ─── Rubric reference sheet ─────────────────────────────────────────────
function ensureRubricSheet(ss) {
  if (ss.getSheetByName('Rubric')) return;
  var sheet = ss.insertSheet('Rubric');

  sheet.appendRow(['LearnAI Assessment — Scoring Rubric']);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.appendRow([]);

  sheet.appendRow(['MASTERY LEVELS']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Points', 'Level', 'Label', 'Description']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 4).setFontWeight('bold');
  sheet.appendRow([1, 'L1', 'Passive Consumer', 'Treats AI as magic oracle. No planning, no verification. "Just make it for me."']);
  sheet.appendRow([2, 'L2', 'Developing User', 'Some awareness but falls back on workarounds or avoidance.']);
  sheet.appendRow([3, 'L3', 'Proficient Creator', 'Good instincts, somewhat vague in execution. Knows the right direction.']);
  sheet.appendRow([4, 'L4', 'Process Partner', 'Defines problem first, picks right tool, gives specific prompts, verifies output, owns the process.']);
  sheet.appendRow([]);

  sheet.appendRow(['OVERALL SCORE RANGES (per test, 6 questions)']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Score Range', 'Level', 'Interpretation']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 3).setFontWeight('bold');
  sheet.appendRow(['6-11', 'L1: Passive Consumer', 'Needs foundational AI literacy']);
  sheet.appendRow(['12-15', 'L2: Developing User', 'Has some awareness, needs guided practice']);
  sheet.appendRow(['16-20', 'L3: Proficient Creator', 'Good grasp, can work semi-independently']);
  sheet.appendRow(['21-24', 'L4: Process Partner', 'Strong AI mastery, independent workflow']);
  sheet.appendRow([]);

  sheet.appendRow(['SKILL CATEGORIES (1 question each per test, max 4 pts)']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Category', 'Pre Question', 'Post Question', 'What it Measures']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 4).setFontWeight('bold');
  sheet.appendRow(['AI Foundations', 'S01: Chatbot budget inconsistency', 'S07: Sales model deployment risk', 'Do they understand what AI actually is and isn\'t?']);
  sheet.appendRow(['Prompt Engineering', 'S02: Donor email variants', 'S08: Policy summary to checklist', 'Can they write specific, constrained prompts?']);
  sheet.appendRow(['Critical Evaluation', 'S03: Meeting transcript action items', 'S09: Repeated answer consistency', 'Do they verify AI output rather than trust appearances?']);
  sheet.appendRow(['Ethics & Safety', 'S04: Nonprofit volunteer notes', 'S10: Hiring tool disparate impact', 'Do they recognize privacy and bias risks?']);
  sheet.appendRow(['Human-AI Collaboration', 'S05: Grant proposal workflow', 'S11: Recursion learning strategies', 'Can they lead the human-AI partnership effectively?']);
  sheet.appendRow(['Tool Selection', 'S06: 80 scanned invoices', 'S12: Clinic infrastructure constraints', 'Can they pick the right tool for the task?']);
  sheet.appendRow([]);

  sheet.appendRow(['PAIRING LOGIC']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Pre and Post tests are matched by calendar date (same session day).']);
  sheet.appendRow(['Participant IDs are auto-generated timestamps — no manual entry needed.']);
  sheet.appendRow(['Gain = Post score - Pre score. Positive gain = improvement after LAI session.']);
  sheet.appendRow([]);

  sheet.appendRow(['STATISTICAL ANALYSIS']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Use Wilcoxon signed-rank test for paired pre/post comparison (ordinal data, small N).']);
  sheet.appendRow(['Effect size (Cohen\'s d) = Mean gain / SD of gain. Reported in Paired sheet summary.']);
  sheet.appendRow(['Report: median, IQR for each test; per-category gains; Likert confidence distribution.']);

  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 400);
}
