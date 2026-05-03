/**
 * LearnAI Assessment — Google Apps Script (HS Edition)
 *
 * PAIRING LOGIC CHANGE:
 *   participant_id is now "nickname-birthmonth" (e.g., "shadow-07")
 *   Pre and Post are matched by participant_id instead of calendar date.
 *
 * SETUP: Same as college version — paste into Extensions → Apps Script → Deploy as Web App.
 */

// ─── Column definitions ─────────────────────────────────────────────────
var PRE_HEADERS = [
  'participant_id', 'timestamp', 'date', 'coding_background',
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
  'participant_id', 'timestamp', 'date',
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
  'participant_id', 'coding_background',
  'pre_date', 'post_date',
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
  return String(isoString).substring(0, 10);
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

    var row;
    if (data.test_type === 'pre') {
      row = [
        data.participant_id, data.timestamp, date, data.coding_background,
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
        data.participant_id, data.timestamp, date,
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
    updatePairedSheet(ss);
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
      message: 'LearnAI HS Assessment endpoint is active. Use POST to submit data.'
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

// ─── Paired analysis (matches by participant_id) ────────────────────────
function updatePairedSheet(ss) {
  var preSheet = ss.getSheetByName('Pre-Test');
  var postSheet = ss.getSheetByName('Post-Test');
  if (!preSheet || !postSheet) return;
  if (preSheet.getLastRow() < 2 || postSheet.getLastRow() < 2) return;

  var preData = preSheet.getRange(2, 1, preSheet.getLastRow() - 1, preSheet.getLastColumn()).getValues();
  var postData = postSheet.getRange(2, 1, postSheet.getLastRow() - 1, postSheet.getLastColumn()).getValues();

  // Index by participant_id (nickname-birthmonth) — keep latest entry per id
  // Pre columns: participant_id(0), timestamp(1), date(2), coding_bg(3), total(4), level(5),
  //              cat_foundations(6), cat_prompt(7), cat_evaluation(8), cat_ethics(9), cat_collaboration(10), cat_tool(11)
  var preMap = {};
  preData.forEach(function(row) {
    var pid = String(row[0]).toLowerCase().trim();
    if (!preMap[pid] || String(row[1]) > String(preMap[pid].timestamp)) {
      preMap[pid] = {
        id: row[0], timestamp: row[1], date: row[2], coding_bg: row[3],
        total: row[4], level: row[5],
        foundations: row[6], prompt: row[7], evaluation: row[8], ethics: row[9], collaboration: row[10], tool: row[11]
      };
    }
  });

  // Post columns: participant_id(0), timestamp(1), date(2), total(3), level(4),
  //               cat_foundations(5)...cat_tool(10), s07..s12, analysis(23), likert(24), open(25)
  var postMap = {};
  postData.forEach(function(row) {
    var pid = String(row[0]).toLowerCase().trim();
    if (!postMap[pid] || String(row[1]) > String(postMap[pid].timestamp)) {
      postMap[pid] = {
        id: row[0], timestamp: row[1], date: row[2],
        total: row[3], level: row[4],
        foundations: row[5], prompt: row[6], evaluation: row[7], ethics: row[8], collaboration: row[9], tool: row[10],
        likert: row[23], open: row[24]
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

  pairedSheet.appendRow(PAIRED_HEADERS);
  pairedSheet.getRange(1, 1, 1, PAIRED_HEADERS.length).setFontWeight('bold');
  pairedSheet.setFrozenRows(1);

  // Match by participant_id
  var pids = Object.keys(preMap).filter(function(pid) { return postMap[pid]; }).sort();
  pids.forEach(function(pid) {
    var pre = preMap[pid];
    var post = postMap[pid];
    pairedSheet.appendRow([
      pre.id, pre.coding_bg,
      pre.date, post.date,
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
    var r = lastRow;
    pairedSheet.appendRow([]);
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
      '', 'Std Dev', '', '',
      '=STDEV(E2:E' + r + ')', '=STDEV(F2:F' + r + ')', '=STDEV(G2:G' + r + ')',
    ]);
    pairedSheet.appendRow([
      '', 'Effect Size (d)', '', '',
      '', '', '=IF(STDEV(G2:G' + r + ')=0,"N/A",AVERAGE(G2:G' + r + ')/STDEV(G2:G' + r + '))'
    ]);
    pairedSheet.getRange(lastRow + 2, 1, 3, PAIRED_HEADERS.length).setFontWeight('bold');
  }
}

// ─── Rubric reference sheet ─────────────────────────────────────────────
function ensureRubricSheet(ss) {
  if (ss.getSheetByName('Rubric')) return;
  var sheet = ss.insertSheet('Rubric');

  sheet.appendRow(['LearnAI HS Assessment — Scoring Rubric']);
  sheet.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sheet.appendRow([]);

  sheet.appendRow(['PAIRING LOGIC']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Pre and Post tests are matched by participant_id (nickname + birth month).']);
  sheet.appendRow(['Example: "shadow-07" on both pre and post will be auto-paired.']);
  sheet.appendRow([]);

  sheet.appendRow(['MASTERY LEVELS']);
  sheet.getRange(sheet.getLastRow(), 1).setFontWeight('bold');
  sheet.appendRow(['Score Range', 'Level', 'Label']);
  sheet.getRange(sheet.getLastRow(), 1, 1, 3).setFontWeight('bold');
  sheet.appendRow(['6-11', 'L1', 'Passive Consumer']);
  sheet.appendRow(['12-15', 'L2', 'Developing User']);
  sheet.appendRow(['16-20', 'L3', 'Proficient Creator']);
  sheet.appendRow(['21-24', 'L4', 'Process Partner']);

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 300);
}
