/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ORTUS CLUB — ElevenLabs Calling Integration (Google Apps Script)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Replaces VAPI with ElevenLabs Conversational AI for outbound calling.
 * Reads leads from any Google Sheet, submits batch calls via ElevenLabs API,
 * and tracks call results back in the sheet.
 *
 * SETUP:
 *   1. Open your Google Sheet
 *   2. Extensions → Apps Script
 *   3. Delete all existing code, paste this entire file
 *   4. Set your API key and Agent ID in the CONFIG section below
 *   5. Click Deploy → New Deployment → Web app → Execute as: Me → Anyone
 *   6. Run onOpen() once to create the custom menu
 *
 * REQUIRED COLUMNS in your sheet:
 *   - Phone Number  (mandatory — E.164 format like +44...)
 *   - First Name    (mapped to prospect_name)
 *   - Last Name
 *   - Email         (mapped to prospect_email)
 *
 * EVENT VARIABLES are set in the sidebar UI (same for all calls in a batch).
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG — Update these before first use
// ═══════════════════════════════════════════════════════════════════════════
var CONFIG = {
  ELEVENLABS_API_KEY: 'sk_24138756ab4b5a842c6d44cf1851b5536931888de6752303',
  AGENT_ID: 'agent_5601kmzey4mve8pswpwvmhckcgnr',
  BRANCH_ID: 'agtbrch_0801kmzey97dfhwbwgctcmkv4ez4',
  PHONE_NUMBER_ID: 'phnum_8701kn1e7q5rfbgsrwp8xzfk1dad',
  API_BASE: 'https://api.elevenlabs.io/v1',
};

// ── Tracking columns managed by this script ──
var CALL_TRACKING_COLUMNS = [
  'Call Status',
  'Call Date',
  'Call Duration',
  'Call Batch ID',
  'Call Notes'
];

// ── Column name detection ──
var PHONE_COLUMN_NAMES = [
  'Phone Number', 'phone_number', 'Phone', 'phone', 'Mobile',
  'mobile', 'Tel', 'tel', 'Telephone', 'Contact Number'
];

var EMAIL_COLUMN_NAMES = [
  'Email', 'email', 'E-mail', 'e-mail', 'Email Address',
  'prospect_email', 'Work Email'
];

var FIRST_NAME_COLUMNS = [
  'First Name', 'firstName', 'first_name', 'Name', 'Given Name'
];

var LAST_NAME_COLUMNS = [
  'Last Name', 'lastName', 'last_name', 'Surname', 'Family Name'
];

// ═══════════════════════════════════════════════════════════════════════════
// MENU & UI
// ═══════════════════════════════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('☎ ElevenLabs Calling')
    .addItem('Open Call Dashboard', 'showSidebar')
    .addSeparator()
    .addItem('Ensure Call Tracking Columns', 'ensureCallColumns')
    .addItem('Check Batch Status', 'checkLatestBatchStatus')
    .addItem('Set API Key', 'promptApiKey')
    .addItem('Set Phone Number ID', 'promptPhoneNumberId')
    .addToUi();
}

function showSidebar() {
  var html = HtmlService.createHtmlOutput(getSidebarHtml())
    .setTitle('ElevenLabs Call Dashboard')
    .setWidth(400);
  SpreadsheetApp.getUi().showSidebar(html);
}

function promptApiKey() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    'ElevenLabs API Key',
    'Paste your ElevenLabs API key:',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('ELEVENLABS_API_KEY', result.getResponseText().trim());
    ui.alert('API key saved securely.');
  }
}

