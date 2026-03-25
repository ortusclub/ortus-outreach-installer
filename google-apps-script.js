/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORTUS LINKEDIN TRACKER — Google Apps Script
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deploy this ONCE from your central Google Sheet:
 *   https://docs.google.com/spreadsheets/d/1YL-sa8OnMs-VwNKcIe75TrUdzFTvYKeezxX-RUuAeBM
 *
 * It will accept requests to update ANY Google Sheet your Google account
 * has edit access to. The target sheet ID is passed in each request.
 *
 * SETUP (one-time):
 *   1. Open the central sheet above
 *   2. Extensions → Apps Script
 *   3. Delete all existing code, paste this entire file
 *   4. Click Deploy → New Deployment
 *      - Type: Web app
 *      - Execute as: Me  (your Google account)
 *      - Who has access: Anyone
 *   5. Authorize when prompted (it needs permission to open other sheets)
 *   6. Copy the deployment URL
 *   7. Paste it into server.js:
 *      process.env.SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/YOUR_ID/exec';
 *
 * IMPORTANT: Your Google account must have edit access to every sheet
 * the campaign uses. For Ortus team sheets this should already be the case.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ── Tracking columns we manage ──
var TRACKING_COLUMNS = [
  'Connection Status',
  'Connection Date',
  'Connection By',
  'First Message Status',
  'First Message Date',
  'Follow-up Status',
  'Follow-up Date'
];

// ── Field name → Column header mapping ──
var FIELD_MAP = {
  connectionStatus:    'Connection Status',
  connectionDate:      'Connection Date',
  connectionBy:        'Connection By',
  firstMessageStatus:  'First Message Status',
  firstMessageDate:    'First Message Date',
  followUpStatus:      'Follow-up Status',
  followUpDate:        'Follow-up Date'
};

// ── URL column detection ──
var URL_COLUMN_NAMES = [
  'LinkedIn URL', 'linkedin_url', 'linkedinUrl', 'LinkedIn',
  'URL', 'url', 'Profile URL', 'profile_url', 'Link'
];

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Handlers
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Validate required field
    if (!data.sheetId) {
      return jsonResponse({ error: 'sheetId is required' });
    }

    // Open the TARGET sheet (not the central one)
    var spreadsheet = SpreadsheetApp.openById(data.sheetId);
    var sheet = spreadsheet.getActiveSheet();

    // Route to the right handler
    switch (data.action) {
      case 'ensureColumns':
        return handleEnsureColumns(sheet);

      case 'updateRow':
      default:
        return handleUpdateRow(sheet, data);

      case 'batchUpdate':
        return handleBatchUpdate(sheet, data);

      case 'getStatus':
        return handleGetStatus(sheet, data);
    }

  } catch (err) {
    return jsonResponse({ error: err.message, stack: err.stack });
  }
}