function promptPhoneNumberId() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt(
    'Phone Number ID',
    'Paste the ElevenLabs Phone Number ID (from your imported Twilio number):',
    ui.ButtonSet.OK_CANCEL
  );
  if (result.getSelectedButton() === ui.Button.OK) {
    PropertiesService.getScriptProperties().setProperty('PHONE_NUMBER_ID', result.getResponseText().trim());
    ui.alert('Phone Number ID saved.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: Submit Batch Call
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Called from the sidebar. Reads leads, builds recipients, submits batch.
 *
 * @param {Object} eventVars — event-level dynamic variables from sidebar form
 * @param {boolean} selectedOnly — if true, only process selected/highlighted rows
 * @returns {Object} result summary
 */
function submitBatchCall(eventVars, selectedOnly) {
  var apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set. Use ☎ ElevenLabs Calling → Set API Key.');

  var phoneNumberId = getPhoneNumberId();
  if (!phoneNumberId) throw new Error('No Phone Number ID set. Use ☎ ElevenLabs Calling → Set Phone Number ID.');

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = getHeaders(sheet);

  // Ensure call tracking columns exist
  ensureCallColumnsOnSheet(sheet, headers);
  headers = getHeaders(sheet); // refresh after adding columns

  // Find required column indices
  var phoneColIdx = findColumnIndex(headers, PHONE_COLUMN_NAMES);
  if (phoneColIdx === -1) throw new Error('No "Phone Number" column found in the sheet.');

  var firstNameIdx = findColumnIndex(headers, FIRST_NAME_COLUMNS);
  var lastNameIdx = findColumnIndex(headers, LAST_NAME_COLUMNS);
  var emailIdx = findColumnIndex(headers, EMAIL_COLUMN_NAMES);
  var callStatusIdx = headers.indexOf('Call Status');

  // Read data rows
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Sheet has no data rows.');

  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var recipients = [];
  var rowIndices = []; // track which sheet rows map to which recipients

  for (var i = 0; i < allData.length; i++) {
    var row = allData[i];

    // Skip rows already called
    if (callStatusIdx !== -1) {
      var existingStatus = (row[callStatusIdx] || '').toString().toLowerCase();
      if (existingStatus === 'completed' || existingStatus === 'answered' || existingStatus === 'scheduled') {
        continue;
      }
    }

    var phone = (row[phoneColIdx] || '').toString().trim();
    if (!phone) continue;

    // Ensure E.164 format
    if (!phone.startsWith('+')) phone = '+' + phone;

    var firstName = firstNameIdx !== -1 ? (row[firstNameIdx] || '').toString().trim() : '';
    var lastName = lastNameIdx !== -1 ? (row[lastNameIdx] || '').toString().trim() : '';
    var email = emailIdx !== -1 ? (row[emailIdx] || '').toString().trim() : '';

    var prospectName = (firstName + ' ' + lastName).trim() || 'there';

    // Build recipient with dynamic variables in the correct nested format
    var recipient = {
      phone_number: phone,
      conversation_initiation_client_data: {
        dynamic_variables: {
          prospect_name: prospectName,
          prospect_email: email,
          caller_name: eventVars.caller_name || 'Sarah',
          host_name: eventVars.host_name || '',
          host_first_name: eventVars.host_first_name || '',
          event_name: eventVars.event_name || '',
          event_date: eventVars.event_date || '',
          event_time: eventVars.event_time || '',
          event_city: eventVars.event_city || '',
          event_area: eventVars.event_area || '',
          event_venue: eventVars.event_venue || '',
          event_format: eventVars.event_format || 'roundtable',
          event_context: eventVars.event_context || '',
          target_audience: eventVars.target_audience || '',
        }
      }
    };

    // Conditionally inject voice override (per D-09 / VOICE-08 / D-11)
    if (eventVars.voice_id) {
      recipient.conversation_initiation_client_data.conversation_config_override = {
        tts: { voice_id: eventVars.voice_id }
      };
    }

    recipients.push(recipient);
    rowIndices.push(i + 2); // 1-indexed sheet row
  }

  if (recipients.length === 0) {
    throw new Error('No eligible leads found. Check that Phone Number column has data and leads are not already marked as called.');
  }

  // Build batch call payload
  var batchName = 'Ortus — ' + (eventVars.event_name || 'Outreach') + ' — ' +
    Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd HH:mm');

  var payload = {
    call_name: batchName,
    agent_id: CONFIG.AGENT_ID,
    agent_phone_number_id: phoneNumberId,
    branch_id: CONFIG.BRANCH_ID,
    environment: 'production',
    recipients: recipients,
    timezone: eventVars.timezone || 'Europe/London',
    target_concurrency_limit: Math.min(recipients.length, 5), // conservative
  };

  // Schedule if requested
  if (eventVars.scheduled_time) {
    payload.scheduled_time_unix = Math.floor(new Date(eventVars.scheduled_time).getTime() / 1000);
  }

  Logger.log('[submitBatchCall] First recipient payload: ' + JSON.stringify(recipients[0]).substring(0, 500));

  // Submit to ElevenLabs
  var response = elevenlabsPost('/convai/batch-calling/submit', payload, apiKey);

  if (response.error) {
    throw new Error('ElevenLabs API error: ' + JSON.stringify(response.error));
  }

  var batchId = response.id || 'unknown';

  // Persist last-used voice for pre-selection on next sidebar open (per D-10 / VOICE-04)
  if (eventVars.voice_id) {
    saveLastUsedVoiceId(eventVars.voice_id);
  }

  var now = Utilities.formatDate(new Date(), 'Europe/London', 'yyyy-MM-dd HH:mm:ss');

  // Mark rows as scheduled in the sheet
  var callStatusColIdx = headers.indexOf('Call Status');
  var callDateColIdx = headers.indexOf('Call Date');
  var callBatchColIdx = headers.indexOf('Call Batch ID');

  for (var j = 0; j < rowIndices.length; j++) {
    var sheetRow = rowIndices[j];
    if (callStatusColIdx !== -1) sheet.getRange(sheetRow, callStatusColIdx + 1).setValue('Scheduled');
    if (callDateColIdx !== -1) sheet.getRange(sheetRow, callDateColIdx + 1).setValue(now);
    if (callBatchColIdx !== -1) sheet.getRange(sheetRow, callBatchColIdx + 1).setValue(batchId);
  }

  // Store batch ID for status checking
  PropertiesService.getScriptProperties().setProperty('LATEST_BATCH_ID', batchId);

  return {
    success: true,
    batchId: batchId,
    batchName: batchName,
    recipientCount: recipients.length,
    status: response.status || 'pending',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CORE: Check Batch Status & Update Sheet
// ═══════════════════════════════════════════════════════════════════════════

function checkLatestBatchStatus() {
  var batchId = PropertiesService.getScriptProperties().getProperty('LATEST_BATCH_ID');
  if (!batchId) {
    SpreadsheetApp.getUi().alert('No batch call has been submitted yet.');
    return;
  }
  var result = checkBatchStatus(batchId);
  SpreadsheetApp.getUi().alert(
    'Batch: ' + batchId + '\n' +
    'Status: ' + result.status + '\n' +
    'Dispatched: ' + result.dispatched + '\n' +
    'Finished: ' + result.finished + '\n' +
    'Total: ' + result.total
  );
}

function checkBatchStatus(batchId) {
  var apiKey = getApiKey();
  if (!apiKey) throw new Error('No API key set.');

  var response = elevenlabsGet('/convai/batch-calling/' + batchId, apiKey);

  var result = {
    batchId: batchId,
    status: response.status || 'unknown',
    dispatched: response.total_calls_dispatched || 0,
    finished: response.total_calls_finished || 0,
    total: response.total_calls_scheduled || 0,
  };

  // If completed, try to update individual row statuses
  if (response.status === 'completed' || response.status === 'in_progress') {
    updateSheetWithCallResults(batchId, apiKey);
  }

  return result;
}

/**
 * Fetches individual call results for a batch and updates the sheet.
 */
function updateSheetWithCallResults(batchId, apiKey) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = getHeaders(sheet);

  var phoneColIdx = findColumnIndex(headers, PHONE_COLUMN_NAMES);
  var callStatusIdx = headers.indexOf('Call Status');
  var callDurationIdx = headers.indexOf('Call Duration');
  var callNotesIdx = headers.indexOf('Call Notes');
  var callBatchIdx = headers.indexOf('Call Batch ID');

  if (phoneColIdx === -1 || callStatusIdx === -1) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // Read all phone numbers and batch IDs to match
  var allData = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();

  // Build phone → row map for this batch
  var phoneRowMap = {};
  for (var i = 0; i < allData.length; i++) {
    var batchCell = callBatchIdx !== -1 ? (allData[i][callBatchIdx] || '').toString() : '';
    if (batchCell !== batchId) continue;

    var phone = normalizePhone(allData[i][phoneColIdx]);
    if (phone) phoneRowMap[phone] = i + 2;
  }

  // Fetch conversation history for this batch
  // ElevenLabs conversations endpoint filtered by batch
  try {
    var conversations = elevenlabsGet('/convai/batch-calling/' + batchId + '/conversations', apiKey);
    var convList = conversations.conversations || conversations || [];

    if (!Array.isArray(convList)) return;

    for (var c = 0; c < convList.length; c++) {
      var conv = convList[c];
      var convPhone = normalizePhone(conv.phone_number || conv.recipient_phone_number || '');
      var sheetRow = phoneRowMap[convPhone];

      if (!sheetRow) continue;

      var callStatus = mapCallStatus(conv.status || conv.call_status || '');
      var duration = conv.duration_secs || conv.call_duration || '';

      if (callStatusIdx !== -1) sheet.getRange(sheetRow, callStatusIdx + 1).setValue(callStatus);
      if (callDurationIdx !== -1 && duration) sheet.getRange(sheetRow, callDurationIdx + 1).setValue(duration + 's');
      if (callNotesIdx !== -1 && conv.summary) sheet.getRange(sheetRow, callNotesIdx + 1).setValue(conv.summary);
    }
  } catch (e) {
    Logger.log('Error fetching conversation results: ' + e.message);
  }
}

function mapCallStatus(status) {
  status = (status || '').toLowerCase();
  if (status === 'done' || status === 'completed' || status === 'success') return 'Completed';
  if (status === 'no_answer' || status === 'no-answer') return 'No Answer';
  if (status === 'busy') return 'Busy';
  if (status === 'failed' || status === 'error') return 'Failed';
  if (status === 'voicemail') return 'Voicemail';
  if (status === 'in_progress' || status === 'ringing') return 'In Progress';
  if (status === 'cancelled') return 'Cancelled';
  return status || 'Unknown';
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBHOOK: Receive call completion callbacks (optional)
// ═══════════════════════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Handle ElevenLabs webhook callback
    if (data.type === 'call_completed' || data.event === 'conversation.ended') {
      return handleCallWebhook(data);
    }

    // Handle manual status check request
    if (data.action === 'checkBatch' && data.batchId) {
      var result = checkBatchStatus(data.batchId);
      return jsonResponse(result);
    }

    // Handle batch submission from external system
    if (data.action === 'submitBatch' && data.eventVars) {
      var result = submitBatchCall(data.eventVars, false);
      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Unknown action' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doGet(e) {
  return jsonResponse({
    status: 'ok',
    service: 'Ortus ElevenLabs Calling',
    deployed: new Date().toISOString(),
    agent_id: CONFIG.AGENT_ID,
  });
}

function handleCallWebhook(data) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = getHeaders(sheet);

  var phoneColIdx = findColumnIndex(headers, PHONE_COLUMN_NAMES);
  var callStatusIdx = headers.indexOf('Call Status');
  var callDurationIdx = headers.indexOf('Call Duration');
  var callNotesIdx = headers.indexOf('Call Notes');

  if (phoneColIdx === -1) return jsonResponse({ error: 'No phone column' });

  var phone = normalizePhone(data.phone_number || data.recipient || '');
  if (!phone) return jsonResponse({ error: 'No phone in webhook' });

  var row = findRowByPhone(sheet, phoneColIdx, phone);
  if (row === -1) return jsonResponse({ error: 'Row not found for ' + phone });

  var status = mapCallStatus(data.status || data.call_status || 'completed');

  if (callStatusIdx !== -1) sheet.getRange(row, callStatusIdx + 1).setValue(status);
  if (callDurationIdx !== -1 && data.duration) sheet.getRange(row, callDurationIdx + 1).setValue(data.duration + 's');
  if (callNotesIdx !== -1 && data.summary) sheet.getRange(row, callNotesIdx + 1).setValue(data.summary);

  return jsonResponse({ success: true, row: row, status: status });
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-POLL: Trigger to check batch status periodically
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Set up a time-driven trigger to poll batch status every 5 minutes.
 * Call this once after submitting a batch.
 */
function startStatusPolling() {
  // Remove existing triggers
  stopStatusPolling();

  ScriptApp.newTrigger('pollBatchStatus')
    .timeBased()
    .everyMinutes(5)
    .create();

  Logger.log('Status polling started (every 5 min).');
}

function stopStatusPolling() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'pollBatchStatus') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

function pollBatchStatus() {
  var batchId = PropertiesService.getScriptProperties().getProperty('LATEST_BATCH_ID');
  if (!batchId) {
    stopStatusPolling();
    return;
  }

  try {
    var result = checkBatchStatus(batchId);
    Logger.log('Poll: ' + batchId + ' → ' + result.status + ' (' + result.finished + '/' + result.total + ')');

    if (result.status === 'completed' || result.status === 'failed' || result.status === 'cancelled') {
      stopStatusPolling();
      Logger.log('Batch ' + result.status + '. Polling stopped.');
    }
  } catch (e) {
    Logger.log('Poll error: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API Helpers
// ═══════════════════════════════════════════════════════════════════════════

function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty('ELEVENLABS_API_KEY') || CONFIG.ELEVENLABS_API_KEY;
}

function getPhoneNumberId() {
  return PropertiesService.getScriptProperties().getProperty('PHONE_NUMBER_ID') || CONFIG.PHONE_NUMBER_ID;
}

function elevenlabsPost(endpoint, payload, apiKey) {
  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'xi-api-key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(CONFIG.API_BASE + endpoint, options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  Logger.log('[ElevenLabs POST ' + endpoint + '] ' + code + ': ' + body.substring(0, 500));

  try {
    return JSON.parse(body);
  } catch (e) {
    return { error: 'Invalid JSON response', code: code, raw: body.substring(0, 200) };
  }
}

function elevenlabsGet(endpoint, apiKey) {
  var options = {
    method: 'get',
    headers: { 'xi-api-key': apiKey },
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(CONFIG.API_BASE + endpoint, options);
  var code = response.getResponseCode();
  var body = response.getContentText();

  Logger.log('[ElevenLabs GET ' + endpoint + '] ' + code);

  try {
    return JSON.parse(body);
  } catch (e) {
    return { error: 'Invalid JSON response', code: code, raw: body.substring(0, 200) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Sheet Utilities
// ═══════════════════════════════════════════════════════════════════════════

function getHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return (h || '').toString().trim();
  });
}

function findColumnIndex(headers, candidates) {
  for (var i = 0; i < headers.length; i++) {
    if (candidates.indexOf(headers[i]) !== -1) return i;
  }
  // Fuzzy match — case insensitive
  for (var i = 0; i < headers.length; i++) {
    var lower = headers[i].toLowerCase();
    for (var j = 0; j < candidates.length; j++) {
      if (lower === candidates[j].toLowerCase()) return i;
    }
  }
  return -1;
}

function ensureCallColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var headers = getHeaders(sheet);
  ensureCallColumnsOnSheet(sheet, headers);
  SpreadsheetApp.getUi().alert('Call tracking columns are ready.');
}

function ensureCallColumnsOnSheet(sheet, headers) {
  var added = [];
  CALL_TRACKING_COLUMNS.forEach(function(col) {
    if (headers.indexOf(col) === -1) {
      var nextCol = headers.length + 1;
      sheet.getRange(1, nextCol).setValue(col);
      sheet.getRange(1, nextCol).setFontWeight('bold');
      headers.push(col);
      added.push(col);
    }
  });
  if (added.length > 0) {
    Logger.log('Added call tracking columns: ' + added.join(', '));
  }
}

function findRowByPhone(sheet, phoneColIdx, searchPhone) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  var phones = sheet.getRange(2, phoneColIdx + 1, lastRow - 1, 1).getValues();
  for (var r = 0; r < phones.length; r++) {
    if (normalizePhone(phones[r][0]) === searchPhone) return r + 2;
  }
  return -1;
}

function normalizePhone(phone) {
  if (!phone) return '';
  return phone.toString().trim().replace(/[\s\-\(\)\.]/g, '');
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════════════════════
// List available agents (for sidebar dropdown)
// ═══════════════════════════════════════════════════════════════════════════

function listAgents() {
  var apiKey = getApiKey();
  if (!apiKey) return [];

  var result = elevenlabsGet('/convai/agents', apiKey);
  if (result.agents) {
    return result.agents.map(function(a) {
      return { id: a.agent_id, name: a.name };
    });
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// List batch calls (for sidebar history)
// ═══════════════════════════════════════════════════════════════════════════

function listBatchCalls() {
  var apiKey = getApiKey();
  if (!apiKey) return [];

  var result = elevenlabsGet('/convai/batch-calling', apiKey);
  if (result.batch_calls || Array.isArray(result)) {
    var calls = result.batch_calls || result;
    return calls.map(function(b) {
      return {
        id: b.id,
        name: b.name,
        status: b.status,
        total: b.total_calls_scheduled,
        finished: b.total_calls_finished,
        created: b.created_at_unix,
      };
    });
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Voice Selection — fetch, cache, and persist voice preferences
// ═══════════════════════════════════════════════════════════════════════════

function getVoiceList() {
  Logger.log('[getVoiceList] Fetching from /v1/voices');
  var apiKey = getApiKey();
  var options = {
    method: 'get',
    headers: { 'xi-api-key': apiKey },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(CONFIG.API_BASE + '/voices', options);
  if (response.getResponseCode() !== 200) {
    Logger.log('[getVoiceList] API error: ' + response.getResponseCode());
    throw new Error('Failed to fetch voices: ' + response.getResponseCode());
  }

  var data = JSON.parse(response.getContentText());

  var voices = (data.voices || []).map(function(v) {
    var labelParts = [];
    if (v.labels) {
      if (v.labels.accent) labelParts.push(v.labels.accent);
      if (v.labels.gender) labelParts.push(v.labels.gender);
      if (v.labels.description) labelParts.push(v.labels.description);
    }
    return {
      voice_id: v.voice_id,
      name: v.name,
      description: labelParts.join(', '),
      category: v.category || ''
    };
  });

  Logger.log('[getVoiceList] Fetched ' + voices.length + ' voices');
  return voices;
}

function getLastUsedVoiceId() {
  return PropertiesService.getUserProperties().getProperty('LAST_VOICE_ID') || '';
}

function saveLastUsedVoiceId(voiceId) {
  if (voiceId) {
    PropertiesService.getUserProperties().setProperty('LAST_VOICE_ID', voiceId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SIDEBAR HTML
// ═══════════════════════════════════════════════════════════════════════════

function getSidebarHtml() {
  return '<!DOCTYPE html>\
<html>\
<head>\
<style>\
  * { box-sizing: border-box; margin: 0; padding: 0; }\
  body { font-family: "Google Sans", Arial, sans-serif; padding: 16px; background: #fafafa; color: #333; font-size: 13px; }\
  h2 { font-size: 16px; margin-bottom: 12px; color: #0a0a09; }\
  h3 { font-size: 13px; margin: 16px 0 8px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }\
  .field { margin-bottom: 10px; }\
  label { display: block; font-size: 11px; font-weight: 600; color: #666; margin-bottom: 3px; text-transform: uppercase; }\
  input, select, textarea { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; background: #fff; }\
  textarea { resize: vertical; min-height: 50px; }\
  input:focus, select:focus, textarea:focus { outline: none; border-color: #C5A255; box-shadow: 0 0 0 2px rgba(197,162,85,0.15); }\
  .btn { width: 100%; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 8px; }\
  .btn-primary { background: linear-gradient(135deg, #C5A255, #F7BE68); color: #0a0a09; }\
  .btn-primary:hover { opacity: 0.9; }\
  .btn-secondary { background: #e8e8e8; color: #333; }\
  .btn-secondary:hover { background: #ddd; }\
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }\
  .status { padding: 10px; border-radius: 6px; margin-top: 12px; font-size: 12px; }\
  .status-ok { background: #e8f5e9; color: #2e7d32; }\
  .status-err { background: #fce4ec; color: #c62828; }\
  .status-info { background: #e3f2fd; color: #1565c0; }\
  .divider { border: none; border-top: 1px solid #eee; margin: 16px 0; }\
  .count { font-size: 24px; font-weight: 700; color: #C5A255; }\
  .row { display: flex; gap: 8px; }\
  .row .field { flex: 1; }\
  .history-item { padding: 8px; background: #fff; border: 1px solid #eee; border-radius: 6px; margin-bottom: 6px; }\
  .history-item .name { font-weight: 600; }\
  .history-item .meta { font-size: 11px; color: #888; }\
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }\
  .badge-pending { background: #fff3e0; color: #e65100; }\
  .badge-completed { background: #e8f5e9; color: #2e7d32; }\
  .badge-in_progress { background: #e3f2fd; color: #1565c0; }\
  .badge-failed { background: #fce4ec; color: #c62828; }\
</style>\
</head>\
<body>\
<h2>☎ ElevenLabs Calling</h2>\
<div id="statusBox"></div>\
\
<h3>Event Details</h3>\
<div class="field"><label>Caller Name</label><input id="caller_name" value="Sarah" /></div>\
<div class="field"><label>Voice</label>\
  <select id="voice_id">\
    <option value="">Loading voices...</option>\
  </select>\
</div>\
<div class="row">\
  <div class="field"><label>Host Name</label><input id="host_name" placeholder="Full name" /></div>\
  <div class="field"><label>Host First Name</label><input id="host_first_name" placeholder="First name" /></div>\
</div>\
<div class="field"><label>Event Name</label><input id="event_name" placeholder="e.g. CIO Roundtable" /></div>\
<div class="row">\
  <div class="field"><label>Event Date</label><input id="event_date" type="date" /></div>\
  <div class="field"><label>Event Time</label><input id="event_time" type="time" /></div>\
</div>\
<div class="row">\
  <div class="field"><label>City</label><input id="event_city" /></div>\
  <div class="field"><label>Area</label><input id="event_area" /></div>\
</div>\
<div class="field"><label>Venue</label><input id="event_venue" /></div>\
<div class="field"><label>Format</label>\
  <select id="event_format">\
    <option value="roundtable">Roundtable</option>\
    <option value="dinner">Dinner</option>\
    <option value="breakfast">Breakfast</option>\
    <option value="lunch">Lunch</option>\
    <option value="virtual roundtable">Virtual Roundtable</option>\
  </select>\
</div>\
<div class="field"><label>Topic / Context</label><textarea id="event_context" placeholder="What the discussion is about..."></textarea></div>\
<div class="field"><label>Target Audience</label><input id="target_audience" placeholder="e.g. CIOs and CTOs" /></div>\
\
<hr class="divider" />\
\
<h3>Schedule</h3>\
<div class="field"><label>When to call</label>\
  <select id="schedule_mode" onchange="toggleSchedule()">\
    <option value="now">Send Immediately</option>\
    <option value="later">Schedule for Later</option>\
  </select>\
</div>\
<div class="field" id="scheduleField" style="display:none">\
  <label>Scheduled Time</label>\
  <input id="scheduled_time" type="datetime-local" />\
</div>\
\
<button class="btn btn-primary" id="submitBtn" onclick="submit()">Submit Batch Call</button>\
<button class="btn btn-secondary" onclick="refreshStatus()">Check Latest Batch Status</button>\
\
<hr class="divider" />\
<h3>Recent Batches</h3>\
<div id="historyList"><em>Click "Check Latest Batch Status" to load...</em></div>\
\
<script>\
function toggleSchedule() {\
  document.getElementById("scheduleField").style.display =\
    document.getElementById("schedule_mode").value === "later" ? "block" : "none";\
}\
\
function showStatus(msg, type) {\
  var box = document.getElementById("statusBox");\
  box.className = "status status-" + type;\
  box.innerHTML = msg;\
}\
\
function submit() {\
  var btn = document.getElementById("submitBtn");\
  btn.disabled = true;\
  btn.textContent = "Submitting...";\
  showStatus("Preparing batch call...", "info");\
\
  var eventVars = {\
    caller_name: document.getElementById("caller_name").value,\
    host_name: document.getElementById("host_name").value,\
    host_first_name: document.getElementById("host_first_name").value,\
    event_name: document.getElementById("event_name").value,\
    event_date: document.getElementById("event_date").value,\
    event_time: document.getElementById("event_time").value,\
    event_city: document.getElementById("event_city").value,\
    event_area: document.getElementById("event_area").value,\
    event_venue: document.getElementById("event_venue").value,\
    event_format: document.getElementById("event_format").value,\
    event_context: document.getElementById("event_context").value,\
    target_audience: document.getElementById("target_audience").value,\
    voice_id: document.getElementById("voice_id").value,\
    timezone: "Europe/London",\
  };\
\
  if (document.getElementById("schedule_mode").value === "later") {\
    eventVars.scheduled_time = document.getElementById("scheduled_time").value;\
  }\
\
  google.script.run\
    .withSuccessHandler(function(result) {\
      btn.disabled = false;\
      btn.textContent = "Submit Batch Call";\
      showStatus("Batch submitted! ID: " + result.batchId + "<br>" + result.recipientCount + " calls " + (result.status || "pending"), "ok");\
      refreshStatus();\
    })\
    .withFailureHandler(function(err) {\
      btn.disabled = false;\
      btn.textContent = "Submit Batch Call";\
      showStatus("Error: " + err.message, "err");\
    })\
    .submitBatchCall(eventVars, false);\
}\
\
function refreshStatus() {\
  google.script.run\
    .withSuccessHandler(function(batches) {\
      var html = "";\
      if (!batches || batches.length === 0) {\
        html = "<em>No batches found.</em>";\
      } else {\
        batches.slice(0, 10).forEach(function(b) {\
          html += \'<div class="history-item">\' +\
            \'<div class="name">\' + (b.name || b.id) + \'</div>\' +\
            \'<div class="meta">\' +\
              \'<span class="badge badge-\' + b.status + \'">\' + b.status + \'</span> \' +\
              b.finished + \'/\' + b.total + \' calls\' +\
            \'</div></div>\';\
        });\
      }\
      document.getElementById("historyList").innerHTML = html;\
    })\
    .withFailureHandler(function(err) {\
      document.getElementById("historyList").innerHTML = "<em>Error: " + err.message + "</em>";\
    })\
    .listBatchCalls();\
}\
\
google.script.run\
  .withSuccessHandler(function(voices) {\
    var sel = document.getElementById("voice_id");\
    sel.innerHTML = "";\
    var def = document.createElement("option");\
    def.value = "";\
    def.textContent = "Agent default voice";\
    sel.appendChild(def);\
    (voices || []).forEach(function(v) {\
      var opt = document.createElement("option");\
      opt.value = v.voice_id;\
      opt.textContent = v.name + (v.description ? " - " + v.description : "");\
      sel.appendChild(opt);\
    });\
  })\
  .withFailureHandler(function(err) {\
    var sel = document.getElementById("voice_id");\
    sel.innerHTML = "";\
    var opt = document.createElement("option");\
    opt.value = "";\
    opt.textContent = "Error loading voices";\
    sel.appendChild(opt);\
  })\
  .getVoiceList();\
</script>\
</body>\
</html>';
}