function doGet(e) {
  // Quick health check — also verifies the script is deployed
  return jsonResponse({
    status: 'ok',
    service: 'Ortus LinkedIn Tracker',
    deployed: new Date().toISOString(),
    usage: 'POST with { sheetId, action, ... }'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Ensure tracking columns exist
// ═══════════════════════════════════════════════════════════════════════════

function handleEnsureColumns(sheet) {
  var headers = getHeaders(sheet);
  var added = [];

  TRACKING_COLUMNS.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      var nextCol = headers.length + 1;
      sheet.getRange(1, nextCol).setValue(col);
      // Bold the header
      sheet.getRange(1, nextCol).setFontWeight('bold');
      headers.push(col);
      added.push(col);
    }
  });

  return jsonResponse({
    success: true,
    headers: headers,
    added: added,
    message: added.length > 0
      ? 'Added columns: ' + added.join(', ')
      : 'All tracking columns already exist'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Update a single row
// ═══════════════════════════════════════════════════════════════════════════

function handleUpdateRow(sheet, data) {
  if (!data.linkedinUrl) {
    return jsonResponse({ error: 'linkedinUrl is required' });
  }

  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found in the sheet' });
  }

  var targetRow = findRowByUrl(sheet, urlColIndex, data.linkedinUrl);

  if (targetRow === -1) {
    return jsonResponse({ error: 'Row not found for: ' + data.linkedinUrl });
  }

  var updated = writeFields(sheet, headers, targetRow, data);

  return jsonResponse({
    success: true,
    sheetId: data.sheetId,
    row: targetRow,
    updated: updated
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Batch update multiple rows at once
// ═══════════════════════════════════════════════════════════════════════════
// Expects data.updates = [{ linkedinUrl, connectionStatus, ... }, ...]
// More efficient than individual calls — one sheet open, one URL column scan.

function handleBatchUpdate(sheet, data) {
  if (!data.updates || !data.updates.length) {
    return jsonResponse({ error: 'updates array is required' });
  }

  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found' });
  }

  // Load all URLs at once
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ error: 'Sheet has no data rows' });
  }

  var allUrls = sheet.getRange(2, urlColIndex + 1, lastRow - 1, 1).getValues();
  var urlMap = {};
  for (var i = 0; i < allUrls.length; i++) {
    var normalized = normalizeUrl(allUrls[i][0]);
    if (normalized) urlMap[normalized] = i + 2; // row number
  }

  var results = [];

  data.updates.forEach(function(update) {
    var normalized = normalizeUrl(update.linkedinUrl);
    var row = urlMap[normalized];

    if (!row) {
      results.push({ linkedinUrl: update.linkedinUrl, error: 'not found' });
      return;
    }

    var updated = writeFields(sheet, headers, row, update);
    results.push({ linkedinUrl: update.linkedinUrl, row: row, updated: updated });
  });

  return jsonResponse({
    success: true,
    sheetId: data.sheetId,
    processed: results.length,
    results: results
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Action: Get tracking status for a URL (or all URLs)
// ═══════════════════════════════════════════════════════════════════════════

function handleGetStatus(sheet, data) {
  var headers = getHeaders(sheet);
  var urlColIndex = findUrlColumn(headers);

  if (urlColIndex === -1) {
    return jsonResponse({ error: 'No LinkedIn URL column found' });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ rows: [] });
  }

  // Read all data at once (efficient)
  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];

  for (var i = 0; i < allData.length; i++) {
    var rowData = {};
    for (var j = 0; j < headers.length; j++) {
      rowData[headers[j]] = allData[i][j] || '';
    }

    // If a specific URL was requested, filter
    if (data.linkedinUrl) {
      var cellUrl = normalizeUrl(rowData[headers[urlColIndex]]);
      var searchUrl = normalizeUrl(data.linkedinUrl);
      if (cellUrl !== searchUrl) continue;
    }

    rows.push(rowData);
  }

  return jsonResponse({ rows: rows, total: rows.length });
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility functions
// ═══════════════════════════════════════════════════════════════════════════

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return (h || '').toString().trim();
  });
}

function findUrlColumn(headers) {
  for (var i = 0; i < headers.length; i++) {
    if (URL_COLUMN_NAMES.indexOf(headers[i]) !== -1) return i;
    if (headers[i].toLowerCase().indexOf('linkedin') !== -1) return i;
  }
  return -1;
}

function findRowByUrl(sheet, urlColIndex, searchUrl) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var urls = sheet.getRange(2, urlColIndex + 1, lastRow - 1, 1).getValues();
  var normalized = normalizeUrl(searchUrl);

  for (var r = 0; r < urls.length; r++) {
    if (normalizeUrl(urls[r][0]) === normalized) {
      return r + 2;
    }
  }
  return -1;
}

function normalizeUrl(url) {
  if (!url) return '';
  return url.toString().trim().toLowerCase().replace(/\/+$/, '');
}

function writeFields(sheet, headers, row, data) {
  var updated = [];

  for (var field in FIELD_MAP) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      var colName = FIELD_MAP[field];
      var colIndex = headers.indexOf(colName);

      if (colIndex === -1) {
        // Auto-create the column
        colIndex = headers.length;
        sheet.getRange(1, colIndex + 1).setValue(colName);
        sheet.getRange(1, colIndex + 1).setFontWeight('bold');
        headers.push(colName);
      }

      sheet.getRange(row, colIndex + 1).setValue(data[field]);
      updated.push(colName);
    }
  }

  return updated;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
