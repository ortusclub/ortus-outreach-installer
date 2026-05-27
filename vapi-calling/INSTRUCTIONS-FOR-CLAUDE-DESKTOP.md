# Instructions for Claude Desktop

I need you to take my complete VAPI calling Google Apps Script (Code.gs) and apply 5 critical fixes to it. Output the COMPLETE fixed file — every single line, nothing removed, nothing summarized. I will copy-paste your output directly into my Apps Script editor.

## The code to fix

I will paste my complete Code.gs below these instructions. It's about 3,500 lines.

## Fixes to apply

### FIX 1 (CR-03): Replace the entire HEADER_ALIASES object

Find `const HEADER_ALIASES = {` and replace the entire object (down to the closing `};`) with this cleaned version that removes ambiguous aliases:

```javascript
const HEADER_ALIASES = {
  prospect_name: ['prospect_name', 'prospect name', 'prospectname', 'first name', 'firstname'],
  prospect_last_name: ['prospect_last_name', 'last name', 'lastname', 'surname'],
  prospect_email: ['prospect_email', 'prospect email', 'email', 'prospectemail'],
  email_verification: ['email_verification', 'email verification', 'verification score', 'email score'],
  phone: ['first phone', 'phone number'],
  first_phone_validation: ['first_phone_validation', 'first phone validation', 'phone validation'],
  status: ['call status', 'call_status', 'vapi status', 'vapi_status'],
  lead_status: ['lead status', 'lead_status'],
  assistant: ['assistant'],
  vapi_number: ['vapi number', 'vapi phone', 'caller number'],
  call_id: ['vapi caller id', 'vapi call id', 'call id'],
  started_at: ['started at', 'call started'],
  ended_at: ['ended at', 'call ended'],
  outcome_summary: ['outcome', 'summary', 'call summary'],
  transcript: ['transcript'],
  recording_url: ['recording url', 'recording link', 'recording'],
  record_id: ['record_id', 'record id', 'id'],
  domain: ['domain'],
  priority_company: ['priority (company)', 'priority company', 'company priority'],
  priority_role: ['priority (role)', 'priority role', 'role priority'],
  priority: ['priority'],
  company_name: ['company_name', 'company name', 'company'],
  job_title: ['job_title', 'job title'],
  linkedin_bio: ['linkedin_bio', 'linkedin bio', 'bio'],
  whatsapp_url: ['whatsapp_url', 'whatsapp url', 'whatsapp'],
  linkedin_membership_id: ['linkedin_membership_id', 'linkedin membership id', 'linkedin id'],
  location: ['location'],
  notes: ['notes', 'note'],
  secondary_emails: ['secondary_emails', 'secondary emails'],
  hubspot_url: ['hubspot_url', 'hubspot url', 'hubspot'],
  ortus_membership: ['ortus_membership', 'ortus membership'],
  current_tag: ['current_tag', 'current tag', 'tag'],
  open_profile: ['open_profile', 'open profile'],
  linkedin_connections: ['linkedin_1st_connections', 'linkedin 1st connections', 'connections'],
  client_lead_status: ['client_lead_status', 'client lead status'],
  additional_emails: ['additional_email_addresses', 'additional email addresses'],
  event_name: ['event_name', 'event name'],
  event_date: ['event_date', 'event date'],
  event_city: ['event_city', 'event city'],
  event_time: ['event_time', 'event time'],
  event_format: ['event_format', 'event format'],
  event_context: ['event_context', 'event context', 'context', 'topic'],
  event_area: ['event_area', 'event area'],
  event_venue: ['event_venue', 'event venue', 'venue', 'restaurant'],
  target_audience: ['target_audience', 'target audience', 'audience'],
  caller_name: ['caller_name', 'caller name', 'caller', 'sender', 'owner'],
  host_name: ['host_name', 'host name'],
  host_first_name: ['host_first_name', 'host first name', 'host firstname'],
  host_pronouns: ['host_pronouns', 'host pronouns', 'pronouns'],
  scheduled_at: ['scheduled_at', 'scheduled at', 'schedule at'],
  scheduled_in_min: ['scheduled_in_min', 'scheduled in min', 'minutes until call', 'mins until call'],
  callback_flag: ['callback_flag', 'callback flag', 'callback'],
  callback_when: ['callback_when', 'callback when', 'callback time', 'call back when', 'call back time'],
  voicemail_left_count: ['voicemail_left_count', 'voicemail left count', 'voicemail count'],
  call_attempt: ['call_attempt', 'call attempt', 'attempt', 'round'],
  lead_quality: ['lead_quality', 'lead quality', 'quality', 'lead flag', 'flag'],
  corrected_email: ['corrected_email', 'corrected email', 'new email', 'updated email', 'verified email'],
  auto_followup_status: ['auto_followup_status', 'auto followup status', 'followup status'],
  auto_followup_preview: ['auto_followup_preview', 'auto followup preview', 'followup preview', 'followup message'],
  batch_id: ['batch_id', 'batch id', 'batchid'],
  second_round_delay_min: ['second_round_delay_min', 'second round delay min', '2nd round delay'],
  second_round_scheduled_at: ['second_round_scheduled_at', 'second round scheduled at', '2nd round scheduled'],
  second_round_status: ['second_round_status', 'second round status', '2nd round status'],
  campaign_status: ['campaign_status', 'campaign status', 'round status', 'multi round status'],
  next_round_at: ['next_round_at', 'next round at', 'next round', 'next call round'],
};
```

What was removed: `'city'` and `'region'` from `location` (they collided with `event_city` and `event_area`). `'name'` from `prospect_name`. `'title'` and `'role'` from `job_title`. `'date'` from `event_date`. `'time'` from `event_time`. `'format'` from `event_format`. `'area'` and `'region area'` from `event_area`. `'location venue'` from `event_venue`.

### FIX 2 (CR-04): Remove the duplicate budget check in processQueueForSheet_

Inside `processQueueForSheet_`, find this duplicated block (it appears TWICE before the `while` loop):

```javascript
    if (!isUnderBudget_()) {
      updateStatus_({ 'Script Status': '...' }, sheetName);
      sp.setProperty(qKey, JSON.stringify(queue));
      return;
    }
```

Remove the duplicate so only ONE budget check remains before the while loop. Keep the one inside the while loop (after each call) as-is.

### FIX 3 (CR-01 + CR-05): Replace the entire doPost function

Replace the entire `function doPost(e) { ... }` with this version that adds:
- Webhook payload validation (CR-05)
- Idempotency check for VAPI retries (new)
- Lock around the active map read/modify/write section (CR-01)
- Returns 200 even on errors so VAPI doesn't retry forever

```javascript
function doPost(e) {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  let sheetName = null;
  try {
    // CR-05: Validate payload
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) return ContentService.createTextOutput('Ignored: empty');
    let body;
    try { body = JSON.parse(raw); } catch (parseErr) { return ContentService.createTextOutput('OK'); }
    const msg = body.message || body || {};
    const type = String(msg.type || (msg.message ? msg.message.type : '') || '').trim();
    const isEnd = (type === 'end-of-call-report' || type === 'call-ended' || type === 'call.ended');
    if (!isEnd) return ContentService.createTextOutput('Ignored: ' + (type || 'no-type'));
    const call = msg.call || (msg.message ? msg.message.call : {}) || {};
    const meta = call.metadata || msg.metadata || (msg.message ? msg.message.metadata : {}) || {};
    const callId = String(call.id || msg.callId || (msg.message ? msg.message.callId : '') || '').trim();
    if (!callId || !sheetId) return ContentService.createTextOutput('OK');
    // Idempotency: skip duplicate webhooks from VAPI retries
    const idempotencyKey = 'WEBHOOK_PROCESSED__' + callId;
    if (sp.getProperty(idempotencyKey)) return ContentService.createTextOutput('OK');
    const ss = SpreadsheetApp.openById(sheetId);
    let sh = null;
    let rowNum = Number(meta.rowNum || 0);
    if (meta.sheetName) sh = ss.getSheetByName(meta.sheetName);
    if (!sh || !rowNum) { for (let i = 0; i < ss.getSheets().length; i++) { const candidate = ss.getSheets()[i]; const r = findRowByCallId_(candidate, callId); if (r) { sh = candidate; rowNum = r; break; } } }
    if (!sh || !rowNum) return ContentService.createTextOutput('Error: Could not locate row');
    sheetName = sh.getName();
    const cols = getHeaderMap_(sh);
    if (!cols.status) return ContentService.createTextOutput('Error: Missing Status header');
    const transcript = (msg.artifact ? msg.artifact.transcript : '') || (msg.message && msg.message.artifact ? msg.message.artifact.transcript : '') || (call.artifact ? call.artifact.transcript : '') || '';
    const recordingUrl = (msg.artifact ? (msg.artifact.recordingUrl || msg.artifact.recording_url) : '') || (msg.message && msg.message.artifact ? msg.message.artifact.recordingUrl : '') || (call.artifact ? call.artifact.recordingUrl : '') || '';
    let summary = (msg.analysis ? msg.analysis.summary : '') || (msg.message && msg.message.analysis ? msg.message.analysis.summary : '') || (call.analysis ? call.analysis.summary : '') || '';
    let startedAt = null;
    if (cols.started_at) { const v = sh.getRange(rowNum, cols.started_at).getValue(); if (v instanceof Date) startedAt = v; }
    const extracted = extractStructured_(msg);
    if (!extracted.corrected_email && transcript) {
      const emailFromTranscript = extractCorrectedEmailFromTranscript_(transcript);
      if (emailFromTranscript) extracted.corrected_email = emailFromTranscript;
    }
    if (cols.corrected_email && extracted.corrected_email) {
      const originalEmail = cols.prospect_email ? String(sh.getRange(rowNum, cols.prospect_email).getValue() || '').trim().toLowerCase() : '';
      if (extracted.corrected_email !== originalEmail) sh.getRange(rowNum, cols.corrected_email).setValue(extracted.corrected_email);
    }
    if (extracted.callback_requested && extracted.callback_when) {
      const tag = 'Callback requested: ' + extracted.callback_when;
      const s = String(summary || '').trim();
      if (s.toLowerCase().indexOf('callback requested') === -1) summary = s ? (tag + ' | ' + s) : tag;
    }
    if (detectNumberFailed_(transcript, summary)) {
      const s = String(summary || '').trim();
      if (s.toLowerCase().indexOf('number failed') === -1) summary = 'Number failed: ' + (s || 'Call could not be completed.');
    }
    const batchId = cols.batch_id ? String(sh.getRange(rowNum, cols.batch_id).getValue() || '').trim() : '';
    const isSecondRound = batchId.endsWith('_R2');
    const callAttempt = cols.call_attempt ? Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 0) : 0;
    const currentVoicemailCount = cols.voicemail_left_count ? Number(sh.getRange(rowNum, cols.voicemail_left_count).getValue() || 0) : 0;
    let previousStatus = '';
    if (isSecondRound) previousStatus = currentVoicemailCount >= 1 ? 'Voicemail' : 'No Answer';
    const statusValue = determineStatus_(msg, transcript, summary, startedAt, { isSecondRound: isSecondRound, callAttempt: callAttempt, voicemailLeftCount: currentVoicemailCount, previousStatus: previousStatus });
    let leadQuality = '';
    if (extracted.success === true) leadQuality = 'GOOD';
    else if (extracted.success === false) leadQuality = 'BAD';
    else leadQuality = calculateLeadQuality_(statusValue, extracted.outcome, extracted.callback_requested, summary + ' ' + transcript);
    if (statusValue === 'Voicemail' && cols.voicemail_left_count) {
      const currentCount = Number(sh.getRange(rowNum, cols.voicemail_left_count).getValue() || 0);
      sh.getRange(rowNum, cols.voicemail_left_count).setValue(currentCount + 1);
    }
    if (cols.call_attempt) {
      const currentAttempt = Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 0);
      if (currentAttempt === 0) sh.getRange(rowNum, cols.call_attempt).setValue(1);
    }
    let finalStatus = statusValue;
    if (cols.call_attempt) {
      const attempt = Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 1);
      if (attempt > 1) finalStatus = statusValue + getRoundSuffix_(attempt);
    }
    sh.getRange(rowNum, cols.status).setValue(finalStatus);
    if (cols.ended_at) sh.getRange(rowNum, cols.ended_at).setValue(new Date());
    if (cols.outcome_summary) sh.getRange(rowNum, cols.outcome_summary).setValue(summary || '');
    if (cols.transcript) sh.getRange(rowNum, cols.transcript).setValue(transcript || '');
    if (cols.recording_url) sh.getRange(rowNum, cols.recording_url).setValue(recordingUrl || '');
    if (callId) {
      const apiKey = sp.getProperty('VAPI_API_KEY');
      const cost = getCallCostFromVapi_(apiKey, callId);
      if (cost > 0) { addToDailySpend_(cost); Logger.log('Call cost: $' + cost.toFixed(4) + ' | Daily: $' + getDailySpend_().toFixed(2)); }
    }
    if (cols.lead_quality) sh.getRange(rowNum, cols.lead_quality).setValue(leadQuality || '');
    if (cols.next_round_at) {
      const baseStatus = getBaseStatus_(finalStatus);
      if (shouldSkipStatus_(baseStatus)) sh.getRange(rowNum, cols.next_round_at).setValue('⏭️ To be Skipped');
    }
    applyRowHygiene_(sh, rowNum, cols);
    // Auto follow-up trigger
    if (AUTO_FOLLOWUP_TRIGGER_STATUSES.indexOf(statusValue) !== -1) {
      const lastCol = sh.getLastColumn();
      const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
      const originalEmail = cols.prospect_email ? String(rowVals[cols.prospect_email - 1] || '').trim() : '';
      const emailToUse = extracted.corrected_email || originalEmail;
      const emailVerificationCol = cols.email_verification || null;
      let emailVerificationScore = null;
      if (emailVerificationCol) { emailVerificationScore = Number(rowVals[emailVerificationCol - 1]); if (isNaN(emailVerificationScore)) emailVerificationScore = null; }
      const prospectData = {
        prospectName: cols.prospect_name ? String(rowVals[cols.prospect_name - 1] || '').trim() : '',
        prospectEmail: emailToUse,
        phone: cols.phone ? normalizePhone_(rowVals[cols.phone - 1]) : '',
        eventName: cols.event_name ? String(rowVals[cols.event_name - 1] || '').trim() : '',
        eventDate: cols.event_date ? formatEventDate_(rowVals[cols.event_date - 1]) : '',
        eventCity: cols.event_city ? String(rowVals[cols.event_city - 1] || '').trim() : '',
        eventTime: cols.event_time ? formatEventTime_(rowVals[cols.event_time - 1]) : '',
        eventVenue: cols.event_venue ? String(rowVals[cols.event_venue - 1] || '').trim() : '',
        callerName: cols.caller_name ? String(rowVals[cols.caller_name - 1] || '').trim() : '',
        hostName: cols.host_name ? String(rowVals[cols.host_name - 1] || '').trim() : '',
        batchId: cols.batch_id ? String(rowVals[cols.batch_id - 1] || '').trim() : '',
        emailVerificationScore: emailVerificationScore
      };
      scheduleAutoFollowup_(sheetId, sheetName, rowNum, statusValue, prospectData);
    }
    // CR-01 FIX: Lock the shared active/queue state update
    let needsMoreProcessing = false, isComplete = false, concurrency = 1;
    const criticalLock = LockService.getScriptLock();
    const hasLock = criticalLock.tryLock(15000);
    if (!hasLock) Logger.log('WARNING: doPost could not acquire lock after 15s for call ' + callId);
    try {
      const aKey = activeKey_(sheetId, sheetName);
      let active = loadJson_(sp, aKey, {});
      if (callId && active[callId]) { delete active[callId]; sp.setProperty(aKey, JSON.stringify(active)); }
      concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 0);
      if (!concurrency) concurrency = Number(sp.getProperty(schedConcurrencyKey_(sheetId)) || 1);
      if (concurrency < 1) concurrency = 1;
      const queue = loadJson_(sp, queueKey_(sheetId, sheetName), []);
      const activeCount = Object.keys(active).length;
      const queueCount = queue.length;
      updateStatus_({ 'Active Calls': activeCount, 'Queued Rows': queueCount }, sheetName);
      needsMoreProcessing = (queueCount > 0 && activeCount < concurrency);
      isComplete = (queueCount === 0 && activeCount === 0);
    } finally { if (hasLock) criticalLock.releaseLock(); }
    // Mark webhook as processed (idempotency)
    sp.setProperty(idempotencyKey, String(Date.now()));
    // Resume queue or mark complete OUTSIDE the lock
    if (needsMoreProcessing) {
      processQueueForSheet_(ss, sh, sp.getProperty('VAPI_API_KEY'), sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
    }
    if (isComplete) {
      updateStatus_({ 'Script Status': '✅ Complete', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName);
      sp.deleteProperty(processingKey_(sheetId, sheetName));
      autoSortIfBatchComplete_(sheetId, sheetName);
    }
    return ContentService.createTextOutput('OK');
  } catch (err) {
    if (sheetName) updateStatus_({ 'Last Error': 'Webhook: ' + (err.message || String(err)) }, sheetName);
    Logger.log('doPost ERROR: ' + (err.message || String(err)));
    return ContentService.createTextOutput('OK');
  }
}
```

### FIX 4 (CR-02): Replace the entire startSecondRoundAutomatically_ function

Replace the entire `function startSecondRoundAutomatically_(config) { ... }` with this version that uses the queue instead of calling triggerVapiCall_ directly:

```javascript
function startSecondRoundAutomatically_(config) {
  const ss = SpreadsheetApp.openById(config.sheetId);
  const sh = ss.getSheetByName(config.sheetName);
  if (!sh) { Logger.log('Sheet not found: ' + config.sheetName); return; }
  const cols = getHeaderMap_(sh);
  if (!cols.batch_id || !cols.status) { Logger.log('Missing batch_id or status column'); return; }
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) { Logger.log('No data rows'); return; }
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
  const sp = PropertiesService.getScriptProperties();
  const fieldsToClear = ['call_id', 'started_at', 'ended_at', 'transcript', 'outcome_summary', 'recording_url', 'callback_flag', 'callback_when', 'scheduled_at', 'scheduled_in_min', 'auto_followup_status', 'auto_followup_preview'];
  const rowsToQueue = [];
  Logger.log('Checking ' + data.length + ' rows for batch: ' + config.batchId);
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = HEADER_ROW_INDEX + 1 + i;
    const rowBatchId = String(row[cols.batch_id - 1] || '').trim();
    const status = String(row[cols.status - 1] || '').trim().toLowerCase();
    if (rowBatchId !== config.batchId) continue;
    const shouldSkip = DO_NOT_CALL_AGAIN_STATUSES.some(function(s) { return status.includes(s); });
    if (shouldSkip) {
      const currentStatus = String(row[cols.status - 1] || '').trim();
      row[cols.status - 1] = '⏭️ Skipped 2nd (' + currentStatus + ')';
      if (cols.second_round_status) row[cols.second_round_status - 1] = '⏭️ Skipped (' + currentStatus + ')';
      continue;
    }
    const shouldCall = config.statuses.some(function(s) { return status.includes(s.toLowerCase()); });
    const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag - 1] || '').trim().toUpperCase() : '';
    const callbackRequested = (callbackFlag === 'TRUE') && config.statuses.includes('callback');
    if (shouldCall || callbackRequested) {
      let assistantToUse = cols.assistant ? String(row[cols.assistant - 1] || '').trim() : '';
      if (status.includes('voicemail') && config.voicemailAssistant) assistantToUse = config.voicemailAssistant;
      row[cols.status - 1] = 'Queued';
      if (cols.assistant && assistantToUse) row[cols.assistant - 1] = assistantToUse;
      if (cols.call_attempt) row[cols.call_attempt - 1] = Number(row[cols.call_attempt - 1] || 0) + 1;
      fieldsToClear.forEach(function(field) { if (cols[field]) row[cols[field] - 1] = ''; });
      row[cols.batch_id - 1] = config.batchId + '_R2';
      rowsToQueue.push(rowNum);
    }
  }
  if (rowsToQueue.length === 0) { Logger.log('No rows for 2nd round'); return; }
  sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
  SpreadsheetApp.flush();
  // CR-02 FIX: Queue rows through standard system instead of direct API calls
  const qKey = queueKey_(config.sheetId, config.sheetName);
  let queue = loadJson_(sp, qKey, []);
  rowsToQueue.forEach(function(rowNum) { if (queue.indexOf(rowNum) === -1) queue.push(rowNum); });
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  const concurrency = Number(sp.getProperty(concurrencyKey_(config.sheetId, config.sheetName)) || 1);
  sp.setProperty(concurrencyKey_(config.sheetId, config.sheetName), String(concurrency));
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (apiKey) {
    processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
  }
  Logger.log('Queued ' + rowsToQueue.length + ' rows for 2nd round of batch ' + config.batchId);
}
```

### FIX 5 (WR-05): Replace the entire autoSortIfBatchComplete_ function

Replace the entire `function autoSortIfBatchComplete_(sheetId, sheetName) { ... }` with this version that adds a lock to prevent concurrent sorts:

```javascript
function autoSortIfBatchComplete_(sheetId, sheetName) {
  // WR-05 FIX: Lock to prevent concurrent sorts corrupting row order
  const sortLock = LockService.getScriptLock();
  if (!sortLock.tryLock(5000)) {
    Logger.log('autoSortIfBatchComplete_: Another sort is running, skipping');
    return;
  }
  try {
    Logger.log('autoSortIfBatchComplete_ called for sheet: ' + sheetName);
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheetByName(sheetName);
    if (!sh) { Logger.log('Sheet not found: ' + sheetName); return; }
    const cols = getHeaderMap_(sh);
    if (!cols.status) { Logger.log('No status column'); return; }
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) { Logger.log('No data rows'); return; }
    const lastCol = sh.getLastColumn();
    const dataRange = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol);
    const data = dataRange.getValues();
    const hasActiveCall = data.some(function(row) {
      const status = String(row[cols.status - 1] || '').trim().toLowerCase();
      return status === 'queued' || status === 'calling...' || status === 'calling';
    });
    if (hasActiveCall) { Logger.log('Still has active calls, skipping sort'); return; }
    const sp = PropertiesService.getScriptProperties();
    let shouldSort = false;
    let batchIdsToClean = [];
    if (cols.batch_id) {
      const batchIds = new Set();
      data.forEach(function(row) {
        const batchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R\d+$/, '');
        if (batchId) batchIds.add(batchId);
      });
      batchIds.forEach(function(batchId) {
        const autoSortSetting = sp.getProperty('BATCH_AUTOSORT_' + batchId);
        if (autoSortSetting === 'true') { shouldSort = true; batchIdsToClean.push(batchId); }
        const multiRoundConfigStr = sp.getProperty('MULTI_ROUND_' + batchId);
        if (multiRoundConfigStr) { try { const config = JSON.parse(multiRoundConfigStr); if (config.autoSort !== false) { shouldSort = true; batchIdsToClean.push(batchId); } } catch (e) {} }
        const secondRoundConfigStr = sp.getProperty('SECOND_ROUND_' + batchId);
        if (secondRoundConfigStr) { try { const config = JSON.parse(secondRoundConfigStr); if (config.autoSort !== false) { shouldSort = true; batchIdsToClean.push(batchId); } } catch (e) {} }
      });
    } else { shouldSort = true; }
    if (!shouldSort) { Logger.log('Auto-sort not enabled'); return; }
    Logger.log('Performing auto-sort...');
    const sortedData = data.map(function(row, idx) { return { row: row, originalIndex: idx }; }).sort(function(a, b) {
      const statusA = String(a.row[cols.status - 1] || '').trim().toLowerCase();
      const statusB = String(b.row[cols.status - 1] || '').trim().toLowerCase();
      const priorityA = getStatusPriority_(statusA);
      const priorityB = getStatusPriority_(statusB);
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.originalIndex - b.originalIndex;
    }).map(function(item) { return item.row; });
    dataRange.setValues(sortedData);
    SpreadsheetApp.flush();
    Logger.log('Auto-sort completed');
    batchIdsToClean.forEach(function(batchId) { sp.deleteProperty('BATCH_AUTOSORT_' + batchId); });
  } catch (e) {
    Logger.log('Error in autoSortIfBatchComplete_: ' + e.message);
  } finally {
    sortLock.releaseLock();
  }
}
```

### FIX 6 (BONUS): Add cleanupOldWebhookKeys_ function and integrate into watchdog

Add this new function anywhere in the file:

```javascript
function cleanupOldWebhookKeys_() {
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const key in allProps) {
    if (!key.startsWith('WEBHOOK_PROCESSED__')) continue;
    if (Number(allProps[key] || 0) < oneHourAgo) sp.deleteProperty(key);
  }
}
```

And at the very top of the `vapiWatchdog_()` function, add this line:

```javascript
cleanupOldWebhookKeys_();
```

### FIX 7 (BONUS): Fix the header comment typo

Change `heartbeatnp0` to `heartbeat` in the header comment.

### FIX 8 (BONUS): Remove double removeWatchdog_ call in vapiWatchdog_

In `vapiWatchdog_()`, near the end where it handles completion, there are two `removeWatchdog_()` calls. Remove one so only one remains.

## Output instructions

1. Apply ALL fixes above to the code I paste below
2. Output the COMPLETE fixed file — every single function, every HTML dialog, nothing removed
3. Do NOT summarize or shorten any function — output them in full
4. The version header should say 4.1 instead of 4.0
5. Do NOT add any markdown formatting or code fences around the output — just output raw JavaScript that I can paste directly into Apps Script

## My current Code.gs

PASTE YOUR COMPLETE CODE.GS BELOW THIS LINE: /** ======================================================================
 * VAPI CALLING + OUTREACH WIZARDS — UNIFIED SCRIPT
 * 
 * Version: 4.0
 *
 * FEATURES:
 * ✅ VAPI AI Calling with queue management
 * ✅ Email follow-up wizard (Gmail)
 * ✅ SMS follow-up wizard (Twilio)
 * ✅ Combined Email + SMS wizard
 * ✅ 2nd round calling support
 * ✅ AI Gatekeeper detection
 * ✅ Lead quality scoring (GOOD/BAD)
 * ✅ Execution monitoring & heartbeatnp0
 * ✅ Smart callback selection
 * ✅ AUTO FOLLOW-UP after Voicemail/No Answer (NEW!)
 *
 * REQUIRED SCRIPT PROPERTIES:
 * - VAPI_API_KEY
 * - TWILIO_ACCOUNT_SID (for SMS)
 * - TWILIO_AUTH_TOKEN (for SMS)
 * - TWILIO_FROM_NUMBER (for SMS)
 *
 * NEW COLUMNS FOR AUTO FOLLOW-UP:
 * - auto_followup_status
 * - auto_followup_preview
 *
 * ====================================================================== */

// ============================================================
// CONFIGURATION
// ============================================================

const ASSISTANTS_SHEET_NAME = '_VapiAssistants';
const PHONE_NUMBERS_SHEET_NAME = '_VapiPhoneNumbers';
const STATUS_SHEET_NAME = '_VapiStatus';
const KEY_PREFIX = 'VAPI_QUEUE_CTRL__';
const HEADER_ROW_INDEX = 1;

const STALE_ACTIVE_MINUTES = 10;
const DEFAULT_ROW_HEIGHT = 21;
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PROCESSING_TIME_MS = 5 * 60 * 1000;

const SCORE_THRESHOLD = 95;
const ALLOWED_STATUSES = new Set(["Voicemail", "No Answer", "AI Gatekeeper"]);
const AUTO_FOLLOWUP_TRIGGER_STATUSES = ['Voicemail', 'No Answer'];

const CALLBACK_WORTHY_STATUSES = ['voicemail', 'no answer'];
const DO_NOT_CALL_AGAIN_STATUSES = [
  'spoke to human', 'ai gatekeeper', 'hung up (≤30s)', 
  'hung up', 'number failed', 'cancelled', 'error', 'no answer 2nd'
];

const VAPI_PHONE_NUMBERS = [
  { display: '+65 3129 5117', e164: '+6531295117', id: '612a2ede-3291-4303-8484-6b4ea68c3fc9' },
  { display: '+44 131 381 2021', e164: '+441313812021', id: '75651434-250e-497f-a3ab-d3c086528fc1' },
  { display: '+1 617 600 0320', e164: '+16176000320', id: '365601af-e5d3-41b5-8d39-887503ef64b9' },
];

const HEADER_ALIASES = {
  // NEW: Map your new columns to the internal names
  prospect_name: ['prospect_name', 'prospect name', 'name', 'prospectname', 'first name', 'firstname'],
  prospect_last_name: ['prospect_last_name', 'last name', 'lastname', 'surname'],
  prospect_email: ['prospect_email', 'prospect email', 'email', 'prospectemail'],
  email_verification: ['email_verification', 'email verification', 'verification score', 'email score'],
  phone: ['first phone'],
  first_phone_validation: ['first_phone_validation', 'first phone validation', 'phone validation'],
  
  // Keep all existing mappings...
  status: ['call status', 'call_status', 'vapi status', 'vapi_status'],
  lead_status: ['lead status', 'lead_status'],  // Your CRM lead status - NOT used by VAPI
  assistant: ['assistant'],
  vapi_number: ['vapi number', 'vapi phone', 'caller number'],
  call_id: ['vapi caller id', 'vapi call id', 'call id'],
  started_at: ['started at', 'call started'],
  ended_at: ['ended at', 'call ended'],
  outcome_summary: ['outcome', 'summary', 'call summary'],
  transcript: ['transcript'],
  recording_url: ['recording url', 'recording link', 'recording'],
  
  // NEW: Add mappings for your new columns
  record_id: ['record_id', 'record id', 'id'],
  domain: ['domain'],
  priority_company: ['priority (company)', 'priority company', 'company priority'],
  priority_role: ['priority (role)', 'priority role', 'role priority'],
  priority: ['priority'],
  company_name: ['company_name', 'company name', 'company'],
  job_title: ['job_title', 'job title', 'title', 'role'],
  linkedin_bio: ['linkedin_bio', 'linkedin bio', 'bio'],
  whatsapp_url: ['whatsapp_url', 'whatsapp url', 'whatsapp'],
  linkedin_membership_id: ['linkedin_membership_id', 'linkedin membership id', 'linkedin id'],
  location: ['location', 'city', 'region'],
  notes: ['notes', 'note'],
  secondary_emails: ['secondary_emails', 'secondary emails'],
  hubspot_url: ['hubspot_url', 'hubspot url', 'hubspot'],
  ortus_membership: ['ortus_membership', 'ortus membership'],
  current_tag: ['current_tag', 'current tag', 'tag'],
  open_profile: ['open_profile', 'open profile'],
  linkedin_connections: ['linkedin_1st_connections', 'linkedin 1st connections', 'connections'],
  client_lead_status: ['client_lead_status', 'client lead status'],
  additional_emails: ['additional_email_addresses', 'additional email addresses'],
  
  // Keep all existing event-related mappings...
  event_name: ['event_name', 'event name'],
  event_date: ['event_date', 'event date', 'date'],
  event_city: ['event_city', 'event city', 'city'],
  event_time: ['event_time', 'event time', 'time'],
  event_format: ['event_format', 'event format', 'format'],
  event_context: ['event_context', 'event context', 'context', 'topic'],
  event_area: ['event_area', 'event area', 'area', 'region area'],
  event_venue: ['event_venue', 'event venue', 'venue', 'restaurant', 'location venue'],
  target_audience: ['target_audience', 'target audience', 'audience'],
  caller_name: ['caller_name', 'caller name', 'caller', 'sender', 'owner'],
  host_name: ['host_name', 'host name'],
  host_first_name: ['host_first_name', 'host first name', 'host firstname'],
  host_pronouns: ['host_pronouns', 'host pronouns', 'pronouns'],
  scheduled_at: ['scheduled_at', 'scheduled at', 'schedule at'],
  scheduled_in_min: ['scheduled_in_min', 'scheduled in min', 'minutes until call', 'mins until call'],
  callback_flag: ['callback_flag', 'callback flag', 'callback'],
  callback_when: ['callback_when', 'callback when', 'callback time', 'call back when', 'call back time'],
  voicemail_left_count: ['voicemail_left_count', 'voicemail left count', 'voicemail count'],
  call_attempt: ['call_attempt', 'call attempt', 'attempt', 'round'],
  lead_quality: ['lead_quality', 'lead quality', 'quality', 'lead flag', 'flag'],
  corrected_email: ['corrected_email', 'corrected email', 'new email', 'updated email', 'verified email'],
  auto_followup_status: ['auto_followup_status', 'auto followup status', 'followup status'],
  auto_followup_preview: ['auto_followup_preview', 'auto followup preview', 'followup preview', 'followup message'],
  batch_id: ['batch_id', 'batch id', 'batchid'],
  second_round_delay_min: ['second_round_delay_min', 'second round delay min', '2nd round delay'],
  second_round_scheduled_at: ['second_round_scheduled_at', 'second round scheduled at', '2nd round scheduled'],
  second_round_status: ['second_round_status', 'second round status', '2nd round status'],
  campaign_status: ['campaign_status', 'campaign status', 'round status', 'multi round status'],
  next_round_at: ['next_round_at', 'next round at', 'next round', 'next call round'],
};

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function _s_(v) { return String(v == null ? "" : v).trim(); }
function _n_(v) {
  const num = Number(String(v == null ? "" : v).trim());
  return isNaN(num) ? NaN : num;
}

function _norm_(s) {
  return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function getHeaderMap_(sh) {
  const headerRow = sh.getRange(HEADER_ROW_INDEX, 1, 1, sh.getLastColumn()).getValues()[0];
  const norm = (v) => String(v || '').toLowerCase().replace(/\n+/g, ' ').replace(/_/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const normalized = headerRow.map(norm);
  const map = {};
  Object.keys(HEADER_ALIASES).forEach(key => {
    const aliases = (HEADER_ALIASES[key] || []).map(norm);
    for (let i = 0; i < normalized.length; i++) {
      if (aliases.includes(normalized[i])) { map[key] = i + 1; break; }
    }
  });
  return map;
}

function _buildNormHeaderMap_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const map = {};
  headers.forEach((h, idx) => {
    const raw = String(h || "").trim();
    if (!raw) return;
    map[_norm_(raw)] = { index0: idx, raw };
  });
  return map;
}

function _resolveCol_(normMap, aliasList) {
  for (const a of aliasList) {
    const hit = normMap[_norm_(a)];
    if (hit) return hit;
  }
  return null;
}

function normalizePhone_(p) {
  const s = String(p || '').replace(/[^\d+]/g, '');
  return s ? (s.startsWith('+') ? s : '+' + s) : '';
}

function formatEventDate_(d) {
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMMM d, yyyy');
  return String(d || '').trim();
}

function formatEventTime_(t) {
  if (t instanceof Date) return Utilities.formatDate(t, Session.getScriptTimeZone(), 'h:mm a');
  return String(t || '').trim();
}

function loadJson_(p, k, f) {
  try {
    const raw = p.getProperty(k);
    if (!raw) return f;
    const parsed = JSON.parse(raw);
    return parsed ? parsed : f;
  } catch (e) { return f; }
}

function colToA1_(colNum) {
  let col = colNum, letters = '';
  while (col > 0) {
    const mod = (col - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    col = Math.floor((col - 1) / 26);
  }
  return letters;
}

function getRoundSuffix_(roundNum) {
  if (!roundNum || roundNum <= 1) return '';
  if (roundNum === 2) return ' 2nd';
  if (roundNum === 3) return ' 3rd';
  return ' ' + roundNum + 'th';
}

function getBaseStatus_(status) {
  // Remove round suffixes like "2nd", "3rd", "4th", "5th" from status
  return String(status || '').replace(/\s+(2nd|3rd|4th|5th)$/i, '').trim();
}

function promptConcurrency_(ui, title, defaultVal) {
  const res = ui.prompt(title, 'Enter a number (e.g. 1, 3, 10).\n\nDefault: ' + defaultVal, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return 0;
  const n = Number(String(res.getResponseText() || '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 50) { ui.alert('Please enter a valid number between 1 and 50.'); return 0; }
  return Math.floor(n);
}

function deleteTriggersByHandler_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t); });
}

// ============================================================
// PROPERTY KEYS
// ============================================================

function queueKey_(id, name) { return KEY_PREFIX + 'QUEUE__' + id + '__' + name; }
function activeKey_(id, name) { return KEY_PREFIX + 'ACTIVE__' + id + '__' + name; }
function concurrencyKey_(id, name) { return KEY_PREFIX + 'CONCURRENCY__' + id + '__' + name; }
function processingKey_(id, name) { return KEY_PREFIX + 'PROCESSING__' + id + '__' + name; }
function heartbeatKey_(id, name) { return KEY_PREFIX + 'HEARTBEAT__' + id + '__' + name; }
function processingStartKey_(id, name) { return KEY_PREFIX + 'PROC_START__' + id + '__' + name; }
function schedSheetKey_(id) { return KEY_PREFIX + 'SCHED_SHEET__' + id; }
function schedConcurrencyKey_(id) { return KEY_PREFIX + 'SCHED_CONCURRENCY__' + id; }
function schedStartAtKey_(id) { return KEY_PREFIX + 'SCHED_STARTAT__' + id; }
function autoFollowupConfigKey_(sheetName) { 
  if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  return KEY_PREFIX + 'AUTO_FOLLOWUP_CONFIG__' + sheetName; 
}
function autoFollowupQueueKey_(sheetName) { 
  if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  return KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__' + sheetName; 
}

// ============================================================
// SETUP
// ============================================================

function ensureSheetId_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('SHEET_ID')) sp.setProperty('SHEET_ID', ss.getId());
}

function vapiSetupCheck() {
  ensureSheetId_();
  const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('VAPI_API_KEY')) { SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY'); return; }
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  const required = ['prospect_name', 'prospect_email', 'phone', 'status', 'assistant', 'vapi_number', 'call_id', 'started_at', 'ended_at', 'outcome_summary', 'transcript', 'recording_url', 'event_name', 'event_date', 'event_city', 'caller_name', 'host_name', 'host_first_name', 'host_pronouns', 'event_time', 'event_format', 'target_audience', 'event_area', 'event_venue', 'callback_flag', 'callback_when', 'voicemail_left_count'];
  const missing = required.filter(k => !cols[k]);
  if (missing.length) { SpreadsheetApp.getUi().alert('❌ Missing headers:\n\n' + missing.map(x => '- ' + x).join('\n')); return; }
  const autoFollowupCols = ['auto_followup_status', 'auto_followup_preview'];
  const missingAuto = autoFollowupCols.filter(k => !cols[k]);
  let msg = '✅ Setup OK.\n\nOptional: call_attempt, lead_quality, email_verification';
  if (missingAuto.length) msg += '\n\n⚠️ For auto follow-up, add: ' + missingAuto.join(', ');
  SpreadsheetApp.getUi().alert(msg);
}

// ============================================================
// AUTO FOLLOW-UP SYSTEM
// ============================================================

function openAutoFollowupWizard() {
  const html = HtmlService.createHtmlOutputFromFile("AutoFollowupWizard").setWidth(620).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(html, "⚡ Configure Auto Follow-up");
}

// ============================================================
// AUTO FOLLOW-UP SYSTEM - FIXED
// ============================================================

function getAutoFollowupConfig(sheetName) {
  const sp = PropertiesService.getScriptProperties();
  if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
  if (!config) {
    return {
      enabled: false,
      channels: 'both',  // string: 'email', 'sms', or 'both'
      delayMinutes: 5,
      triggerStatuses: ['Voicemail', 'No Answer'],
      emailSubject: 'Sorry I missed you!',
      emailTemplate: 'Hi <b>{{prospect_name}}</b>,<br><br>I just tried to give you a call about <b>{{event_name}}</b> on {{event_date}} in {{event_city}}, but couldn\'t get through.<br><br>No worries — I know everyone\'s busy! If you have a moment, I\'d love to tell you more about this exclusive event.<br><br>Feel free to reply to this email or let me know a good time to call back.<br><br>Best regards,<br><b>{{caller_name}}</b>',
      smsTemplate: 'Hi {{prospect_name}}! It\'s {{caller_name}} — I just tried calling about {{event_name}} on {{event_date}}. When\'s a good time to chat? Reply here or I\'ll try again soon!'
    };
  }
  return config;
}

function saveAutoFollowupConfig(config, sheetName) {
  const sp = PropertiesService.getScriptProperties();
  if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
  
  // Normalize channels to string format
  let channelsValue = config.channels;
  if (Array.isArray(channelsValue)) {
    if (channelsValue.includes('email') && channelsValue.includes('sms')) {
      channelsValue = 'both';
    } else if (channelsValue.includes('email')) {
      channelsValue = 'email';
    } else if (channelsValue.includes('sms')) {
      channelsValue = 'sms';
    } else {
      channelsValue = 'both';
    }
  }
  
  const validConfig = {
    enabled: Boolean(config.enabled),
    channels: ['email', 'sms', 'both'].includes(channelsValue) ? channelsValue : 'both',
    delayMinutes: Math.max(0, Math.min(1440, Number(config.delayMinutes) || 5)),
    specificTime: config.specificTime || null,
    specificDays: Number(config.specificDays) || 0,
    triggerStatuses: Array.isArray(config.triggerStatuses) ? config.triggerStatuses : ['Voicemail', 'No Answer'],
    emailSubject: String(config.emailSubject || 'Sorry I missed you!').trim(),
    emailTemplate: String(config.emailTemplate || config.emailBody || '').trim(),
    smsTemplate: String(config.smsTemplate || config.smsBody || '').trim()
  };
  sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(validConfig));
  if (validConfig.enabled) setupAutoFollowupTrigger_();
  else removeAutoFollowupTrigger_();
  return { success: true, config: validConfig };
}

function scheduleAutoFollowup_(sheetId, sheetName, rowNum, status, prospectData) {
  const sp = PropertiesService.getScriptProperties();
  const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
  
  Logger.log('scheduleAutoFollowup_ called for row ' + rowNum + ', status: ' + status);
  Logger.log('Config found: ' + (config ? 'YES' : 'NO'));
  
  if (!config || !config.enabled) {
    Logger.log('Auto followup not enabled for sheet: ' + sheetName);
    return;
  }
  
 if (!config.triggerStatuses.includes(status)) {
    Logger.log('Status "' + status + '" not in trigger statuses: ' + config.triggerStatuses.join(', '));
    return;
  }
  
  // Get channels from config and make it modifiable
  var channels = config.channels;
  
  // Check email verification score - only skip if sending EMAIL
  const shouldSendEmail = (channels === 'email' || channels === 'both');

if (shouldSendEmail && prospectData.emailVerificationScore !== undefined && prospectData.emailVerificationScore !== null) {
  const score = Number(prospectData.emailVerificationScore);
  if (isNaN(score) || score <= 95) {
    Logger.log('Skipping email follow-up for row ' + rowNum + ': email_verification score ' + score + ' <= 95');
    
    // If ONLY email, skip entirely
    if (channels === 'email') {
      try {
        const ss = SpreadsheetApp.openById(sheetId);
        const sh = ss.getSheetByName(sheetName);
        if (sh) {
          const cols = getHeaderMap_(sh);
          if (cols.auto_followup_status) {
            sh.getRange(rowNum, cols.auto_followup_status).setValue('⏭️ Skipped (email score ≤95)');
          }
        }
      } catch (e) {
        Logger.log('Error updating skip status: ' + e.message);
      }
      return;
    }
    
    // If 'both', downgrade to SMS only
    if (channels === 'both') {
      Logger.log('Email score too low - sending SMS only for row ' + rowNum);
      channels = 'sms';
    }
  }
}
  
  // Calculate send time
  var sendAt;
  if (config.specificTime) {
    var timeParts = config.specificTime.split(':');
    var targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + (config.specificDays || 0));
    targetDate.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), 0, 0);
    sendAt = targetDate.getTime();
  } else {
    sendAt = Date.now() + ((config.delayMinutes || 0) * 60 * 1000);
  }
  
  // Load existing queue
  const queueKey = autoFollowupQueueKey_(sheetName);
  const queue = loadJson_(sp, queueKey, []);
  
  // Check for existing entry for this row
  const existingIndex = queue.findIndex(function(item) {
    return item.sheetId === sheetId && item.sheetName === sheetName && item.rowNum === rowNum;
  });
  
 const entry = {
  sheetId: sheetId,
  sheetName: sheetName,
  rowNum: rowNum,
  status: status,
  sendAt: sendAt,
  prospectData: prospectData,
  channels: channels,  // Use the modified 'channels' variable, not config.channels
  createdAt: Date.now()
};
  
  if (existingIndex >= 0) {
    queue[existingIndex] = entry;
    Logger.log('Updated existing queue entry for row ' + rowNum);
  } else {
    queue.push(entry);
    Logger.log('Added new queue entry for row ' + rowNum);
  }
  
  // Save queue
  sp.setProperty(queueKey, JSON.stringify(queue));
  Logger.log('Queue saved with ' + queue.length + ' entries');
  
  // Update sheet status
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheetByName(sheetName);
    if (sh) {
      const cols = getHeaderMap_(sh);
      if (cols.auto_followup_status) {
        const timeStr = Utilities.formatDate(new Date(sendAt), Session.getScriptTimeZone(), 'HH:mm');
        sh.getRange(rowNum, cols.auto_followup_status).setValue('⏳ Scheduled ' + timeStr);
      }
      if (cols.auto_followup_preview) {
        sh.getRange(rowNum, cols.auto_followup_preview).setValue(generateFollowupPreview_(config, prospectData));
      }
    }
  } catch (e) {
    Logger.log('Error updating auto followup status: ' + e.message);
  }
}

function processAutoFollowupQueue_() {
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  
  Logger.log('processAutoFollowupQueue_ running...');
  
  // Find all sheet-specific queues
  for (const key in allProps) {
    if (!key.startsWith(KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__')) continue;
    
    // Extract sheet name from key
    const sheetName = key.replace(KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__', '');
    Logger.log('Processing queue for sheet: ' + sheetName);
    
    // Get config for this sheet
    const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
    if (!config || !config.enabled) {
      Logger.log('Config not enabled for sheet: ' + sheetName);
      continue;
    }
    
    // Get queue for this sheet
    const queue = loadJson_(sp, key, []);
    Logger.log('Queue has ' + queue.length + ' items');
    
    if (queue.length === 0) continue;
    
    const now = Date.now();
    const toProcess = [];
    const remaining = [];
    
    queue.forEach(function(item) {
      if (item.sendAt <= now) {
        toProcess.push(item);
      } else {
        remaining.push(item);
      }
    });
    
    Logger.log('Items to process now: ' + toProcess.length + ', remaining: ' + remaining.length);
    
    if (toProcess.length === 0) continue;
    const sentThisRun = new Set();
    
    // Process items for this sheet
    toProcess.forEach(function(item) { 
        try {                                                                                                                                                                       
          const phoneKey = String((item.prospectData && item.prospectData.phone) || '').replace(/[^0-9]/g, '');
          if (phoneKey && sentThisRun.has(phoneKey)) {                                                                                                                              
            Logger.log('Skipping row ' + item.rowNum + ' — already sent to ' + phoneKey + ' in this run');                                                                          
            updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, '⏭️  Skipped (duplicate in same run)');                                                             
            return;                                                                                                                                                                 
          }                                                                                                                                                                         
          Logger.log('Sending auto followup for row ' + item.rowNum);                                                                                                               
          sendAutoFollowup_(item, config);                  
          if (phoneKey) sentThisRun.add(phoneKey);                                                                                                                                  
        } catch (e) {
        Logger.log('Error sending auto followup: ' + e.message);
        updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, '❌ ' + e.message);
      }
    });
    
    // Save remaining queue for this sheet
    sp.setProperty(key, JSON.stringify(remaining));
  }
}

function sendAutoFollowup_(item, config) {
  const prospectData = item.prospectData;
  var channels = item.channels || config.channels;
  const results = { emailSent: false, smsSent: false, errors: [] };
  
  Logger.log('sendAutoFollowup_ - channels: ' + channels);
  Logger.log('Prospect email: ' + (prospectData.prospectEmail || 'none'));
  Logger.log('Prospect phone: ' + (prospectData.phone || 'none'));
  
  const vars = {
    prospect_name: prospectData.prospectName || 'there',
    prospect_email: prospectData.prospectEmail || '',
    phone: prospectData.phone || '',
    event_name: prospectData.eventName || '',
    event_date: prospectData.eventDate || '',
    event_city: prospectData.eventCity || '',
    event_time: prospectData.eventTime || '',
    event_venue: prospectData.eventVenue || '',
    caller_name: prospectData.callerName || 'Your contact',
    host_name: prospectData.hostName || '',
  };
  

  
  const shouldSendEmail = (channels === 'email' || channels === 'both');
  const hasValidEmail = vars.prospect_email && vars.prospect_email.indexOf('@') !== -1;
  
  Logger.log('Should send email: ' + shouldSendEmail + ', has valid email: ' + hasValidEmail);
  
  if (shouldSendEmail && hasValidEmail) {
    try {
      const subject = replaceTemplateVars_(config.emailSubject, vars);
      const htmlBody = replaceTemplateVars_(config.emailTemplate, vars);
      const plainBody = htmlBody.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '');
      
      Logger.log('Sending email to: ' + vars.prospect_email);
      GmailApp.sendEmail(vars.prospect_email, subject, plainBody, { htmlBody: htmlBody });
      results.emailSent = true;
      Logger.log('Email sent successfully');
    } catch (e) {
      Logger.log('Email error: ' + e.message);
      results.errors.push('Email: ' + e.message);
    }
  }
  
  // Send SMS if configured
  const shouldSendSms = (channels === 'sms' || channels === 'both');
  const hasValidPhone = vars.phone && vars.phone.startsWith('+');
  
  Logger.log('Should send SMS: ' + shouldSendSms + ', has valid phone: ' + hasValidPhone);
  
 if (shouldSendSms && hasValidPhone) {
      if (wasMessagedThisWeek_(vars.phone)) {                                                                                                                                       
        Logger.log('Skipping SMS to ' + vars.phone + ' — already messaged within 7 days');
        results.errors.push('SMS: Skipped (sent within 7d)');                                                                                                                       
      } else {                                                                                                                                                                      
        try {                                                                                                                                                                       
          const sp = PropertiesService.getScriptProperties();                                                                                                                       
          const sid = sp.getProperty("TWILIO_ACCOUNT_SID"); 
          const token = sp.getProperty("TWILIO_AUTH_TOKEN");                                                                                                                        
          const fromNumber = sp.getProperty("TWILIO_FROM_NUMBER");                                                                                                                  
                                         
          if (sid && token && fromNumber) {                                                                                                                                         
            const body = replaceTemplateVars_(config.smsTemplate, vars);
            Logger.log('Sending SMS to: ' + vars.phone);                                                                                                                            
            _twilioSendSms_(sid, token, fromNumber, vars.phone, body);
            results.smsSent = true;                                                                                                                                                 
            // Log to Project Tag sheet — always log, even without a batchId,
            // so the weekly cap can see it                                                                                                                                         
            var batchId = prospectData.batchId || 'auto_followup';
            logToProjectTagSheet_(vars.phone, batchId);                                                                                                                                                                      
            Logger.log('SMS sent successfully');            
          } else {                       
            results.errors.push('SMS: Missing Twilio credentials');                                                                                                                 
            Logger.log('Missing Twilio credentials');
          }                                                                                                                                                                         
        } catch (e) {                                       
          Logger.log('SMS error: ' + e.message);
          results.errors.push('SMS: ' + e.message);                                                                                                                                 
        }
      }                                                                                                                                                                             
    }     
  
  // Determine status text
  let statusText = '';
  if (results.emailSent && results.smsSent) statusText = '✅ Email + SMS Sent';
  else if (results.emailSent) statusText = '✅ Email Sent';
  else if (results.smsSent) statusText = '✅ SMS Sent';
  else if (results.errors.length > 0) statusText = '❌ ' + results.errors.join('; ');
  else statusText = '⚠️ No valid contact';
  
  Logger.log('Final status: ' + statusText);
  updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, statusText);
}


function disableAutoFollowup() {
  const sp = PropertiesService.getScriptProperties();
  const sheetName = SpreadsheetApp.getActiveSheet().getName();
  const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), {});
  config.enabled = false;
  sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(config));
  // Don't remove trigger - other sheets might still need it
  SpreadsheetApp.getUi().alert('✅ Auto Follow-up disabled for ' + sheetName + '.');
}

function viewAutoFollowupStatus() {
  const sp = PropertiesService.getScriptProperties();
  const sheetName = SpreadsheetApp.getActiveSheet().getName();
  const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
  const queue = loadJson_(sp, autoFollowupQueueKey_(sheetName), []);
  if (!config) { SpreadsheetApp.getUi().alert('Auto Follow-up not configured.\n\nUse "Configure Auto Follow-up" to set it up.'); return; }
  const status = config.enabled ? '🟢 ENABLED' : '🔴 DISABLED';
  const channelDisplay = { 'email': '📧 Email only', 'sms': '💬 SMS only', 'both': '📧💬 Email + SMS' }[config.channels] || config.channels;
  SpreadsheetApp.getUi().alert('=== AUTO FOLLOW-UP STATUS (' + sheetName + ') ===\n\nStatus: ' + status + '\nChannel: ' + channelDisplay + '\nDelay: ' + config.delayMinutes + ' min\nTriggers: ' + config.triggerStatuses.join(', ') + '\nPending: ' + queue.length);
}

function setupAutoFollowupTrigger_() {
  removeAutoFollowupTrigger_();
  ScriptApp.newTrigger('processAutoFollowupQueue_').timeBased().everyMinutes(1).create();
}

function removeAutoFollowupTrigger_() {
  deleteTriggersByHandler_('processAutoFollowupQueue_');
}


function updateAutoFollowupStatus_(sheetId, sheetName, rowNum, statusText) {
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheetByName(sheetName);
    if (sh) {
      const cols = getHeaderMap_(sh);
      if (cols.auto_followup_status) sh.getRange(rowNum, cols.auto_followup_status).setValue(statusText);
    }
  } catch (e) { console.error('Error updating status:', e); }
}

function replaceTemplateVars_(template, vars) {
  let result = template;
  Object.keys(vars).forEach(key => { result = result.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'gi'), vars[key] || ''); });
  return result;
}

function generateFollowupPreview_(config, prospectData) {
  const vars = {
    prospect_name: prospectData.prospectName || '[Name]',
    prospect_email: prospectData.prospectEmail || '[Email]',
    phone: prospectData.phone || '[Phone]',
    event_name: prospectData.eventName || '[Event]',
    event_date: prospectData.eventDate || '[Date]',
    event_city: prospectData.eventCity || '[City]',
    event_time: prospectData.eventTime || '[Time]',
    event_venue: prospectData.eventVenue || '[Venue]',
    caller_name: prospectData.callerName || '[Caller]',
    host_name: prospectData.hostName || '[Host]',
  };
  const parts = [];
  if (config.channels === 'email' || config.channels === 'both') {
    parts.push('📧 SUBJECT: ' + replaceTemplateVars_(config.emailSubject, vars) + '\n\n' + replaceTemplateVars_(config.emailTemplate, vars));
  }
  if (config.channels === 'sms' || config.channels === 'both') {
    parts.push('💬 SMS: ' + replaceTemplateVars_(config.smsTemplate, vars));
  }
  return parts.join('\n\n---\n\n');
}

// ============================================================
// STATUS MONITORING
// ============================================================

function getStatusSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let statusSh = ss.getSheetByName(STATUS_SHEET_NAME);
  if (!statusSh) {
    statusSh = ss.insertSheet(STATUS_SHEET_NAME);
    statusSh.getRange('A1').setValue('Metric');
    statusSh.getRange('A2:A10').setValues([['Script Status'],['Last Heartbeat'],['Seconds Since Heartbeat'],['Active Calls'],['Queued Rows'],['Concurrency Setting'],['Campaign Sheet'],['Processing Started'],['Last Error']]);
    statusSh.getRange('A1').setFontWeight('bold');
    statusSh.setColumnWidth(1, 180);
  }
  return statusSh;
}

function getStatusColumnForSheet_(statusSh, sheetName) {
  const headerRow = statusSh.getRange(1, 1, 1, statusSh.getLastColumn()).getValues()[0];
  for (let i = 1; i < headerRow.length; i++) { if (headerRow[i] === sheetName) return i + 1; }
  const newCol = Math.max(2, statusSh.getLastColumn() + 1);
  statusSh.getRange(1, newCol).setValue(sheetName).setFontWeight('bold');
  statusSh.setColumnWidth(newCol, 250);
  const colLetter = colToA1_(newCol);
  statusSh.getRange(4, newCol).setFormula('=IF(' + colLetter + '3="","N/A",ROUND((NOW()-' + colLetter + '3)*86400,0)&" sec ago")');
  statusSh.getRange(8, newCol).setValue(sheetName);
  return newCol;
}

function updateStatus_(updates, sheetName) {
  try {
    if (!sheetName) { try { sheetName = SpreadsheetApp.getActiveSheet().getName(); } catch (e) { return; } }
    if (sheetName.startsWith('_Vapi')) return;
    const statusSh = getStatusSheet_();
    const col = getStatusColumnForSheet_(statusSh, sheetName);
    const metrics = { 'Script Status': 2, 'Last Heartbeat': 3, 'Active Calls': 5, 'Queued Rows': 6, 'Concurrency Setting': 7, 'Campaign Sheet': 8, 'Processing Started': 9, 'Last Error': 10 };
    Object.entries(updates).forEach(function(entry) { const row = metrics[entry[0]]; if (row) statusSh.getRange(row, col).setValue(entry[1]); });
  } catch (e) { console.error('Status update failed:', e); }
}

function recordHeartbeat_(sheetId, sheetName) {
  const sp = PropertiesService.getScriptProperties();
  const now = Date.now();
  sp.setProperty(heartbeatKey_(sheetId, sheetName), String(now));
  updateStatus_({ 'Last Heartbeat': new Date(now) }, sheetName);
}

function vapiShowStatus() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sh = SpreadsheetApp.getActiveSheet();
  const sheetName = sh.getName();
  const queue = loadJson_(sp, queueKey_(sheetId, sheetName), []);
  const active = loadJson_(sp, activeKey_(sheetId, sheetName), {});
  const concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 1);
  const isProcessing = sp.getProperty(processingKey_(sheetId, sheetName)) === 'true';
  const lastHeartbeat = sp.getProperty(heartbeatKey_(sheetId, sheetName));
  let heartbeatAge = 'N/A';
  if (lastHeartbeat) heartbeatAge = Math.round((Date.now() - Number(lastHeartbeat)) / 1000) + ' seconds ago';
  let status = '⚪ Idle';
  if (isProcessing) {
    const age = lastHeartbeat ? Math.round((Date.now() - Number(lastHeartbeat)) / 1000) : 999;
    if (age < 60) status = '🟢 Running (healthy)';
    else if (age < 120) status = '🟡 Running (slow)';
    else status = '🔴 Possibly frozen';
  }
  SpreadsheetApp.getUi().alert('=== VAPI STATUS ===\n\nStatus: ' + status + '\nHeartbeat: ' + heartbeatAge + '\nActive: ' + Object.keys(active).length + '\nQueued: ' + queue.length + '\nConcurrency: ' + concurrency);
}

function vapiForceRestart() {
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Force Restart', 'Clear locks and restart?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sh = SpreadsheetApp.getActiveSheet();
  const sheetName = sh.getName();
  sp.deleteProperty(processingKey_(sheetId, sheetName));
  removeWatchdog_();
  let concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 0);
  if (!concurrency) { concurrency = promptConcurrency_(ui, 'Set concurrency:', 1); if (!concurrency) return; }
  updateStatus_({ 'Script Status': '🔄 Restarting...', 'Last Error': '' }, sheetName);
  vapiStartProcessingActiveSheet_(concurrency);
  ui.alert('✅ Restarted.');
}

// ============================================================
// 2ND ROUND CALLING
// ============================================================

function vapiShowCallbackSummary() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  if (!cols.status) return SpreadsheetApp.getUi().alert('❌ Missing Status header');
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) return SpreadsheetApp.getUi().alert('No data.');
  const statuses = sh.getRange(HEADER_ROW_INDEX + 1, cols.status, lastRow - HEADER_ROW_INDEX, 1).getValues();
  const statusCounts = {};
  statuses.forEach(function(row) { const s = String(row[0] || '').trim() || '(empty)'; statusCounts[s] = (statusCounts[s] || 0) + 1; });
  let callbackCount = 0, doNotCallCount = 0;
  Object.entries(statusCounts).forEach(function(entry) {
    const n = entry[0].toLowerCase();
    if (CALLBACK_WORTHY_STATUSES.some(function(s) { return n.includes(s); })) callbackCount += entry[1];
    else if (DO_NOT_CALL_AGAIN_STATUSES.some(function(s) { return n.includes(s); })) doNotCallCount += entry[1];
  });
  const summary = Object.entries(statusCounts).sort(function(a, b) { return b[1] - a[1]; }).map(function(e) { return '  ' + e[0] + ': ' + e[1]; }).join('\n');
  SpreadsheetApp.getUi().alert('=== STATUS SUMMARY ===\n\n' + summary + '\n\n📞 Callback worthy: ' + callbackCount + '\n🚫 Do not call: ' + doNotCallCount);
}

function vapiSelectForCallback() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  if (!cols.status) return ui.alert('❌ Missing Status header');
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) return ui.alert('No data.');
  
  const lastCol = sh.getLastColumn();
  const allData = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
  
  const rowsToSelect = [];
  for (let i = 0; i < allData.length; i++) {
    const row = allData[i];
    const status = String(row[cols.status - 1] || '').trim().toLowerCase();
    const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag - 1] || '').trim().toUpperCase() : '';
    
    // Select if: Voicemail/No Answer OR callback was requested
    const isCallbackWorthy = CALLBACK_WORTHY_STATUSES.some(function(s) { return status.includes(s); });
    const callbackRequested = (callbackFlag === 'TRUE');
    
    if (isCallbackWorthy || callbackRequested) {
      rowsToSelect.push(HEADER_ROW_INDEX + 1 + i);
    }
  }
  
  if (rowsToSelect.length === 0) return ui.alert('No rows for 2nd round.\n\nLooking for: Voicemail, No Answer, or Callback Requested');
  sh.setActiveRangeList(sh.getRangeList(rowsToSelect.map(function(r) { return r + ':' + r; })));
  ui.alert('✅ Selected ' + rowsToSelect.length + ' rows.\n\n(Includes callback requests)');
}

function vapiPrepareSecondRound() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) return ui.alert('Select rows first.');
  const cols = getHeaderMap_(sh);
  if (!cols.status) return ui.alert('❌ Missing Status header');
  if (ui.alert('Prepare 2nd Round', 'Reset call fields for ' + range.getNumRows() + ' rows?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lastCol = sh.getLastColumn();
  
  // Read all data at once
  const allData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  const fieldsToClear = ['call_id', 'started_at', 'ended_at', 'transcript', 'outcome_summary', 'recording_url', 'callback_flag', 'callback_when', 'scheduled_at', 'scheduled_in_min', 'auto_followup_status', 'auto_followup_preview'];
  
  let count = 0;
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    // Set status to Queued
    allData[i][cols.status - 1] = 'Queued';
    
    // Increment call_attempt
    if (cols.call_attempt) {
      const currentAttempt = Number(allData[i][cols.call_attempt - 1] || 0);
      allData[i][cols.call_attempt - 1] = currentAttempt + 1;
    }
    
    // Clear fields
    fieldsToClear.forEach(function(field) {
      if (cols[field]) allData[i][cols[field] - 1] = '';
    });
    
    count++;
  }
  
  // Write all data at once
  sh.getRange(startRow, 1, numRows, lastCol).setValues(allData);
  
  // Apply row hygiene after
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    applyRowHygiene_(sh, rowNum, cols);
  }
  
  SpreadsheetApp.flush(); // Force write to complete
  
  ui.alert('✅ Prepared ' + count + ' rows for 2nd round.\n\nNow use "Call highlighted now" to start calling.');
}

// ============================================================
// MAIN CALLING ACTIONS
// ============================================================

function vapiCallHighlightedNow() {
  ensureSheetId_();
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) return ui.alert('Select rows first.');
  const concurrency = promptConcurrency_(ui, 'How many calls at once?', 1);
  if (!concurrency) return;
  const sp = PropertiesService.getScriptProperties();
  sp.setProperty(concurrencyKey_(sp.getProperty('SHEET_ID'), sh.getName()), String(concurrency));
  vapiQueueRange_(sh, range);
  vapiStartProcessingActiveSheet_(concurrency);
}

function vapiScheduleHighlighted() {
  ensureSheetId_();
  const ui = SpreadsheetApp.getUi();
  
  // Load last used settings
  const lastSettings = getLastCampaignSettings_() || {};
  const savedSettingsJson = JSON.stringify({
    concurrency: lastSettings.concurrency || 1,
    rounds: lastSettings.rounds || [],
    followup: lastSettings.followup || null
  }).replace(/'/g, "\\'");
  const senderEmail = Session.getActiveUser().getEmail() || 'your Gmail account';
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) return ui.alert('Select rows first.');
  
  // Get assistants
  const assistantSheet = ss.getSheetByName(ASSISTANTS_SHEET_NAME);
  let assistantOptions = '';
  let retryAssistantOptions = '<option value="">-- Same as Round 1 --</option>';
  
  if (assistantSheet) {
    const assistantData = assistantSheet.getDataRange().getValues();
    for (let i = 1; i < assistantData.length; i++) {
      const name = String(assistantData[i][0] || '').trim();
      if (name) {
        const escaped = name.replace(/"/g, '&quot;');
        const isSelected = (lastSettings.assistant === name || lastSettings.assistant === escaped) ? ' selected' : '';
        assistantOptions += '<option value="' + escaped + '"' + isSelected + '>' + name + '</option>';
        const isRetrySelected = (lastSettings.retryAssistant === name || lastSettings.retryAssistant === escaped) ? ' selected' : '';
        retryAssistantOptions += '<option value="' + escaped + '"' + isRetrySelected + '>' + name + '</option>';
      }
    }
  }
  
  if (!assistantOptions) {
    assistantOptions = '<option value="">-- No assistants found --</option>';
  }
  
  // Get phone numbers
  const phoneSheet = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME);
  let phoneOptions = '';
  
  if (phoneSheet) {
    const phoneData = phoneSheet.getDataRange().getValues();
    for (let i = 1; i < phoneData.length; i++) {
      const display = String(phoneData[i][0] || '').trim();
      if (display) {
        const escaped = display.replace(/"/g, '&quot;');
        const isPhoneSelected = (lastSettings.phoneNumber === display || lastSettings.phoneNumber === escaped) ? ' selected' : '';
        phoneOptions += '<option value="' + escaped + '"' + isPhoneSelected + '>' + display + '</option>';
      }
    }
  }
  
  if (!phoneOptions) {
    phoneOptions = '<option value="">-- No phone numbers found --</option>';
  }
  
  const tzOptions = '<optgroup label="Europe">' +
    '<option value="Europe/London" selected>🇬🇧 London (GMT/BST)</option>' +
    '<option value="Europe/Dublin">🇮🇪 Dublin</option>' +
    '<option value="Europe/Lisbon">🇵🇹 Lisbon</option>' +
    '<option value="Europe/Paris">🇫🇷 Paris / Berlin / Rome / Madrid (CET)</option>' +
    '<option value="Europe/Athens">🇬🇷 Athens / Helsinki (EET)</option>' +
    '<option value="Europe/Moscow">🇷🇺 Moscow</option>' +
    '</optgroup>' +
    '<optgroup label="Americas">' +
    '<option value="America/New_York">🇺🇸 New York / Miami / Toronto (EST)</option>' +
    '<option value="America/Chicago">🇺🇸 Chicago / Houston (CST)</option>' +
    '<option value="America/Denver">🇺🇸 Denver / Phoenix (MST)</option>' +
    '<option value="America/Los_Angeles">🇺🇸 Los Angeles / Vancouver (PST)</option>' +
    '<option value="America/Mexico_City">🇲🇽 Mexico City</option>' +
    '<option value="America/Bogota">🇨🇴 Bogotá / Lima</option>' +
    '<option value="America/Sao_Paulo">🇧🇷 São Paulo</option>' +
    '<option value="America/Buenos_Aires">🇦🇷 Buenos Aires</option>' +
    '</optgroup>' +
    '<optgroup label="Asia/Pacific">' +
    '<option value="Asia/Dubai">🇦🇪 Dubai</option>' +
    '<option value="Asia/Kolkata">🇮🇳 Mumbai / Delhi</option>' +
    '<option value="Asia/Singapore">🇸🇬 Singapore / Hong Kong</option>' +
    '<option value="Asia/Tokyo">🇯🇵 Tokyo</option>' +
    '<option value="Asia/Seoul">🇰🇷 Seoul</option>' +
    '<option value="Australia/Sydney">🇦🇺 Sydney / Melbourne</option>' +
    '</optgroup>';

  const html = HtmlService.createHtmlOutput(`
<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 16px; margin: 0; font-size: 13px; }
    h3 { margin: 0 0 16px 0; color: #1a73e8; }
    .section { border: 1px solid #ddd; padding: 12px; border-radius: 8px; margin-bottom: 12px; background: #fafafa; }
    .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .section-title { font-weight: bold; font-size: 14px; }
    .section-title-primary { font-weight: bold; font-size: 14px; color: #1a73e8; }
    .remove-btn { background: #f44336; color: white; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
    .remove-btn:hover { background: #d32f2f; }
    label { display: block; margin-top: 10px; font-weight: 500; font-size: 12px; color: #555; }
    label:first-child { margin-top: 0; }
    select, input[type="number"], input[type="time"] { width: 100%; padding: 8px; margin-top: 4px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
    .row { display: flex; gap: 10px; }
    .row > * { flex: 1; }
    .radio-group { margin-top: 8px; }
    .radio-group label { display: flex; align-items: center; gap: 6px; font-weight: normal; margin-top: 6px; cursor: pointer; }
    .checkbox-group { margin-top: 8px; }
    .checkbox-group label { display: inline-flex; align-items: center; gap: 4px; font-weight: normal; margin-right: 10px; cursor: pointer; font-size: 12px; }
    .time-config { margin-top: 10px; padding: 10px; background: #e8f4fd; border-radius: 4px; }
    .time-config.hidden { display: none; }
    .add-round-btn { background: #4caf50; color: white; border: none; border-radius: 4px; padding: 10px 20px; cursor: pointer; width: 100%; margin: 10px 0; font-size: 14px; }
    .add-round-btn:hover { background: #43a047; }
    .add-round-btn:disabled { background: #ccc; cursor: not-allowed; }
    .btn-row { display: flex; gap: 10px; margin-top: 16px; }
    .btn { padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #1a73e8; color: white; flex: 1; }
    .btn-primary:hover { background: #1557b0; }
    .btn-primary:disabled { background: #ccc; cursor: not-allowed; }
    .btn-secondary { background: #f1f1f1; color: #333; border: 1px solid #ccc; }
    .info { background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 11px; color: #856404; }
    .config-section { background: #e3f2fd; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #90caf9; }
    .retry-section { background: #e8f5e9; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #c8e6c9; }
    .retry-section label { color: #2e7d32; }
    .hint { font-size: 10px; color: #666; margin-top: 4px; }
    #rounds-container { max-height: 220px; overflow-y: auto; }
    .followup-section { background: #fce4ec; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #f8bbd9; }
    .followup-section.disabled { opacity: 0.5; }
    .followup-section label { color: #880e4f; }
    .followup-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .followup-header input[type="checkbox"] { width: 18px; height: 18px; }
    .followup-content { display: none; }
    .followup-content.show { display: block; }
    .channel-btns { display: flex; gap: 6px; margin: 10px 0; }
    .channel-btn { flex: 1; padding: 8px; border: 2px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; text-align: center; font-size: 12px; }
    .channel-btn:hover { border-color: #e91e63; }
    .channel-btn.active { border-color: #e91e63; background: #fce4ec; font-weight: bold; }
    .followup-fields textarea { width: 100%; min-height: 60px; margin-top: 4px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; }
    .followup-fields input[type="text"] { width: 100%; padding: 8px; margin-top: 4px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
    .followup-fields .field-group { margin-bottom: 10px; }
    .followup-fields .field-group.hidden { display: none; }
    .variables-hint { font-size: 10px; color: #666; margin-top: 4px; }
    .sender-box { background: #e8f5e9; border: 2px solid #4caf50; border-radius: 6px; padding: 10px; margin-bottom: 10px; text-align: center; }
    .sender-label { font-size: 11px; color: #2e7d32; margin-bottom: 2px; }
    .sender-email { font-size: 16px; font-weight: bold; color: #1b5e20; word-break: break-all; }
  </style>
</head>
<body>
  <h3>⏰ Schedule Multi-Round Campaign</h3>
  <div class="info">📞 Selected: <b>${range.getNumRows()} rows</b> | Configure up to 5 rounds</div>
  
  <div class="config-section">
    <div class="section-title-primary">📞 Campaign Settings</div>
    <div class="row">
      <div>
        <label>🎙️ Assistant</label>
        <select id="assistant">${assistantOptions}</select>
      </div>
      <div>
        <label>📱 Phone Number</label>
        <select id="phoneNumber">${phoneOptions}</select>
      </div>
    </div>
    <div class="row" style="margin-top:8px;">
      <div>
        <label>🔄 Concurrency</label>
        <input type="number" id="concurrency" value="${lastSettings.concurrency || 1}" min="1" max="5" />
      </div>
      <div></div>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">1️⃣ Round 1 (First Calls)</div>
    
    <div class="radio-group">
      <label><input type="radio" name="round1Type" value="delay" checked onchange="toggleRound1()"> Start in X minutes</label>
      <label><input type="radio" name="round1Type" value="specific" onchange="toggleRound1()"> Start at specific time</label>
    </div>
    
    <div id="round1DelayConfig" class="time-config">
      <label>Start in (minutes)</label>
      <input type="number" id="round1_delay" value="1" min="1" max="10080" />
    </div>
    
    <div id="round1SpecificConfig" class="time-config hidden">
      <div class="row">
        <div><label>Time</label><input type="time" id="round1_time" value="09:00" /></div>
        <div><label>Timezone</label><select id="round1_tz">${tzOptions}</select></div>
      </div>
      <div class="row" style="margin-top:8px;">
        <div><label>Day</label>
          <select id="round1_days">
            <option value="0">Today</option>
            <option value="1" selected>Tomorrow (+1 day)</option>
            <option value="2">+2 days</option>
            <option value="3">+3 days</option>
            <option value="4">+4 days</option>
            <option value="5">+5 days</option>
            <option value="6">+6 days</option>
            <option value="7">+7 days</option>
          </select>
        </div>
      </div>
    </div>
  </div>
  
  <div class="retry-section">
    <label>🎙️ Assistant for Retry Rounds</label>
    <select id="retryAssistant">${retryAssistantOptions}</select>
    <div class="hint">💡 Use a "No-VM" assistant for voicemail callbacks</div>
  </div>
  
  <div id="rounds-container"></div>
  <button class="add-round-btn" id="addRoundBtn" onclick="addRound()">➕ Add Round 2</button>
  
  <div class="section">
    <div class="section-title">📊 After All Rounds Complete</div>
    <div class="checkbox-group"><label><input type="checkbox" id="autoSort" checked /> Auto-sort "Spoke to Human" to top</label></div>
  </div>
  
  <div class="followup-section">
    <div class="followup-header">
      <input type="checkbox" id="enableFollowup" onchange="toggleFollowup()" checked />
      <span class="section-title">📧💬 Auto Follow-up (for Voicemail/No Answer)</span>
    </div>
    <div class="followup-content show" id="followupContent">
      <div class="sender-box">
        <div class="sender-label">📧 EMAILS WILL BE SENT FROM</div>
        <div class="sender-email">${senderEmail}</div>
      </div>
      <div class="channel-btns">
        <div class="channel-btn active" id="fuBtnEmail" onclick="selectFollowupChannel('email')">📧 Email</div>
        <div class="channel-btn" id="fuBtnSms" onclick="selectFollowupChannel('sms')">💬 SMS</div>
        <div class="channel-btn" id="fuBtnBoth" onclick="selectFollowupChannel('both')">📧💬 Both</div>
      </div>
      <div class="followup-fields">
        <div class="field-group" id="fuEmailFields">
          <label>📧 Email Subject</label>
          <input type="text" id="fuEmailSubject" value="Following up on our call about {{event_name}}" />
          <label style="margin-top:8px">📧 Email Body</label>
          <textarea id="fuEmailBody">Hi {{prospect_name}},

We just tried to give you a call regarding {{event_name}} in {{event_city}}, but couldn't get through.

I was hoping to invite you to a dinner discussion on {{event_date}}.

Please let me know if you're interested!

Best regards,
{{caller_name}}</textarea>
        </div>
        <div class="field-group hidden" id="fuSmsFields">
          <label>💬 SMS Message</label>
          <textarea id="fuSmsBody" style="min-height:50px">Hi {{prospect_name}} — it's {{caller_name}}. I just tried calling you regarding {{event_name}} in {{event_city}}. I was hoping to follow up on the personal invitation we sent you. Please see here for more information on the topic, agenda, and other attendees: https://shorturl.at/LKmLT. You can also RSVP via that link. Thanks!</textarea>
        </div>
        <div class="variables-hint">Variables: {{prospect_name}}, {{event_name}}, {{event_city}}, {{event_date}}, {{caller_name}}, {{host_name}}</div>
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid #f8bbd9;">
          <label style="margin-bottom:8px;">⏰ Send follow-up:</label>
          <div class="radio-group" style="margin-top:4px;">
            <label><input type="radio" name="fuTiming" value="immediate" checked onchange="toggleFuTiming()"> Immediately after call</label>
            <label><input type="radio" name="fuTiming" value="delay" onchange="toggleFuTiming()"> After delay</label>
            <label><input type="radio" name="fuTiming" value="specific" onchange="toggleFuTiming()"> At specific time</label>
          </div>
          <div id="fuDelayConfig" class="time-config hidden" style="margin-top:8px;">
            <div class="row">
              <div><label>Minutes</label><input type="number" id="fuDelayMin" value="30" min="1" max="1440"/></div>
            </div>
          </div>
          <div id="fuSpecificConfig" class="time-config hidden" style="margin-top:8px;">
            <div class="row">
              <div><label>Time</label><input type="time" id="fuTime" value="09:00"/></div>
              <div><label>Day</label>
                <select id="fuDays">
                  <option value="0">Today</option>
                  <option value="1" selected>Tomorrow</option>
                  <option value="2">+2 days</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <div class="btn-row">
    <button class="btn btn-secondary" id="cancelBtn" onclick="google.script.host.close()">Cancel</button>
    <button class="btn btn-primary" id="submitBtn" onclick="scheduleCampaign()">⏰ Schedule Campaign</button>
  </div>
  
  <script>
    var roundCount = 1;
    var maxRounds = 5;
    var followupChannel = 'email';
    var savedSettings = JSON.parse('${savedSettingsJson}');
    var tzOptions = \`${tzOptions}\`;
    
    function toggleRound1() {
      var type = document.querySelector('input[name=round1Type]:checked').value;
      document.getElementById('round1DelayConfig').classList.toggle('hidden', type !== 'delay');
      document.getElementById('round1SpecificConfig').classList.toggle('hidden', type !== 'specific');
    }
    
    function addRound() {
      if (roundCount >= maxRounds) return;
      roundCount++;
      var c = document.getElementById('rounds-container');
      var d = document.createElement('div');
      d.className = 'section'; d.id = 'round' + roundCount + '_section';
      var n = roundCount;
      var emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
      d.innerHTML = '<div class="section-header"><span class="section-title">' + emojis[n-1] + ' Round ' + n + '</span><button class="remove-btn" onclick="removeRound(' + n + ')">🗑️</button></div>' +
        '<div class="radio-group"><label><input type="radio" name="round' + n + '_type" value="delay" checked onchange="toggleTime(' + n + ')"> After delay</label><label><input type="radio" name="round' + n + '_type" value="specific" onchange="toggleTime(' + n + ')"> At specific time</label></div>' +
        '<div id="round' + n + '_delay_cfg" class="time-config"><div class="row"><div><label>Hours</label><input type="number" id="round' + n + '_hrs" value="2" min="0" max="168"/></div><div><label>Minutes</label><input type="number" id="round' + n + '_min" value="0" min="0" max="59"/></div></div></div>' +
        '<div id="round' + n + '_spec_cfg" class="time-config hidden"><div class="row"><div><label>Time</label><input type="time" id="round' + n + '_time" value="10:00"/></div><div><label>Timezone</label><select id="round' + n + '_tz">' + tzOptions + '</select></div></div><div class="row" style="margin-top:8px"><div><label>Day</label><select id="round' + n + '_days"><option value="0">Today</option><option value="1" selected>Tomorrow</option><option value="2">+2 days</option><option value="3">+3 days</option><option value="4">+4 days</option><option value="5">+5 days</option></select></div></div></div>' +
        '<label style="margin-top:12px">Retry statuses:</label><div class="checkbox-group"><label><input type="checkbox" id="round' + n + '_vm" checked/> Voicemail</label><label><input type="checkbox" id="round' + n + '_na" checked/> No Answer</label><label><input type="checkbox" id="round' + n + '_cb" checked/> Callback</label><label><input type="checkbox" id="round' + n + '_busy"/> Busy</label></div>';
      c.appendChild(d);
      updateBtn();
    }
    
    function removeRound(n) { var s = document.getElementById('round' + n + '_section'); if(s) s.remove(); renumber(); }
    
    function renumber() { 
      var sections = document.querySelectorAll('#rounds-container .section'); 
      roundCount = 1; 
      var emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
      sections.forEach(function(s, i) { 
        roundCount = i + 2; var n = i + 2; 
        s.id = 'round' + n + '_section'; 
        s.querySelector('.section-title').innerHTML = emojis[n-1] + ' Round ' + n; 
        s.querySelector('.remove-btn').setAttribute('onclick', 'removeRound(' + n + ')'); 
        s.querySelectorAll('[id],[name]').forEach(function(el) { 
          if(el.id) el.id = el.id.replace(/round\\d+/, 'round' + n); 
          if(el.name) el.name = el.name.replace(/round\\d+/, 'round' + n); 
        }); 
        s.querySelectorAll('input[type=radio]').forEach(function(el) { el.setAttribute('onchange', 'toggleTime(' + n + ')'); }); 
      }); 
      updateBtn(); 
    }
    
    function updateBtn() { 
      var b = document.getElementById('addRoundBtn'); 
      if(roundCount >= maxRounds) { b.disabled = true; b.textContent = 'Max 5 rounds'; } 
      else { b.disabled = false; b.textContent = '➕ Add Round ' + (roundCount + 1); } 
    }
    
    function toggleTime(n) { 
      var t = document.querySelector('input[name=round' + n + '_type]:checked').value; 
      document.getElementById('round' + n + '_delay_cfg').classList.toggle('hidden', t !== 'delay'); 
      document.getElementById('round' + n + '_spec_cfg').classList.toggle('hidden', t !== 'specific'); 
    }
    
    function setLoading(on) { 
      document.getElementById('submitBtn').disabled = on; 
      document.getElementById('submitBtn').textContent = on ? '⏳ Scheduling...' : '⏰ Schedule Campaign'; 
      document.getElementById('cancelBtn').disabled = on; 
      document.getElementById('addRoundBtn').disabled = on; 
    }
    
    function toggleFollowup() {
      var enabled = document.getElementById('enableFollowup').checked;
      document.getElementById('followupContent').classList.toggle('show', enabled);
    }
    
    function selectFollowupChannel(ch) {
      followupChannel = ch;
      document.getElementById('fuBtnEmail').classList.toggle('active', ch === 'email');
      document.getElementById('fuBtnSms').classList.toggle('active', ch === 'sms');
      document.getElementById('fuBtnBoth').classList.toggle('active', ch === 'both');
      document.getElementById('fuEmailFields').classList.toggle('hidden', ch === 'sms');
      document.getElementById('fuSmsFields').classList.toggle('hidden', ch === 'email');
    }
    
    function toggleFuTiming() {
      var timing = document.querySelector('input[name=fuTiming]:checked').value;
      document.getElementById('fuDelayConfig').classList.toggle('hidden', timing !== 'delay');
      document.getElementById('fuSpecificConfig').classList.toggle('hidden', timing !== 'specific');
    }
    
    function restoreSavedSettings() {
      if (!savedSettings) return;
      // Restore concurrency is already handled by template
      // Restore rounds
      if (savedSettings.rounds && savedSettings.rounds.length > 0) {
        savedSettings.rounds.forEach(function(r) {
          addRound();
          var n = roundCount;
          if (r.type === 'specific') {
            var radio = document.querySelector('input[name=round' + n + '_type][value=specific]');
            if (radio) { radio.checked = true; toggleTime(n); }
            if (r.time) document.getElementById('round' + n + '_time').value = r.time;
            if (r.timezone) document.getElementById('round' + n + '_tz').value = r.timezone;
            if (r.daysFromNow !== undefined) document.getElementById('round' + n + '_days').value = r.daysFromNow;
          } else {
            var hrs = Math.floor((r.delayMinutes || 120) / 60);
            var mins = (r.delayMinutes || 120) % 60;
            document.getElementById('round' + n + '_hrs').value = hrs;
            document.getElementById('round' + n + '_min').value = mins;
          }
          if (r.statuses) {
            document.getElementById('round' + n + '_vm').checked = r.statuses.indexOf('voicemail') >= 0;
            document.getElementById('round' + n + '_na').checked = r.statuses.indexOf('no answer') >= 0;
            document.getElementById('round' + n + '_cb').checked = r.statuses.indexOf('callback') >= 0;
            document.getElementById('round' + n + '_busy').checked = r.statuses.indexOf('busy') >= 0;
          }
        });
      }
      // Restore followup
      if (savedSettings.followup && savedSettings.followup.enabled) {
        document.getElementById('enableFollowup').checked = true;
        toggleFollowup();
        selectFollowupChannel(savedSettings.followup.channel || 'email');
        if (savedSettings.followup.emailSubject) document.getElementById('fuEmailSubject').value = savedSettings.followup.emailSubject;
        if (savedSettings.followup.emailBody) document.getElementById('fuEmailBody').value = savedSettings.followup.emailBody;
        if (savedSettings.followup.smsBody) document.getElementById('fuSmsBody').value = savedSettings.followup.smsBody;
      }
    }
    
    // Initialize on load
    document.addEventListener('DOMContentLoaded', restoreSavedSettings);
    
    function scheduleCampaign() {
      var assistant = document.getElementById('assistant').value;
      var phoneNumber = document.getElementById('phoneNumber').value;
      
      if (!assistant) { alert('Please select an assistant'); return; }
      if (!phoneNumber) { alert('Please select a phone number'); return; }
      
      setLoading(true);
      
      var round1Type = document.querySelector('input[name=round1Type]:checked').value;
      var cfg = {
        assistant: assistant,
        phoneNumber: phoneNumber,
        round1Type: round1Type,
        round1DelayMin: parseInt(document.getElementById('round1_delay').value) || 1,
        round1Time: document.getElementById('round1_time').value,
        round1Timezone: document.getElementById('round1_tz').value,
        round1DaysFromNow: parseInt(document.getElementById('round1_days').value) || 0,
        concurrency: parseInt(document.getElementById('concurrency').value) || 3,
        retryAssistant: document.getElementById('retryAssistant').value,
        autoSort: document.getElementById('autoSort').checked,
        rounds: [],
        followup: null
      };
      
      // Add followup config if enabled
      if (document.getElementById('enableFollowup').checked) {
        var fuTiming = document.querySelector('input[name=fuTiming]:checked').value;
        cfg.followup = {
          enabled: true,
          channel: followupChannel,
          emailSubject: document.getElementById('fuEmailSubject').value,
          emailBody: document.getElementById('fuEmailBody').value,
          smsBody: document.getElementById('fuSmsBody').value,
          timing: fuTiming,
          delayMinutes: fuTiming === 'delay' ? (parseInt(document.getElementById('fuDelayMin').value) || 30) : 0,
          specificTime: fuTiming === 'specific' ? document.getElementById('fuTime').value : null,
          specificDays: fuTiming === 'specific' ? (parseInt(document.getElementById('fuDays').value) || 0) : 0
        };
      }
      
      for (var i = 2; i <= roundCount; i++) {
        var sec = document.getElementById('round' + i + '_section');
        if (!sec) continue;
        var typ = document.querySelector('input[name=round' + i + '_type]:checked');
        typ = typ ? typ.value : 'delay';
        var r = { roundNum: i, type: typ, statuses: [] };
        
        if (typ === 'delay') {
          r.delayMinutes = (parseInt(document.getElementById('round' + i + '_hrs').value) || 0) * 60 + 
                           (parseInt(document.getElementById('round' + i + '_min').value) || 0);
        } else {
          r.time = document.getElementById('round' + i + '_time').value;
          r.timezone = document.getElementById('round' + i + '_tz').value;
          r.daysFromNow = parseInt(document.getElementById('round' + i + '_days').value) || 0;
        }
        
        if (document.getElementById('round' + i + '_vm').checked) r.statuses.push('voicemail');
        if (document.getElementById('round' + i + '_na').checked) r.statuses.push('no answer');
        if (document.getElementById('round' + i + '_cb').checked) r.statuses.push('callback');
        if (document.getElementById('round' + i + '_busy').checked) r.statuses.push('busy');
        
        cfg.rounds.push(r);
      }
      
      google.script.run
        .withSuccessHandler(function(r) { alert(r); google.script.host.close(); })
        .withFailureHandler(function(e) { setLoading(false); alert('Error: ' + e.message); })
        .vapiScheduleMultiRoundCampaign(cfg);
    }
  </script>
</body>
</html>
  `).setWidth(520).setHeight(780);
  
  ui.showModalDialog(html, 'Schedule Multi-Round Campaign');
}
/**
 * Schedules a batch with optional auto 2nd round
 */
function vapiScheduleBatchWithConfig(config) {
  ensureSheetId_();
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) throw new Error('Please select rows first');
  
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  
  // Validate inputs
  const startMinutes = Number(config.startMinutes) || 30;
  const concurrency = Number(config.concurrency) || 5;
  
  if (startMinutes < 1 || startMinutes > 10080) throw new Error('Start time must be 1-10080 minutes');
  if (concurrency < 1 || concurrency > 50) throw new Error('Concurrency must be 1-55');
  
  // Generate batch ID
  const batchId = generateBatchId_(sheetName);
  const startAt = new Date(Date.now() + startMinutes * 60000);
  
  // Get column map
  let cols = getHeaderMap_(sh);
  
  // Add missing columns if they don't exist
  let newColsAdded = false;
  const columnsToAdd = ['batch_id', 'second_round_delay_min', 'second_round_scheduled_at', 'second_round_status'];
  
  columnsToAdd.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
      newColsAdded = true;
    }
  });
  
  if (newColsAdded) {
    cols = getHeaderMap_(sh);
  }
  
  // Ensure schedule columns exist
  ensureScheduleColumns_(sh);
  cols = getHeaderMap_(sh);
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const updatedLastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, updatedLastCol).getValues();
  
  // Calculate estimated 2nd round time
  let secondRoundScheduledText = '';
  if (config.delayMinutes > 0) {
    // Estimate: 1st batch starts at startAt, takes ~2 min per row, then add delay
    const estimatedFirstBatchMinutes = Math.max(5, numRows * 2);
    const estimatedSecondRoundTime = new Date(startAt.getTime() + (estimatedFirstBatchMinutes + config.delayMinutes) * 60 * 1000);
    secondRoundScheduledText = Utilities.formatDate(estimatedSecondRoundTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' (est.)';
  }
  
  // Update rows with batch info
  let queuedCount = 0;
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    // Ensure row array is long enough
    while (allData[i].length < updatedLastCol) {
      allData[i].push('');
    }
    
    // Set status to Queued
    if (cols.status) {
      const currentStatus = String(allData[i][cols.status - 1] || '').trim();
      if (!currentStatus || currentStatus === 'Queued') {
        allData[i][cols.status - 1] = 'Queued';
        queuedCount++;
      }
    }
    
    // Set batch_id
    if (cols.batch_id) {
      allData[i][cols.batch_id - 1] = batchId;
    }
    
    // Set scheduled_at
    if (cols.scheduled_at) {
      allData[i][cols.scheduled_at - 1] = startAt;
    }
    
    // Set second_round_delay_min
    if (cols.second_round_delay_min) {
      allData[i][cols.second_round_delay_min - 1] = config.delayMinutes > 0 ? config.delayMinutes + ' min' : '';
    }
    
    // Set second_round_scheduled_at
    if (cols.second_round_scheduled_at) {
      allData[i][cols.second_round_scheduled_at - 1] = config.delayMinutes > 0 ? secondRoundScheduledText : '';
    }
    
    // Set second_round_status
    if (cols.second_round_status) {
      allData[i][cols.second_round_status - 1] = config.delayMinutes > 0 ? '⏳ Scheduled' : 'No 2nd round';
    }
  }
  
  // Write data back
  sh.getRange(startRow, 1, numRows, updatedLastCol).setValues(allData);
  
  // Set scheduled_in_min formula
  if (cols.scheduled_in_min && cols.scheduled_at) {
    const atColLetter = colToA1_(cols.scheduled_at);
    const formulas = [];
    for (let i = 0; i < numRows; i++) {
      const r = startRow + i;
      formulas.push(['=IF(' + atColLetter + r + '="","",IF(' + atColLetter + r + '<=NOW(),"due","in "&ROUND((' + atColLetter + r + '-NOW())*1440,0)&" min"))']);
    }
    sh.getRange(startRow, cols.scheduled_in_min, numRows, 1).setFormulas(formulas);
  }
  
  SpreadsheetApp.flush();
  
  // Store concurrency setting
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  sp.setProperty(schedSheetKey_(sheetId), sheetName);
  sp.setProperty(schedConcurrencyKey_(sheetId), String(concurrency));
  sp.setProperty(schedStartAtKey_(sheetId), String(startAt.getTime()));
  
// Store 2nd round config if enabled
if (config.delayMinutes > 0) {
  const secondRoundConfig = {
    batchId: batchId,
    delayMinutes: config.delayMinutes,
    statuses: config.statuses,
    firstBatchStartedAt: null,
    scheduledStartAt: startAt.toISOString(),
    sheetName: sheetName,
    sheetId: sheetId,
    status: 'waiting_for_first_batch',
    autoSort: config.autoSort !== false,
    voicemailAssistant: config.voicemailAssistant || ''  // NEW: Store voicemail assistant
  };
  sp.setProperty('SECOND_ROUND_' + batchId, JSON.stringify(secondRoundConfig));
}

// Store autoSort preference for batches without 2nd round
sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Queue the rows
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r > HEADER_ROW_INDEX && queue.indexOf(r) === -1) {
      queue.push(r);
    }
  }
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  
  // Delete existing scheduled triggers and create new one
  deleteTriggersByHandler_('vapiScheduledKickoff_');
  ScriptApp.newTrigger('vapiScheduledKickoff_').timeBased().at(startAt).create();
  
  // Create monitor trigger for 2nd round if needed
  if (config.delayMinutes > 0) {
    createSecondRoundMonitorTrigger_();
  }
  
  // Update status sheet
  updateStatus_({ 
    'Script Status': '⏰ Scheduled for ' + Utilities.formatDate(startAt, Session.getScriptTimeZone(), 'HH:mm'),
    'Queued Rows': queue.length,
    'Concurrency Setting': concurrency
  }, sheetName);
  
  // Build result message
  let message = '✅ Batch scheduled!\n\n';
  message += '📞 ' + queuedCount + ' calls queued\n';
  message += '⏰ Starting at: ' + Utilities.formatDate(startAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + '\n';
  message += '🔄 Concurrency: ' + concurrency + ' calls at once\n';
  
  if (config.delayMinutes > 0) {
    message += '\n2️⃣ Second round:\n';
    message += '⏱️ Delay: ' + config.delayMinutes + ' min after 1st batch\n';
    message += '📋 Statuses: ' + config.statuses.join(', ') + '\n';
  }
  
  message += '\nBatch ID: ' + batchId;
  
  return message;
}

function vapiScheduleRange_(sh, range, startAt, concurrency) {
  vapiQueueRange_(sh, range);
  ensureScheduleColumns_(sh);
  const cols = getHeaderMap_(sh);
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  sh.getRange(startRow, cols.scheduled_at, numRows, 1).setValue(startAt);
  const atColLetter = colToA1_(cols.scheduled_at);
  const formulas = [];
  for (let i = 0; i < numRows; i++) { const r = startRow + i; formulas.push(['=IF(' + atColLetter + r + '="","",IF(' + atColLetter + r + '<=NOW(),"due","in "&ROUND((' + atColLetter + r + '-NOW())*1440,0)&" min"))']); }
  sh.getRange(startRow, cols.scheduled_in_min, numRows, 1).setFormulas(formulas);
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  sp.setProperty(schedSheetKey_(sheetId), sheetName);
  sp.setProperty(schedConcurrencyKey_(sheetId), String(concurrency));
  sp.setProperty(schedStartAtKey_(sheetId), String(startAt.getTime()));
  deleteTriggersByHandler_('vapiScheduledKickoff_');
  ScriptApp.newTrigger('vapiScheduledKickoff_').timeBased().at(startAt).create();
}

function vapiCancelScheduledStart() {
  deleteTriggersByHandler_('vapiScheduledKickoff_');
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  if (sheetId) { sp.deleteProperty(schedSheetKey_(sheetId)); sp.deleteProperty(schedConcurrencyKey_(sheetId)); sp.deleteProperty(schedStartAtKey_(sheetId)); }
  updateStatus_({ 'Script Status': '⚪ Idle', 'Queued Rows': 0 }, SpreadsheetApp.getActiveSheet().getName());
  SpreadsheetApp.getUi().alert('✅ Cancelled.');
}

function vapiScheduledKickoff_() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (!sheetId || !apiKey) return;
  
  const sheetName = sp.getProperty(schedSheetKey_(sheetId));
  const concurrency = Number(sp.getProperty(schedConcurrencyKey_(sheetId)) || 1);
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
  if (!sh) return;
  
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  
  // Update any multi-round configs for this sheet to mark Round 1 as started
  const allProps = sp.getProperties();
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    try {
      const config = JSON.parse(allProps[key]);
      if (config.sheetName === sheetName && config.currentRound === 1 && !config.round1StartedAt) {
        config.round1StartedAt = new Date().toISOString();
        sp.setProperty(key, JSON.stringify(config));
        Logger.log('Multi-round campaign started: ' + config.batchId);
        
        // Update status columns
        updateMultiRoundStatusInSheet_(config, '🔄 Round 1/' + config.totalRounds + ' in progress');
        
        // Update next round info
        if (config.rounds && config.rounds.length > 0) {
          const nextRound = config.rounds[0];
          if (nextRound.type === 'delay') {
            updateMultiRoundNextAtInSheet_(config, 'R2: +' + nextRound.delayMinutes + ' min after R1');
          } else {
            const targetTime = new Date(nextRound.scheduledAt);
            updateMultiRoundNextAtInSheet_(config, 'R2: ' + Utilities.formatDate(targetTime, Session.getScriptTimeZone(), 'MMM d HH:mm'));
          }
        } else {
          updateMultiRoundNextAtInSheet_(config, 'Single round campaign');
        }
      }
    } catch (e) {
      Logger.log('Error updating multi-round config: ' + e.message);
    }
  }
  
  // Also update old SECOND_ROUND_ configs (backward compatibility)
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    try {
      const config = JSON.parse(allProps[key]);
      if (config.sheetName === sheetName && config.status === 'waiting_for_first_batch' && !config.firstBatchStartedAt) {
        config.firstBatchStartedAt = new Date().toISOString();
        sp.setProperty(key, JSON.stringify(config));
        Logger.log('Updated 2nd round config - 1st batch started: ' + key);
      }
    } catch (e) {}
  }
  
  processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
}

function vapiStartProcessingActiveSheet_(concurrency) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (!apiKey) return SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY');
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  updateStatus_({ 'Script Status': '🟢 Starting...', 'Concurrency Setting': concurrency, 'Campaign Sheet': sheetName, 'Processing Started': new Date() }, sheetName);
  processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
}

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

function vapiQueueRange_(sh, range) {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  const cols = getHeaderMap_(sh);
  if (!cols.status) throw new Error('Missing Status header');
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const statusVals = sh.getRange(startRow, cols.status, numRows, 1).getValues().map(function(r) { return String(r[0] || '').trim(); });
  const statusOut = [];
  let changed = false;
  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r <= HEADER_ROW_INDEX) { statusOut.push([statusVals[i]]); continue; }
    const status = statusVals[i];
    if (status && status !== 'Queued') { statusOut.push([status]); continue; }
    if (queue.indexOf(r) === -1) { queue.push(r); statusOut.push(['Queued']); changed = true; }
    else statusOut.push([status || 'Queued']);
  }
  if (changed) {
    sh.getRange(startRow, cols.status, numRows, 1).setValues(statusOut);
    queue.sort(function(a, b) { return a - b; });
    sp.setProperty(qKey, JSON.stringify(queue));
    updateStatus_({ 'Queued Rows': queue.length }, sheetName);
  }
}

function vapiStopQueue() {
  ensureSheetId_();
  const sh = SpreadsheetApp.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const cols = getHeaderMap_(sh);
  if (!cols.status) return SpreadsheetApp.getUi().alert('❌ Missing Status header');
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  const lastRow = sh.getLastRow();
  let changeCount = 0;
  if (lastRow > HEADER_ROW_INDEX) {
    const statusRange = sh.getRange(HEADER_ROW_INDEX + 1, cols.status, lastRow - HEADER_ROW_INDEX, 1);
    const statuses = statusRange.getValues();
    for (let i = 0; i < statuses.length; i++) { if (String(statuses[i][0]).trim() === 'Queued') { statuses[i][0] = 'Cancelled'; changeCount++; } }
    if (changeCount > 0) statusRange.setValues(statuses);
  }
  sp.deleteProperty(queueKey_(sheetId, sheetName));
  sp.deleteProperty(activeKey_(sheetId, sheetName));
  sp.deleteProperty(processingKey_(sheetId, sheetName));
  sp.deleteProperty(heartbeatKey_(sheetId, sheetName));
  updateStatus_({ 'Script Status': '🛑 Stopped', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName);
  SpreadsheetApp.getUi().alert('🛑 Stopped. ' + changeCount + ' cancelled.');
}

function ensureScheduleColumns_(sh) {
  const cols = getHeaderMap_(sh);
  let lastCol = sh.getLastColumn();
  if (!cols.scheduled_at) { lastCol++; sh.getRange(HEADER_ROW_INDEX, lastCol).setValue('scheduled_at'); }
  if (!cols.scheduled_in_min) { lastCol++; sh.getRange(HEADER_ROW_INDEX, lastCol).setValue('scheduled_in_min'); }
}

function applyRowHygiene_(sh, rowNum, cols) {
  try {
    sh.setRowHeight(rowNum, DEFAULT_ROW_HEIGHT);
    const columnsToClip = [cols.prospect_name, cols.prospect_email, cols.phone, cols.status, cols.assistant, cols.vapi_number, cols.call_id, cols.outcome_summary, cols.transcript, cols.recording_url, cols.event_name, cols.event_city, cols.callback_when, cols.auto_followup_status, cols.auto_followup_preview].filter(function(c) { return c; });
    columnsToClip.forEach(function(colNum) { try { sh.getRange(rowNum, colNum, 1, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP); } catch (e) {} });
  } catch (e) {}
}

// ============================================================
// PROCESS QUEUE
// ============================================================
function processQueueForSheet_(ss, sh, apiKey, fallbackPhoneNumberId, fallbackAssistantId, concurrency) {
  const sheetName = sh.getName();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { 
    // Don't update status - just return silently. Next webhook/trigger will retry.
    Logger.log('Could not acquire lock for ' + sheetName + ', will retry on next trigger');
    return; 
  }
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  
  try {
    sp.setProperty(processingKey_(sheetId, sheetName), 'true');
    sp.setProperty(processingStartKey_(sheetId, sheetName), String(Date.now()));
    const cols = getHeaderMap_(sh);
    
    // Reduced required columns - assistant and vapi_number no longer required
    const required = ['phone', 'status', 'call_id', 'started_at', 'prospect_name', 'prospect_email', 'event_name', 'event_date', 'event_city', 'caller_name', 'host_name', 'host_first_name', 'host_pronouns', 'event_time', 'event_format', 'target_audience', 'event_area', 'event_venue', 'voicemail_left_count', 'callback_flag', 'callback_when'];
    const missing = required.filter(function(k) { return !cols[k]; });
    if (missing.length) { updateStatus_({ 'Script Status': '❌ Missing headers', 'Last Error': missing.join(', ') }, sheetName); return; }
    
    const qKey = queueKey_(sheetId, sheetName);
    const aKey = activeKey_(sheetId, sheetName);
    let queue = loadJson_(sp, qKey, []);
    let active = loadJson_(sp, aKey, {});
    queue.sort(function(a, b) { return a - b; });
    active = cleanupStaleActive_(sh, active);
    sp.setProperty(aKey, JSON.stringify(active));
    const lastCol = sh.getLastColumn();
    recordHeartbeat_(sheetId, sheetName);
    
    // Load all MULTI_ROUND_ configs for this sheet to find assistant/phone settings
    const batchConfigs = {};
    const allProps = sp.getProperties();
    for (const key in allProps) {
      if (!key.startsWith('MULTI_ROUND_')) continue;
      try {
        const config = JSON.parse(allProps[key]);
        if (config.sheetName === sheetName) {
          batchConfigs[config.batchId] = config;
        }
      } catch (e) {}
    }
    
    // Also load SECOND_ROUND_ configs (old system)
    for (const key in allProps) {
      if (!key.startsWith('SECOND_ROUND_')) continue;
      try {
        const config = JSON.parse(allProps[key]);
        if (config.sheetName === sheetName) {
          batchConfigs[config.batchId] = config;
        }
      } catch (e) {}
    }
    
    let callsMade = 0;
    const startTime = Date.now();
    // Add this line right before: while (Object.keys(active).length < concurrency && queue.length > 0) {
        if (!isUnderBudget_()) {
          updateStatus_({ 'Script Status': '💰 Daily budget reached ($' + getDailySpend_().toFixed(2) + '/$' + DAILY_BUDGET_USD + ')' }, sheetName);
          sp.setProperty(qKey, JSON.stringify(queue));
        return;
          }
        // Add this line right before: while (Object.keys(active).length < concurrency && queue.length > 0) {
          if (!isUnderBudget_()) {
          updateStatus_({ 'Script Status': '💰 Daily budget reached ($' + getDailySpend_().toFixed(2) + '/$' + DAILY_BUDGET_USD + ')' }, sheetName);
          sp.setProperty(qKey, JSON.stringify(queue));
          return;
          }

    while (Object.keys(active).length < concurrency && queue.length > 0) {
      if (Date.now() - startTime > MAX_PROCESSING_TIME_MS) { updateStatus_({ 'Script Status': '⚠️ Timeout' }, sheetName); break; }
      recordHeartbeat_(sheetId, sheetName);
      const rowNum = queue.shift();
      const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
      const phone = normalizePhone_(rowVals[cols.phone - 1]);
      if (!phone) { sh.getRange(rowNum, cols.status).setValue('Skipped: Invalid Phone'); applyRowHygiene_(sh, rowNum, cols); continue; }
      
      // Get batch ID for this row to find config
      const rowBatchId = cols.batch_id ? String(rowVals[cols.batch_id - 1] || '').trim() : '';
      const baseBatchId = rowBatchId.replace(/_R\d+$/, ''); // Remove _R2, _R3, etc.
      const batchConfig = batchConfigs[baseBatchId] || null;
      
      // Determine assistant - prefer batch config, then column, then fallback
      let assistantName = '';
      let assistantId = '';
      
      if (batchConfig && batchConfig.assistant) {
        // Use assistant from batch config
        assistantName = batchConfig.assistant;
        
        // Check if this is a retry round and should use retry assistant
        if (batchConfig.retryAssistant && rowBatchId !== baseBatchId) {
          // This is a retry round (has _R2, _R3, etc.)
          const currentAttempt = cols.call_attempt ? Number(rowVals[cols.call_attempt - 1] || 1) : 1;
          if (currentAttempt > 1) {
            assistantName = batchConfig.retryAssistant;
          }
        }
        
        assistantId = resolveAssistantIdFromName_(ss, assistantName, fallbackAssistantId);
      } else if (cols.assistant) {
        // Fall back to column value (for old batches without config)
        assistantName = String(rowVals[cols.assistant - 1] || '').trim();
        assistantId = resolveAssistantIdFromName_(ss, assistantName, fallbackAssistantId);
      } else {
        assistantId = fallbackAssistantId;
      }
      
      if (!assistantId) { sh.getRange(rowNum, cols.status).setValue('Skipped: No Assistant'); applyRowHygiene_(sh, rowNum, cols); continue; }
      
      // Determine phone number - prefer batch config, then column, then fallback
      let phoneNumberDisplay = '';
      let phoneNumberId = '';
      
      if (batchConfig && batchConfig.phoneNumber) {
        phoneNumberDisplay = batchConfig.phoneNumber;
        phoneNumberId = resolvePhoneNumberIdFromDisplay_(ss, phoneNumberDisplay, fallbackPhoneNumberId);
      } else if (cols.vapi_number) {
        phoneNumberDisplay = String(rowVals[cols.vapi_number - 1] || '').trim();
        phoneNumberId = resolvePhoneNumberIdFromDisplay_(ss, phoneNumberDisplay, fallbackPhoneNumberId);
      } else {
        phoneNumberId = fallbackPhoneNumberId;
      }
      
      if (!phoneNumberId) { sh.getRange(rowNum, cols.status).setValue('Skipped: No Vapi Number'); applyRowHygiene_(sh, rowNum, cols); continue; }
      
      const eventDateStr = formatEventDate_(rowVals[cols.event_date - 1]);
      const eventTimeStr = formatEventTime_(rowVals[cols.event_time - 1]);
      const eventArea = String(rowVals[cols.event_area - 1] || '').trim() || String(rowVals[cols.event_city - 1] || '').trim();
      const eventVenue = String(rowVals[cols.event_venue - 1] || '').trim();
      const voicemailLeftCount = Number(rowVals[cols.voicemail_left_count - 1] || 0) || 0;
      
      const variableValues = {
        prospect_name: String(rowVals[cols.prospect_name - 1] || '').trim(),
        prospect_email: String(rowVals[cols.prospect_email - 1] || '').trim(),
        event_name: String(rowVals[cols.event_name - 1] || '').trim(),
        event_date: eventDateStr,
        event_city: String(rowVals[cols.event_city - 1] || '').trim(),
        event_area: eventArea,
        event_venue: eventVenue,
        caller_name: String(rowVals[cols.caller_name - 1] || 'Alex').trim(),
        host_name: String(rowVals[cols.host_name - 1] || '').trim(),
        host_first_name: String(rowVals[cols.host_first_name - 1] || '').trim(),
        host_pronouns: String(rowVals[cols.host_pronouns - 1] || 'they/them').trim(),
        event_time: eventTimeStr,
        event_format: String(rowVals[cols.event_format - 1] || '').trim(),
        event_context: cols.event_context ? String(rowVals[cols.event_context - 1] || '').trim() : '',
        target_audience: String(rowVals[cols.target_audience - 1] || '').trim(),
        leave_voicemail: voicemailLeftCount >= 1 ? 'no' : 'yes',
        voicemail_action: voicemailLeftCount >= 1 ? 'hang_up_immediately' : 'leave_message',
        voicemail_left_count: String(voicemailLeftCount)
      };
      
      const payload = { 
        assistantId: assistantId, 
        phoneNumberId: phoneNumberId, 
        customer: { number: phone, name: variableValues.prospect_name }, 
        metadata: { sheetName: sheetName, rowNum: rowNum }, 
        assistantOverrides: { variableValues: variableValues } 
      };
      
      try {
        const call = vapiCreateCall_(apiKey, payload);
        if (call && call.id) {
          active[call.id] = rowNum;
          sh.getRange(rowNum, cols.call_id).setValue(call.id);
          sh.getRange(rowNum, cols.status).setValue('Calling...');
          sh.getRange(rowNum, cols.started_at).setValue(new Date());
          applyRowHygiene_(sh, rowNum, cols);
          callsMade++;
          if (!isUnderBudget_()) {
              Logger.log('Daily budget reached, stopping queue');
              break;
              }
          updateStatus_({ 'Script Status': '🟢 Running (' + callsMade + ' calls)', 'Active Calls': Object.keys(active).length }, sheetName);
        } else { sh.getRange(rowNum, cols.status).setValue('Error: No call.id'); applyRowHygiene_(sh, rowNum, cols); }
      } catch (err) {
        sh.getRange(rowNum, cols.status).setValue('Error: ' + (err.message || String(err)).slice(0, 100));
        applyRowHygiene_(sh, rowNum, cols);
        updateStatus_({ 'Last Error': 'Row ' + rowNum + ': ' + (err.message || '').slice(0, 200) }, sheetName);
      }
      Utilities.sleep(500);
    }
    
    sp.setProperty(qKey, JSON.stringify(queue));
    sp.setProperty(aKey, JSON.stringify(active));
    const activeCount = Object.keys(active).length;
    const queuedCount = queue.length;
    if (activeCount === 0 && queuedCount === 0) { 
      updateStatus_({ 'Script Status': '✅ Complete', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName); 
      sp.deleteProperty(processingKey_(sheetId, sheetName));
      autoSortIfBatchComplete_(sheetId, sheetName);
    }
    else updateStatus_({ 'Script Status': '🟢 Running (' + activeCount + ' active, ' + queuedCount + ' queued)', 'Active Calls': activeCount, 'Queued Rows': queuedCount }, sheetName);
  } catch (err) { 
    updateStatus_({ 'Script Status': '❌ Error', 'Last Error': err.message || String(err) }, sheetName); 
    throw err; 
  }
  finally { lock.releaseLock(); }
}

function cleanupStaleActive_(sh, activeMap) {
  const cols = getHeaderMap_(sh);
  if (!cols.started_at || !cols.status) return activeMap || {};
  const now = Date.now();
  const cleaned = {};
  Object.entries(activeMap || {}).forEach(function(entry) {
    const callId = entry[0], rowNum = entry[1];
    try {
      const r = Number(rowNum);
      if (!r || r <= HEADER_ROW_INDEX) return;
      const startedAt = sh.getRange(r, cols.started_at).getValue();
      const status = String(sh.getRange(r, cols.status).getValue() || '').trim();
      if (!(startedAt instanceof Date)) { if (status === 'Calling...') { sh.getRange(r, cols.status).setValue('Auto-cleared'); applyRowHygiene_(sh, r, cols); } return; }
      const ageMin = (now - startedAt.getTime()) / 60000;
      if (ageMin < STALE_ACTIVE_MINUTES && status === 'Calling...') { cleaned[callId] = r; return; }
      if (status === 'Calling...') { sh.getRange(r, cols.status).setValue('Auto-cleared (stale)'); applyRowHygiene_(sh, r, cols); }
    } catch (e) {}
  });
  return cleaned;
}

// ============================================================
// WEBHOOK (doPost)
// ============================================================

function doPost(e) {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  let sheetName = null;
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    const body = raw ? JSON.parse(raw) : {};
    const msg = body.message || body || {};
    const type = String(msg.type || (msg.message ? msg.message.type : '') || '').trim();
    const isEnd = (type === 'end-of-call-report' || type === 'call-ended' || type === 'call.ended');
    if (!isEnd) return ContentService.createTextOutput('Ignored: ' + (type || 'no-type'));
    const call = msg.call || (msg.message ? msg.message.call : {}) || {};
    const meta = call.metadata || msg.metadata || (msg.message ? msg.message.metadata : {}) || {};
    const callId = String(call.id || msg.callId || (msg.message ? msg.message.callId : '') || '').trim();
    if (!sheetId) return ContentService.createTextOutput('Error: Missing SHEET_ID');
    const ss = SpreadsheetApp.openById(sheetId);
    let sh = null;
    let rowNum = Number(meta.rowNum || 0);
    if (meta.sheetName) sh = ss.getSheetByName(meta.sheetName);
    if (!sh || !rowNum) { for (let i = 0; i < ss.getSheets().length; i++) { const candidate = ss.getSheets()[i]; const r = findRowByCallId_(candidate, callId); if (r) { sh = candidate; rowNum = r; break; } } }
    if (!sh || !rowNum) return ContentService.createTextOutput('Error: Could not locate row');
    sheetName = sh.getName();
    const cols = getHeaderMap_(sh);
    if (!cols.status) return ContentService.createTextOutput('Error: Missing Status header');
    const transcript = (msg.artifact ? msg.artifact.transcript : '') || (msg.message && msg.message.artifact ? msg.message.artifact.transcript : '') || (call.artifact ? call.artifact.transcript : '') || '';
    const recordingUrl = (msg.artifact ? (msg.artifact.recordingUrl || msg.artifact.recording_url) : '') || (msg.message && msg.message.artifact ? msg.message.artifact.recordingUrl : '') || (call.artifact ? call.artifact.recordingUrl : '') || '';
    let summary = (msg.analysis ? msg.analysis.summary : '') || (msg.message && msg.message.analysis ? msg.message.analysis.summary : '') || (call.analysis ? call.analysis.summary : '') || '';
    let startedAt = null;
    if (cols.started_at) { const v = sh.getRange(rowNum, cols.started_at).getValue(); if (v instanceof Date) startedAt = v; }
    const extracted = extractStructured_(msg);
    
    // Try to extract corrected email from transcript if not in structured data
    if (!extracted.corrected_email && transcript) {
      const emailFromTranscript = extractCorrectedEmailFromTranscript_(transcript);
      if (emailFromTranscript) extracted.corrected_email = emailFromTranscript;
    }
    
    if (cols.corrected_email && extracted.corrected_email) {
      const originalEmail = cols.prospect_email ? String(sh.getRange(rowNum, cols.prospect_email).getValue() || '').trim().toLowerCase() : '';
      if (extracted.corrected_email !== originalEmail) {
        sh.getRange(rowNum, cols.corrected_email).setValue(extracted.corrected_email);
      }
    }

    if (extracted.callback_requested && extracted.callback_when) {
      const tag = 'Callback requested: ' + extracted.callback_when;
      const s = String(summary || '').trim();
      if (s.toLowerCase().indexOf('callback requested') === -1) summary = s ? (tag + ' | ' + s) : tag;
    }
    if (detectNumberFailed_(transcript, summary)) {
      const s = String(summary || '').trim();
      if (s.toLowerCase().indexOf('number failed') === -1) summary = 'Number failed: ' + (s || 'Call could not be completed.');
    }
    
    // Get additional context for status determination
    const batchId = cols.batch_id ? String(sh.getRange(rowNum, cols.batch_id).getValue() || '').trim() : '';
    const isSecondRound = batchId.endsWith('_R2');
    const callAttempt = cols.call_attempt ? Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 0) : 0;
    const currentVoicemailCount = cols.voicemail_left_count ? Number(sh.getRange(rowNum, cols.voicemail_left_count).getValue() || 0) : 0;

    // Determine previous status based on context
    let previousStatus = '';
    if (isSecondRound) {
      if (currentVoicemailCount >= 1) {
        previousStatus = 'Voicemail';
      } else {
        previousStatus = 'No Answer';
      }
    }

    const statusValue = determineStatus_(msg, transcript, summary, startedAt, {
      isSecondRound: isSecondRound,
      callAttempt: callAttempt,
      voicemailLeftCount: currentVoicemailCount,
      previousStatus: previousStatus
    });

    let leadQuality = '';
    if (extracted.success === true) leadQuality = 'GOOD';
    else if (extracted.success === false) leadQuality = 'BAD';
    else leadQuality = calculateLeadQuality_(statusValue, extracted.outcome, extracted.callback_requested, summary + ' ' + transcript);
    if (statusValue === 'Voicemail' && cols.voicemail_left_count) {
      const currentCount = Number(sh.getRange(rowNum, cols.voicemail_left_count).getValue() || 0);
      sh.getRange(rowNum, cols.voicemail_left_count).setValue(currentCount + 1);
    }
    if (cols.call_attempt) {
      const currentAttempt = Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 0);
      if (currentAttempt === 0) sh.getRange(rowNum, cols.call_attempt).setValue(1);
    }
// Add round suffix if this is a 2nd+ round call
    let finalStatus = statusValue;
    if (cols.call_attempt) {
      const attempt = Number(sh.getRange(rowNum, cols.call_attempt).getValue() || 1);
      if (attempt > 1) {
        finalStatus = statusValue + getRoundSuffix_(attempt);
      }
    }
    sh.getRange(rowNum, cols.status).setValue(finalStatus);
    if (cols.ended_at) sh.getRange(rowNum, cols.ended_at).setValue(new Date());
    if (cols.outcome_summary) sh.getRange(rowNum, cols.outcome_summary).setValue(summary || '');
    if (cols.transcript) sh.getRange(rowNum, cols.transcript).setValue(transcript || '');
    if (cols.recording_url) sh.getRange(rowNum, cols.recording_url).setValue(recordingUrl || '');
    // Track call cost for daily budget
          if (callId) {
            const apiKey = sp.getProperty('VAPI_API_KEY');
            const cost = getCallCostFromVapi_(apiKey, callId);
          if (cost > 0) {
            addToDailySpend_(cost);
             Logger.log('Call cost: $' + cost.toFixed(4) + ' | Daily total: $' + getDailySpend_().toFixed(2));
              }
}
    if (cols.lead_quality) sh.getRange(rowNum, cols.lead_quality).setValue(leadQuality || '');
    // Update next_round_at based on whether this row will be skipped
    if (cols.next_round_at) {
      const baseStatus = getBaseStatus_(finalStatus);
      if (shouldSkipStatus_(baseStatus)) {
        sh.getRange(rowNum, cols.next_round_at).setValue('⏭️ To be Skipped');
      }
      // If not skipping, keep the existing scheduled time
    }
    applyRowHygiene_(sh, rowNum, cols);
    
    // ========== AUTO FOLLOW-UP TRIGGER ==========
    // ========== AUTO FOLLOW-UP TRIGGER ==========
if (AUTO_FOLLOWUP_TRIGGER_STATUSES.indexOf(statusValue) !== -1) {
  const lastCol = sh.getLastColumn();
  const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  
  const originalEmail = cols.prospect_email ? String(rowVals[cols.prospect_email - 1] || '').trim() : '';
  const emailToUse = extracted.corrected_email || originalEmail;
  
  // Get email verification score
  const emailVerificationCol = cols.email_verification || null;
  let emailVerificationScore = null;
  if (emailVerificationCol) {
    const scoreVal = rowVals[emailVerificationCol - 1];
    emailVerificationScore = Number(scoreVal);
    if (isNaN(emailVerificationScore)) emailVerificationScore = null;
  }
  
  const prospectData = {
    prospectName: cols.prospect_name ? String(rowVals[cols.prospect_name - 1] || '').trim() : '',
    prospectEmail: emailToUse,
    phone: cols.phone ? normalizePhone_(rowVals[cols.phone - 1]) : '',
    eventName: cols.event_name ? String(rowVals[cols.event_name - 1] || '').trim() : '',
    eventDate: cols.event_date ? formatEventDate_(rowVals[cols.event_date - 1]) : '',
    eventCity: cols.event_city ? String(rowVals[cols.event_city - 1] || '').trim() : '',
    eventTime: cols.event_time ? formatEventTime_(rowVals[cols.event_time - 1]) : '',
    eventVenue: cols.event_venue ? String(rowVals[cols.event_venue - 1] || '').trim() : '',
    callerName: cols.caller_name ? String(rowVals[cols.caller_name - 1] || '').trim() : '',
    hostName: cols.host_name ? String(rowVals[cols.host_name - 1] || '').trim() : '',
    batchId: cols.batch_id ? String(rowVals[cols.batch_id - 1] || '').trim() : '',
    emailVerificationScore: emailVerificationScore
  };
  scheduleAutoFollowup_(sheetId, sheetName, rowNum, statusValue, prospectData);
}
    
 const aKey = activeKey_(sheetId, sheetName);
    let active = loadJson_(sp, aKey, {});
    if (callId && active[callId]) { 
      delete active[callId]; 
      sp.setProperty(aKey, JSON.stringify(active)); 
    }
    
    let concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 0);
    if (!concurrency) concurrency = Number(sp.getProperty(schedConcurrencyKey_(sheetId)) || 1);
    if (concurrency < 1) concurrency = 1;
    
    const queue = loadJson_(sp, queueKey_(sheetId, sheetName), []);
    const activeCount = Object.keys(active).length;
    const queueCount = queue.length;
    
    updateStatus_({ 'Active Calls': activeCount, 'Queued Rows': queueCount }, sheetName);
    
    // Check if more calls needed
    if (queueCount > 0 && activeCount < concurrency) {
      processQueueForSheet_(ss, sh, sp.getProperty('VAPI_API_KEY'), sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
    }
    
    // ALWAYS check for completion (this was the bug - it was inside else if)
    if (queueCount === 0 && activeCount === 0) {
      updateStatus_({ 'Script Status': '✅ Complete', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName);
      sp.deleteProperty(processingKey_(sheetId, sheetName));
      autoSortIfBatchComplete_(sheetId, sheetName);
    }


    return ContentService.createTextOutput('OK');
  } catch (err) {
    if (sheetName) updateStatus_({ 'Last Error': 'Webhook: ' + (err.message || String(err)) }, sheetName);
    return ContentService.createTextOutput('Error: ' + (err.message || String(err)));
  }
}

function doGet() { return ContentService.createTextOutput('OK - Web App reachable'); }

// ============================================================
// STATUS LOGIC
// ============================================================

function determineStatus_(msg, transcript, summary, startedAt, context) {
  // Context contains: isSecondRound, callAttempt, voicemailLeftCount, previousStatus
  // NOTE: This function should NEVER add round suffixes (2nd, 3rd, etc.)
  // Suffixes are added in doPost based on call_attempt
  context = context || {};
  
  const extracted = extractStructured_(msg);
  const fromVapi = normalizeStatus_(extracted.call_status);
  
  const tRaw = String(transcript || '').trim();
  const sRaw = String(summary || '').trim();
  const t = tRaw.toLowerCase();
  const s = sRaw.toLowerCase();
  let durationSec = null;
  if (startedAt instanceof Date) durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
  
  // Check for voicemail/no answer indicators
  const hasVoicemailIndicator = s.indexOf('voicemail') !== -1 || t.indexOf('voicemail') !== -1 ||
    t.indexOf('leave a message') !== -1 || t.indexOf('after the beep') !== -1 ||
    t.indexOf('after the tone') !== -1 || t.indexOf('not available') !== -1;
  
  const automatedPhrases = ['please leave', 'after the', 'beep', 'tone', 'not available', 'voicemail', 'message', 'record your'];
  const hasOnlyAutomated = automatedPhrases.some(function(phrase) {
    return t.indexOf(phrase) !== -1;
  });
  
  // If VAPI returned a status, use it (strip any suffix it might have)
  if (fromVapi) {
    return getBaseStatus_(fromVapi);
  }
  
  // Manual detection
  const gatekeeperResult = detectAiGatekeeper_(tRaw);
  if (gatekeeperResult.detected && gatekeeperResult.rejected) return 'AI Gatekeeper';
  if (detectNumberFailed_(tRaw, sRaw)) return 'Number Failed';
  
  // Voicemail detected
  if (hasVoicemailIndicator) {
    return 'Voicemail';
  }
  
  // Short call with transcript = hung up
  if (durationSec !== null && durationSec <= 30 && tRaw.length > 0) {
    if (tRaw.length < 100 || hasOnlyAutomated) {
      return 'No Answer';
    }
    return 'Hung Up (≤30s)';
  }
  
  // No transcript at all
  if (!tRaw) {
    return 'No Answer';
  }
  
  // Very short/automated transcript
  if (tRaw.length < 100 || hasOnlyAutomated) {
    return 'No Answer';
  }
  
  return 'Spoke to Human';
}

function normalizeStatus_(s) {
  const v = String(s || '').trim().toLowerCase();
  if (!v) return '';
  if (v.indexOf('ai gatekeeper') !== -1) return 'AI Gatekeeper';
  if (v.indexOf('spoke') !== -1) return 'Spoke to Human';
  if (v.indexOf('voicemail') !== -1) return 'Voicemail';
  if (v.indexOf('number failed') !== -1 || v.indexOf('invalid') !== -1 || v.indexOf('not in service') !== -1 || v.indexOf('disconnected') !== -1) return 'Number Failed';
  if (v.indexOf('no answer') !== -1 || v.indexOf('no_answer') !== -1) return 'No Answer';
  if (v.indexOf('hung up') !== -1 || v.indexOf('hangup') !== -1 || v.indexOf('≤30') !== -1) return 'Hung Up (≤30s)';
  return '';
}

function extractStructured_(msg) {
  const out = { call_status: '', callback_requested: false, callback_when: '', success: null, outcome: '', corrected_email: '' };
  const analysis = msg.analysis || (msg.message ? msg.message.analysis : null);
  const candidates = [analysis ? analysis.structuredData : null, analysis ? analysis.structured_data : null, analysis ? analysis.json : null, analysis ? analysis.extraction : null, analysis ? analysis.extractions : null, analysis ? analysis.output : null, analysis].filter(Boolean);
  let data = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (typeof c === 'string') { try { const parsed = JSON.parse(c); if (parsed && typeof parsed === 'object') { data = parsed; break; } } catch (e) {} }
    else if (c && typeof c === 'object') { data = c; break; }
  }
  if (data && typeof data === 'object') {
    const cs = data.call_status || data.callStatus || data['call status'] || data.status;
    if (typeof cs === 'string') out.call_status = cs.trim();
    const cr = data.callback_requested || data.callbackRequested || data['callback requested'];
    if (typeof cr === 'boolean') out.callback_requested = cr;
    if (typeof cr === 'string') out.callback_requested = cr.trim().toLowerCase() === 'true';
    const cw = data.callback_when || data.callbackWhen || data['callback when'];
    if (typeof cw === 'string') out.callback_when = cw.trim();
    const successField = data.success || data.Success || data['Success Evaluation - Pass/Fail'] || data['Success Evaluation'] || data.successEvaluation || data.result || data.passed || data.pass || data.evaluation;
    if (typeof successField === 'boolean') out.success = successField;
    else if (typeof successField === 'string') { const val = successField.trim().toLowerCase(); if (val === 'true' || val === 'yes' || val === 'pass' || val === 'good') out.success = true; else if (val === 'false' || val === 'no' || val === 'fail' || val === 'bad') out.success = false; }
    const oc = data.outcome || data.Outcome;
    if (typeof oc === 'string') out.outcome = oc.trim();
    const ce = data.corrected_email || data.correctedEmail || data['corrected email'] || data.new_email || data.newEmail || data['new email'] || data.updated_email || data.updatedEmail || data['updated email'] || data.email_correction || data.emailCorrection;
    if (typeof ce === 'string' && ce.includes('@')) out.corrected_email = ce.trim().toLowerCase();
  }
  
  // If no corrected email from structured data, try to extract from transcript
  if (!out.corrected_email) {
    const transcript = (msg.artifact ? msg.artifact.transcript : '') || (msg.message && msg.message.artifact ? msg.message.artifact.transcript : '') || '';
    const extractedEmail = extractEmailFromTranscript_(transcript);
    if (extractedEmail) out.corrected_email = extractedEmail;
  }
  
  return out;
}

function extractCorrectedEmailFromTranscript_(transcript) {
  if (!transcript) return '';
  const t = String(transcript).toLowerCase();
  
  // Pattern: "X at Y dot com" - handles "antonio at ortas club dot com"
  const pattern = /(?:send\s+(?:it\s+)?to|it'?s|email\s+is|address\s+is|to)\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+at\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+dot\s+([a-z]+)/gi;
  
  let match;
  while ((match = pattern.exec(t)) !== null) {
    const localPart = match[1].replace(/\s+/g, '');
    const domainName = match[2].replace(/\s+/g, '');
    const tld = match[3].replace(/\s+/g, '');
    const email = localPart + '@' + domainName + '.' + tld;
    if (email.length > 5) return email.toLowerCase();
  }
  
  // Fallback: find standard email format
  const standardMatch = t.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi);
  if (standardMatch && standardMatch.length > 0) {
    return standardMatch[standardMatch.length - 1].toLowerCase();
  }
  
  return '';
}

function extractEmailFromTranscript_(transcript) {
  if (!transcript) return '';
  const t = String(transcript).toLowerCase();
  
  // Look for patterns where user corrects their email
  // Common patterns: "it's actually X", "no, it's X", "my email is X", "send it to X"
  const correctionPatterns = [
    /(?:no[,.]?\s*)?(?:actually[,.]?\s*)?(?:it'?s|my email is|send (?:it |the )?(?:details |invite |invitation )?to)\s+([a-z0-9][a-z0-9._%+-]*\s*(?:at|@)\s*[a-z0-9][a-z0-9.-]*\s*(?:dot|\.)\s*[a-z]{2,})/gi,
    /(?:email is|address is|send to|mail to)\s+([a-z0-9][a-z0-9._%+-]*\s*(?:at|@)\s*[a-z0-9][a-z0-9.-]*\s*(?:dot|\.)\s*[a-z]{2,})/gi
  ];
  
  // Also look for AI confirming they'll send to a new email
  const aiConfirmPatterns = [
    /(?:send|update|send the details to|send it to)\s+([a-z0-9][a-z0-9._%+-]*\s*(?:at|@)\s*[a-z0-9][a-z0-9.-]*\s*(?:dot|\.)\s*[a-z]{2,})/gi
  ];
  
  let foundEmail = '';
  
  // Check correction patterns first
  for (const pattern of correctionPatterns) {
    const matches = t.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        foundEmail = normalizeSpokenEmail_(match[1]);
        if (foundEmail) return foundEmail;
      }
    }
  }
  
  // Check AI confirmation patterns (when AI says "I'll send to X@Y.com")
  for (const pattern of aiConfirmPatterns) {
    const matches = t.matchAll(pattern);
    for (const match of matches) {
      if (match[1]) {
        foundEmail = normalizeSpokenEmail_(match[1]);
        if (foundEmail) return foundEmail;
      }
    }
  }
  
  return '';
}

function normalizeSpokenEmail_(spokenEmail) {
  if (!spokenEmail) return '';
  let email = String(spokenEmail).toLowerCase().trim();
  
  // Convert spoken words to email characters
  email = email
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+dash\s+/g, '-')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+/g, ''); // Remove any remaining spaces
  
  // Validate it looks like an email
  if (email.includes('@') && email.includes('.') && email.length > 5) {
    // Basic email regex validation
    const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
    if (emailRegex.test(email)) {
      return email;
    }
  }
  
  return '';
}

function calculateLeadQuality_(status, outcome, callbackRequested, summaryAndTranscript) {
  const s = String(status || '').toLowerCase();
  const o = String(outcome || '').toLowerCase();
  const text = String(summaryAndTranscript || '').toLowerCase();
  const declinePhrases = ['not interested', 'no thanks', 'no thank you', "don't call", 'dont call', 'stop calling', 'remove me', 'take me off', 'not for me', "i'm good", 'no need', 'declined', 'rejected', "don't contact", 'dont contact', 'leave me alone'];
  const interestPhrases = ['interested', 'sounds good', 'sounds great', 'tell me more', 'send it', 'resend', 'bump the email', 'bump it', "i'll look", 'i will look', "i'll check", 'i will check', 'yes', 'sure', 'okay', "i'd love", 'i would love', 'count me in', 'sign me up'];
  if (s.indexOf('number failed') !== -1 || s.indexOf('hung up') !== -1) return 'BAD';
  if (o.indexOf('declined') !== -1 || o.indexOf('remove') !== -1 || o.indexOf('not interested') !== -1) return 'BAD';
  for (let i = 0; i < declinePhrases.length; i++) { if (text.indexOf(declinePhrases[i]) !== -1) return 'BAD'; }
  if (callbackRequested || o.indexOf('interested') !== -1 || o.indexOf('callback') !== -1) return 'GOOD';
  for (let i = 0; i < interestPhrases.length; i++) { if (text.indexOf(interestPhrases[i]) !== -1) return 'GOOD'; }
  if (s.indexOf('voicemail') !== -1 || s.indexOf('no answer') !== -1) return 'GOOD';
  if (s.indexOf('ai gatekeeper') !== -1) return 'BAD';
  if (o.indexOf('gatekeeper') !== -1 || o.indexOf('busy') !== -1) return 'GOOD';
  if (s.indexOf('spoke to human') !== -1) return 'BAD';
  return 'BAD';
}

function detectAiGatekeeper_(transcript) {
  const t = String(transcript || '').toLowerCase().replace(/['']/g, "'").replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
  const gatekeeperGreeting = ["record your name", "reason for calling", "see if this person is available"];
  const rejectionPhrases = ["this person is not available", "leave an additional message", "please reply after the tone", "not available right now", "cannot take your call", "is not available if you would like"];
  let detected = true;
  for (let i = 0; i < gatekeeperGreeting.length; i++) { if (t.indexOf(gatekeeperGreeting[i]) === -1) { detected = false; break; } }
  let rejected = false;
  for (let i = 0; i < rejectionPhrases.length; i++) { if (t.indexOf(rejectionPhrases[i]) !== -1) { rejected = true; break; } }
  return { detected: detected, rejected: rejected };
}

function detectNumberFailed_(transcript, summary) {
  const text = (String(summary || '') + ' ' + String(transcript || '')).toLowerCase();
  const patterns = ['number is not in service', 'not in service', 'invalid number', 'call could not be completed', 'could not be completed', 'failed to connect', 'connection failed', 'twilio connection failed', 'unallocated number', 'disconnected', 'no route to destination', 'carrier error', 'sip error', 'hangup cause'];
  for (let i = 0; i < patterns.length; i++) { if (text.indexOf(patterns[i]) !== -1) return true; }
  return false;
}

function findRowByCallId_(sh, callId) {
  if (!callId) return 0;
  const cols = getHeaderMap_(sh);
  if (!cols.call_id) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) return 0;
  const values = sh.getRange(HEADER_ROW_INDEX + 1, cols.call_id, lastRow - HEADER_ROW_INDEX, 1).getValues();
  for (let i = 0; i < values.length; i++) { if (String(values[i][0] || '').trim() === callId) return HEADER_ROW_INDEX + 1 + i; }
return 0;
}

// ============================================================
// VAPI API & RESOLVERS
// ============================================================

function vapiCreateCall_(apiKey, payload) {
  const res = UrlFetchApp.fetch('https://api.vapi.ai/call', { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + apiKey }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error(res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function resolveAssistantIdFromName_(ss, name, fallback) {
  const target = String(name || '').trim();
  if (target) {
    const aSh = ss.getSheetByName(ASSISTANTS_SHEET_NAME);
    if (aSh) { const vals = aSh.getDataRange().getValues(); for (let i = 1; i < vals.length; i++) { if (String(vals[i][0]).trim() === target) return String(vals[i][1]).trim(); } }
  }
  return fallback ? String(fallback).trim() : '';
}

function resolvePhoneNumberIdFromDisplay_(ss, display, fallback) {
  const target = String(display || '').trim();
  if (target) {
    const pSh = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME);
    if (pSh) { const vals = pSh.getDataRange().getValues(); for (let i = 1; i < vals.length; i++) { if (String(vals[i][0]).trim() === target) return String(vals[i][2]).trim(); } }
  }
  return fallback ? String(fallback).trim() : '';
}

function vapiRefreshAssistantDropdown() {
  ensureSheetId_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (!apiKey) return SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY');
  const cols = getHeaderMap_(sh);
  if (!cols.assistant) return SpreadsheetApp.getUi().alert('❌ Missing Assistant header');
  try {
    const res = UrlFetchApp.fetch('https://api.vapi.ai/assistant', { method: 'get', headers: { Authorization: 'Bearer ' + apiKey }, muteHttpExceptions: true });
    const assistants = JSON.parse(res.getContentText());
    const arr = Array.isArray(assistants) ? assistants : (assistants.data || []);
    let aSh = ss.getSheetByName(ASSISTANTS_SHEET_NAME) || ss.insertSheet(ASSISTANTS_SHEET_NAME);
    aSh.clear().getRange(1, 1, 1, 2).setValues([['Name', 'ID']]);
    if (arr.length) {
      const rows = arr.map(function(a) { return [String(a.name || a.id).trim(), String(a.id).trim()]; });
      aSh.getRange(2, 1, rows.length, 2).setValues(rows);
      const rule = SpreadsheetApp.newDataValidation().requireValueInRange(aSh.getRange(2, 1, rows.length, 1), true).build();
      sh.getRange(HEADER_ROW_INDEX + 1, cols.assistant, sh.getMaxRows() - HEADER_ROW_INDEX, 1).setDataValidation(rule);
      SpreadsheetApp.getUi().alert('✅ Assistants updated.');
    } else SpreadsheetApp.getUi().alert('⚠️ No assistants returned.');
  } catch (e) { SpreadsheetApp.getUi().alert('Error: ' + e.message); }
}

function vapiRefreshPhoneNumberDropdown() {
  ensureSheetId_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const cols = getHeaderMap_(sh);
  if (!cols.vapi_number) return SpreadsheetApp.getUi().alert('❌ Missing "Vapi number" header');
  let pSh = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME) || ss.insertSheet(PHONE_NUMBERS_SHEET_NAME);
  pSh.clear().getRange(1, 1, 1, 3).setValues([['Display', 'E164', 'ID']]);
  const rows = VAPI_PHONE_NUMBERS.map(function(x) { return [x.display, x.e164, x.id]; });
  pSh.getRange(2, 1, rows.length, 3).setValues(rows);
  const rule = SpreadsheetApp.newDataValidation().requireValueInRange(pSh.getRange(2, 1, rows.length, 1), true).build();
  sh.getRange(HEADER_ROW_INDEX + 1, cols.vapi_number, sh.getMaxRows() - HEADER_ROW_INDEX, 1).setDataValidation(rule);
  SpreadsheetApp.getUi().alert('✅ Phone numbers updated.');
}

// ============================================================
// OUTREACH WIZARDS — EMAIL
// ============================================================

function openEmailWizard() {
  const html = HtmlService.createHtmlOutputFromFile("EmailWizard").setWidth(520).setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, "Follow-up Email Wizard");
}

function getEmailWizardPreview() { return _buildOutreachPreview_("email"); }

function sendEmailsFromWizard(payload) {
  if (!payload || !Array.isArray(payload.candidates)) throw new Error("Invalid payload.");
  const subject = (payload.subject || "").trim() || "Quick follow-up";
  const bodyTemplate = (payload.body || "").trim() || "Hi {{name}},\n\nJust tried to reach you — reply here with a good time.\n\nBest,\n{{sender}}";
  const sent = [], failed = [];
  payload.candidates.forEach(function(c) {
    try {
      const to = _s_(c.recipient);
      if (!to || to.indexOf("@") === -1) throw new Error("Invalid email");
      const name = _s_(c.prospectName) || "there";
      const sender = _s_(c.callerName) || (Session.getActiveUser().getEmail() || "Me");
      const body = bodyTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender);
      GmailApp.sendEmail(to, subject, body);
      sent.push({ row: c.row, recipient: to });
      var batchId = _s_(c.batchId);
      if (batchId) logToProjectTagSheet_(to, batchId);
    } catch (e) { failed.push({ row: c.row, recipient: c.recipient, error: String(e.message || e) }); }
  });
  return { sentCount: sent.length, failedCount: failed.length, sent: sent, failed: failed };
}

// ============================================================
// OUTREACH WIZARDS — SMS
// ============================================================

function openSmsWizard() {
  const html = HtmlService.createHtmlOutputFromFile("SmsWizard").setWidth(520).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, "Follow-up SMS Wizard");
}

function getSmsWizardPreview() { return _buildOutreachPreview_("sms"); }

function sendSmsFromWizard(payload) {
  if (!payload || !Array.isArray(payload.candidates)) throw new Error("Invalid payload.");
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty("TWILIO_ACCOUNT_SID");
  const token = props.getProperty("TWILIO_AUTH_TOKEN");
  const fromNumber = props.getProperty("TWILIO_FROM_NUMBER");
  if (!sid || !token || !fromNumber) throw new Error("Missing Twilio Script Properties");
  const smsTemplate = (payload.body || "").trim() || "Hi {{name}} — it's {{sender}}. Tried to reach you. When's a good time to reconnect?";
  const sent = [], failed = [];
  payload.candidates.forEach(function(c) {
    try {
      const to = _s_(c.recipient);
      if (!to || to.indexOf("+") !== 0) throw new Error("Invalid phone (must be E.164 +...)");
      if (wasMessagedThisWeek_(to)) throw new Error("Skipped: SMS sent within 7d");
      const name = _s_(c.prospectName) || "there";
      const sender = _s_(c.callerName) || "me";
      const body = smsTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender);
      _twilioSendSms_(sid, token, fromNumber, to, body);
      sent.push({ row: c.row, recipient: to });
    } catch (e) { failed.push({ row: c.row, recipient: c.recipient, error: String(e.message || e) }); }
  });
  return { sentCount: sent.length, failedCount: failed.length, sent: sent, failed: failed };
}

function _twilioSendSms_(sid, token, fromNumber, toNumber, body) {
  const url = "https://api.twilio.com/2010-04-01/Accounts/" + encodeURIComponent(sid) + "/Messages.json";
  const options = { method: "post", muteHttpExceptions: true, payload: { From: fromNumber, To: toNumber, Body: body }, headers: { Authorization: "Basic " + Utilities.base64Encode(sid + ":" + token) } };
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Twilio error " + code + ": " + res.getContentText());
}

// ============================================================
// OUTREACH WIZARDS — BOTH
// ============================================================

function openBothWizard() {
  const html = HtmlService.createHtmlOutputFromFile("BothWizard").setWidth(560).setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, "Follow-up Email + SMS Wizard");
}

function getBothWizardPreview() { return _buildOutreachPreview_("both"); }

function sendBothFromWizard(payload) {
  if (!payload || !Array.isArray(payload.candidates)) throw new Error("Invalid payload.");
  const props = PropertiesService.getScriptProperties();
  const sid = props.getProperty("TWILIO_ACCOUNT_SID");
  const token = props.getProperty("TWILIO_AUTH_TOKEN");
  const fromNumber = props.getProperty("TWILIO_FROM_NUMBER");
  if (!sid || !token || !fromNumber) throw new Error("Missing Twilio Script Properties");
  const emailSubject = (payload.emailSubject || "").trim() || "Quick follow-up";
  const emailBodyTemplate = (payload.emailBody || "").trim() || "Hi {{name}},\n\nJust tried to reach you — reply here with a good time.\n\nBest,\n{{sender}}";
  const smsTemplate = (payload.smsBody || "").trim() || "Hi {{name}} — it's {{sender}}. Tried to reach you. When's a good time?";
  const emailSent = [], emailFailed = [], smsSent = [], smsFailed = [];
  payload.candidates.forEach(function(c) {
    const name = _s_(c.prospectName) || "there";
    const sender = _s_(c.callerName) || (Session.getActiveUser().getEmail() || "Me");
    try {
      const toEmail = _s_(c.email);
      if (!toEmail || toEmail.indexOf("@") === -1) throw new Error("Invalid email");
      const body = emailBodyTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender);
      GmailApp.sendEmail(toEmail, emailSubject, body);
      emailSent.push({ row: c.row, recipient: toEmail });
    } catch (e) { emailFailed.push({ row: c.row, recipient: c.email, error: String(e.message || e) }); }
    try {
      const toPhone = _s_(c.phone);
      if (!toPhone || toPhone.indexOf("+") !== 0) throw new Error("Invalid phone");
      if (wasMessagedThisWeek_(toPhone)) throw new Error("Skipped: SMS sent within 7d");
      const body = smsTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender);
      _twilioSendSms_(sid, token, fromNumber, toPhone, body);
      smsSent.push({ row: c.row, recipient: toPhone });
      var batchId = _s_(c.batchId);
      if (batchId) logToProjectTagSheet_(toPhone, batchId);
    } catch (e) { smsFailed.push({ row: c.row, recipient: c.phone, error: String(e.message || e) }); }
  });
  return { emailSentCount: emailSent.length, emailFailedCount: emailFailed.length, smsSentCount: smsSent.length, smsFailedCount: smsFailed.length, emailFailed: emailFailed, smsFailed: smsFailed };
}

// ============================================================
// OUTREACH PREVIEW BUILDER
// ============================================================

function _buildOutreachPreview_(mode) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getActiveRange();
  if (!range) throw new Error("Select at least one row first.");
  const normMap = _buildNormHeaderMap_(sheet);
  const colName = _resolveCol_(normMap, HEADER_ALIASES.prospect_name);
  const colEmail = _resolveCol_(normMap, HEADER_ALIASES.prospect_email);
  const colScore = _resolveCol_(normMap, HEADER_ALIASES.email_verification);
  const colPhone = _resolveCol_(normMap, HEADER_ALIASES.phone);
  const colStatus = _resolveCol_(normMap, HEADER_ALIASES.status);
  const colCaller = _resolveCol_(normMap, HEADER_ALIASES.caller_name);
  const colBatchId = _resolveCol_(normMap, HEADER_ALIASES.batch_id);
  const lastCol = sheet.getLastColumn();
  const rows = sheet.getRange(range.getRow(), 1, range.getNumRows(), lastCol).getValues();
  const candidates = [], skipped = [];
  rows.forEach(function(r, i) {
    const rowNum = range.getRow() + i;
    const name = colName ? _s_(r[colName.index0]) : "";
    const email = colEmail ? _s_(r[colEmail.index0]) : "";
    const score = colScore ? _n_(r[colScore.index0]) : NaN;
    const phone = colPhone ? _s_(r[colPhone.index0]) : "";
    const status = colStatus ? _s_(r[colStatus.index0]) : "";
    const caller = colCaller ? _s_(r[colCaller.index0]) : "";
    const reasons = [];
    if (!colScore) reasons.push("Missing email_verification header");
    if (!(score > SCORE_THRESHOLD)) reasons.push("email_verification <= " + SCORE_THRESHOLD);
    if (!colStatus) reasons.push("Missing Status header");
    if (!ALLOWED_STATUSES.has(status)) reasons.push("Status not allowed");
    if (mode === "email" || mode === "both") {
      if (!colEmail) reasons.push("Missing prospect_email header");
      if (!email || email.indexOf("@") === -1) reasons.push("Invalid prospect_email");
    }
    if (mode === "sms" || mode === "both") {
      if (!colPhone) reasons.push("Missing Phone header");
      if (!phone || phone.indexOf("+") !== 0) reasons.push("Invalid Phone (must be E.164 +...)");
    }
    if (reasons.length) { skipped.push({ row: rowNum, reason: reasons.join("; ") }); return; }
    if (mode === "email") candidates.push({ row: rowNum, recipient: email, score: score, status: status, prospectName: name, callerName: caller, batchId: colBatchId ? _s_(r[colBatchId.index0]) : "" });

    else if (mode === "sms") candidates.push({ row: rowNum, recipient: phone, score: score, status: status, prospectName: name, callerName: caller, batchId: colBatchId ? _s_(r[colBatchId.index0]) : "" });
    else candidates.push({ row: rowNum, email: email, phone: phone, score: score, status: status, prospectName: name, callerName: caller, batchId: colBatchId ? _s_(r[colBatchId.index0]) : "" });
  });
  return {
    sheetName: sheet.getName(),
    userEmail: Session.getActiveUser().getEmail() || "",
    candidates: candidates,
    skipped: skipped,
    hasProspectNameHeader: Boolean(colName),
    hasCallerNameHeader: Boolean(colCaller),
    hasEmailHeader: Boolean(colEmail),
    hasPhoneHeader: Boolean(colPhone),
    hasScoreHeader: Boolean(colScore),
    hasStatusHeader: Boolean(colStatus),
    resolvedHeaders: {
      prospect_name: colName ? colName.raw : null,
      prospect_email: colEmail ? colEmail.raw : null,
      email_verification: colScore ? colScore.raw : null,
      Phone: colPhone ? colPhone.raw : null,
      Status: colStatus ? colStatus.raw : null,
      caller_name: colCaller ? colCaller.raw : null
    }
  };
}

// ============================================================
// AUTOMATED SECOND ROUND CALLING
// ============================================================

// ============================================================
// CAMPAIGN SETTINGS PERSISTENCE
// ============================================================

/**
 * Gets the last used campaign settings from script properties
 */
function getLastCampaignSettings_() {
  const sp = PropertiesService.getScriptProperties();
  const saved = sp.getProperty('LAST_CAMPAIGN_SETTINGS');
  if (saved) {
    try {
      return JSON.parse(saved);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * Saves campaign settings to script properties for next time
 */
function saveLastCampaignSettings_(config) {
  const sp = PropertiesService.getScriptProperties();
  const toSave = {
    assistant: config.assistant || '',
    phoneNumber: config.phoneNumber || '',
    concurrency: config.concurrency || 1,
    retryAssistant: config.retryAssistant || '',
    autoSort: config.autoSort !== false,
    rounds: config.rounds || [],
    followup: config.followup || null
  };
  sp.setProperty('LAST_CAMPAIGN_SETTINGS', JSON.stringify(toSave));
}

/**
 * Debug: Shows the currently saved campaign settings
 * Run this from the script editor to verify settings are saved
 */
function debugShowSavedSettings() {
  const settings = getLastCampaignSettings_();
  const ui = SpreadsheetApp.getUi();
  if (settings) {
    ui.alert('Saved Campaign Settings', 
      'Assistant: ' + (settings.assistant || 'none') + '\n' +
      'Phone: ' + (settings.phoneNumber || 'none') + '\n' +
      'Concurrency: ' + (settings.concurrency || 1) + '\n' +
      'Retry Assistant: ' + (settings.retryAssistant || 'none'),
      ui.ButtonSet.OK);
  } else {
    ui.alert('No saved settings found. Run a campaign first.');
  }
}

/**
 * Shows dialog to configure and start batch with auto 2nd round
 */
/**
 * Shows dialog to configure and start batch with auto 2nd round
 */
/**
 * Shows dialog to start calling with optional status skipping for follow-ups
 */

/**
 * Shows dialog to start calling with optional status skipping for follow-ups
 */
function vapiStartBatchWithAutoSecondRound() {
  ensureSheetId_();
  const ui = SpreadsheetApp.getUi();
  
  // Load last used settings
  const lastSettings = getLastCampaignSettings_() || {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) return ui.alert('Select rows first.');
  
  // Get assistants
  const assistantSheet = ss.getSheetByName(ASSISTANTS_SHEET_NAME);
  let assistantOptions = '';
  
  if (assistantSheet) {
    const assistantData = assistantSheet.getDataRange().getValues();
    for (let i = 1; i < assistantData.length; i++) {
      const name = String(assistantData[i][0] || '').trim();
      if (name) {
        const escaped = name.replace(/"/g, '&quot;');
        const isSelected = (lastSettings.assistant === name || lastSettings.assistant === escaped) ? ' selected' : '';
        assistantOptions += '<option value="' + escaped + '"' + isSelected + '>' + name + '</option>';
      }
    }
  }
  
  if (!assistantOptions) {
    assistantOptions = '<option value="">-- No assistants found --</option>';
  }
  
  // Get phone numbers
  const phoneSheet = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME);
  let phoneOptions = '';
  
  if (phoneSheet) {
    const phoneData = phoneSheet.getDataRange().getValues();
    for (let i = 1; i < phoneData.length; i++) {
      const display = String(phoneData[i][0] || '').trim();
      if (display) {
        const escaped = display.replace(/"/g, '&quot;');
        const isPhoneSelected = (lastSettings.phoneNumber === display || lastSettings.phoneNumber === escaped) ? ' selected' : '';
        phoneOptions += '<option value="' + escaped + '"' + isPhoneSelected + '>' + display + '</option>';
      }
    }
  }
  
  if (!phoneOptions) {
    phoneOptions = '<option value="">-- No phone numbers found --</option>';
  }
  
  // Count rows by status in the selection
  const cols = getHeaderMap_(sh);
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lastCol = sh.getLastColumn();
  const selectedData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  const statusCounts = {};
  selectedData.forEach(function(row) {
    if (startRow + selectedData.indexOf(row) <= HEADER_ROW_INDEX) return;
    const status = cols.status ? String(row[cols.status - 1] || '').trim() : '';
    const baseStatus = getBaseStatus_(status);
    if (baseStatus) {
      statusCounts[baseStatus] = (statusCounts[baseStatus] || 0) + 1;
    }
  });
  
  // Build status checkboxes
  const defaultSkipStatuses = ['Spoke to Human', 'AI Gatekeeper', 'Hung Up', 'Hung Up (≤30s)', 'Number Failed'];
  const allStatuses = ['Spoke to Human', 'AI Gatekeeper', 'Hung Up', 'Hung Up (≤30s)', 'Number Failed', 'Voicemail', 'No Answer', 'Cancelled', 'Error'];
  
  let statusCheckboxesHtml = '';
  allStatuses.forEach(function(status) {
    const count = statusCounts[status] || 0;
    const isChecked = defaultSkipStatuses.includes(status) ? 'checked' : '';
    const countBadge = count > 0 ? ' <span class="count-badge">' + count + '</span>' : '';
    statusCheckboxesHtml += '<label class="status-checkbox"><input type="checkbox" name="skipStatus" value="' + status + '" ' + isChecked + ' /> ' + status + countBadge + '</label>';
  });

  const html = HtmlService.createHtmlOutput(`
<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; padding: 16px; margin: 0; font-size: 13px; }
    h3 { margin: 0 0 16px 0; color: #4285f4; }
    .section { border: 1px solid #ddd; padding: 12px; border-radius: 8px; margin-bottom: 12px; background: #fafafa; }
    .section-title { font-weight: bold; font-size: 14px; margin-bottom: 10px; }
    .section-title-primary { font-weight: bold; font-size: 14px; color: #1a73e8; }
    label { display: block; margin-top: 10px; font-weight: 500; font-size: 12px; color: #555; }
    label:first-child { margin-top: 0; }
    select, input[type="number"] { width: 100%; padding: 8px; margin-top: 4px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
    .row { display: flex; gap: 10px; }
    .row > * { flex: 1; }
    .checkbox-group { margin-top: 8px; }
    .checkbox-group label { display: inline-flex; align-items: center; gap: 4px; font-weight: normal; margin-right: 10px; cursor: pointer; font-size: 12px; }
    .btn-row { display: flex; gap: 10px; margin-top: 16px; }
    .btn { padding: 12px 24px; border: none; border-radius: 4px; cursor: pointer; font-size: 14px; }
    .btn-primary { background: #4285f4; color: white; flex: 1; }
    .btn-primary:hover { background: #3367d6; }
    .btn-primary:disabled { background: #ccc; cursor: not-allowed; }
    .btn-secondary { background: #f1f1f1; color: #333; border: 1px solid #ccc; }
    .info { background: #e8f4fd; padding: 10px; border-radius: 4px; margin-bottom: 12px; font-size: 12px; color: #1a73e8; }
    .config-section { background: #fff8e1; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #ffe082; }
    .skip-section { background: #fff3e0; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #ffcc80; }
    .skip-section .section-title { color: #e65100; }
    .status-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .status-checkbox { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #fff; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: normal; margin: 0; }
    .status-checkbox:hover { background: #f5f5f5; }
    .status-checkbox input { margin: 0; }
    .count-badge { background: #e0e0e0; color: #666; padding: 2px 6px; border-radius: 10px; font-size: 10px; margin-left: 4px; }
    .hint { font-size: 11px; color: #666; margin-top: 8px; }
    .followup-section { background: #e3f2fd; padding: 12px; border-radius: 8px; margin-bottom: 12px; border: 1px solid #90caf9; }
    .followup-section .section-title { color: #1565c0; }
    .followup-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .followup-header input[type="checkbox"] { width: 18px; height: 18px; }
    .followup-content { display: none; }
    .followup-content.show { display: block; }
    .followup-fields textarea { width: 100%; min-height: 70px; margin-top: 4px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; }
    .variables-hint { font-size: 10px; color: #666; margin-top: 4px; }
    .radio-group { margin-top: 8px; }
    .radio-group label { display: flex; align-items: center; gap: 6px; font-weight: normal; margin-top: 6px; cursor: pointer; }
    .time-config { margin-top: 10px; padding: 10px; background: #fff; border-radius: 4px; border: 1px solid #90caf9; }
    .time-config.hidden { display: none; }
  </style>
</head>
<body>
  <h3>🚀 Start Calling Now</h3>
  <div class="info">📞 Selected: <b>${range.getNumRows()} rows</b> | Calls start immediately</div>
  
  <div class="config-section">
    <div class="section-title-primary">📞 Campaign Settings</div>
    <div class="row">
      <div>
        <label>🎙️ Assistant</label>
        <select id="assistant">${assistantOptions}</select>
      </div>
      <div>
        <label>📱 Phone Number</label>
        <select id="phoneNumber">${phoneOptions}</select>
      </div>
    </div>
    <div class="row" style="margin-top:8px;">
      <div>
        <label>🔄 Concurrency</label>
        <input type="number" id="concurrency" value="1" min="1" max="5" />
      </div>
      <div></div>
    </div>
  </div>
  
  <div class="skip-section">
    <div class="section-title">⏭️ Skip Statuses (for Follow-Up batches)</div>
    <div class="hint">If this is a follow-up batch, select which statuses to skip:</div>
    <div class="status-grid">
      ${statusCheckboxesHtml}
    </div>
    <div class="hint" style="margin-top:10px;">💡 Rows with checked statuses will be set to "Skipped" and won't be called.</div>
  </div>
  
  <div class="section">
    <div class="section-title">📊 After Calls Complete</div>
    <div class="checkbox-group"><label><input type="checkbox" id="autoSort" checked /> Auto-sort "Spoke to Human" to top</label></div>
  </div>
  
  <div class="followup-section">
    <div class="followup-header">
      <input type="checkbox" id="enableFollowup" onchange="toggleFollowup()" checked />
      <span class="section-title">💬 Auto SMS Follow-up (for Voicemail/No Answer)</span>
    </div>
    <div class="followup-content show" id="followupContent">
      <div class="followup-fields">
        <label>💬 SMS Message</label>
        <textarea id="fuSmsBody">Hi {{prospect_name}} — it's {{caller_name}}. I just tried calling you regarding {{event_name}} in {{event_city}}. I was hoping to follow up on the personal invitation we sent you. Please see here for more information on the topic, agenda, and other attendees: https://shorturl.at/LKmLT. You can also RSVP via that link. Thanks!</textarea>
        <div class="variables-hint">Variables: {{prospect_name}}, {{event_name}}, {{event_city}}, {{event_date}}, {{caller_name}}, {{host_name}}</div>
        
        <div style="margin-top:12px; padding-top:10px; border-top:1px solid #90caf9;">
          <label style="margin-bottom:8px;">⏰ Send SMS:</label>
          <div class="radio-group" style="margin-top:4px;">
            <label><input type="radio" name="fuTiming" value="immediate" checked onchange="toggleFuTiming()"> Immediately after call</label>
            <label><input type="radio" name="fuTiming" value="delay" onchange="toggleFuTiming()"> After delay</label>
          </div>
          <div id="fuDelayConfig" class="time-config hidden" style="margin-top:8px;">
            <div class="row">
              <div><label>Minutes</label><input type="number" id="fuDelayMin" value="30" min="1" max="1440"/></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  
  <div class="btn-row">
    <button class="btn btn-secondary" onclick="google.script.host.close()">Cancel</button>
    <button class="btn btn-primary" id="submitBtn" onclick="startCampaign()">🚀 Start Calling</button>
  </div>
  
  <script>
    function toggleFollowup() {
      var enabled = document.getElementById('enableFollowup').checked;
      document.getElementById('followupContent').classList.toggle('show', enabled);
    }
    
    function toggleFuTiming() {
      var timing = document.querySelector('input[name=fuTiming]:checked').value;
      document.getElementById('fuDelayConfig').classList.toggle('hidden', timing !== 'delay');
    }
    
    function setLoading(on) { 
      document.getElementById('submitBtn').disabled = on; 
      document.getElementById('submitBtn').textContent = on ? '⏳ Starting...' : '🚀 Start Calling'; 
    }
    
    function startCampaign() {
      var assistant = document.getElementById('assistant').value;
      var phoneNumber = document.getElementById('phoneNumber').value;
      
      if (!assistant) { alert('Please select an assistant'); return; }
      if (!phoneNumber) { alert('Please select a phone number'); return; }
      
      setLoading(true);
      
      // Collect skip statuses
      var skipStatuses = [];
      document.querySelectorAll('input[name="skipStatus"]:checked').forEach(function(cb) {
        skipStatuses.push(cb.value);
      });
      
      var cfg = {
        assistant: assistant,
        phoneNumber: phoneNumber,
        concurrency: parseInt(document.getElementById('concurrency').value) || 1,
        autoSort: document.getElementById('autoSort').checked,
        skipStatuses: skipStatuses,
        followup: null
      };
      
      // Add SMS followup config if enabled
      if (document.getElementById('enableFollowup').checked) {
        var fuTiming = document.querySelector('input[name=fuTiming]:checked').value;
        cfg.followup = {
          enabled: true,
          channel: 'sms',
          smsBody: document.getElementById('fuSmsBody').value,
          timing: fuTiming,
          delayMinutes: fuTiming === 'delay' ? (parseInt(document.getElementById('fuDelayMin').value) || 30) : 0
        };
      }
      
      google.script.run
        .withSuccessHandler(function(r) { alert(r); google.script.host.close(); })
        .withFailureHandler(function(e) { setLoading(false); alert('Error: ' + e.message); })
        .vapiStartCallingNow(cfg);
    }
  </script>
</body>
</html>
  `).setWidth(520).setHeight(620);
  
  ui.showModalDialog(html, 'Start Calling Now');
}

/**
 * Starts calling immediately with optional status skipping
 */
function vapiStartCallingNow(config) {
  ensureSheetId_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) throw new Error('Please select rows first');
  
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  
const concurrency = Number(config.concurrency) || 1;  
  if (!config.assistant) throw new Error('Please select an assistant');
  if (!config.phoneNumber) throw new Error('Please select a phone number');
  
  // Save settings for next time
  saveLastCampaignSettings_(config);
  
  // Save auto followup config if enabled (SMS only)
  if (config.followup && config.followup.enabled) {
    const followupConfig = {
      enabled: true,
      triggerStatuses: ['Voicemail', 'No Answer'],
      channels: 'sms',
      delayMinutes: config.followup.timing === 'immediate' ? 0 : (config.followup.delayMinutes || 0),
      smsTemplate: config.followup.smsBody || ''
    };
    sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(followupConfig));
    setupAutoFollowupTrigger_();
  } else {
    sp.deleteProperty(autoFollowupConfigKey_(sheetName));
  }
  
  const batchId = generateBatchId_(sheetName);
  
  // Ensure columns exist
  let cols = getHeaderMap_(sh);
  const columnsToEnsure = ['call_attempt', 'batch_id'];
  columnsToEnsure.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
    }
  });
  cols = getHeaderMap_(sh);
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  // Build skip statuses set (case insensitive)
  const skipStatusesLower = (config.skipStatuses || []).map(function(s) { return s.toLowerCase(); });
  
  let queuedCount = 0;
  let skippedCount = 0;
  
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    while (allData[i].length < lastCol) allData[i].push('');
    
    // Check if this row should be skipped based on its current status
    const currentStatus = cols.status ? String(allData[i][cols.status - 1] || '').trim() : '';
    const baseStatus = getBaseStatus_(currentStatus).toLowerCase();
    
    const shouldSkip = skipStatusesLower.some(function(skipStatus) {
      return baseStatus.includes(skipStatus.toLowerCase());
    });
    
    if (shouldSkip && currentStatus) {
      // Mark as skipped
      allData[i][cols.status - 1] = '⏭️ Skipped (' + currentStatus + ')';
      skippedCount++;
      continue;
    }
    
    // Set status to Queued
    if (cols.status) {
      allData[i][cols.status - 1] = 'Queued';
      queuedCount++;
    }
    
    // Set batch ID
    if (cols.batch_id) allData[i][cols.batch_id - 1] = batchId;
    
    // Set assistant from wizard
    if (cols.assistant) allData[i][cols.assistant - 1] = config.assistant;
    
    // Set phone number from wizard
    if (cols.vapi_number) allData[i][cols.vapi_number - 1] = config.phoneNumber;
    
    // Set call attempt
    if (cols.call_attempt) {
      const current = Number(allData[i][cols.call_attempt - 1] || 0);
      allData[i][cols.call_attempt - 1] = current + 1;
    }
  }
  
  sh.getRange(startRow, 1, numRows, lastCol).setValues(allData);
  SpreadsheetApp.flush();
  
  sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Store concurrency and queue rows
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  
  // Only queue rows that are now "Queued"
  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r > HEADER_ROW_INDEX) {
      const status = String(allData[i][cols.status - 1] || '').trim();
      if (status === 'Queued' && queue.indexOf(r) === -1) {
        queue.push(r);
      }
    }
  }
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  
  // Start calling immediately
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (!apiKey) throw new Error('Missing VAPI_API_KEY');
  
// Start watchdog to prevent freezing
  startWatchdog_();
  
  processQueueForSheet_(
    ss, 
    sh, 
    apiKey, 
    sp.getProperty('VAPI_PHONE_NUMBER_ID'), 
    sp.getProperty('VAPI_ASSISTANT_ID'), 
    concurrency
  );
  
  // Build result message
  let message = '✅ Calling Started!\n\n';
  message += '📋 Batch ID: ' + batchId + '\n';
  message += '📞 ' + queuedCount + ' rows queued\n';
  
  if (skippedCount > 0) {
    message += '⏭️ ' + skippedCount + ' rows skipped\n';
  }
  
  message += '🎙️ Assistant: ' + config.assistant + '\n';
  message += '📱 Phone: ' + config.phoneNumber + '\n';
  
  if (config.followup && config.followup.enabled) {
    message += '\n💬 Auto SMS follow-up enabled';
  }
  
  return message;
}
function vapiStartMultiRoundNow(config) {
  ensureSheetId_();
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const range = sh.getActiveRange();
  if (!range) throw new Error('Please select rows first');
  
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  
  const concurrency = Number(config.concurrency) || 3;
  if (concurrency < 1 || concurrency > 50) throw new Error('Concurrency must be 1-5');
  
  if (!config.assistant) throw new Error('Please select an assistant');
  if (!config.phoneNumber) throw new Error('Please select a phone number');
  
  // Save settings for next time
  saveLastCampaignSettings_(config);
  
// Save auto followup config if enabled
if (config.followup && config.followup.enabled) {
  const followupConfig = {
    enabled: true,
    triggerStatuses: ['Voicemail', 'No Answer'],
    channels: config.followup.channel,  // Keep as string: 'email', 'sms', or 'both'
    delayMinutes: config.followup.timing === 'immediate' ? 0 : (config.followup.timing === 'delay' ? config.followup.delayMinutes : 0),
    specificTime: config.followup.timing === 'specific' ? config.followup.specificTime : null,
    specificDays: config.followup.timing === 'specific' ? config.followup.specificDays : 0,
    emailSubject: config.followup.emailSubject || '',
    emailTemplate: config.followup.emailBody || '',
    smsTemplate: config.followup.smsBody || ''
  };
  sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(followupConfig));
  setupAutoFollowupTrigger_();
}
else {
    // Disable auto followup if not enabled
    sp.deleteProperty(autoFollowupConfigKey_(sheetName));
  }
  
  const batchId = generateBatchId_(sheetName);
  
  // Ensure columns exist
  let cols = getHeaderMap_(sh);
  const columnsToEnsure = ['call_attempt', 'batch_id', 'campaign_status', 'next_round_at'];
  columnsToEnsure.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
    }
  });
  cols = getHeaderMap_(sh);
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  // Build schedule summary for display
  let scheduleText = 'Round 1: NOW';
  if (config.rounds && config.rounds.length > 0) {
    config.rounds.forEach(function(round, idx) {
      let timeStr = '';
      if (round.type === 'delay') {
        const hours = Math.floor(round.delayMinutes / 60);
        const mins = round.delayMinutes % 60;
        timeStr = '+' + (hours > 0 ? hours + 'h' : '') + (mins > 0 ? mins + 'm' : '');
      } else {
        timeStr = round.time + ' (' + round.timezone.split('/').pop().replace('_', ' ') + ')';
        if (round.daysFromNow > 0) timeStr += ' +' + round.daysFromNow + 'd';
      }
      scheduleText += ' → R' + round.roundNum + ': ' + timeStr;
    });
  }
  
  let queuedCount = 0;
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    while (allData[i].length < lastCol) allData[i].push('');
    
    // Set status to Queued
    if (cols.status) {
      const currentStatus = String(allData[i][cols.status - 1] || '').trim();
      if (!currentStatus || currentStatus === 'Queued') {
        allData[i][cols.status - 1] = 'Queued';
        queuedCount++;
      }
    }
    
    // Set batch ID
    if (cols.batch_id) allData[i][cols.batch_id - 1] = batchId;
    
    // Set assistant from wizard
    if (cols.assistant) allData[i][cols.assistant - 1] = config.assistant;
    
    // Set phone number from wizard
    if (cols.vapi_number) allData[i][cols.vapi_number - 1] = config.phoneNumber;
    
    // Set call attempt
    if (cols.call_attempt) {
      const current = Number(allData[i][cols.call_attempt - 1] || 0);
      if (!current) allData[i][cols.call_attempt - 1] = 1;
    }
    
    // Set campaign status
    if (cols.campaign_status) {
      const totalRounds = 1 + (config.rounds ? config.rounds.length : 0);
      if (totalRounds > 1) {
        allData[i][cols.campaign_status - 1] = '🔄 Round 1/' + totalRounds + ' in progress';
      } else {
        allData[i][cols.campaign_status - 1] = '🔄 Running';
      }
    }
    
    // Set next round info
    if (cols.next_round_at) {
      if (config.rounds && config.rounds.length > 0) {
        // Check current status - if it will be skipped, show that instead
        const currentStatus = cols.status ? String(allData[i][cols.status - 1] || '').trim() : '';
        
        if (shouldSkipStatus_(currentStatus)) {
          allData[i][cols.next_round_at - 1] = '⏭️ To be Skipped';
        } else {
          const nextRound = config.rounds[0];
          if (nextRound.type === 'delay') {
            allData[i][cols.next_round_at - 1] = 'R2: +' + nextRound.delayMinutes + ' min after R1';
          } else {
            const targetTime = calculateSpecificTime_(nextRound.time, nextRound.timezone, nextRound.daysFromNow);
            allData[i][cols.next_round_at - 1] = 'R2: ' + Utilities.formatDate(targetTime, Session.getScriptTimeZone(), 'MMM d HH:mm');
          }
        }
      } else {
        allData[i][cols.next_round_at - 1] = 'No additional rounds';
      }
  }
  }
  
  sh.getRange(startRow, 1, numRows, lastCol).setValues(allData);
  SpreadsheetApp.flush();
  
  // Store multi-round config if there are additional rounds
  if (config.rounds && config.rounds.length > 0) {
    const multiRoundConfig = {
      batchId: batchId,
      sheetId: sheetId,
      sheetName: sheetName,
      concurrency: concurrency,
      assistant: config.assistant,
      phoneNumber: config.phoneNumber,
      retryAssistant: config.retryAssistant || config.assistant,
      autoSort: config.autoSort !== false,
      currentRound: 1,
      totalRounds: 1 + config.rounds.length,
      rounds: config.rounds,
      round1StartedAt: new Date().toISOString(),
      round1CompletedAt: null,
      createdAt: new Date().toISOString()
    };
    
    // Calculate scheduled times for specific time rounds
    multiRoundConfig.rounds.forEach(function(round) {
      if (round.type === 'specific') {
        const targetDate = calculateSpecificTime_(round.time, round.timezone, round.daysFromNow);
        round.scheduledAt = targetDate.toISOString();
      }
    });
    
    sp.setProperty('MULTI_ROUND_' + batchId, JSON.stringify(multiRoundConfig));
    createMultiRoundMonitorTrigger_();
  }
  
  sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Store concurrency and queue rows
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r > HEADER_ROW_INDEX && queue.indexOf(r) === -1) queue.push(r);
  }
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  
  // Start calling immediately
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (!apiKey) throw new Error('Missing VAPI_API_KEY');
  
  processQueueForSheet_(
    ss, 
    sh, 
    apiKey, 
    sp.getProperty('VAPI_PHONE_NUMBER_ID'), 
    sp.getProperty('VAPI_ASSISTANT_ID'), 
    concurrency
  );
  
  // Build result message
  let message = '✅ Campaign Started!\n\n';
  message += '📋 Batch ID: ' + batchId + '\n';
  message += '📞 ' + queuedCount + ' rows calling now\n';
  message += '🎙️ Assistant: ' + config.assistant + '\n';
  message += '📱 Phone: ' + config.phoneNumber + '\n';
  message += '🔄 Concurrency: ' + concurrency + '\n';
  
  if (config.rounds && config.rounds.length > 0) {
    message += '\n━━━━━━━━━━━━━━━━━━━━\n\n';
    message += '1️⃣ Round 1: NOW\n';
    
    config.rounds.forEach(function(round, idx) {
      const emoji = ['2️⃣', '3️⃣', '4️⃣', '5️⃣'][idx] || '📞';
      let timeStr = '';
      if (round.type === 'delay') {
        const hours = Math.floor(round.delayMinutes / 60);
        const mins = round.delayMinutes % 60;
        timeStr = '+' + (hours > 0 ? hours + 'h ' : '') + (mins > 0 ? mins + 'm' : '') + ' after R' + (round.roundNum - 1);
      } else {
        timeStr = round.time + ' (' + round.timezone.split('/').pop().replace('_', ' ') + ')';
        if (round.daysFromNow > 0) timeStr += ' +' + round.daysFromNow + 'd';
      }
      message += emoji + ' Round ' + round.roundNum + ': ' + timeStr + '\n';
    });
  }
  
  return message;
}
/**
 * Starts batch immediately with optional 2nd round (delay OR specific time)
 */
function vapiStartBatchWithConfigV2(config) {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  let cols = getHeaderMap_(sh);
  
  
  const range = sh.getActiveRange();
  if (!range) {
    ui.alert('❌ Please select rows first');
    return;
  }
  
  const batchId = generateBatchId_(sh.getName());
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  
  // Add missing columns
  const columnsToAdd = ['batch_id', 'second_round_delay_min', 'second_round_scheduled_at', 'second_round_status'];
  columnsToAdd.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
    }
  });
  cols = getHeaderMap_(sh);
  
  // Calculate 2nd round scheduled time text
  let secondRoundScheduledText = '';
  let actualDelayMinutes = -1;
  
  if (config.secondRoundType === 'delay' && config.delayMinutes > 0) {
    actualDelayMinutes = config.delayMinutes;
    const estimatedFirstBatchMinutes = Math.max(5, numRows * 2);
    const estimatedTime = new Date(Date.now() + (estimatedFirstBatchMinutes + config.delayMinutes) * 60 * 1000);
    secondRoundScheduledText = Utilities.formatDate(estimatedTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' (est.)';
  } else if (config.secondRoundType === 'specific' && config.specificTime) {
    const targetTime = calculateSpecificTime_(config.specificTime, config.timezone, config.daysFromNow);
    secondRoundScheduledText = Utilities.formatDate(targetTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    actualDelayMinutes = 0;
  }
  
  // Update rows
  const lastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    while (allData[i].length < lastCol) allData[i].push('');
    
    if (cols.batch_id) allData[i][cols.batch_id - 1] = batchId;
    
    if (cols.second_round_delay_min) {
      if (config.secondRoundType === 'delay') {
        allData[i][cols.second_round_delay_min - 1] = config.delayMinutes + ' min';
      } else if (config.secondRoundType === 'specific') {
        allData[i][cols.second_round_delay_min - 1] = 'At ' + config.specificTime;
      } else {
        allData[i][cols.second_round_delay_min - 1] = '';
      }
    }
    
    if (cols.second_round_scheduled_at) {
      allData[i][cols.second_round_scheduled_at - 1] = secondRoundScheduledText;
    }
    
    if (cols.second_round_status) {
      allData[i][cols.second_round_status - 1] = config.secondRoundType !== 'none' ? '⏳ Pending' : 'No 2nd round';
    }
  }
  
  sh.getRange(startRow, 1, numRows, lastCol).setValues(allData);
  SpreadsheetApp.flush();
  
  // Store 2nd round config
  if (config.secondRoundType !== 'none') {
    const secondRoundConfig = {
      batchId: batchId,
      type: config.secondRoundType,
      delayMinutes: config.delayMinutes,
      specificTime: config.specificTime,
      timezone: config.timezone,
      daysFromNow: config.daysFromNow,
      statuses: config.statuses,
      firstBatchStartedAt: new Date().toISOString(),
      sheetName: sh.getName(),
      sheetId: sheetId,
      status: 'waiting_for_first_batch',
      autoSort: config.autoSort !== false,
      voicemailAssistant: config.voicemailAssistant || ''
    };
    
    if (config.secondRoundType === 'specific') {
      const targetTime = calculateSpecificTime_(config.specificTime, config.timezone, config.daysFromNow);
      secondRoundConfig.scheduledAt = targetTime.toISOString();
    }
    
    sp.setProperty('SECOND_ROUND_' + batchId, JSON.stringify(secondRoundConfig));
    createSecondRoundMonitorTrigger_();
  }
  
  sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Prompt for concurrency and start
  const concurrency = promptConcurrency_(ui, 'How many calls at once?', 1);
  if (!concurrency) return;
  
  sp.setProperty(concurrencyKey_(sheetId, sh.getName()), String(concurrency));
  vapiQueueRange_(sh, range);
  vapiStartProcessingActiveSheet_(concurrency);
  
  // Show confirmation
  let message = '✅ Batch started!\n\n📞 Calling ' + numRows + ' rows now\n';
  
  if (config.secondRoundType === 'delay') {
    const hours = Math.floor(config.delayMinutes / 60);
    const mins = config.delayMinutes % 60;
    message += '⏰ 2nd round: ' + (hours > 0 ? hours + 'h ' : '') + (mins > 0 ? mins + 'm' : '') + ' after 1st batch\n';
  } else if (config.secondRoundType === 'specific') {
    message += '⏰ 2nd round: ' + config.specificTime + ' (' + config.timezone.split('/').pop() + ')';
    if (config.daysFromNow > 0) message += ' +' + config.daysFromNow + ' day(s)';
    message += '\n';
  }
  
  if (config.secondRoundType !== 'none') {
    message += '📋 Retry: ' + config.statuses.join(', ') + '\n';
  }
  
  message += '\nBatch ID: ' + batchId;
  
  ui.alert(message);
}

/**
 * Starts the batch and schedules the 2nd round
 */
function vapiStartBatchWithConfig(config) {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  let cols = getHeaderMap_(sh);
  
  // Generate a unique batch ID
  const batchId = generateBatchId_(sh.getName());
  
  // Get selected rows
  const range = sh.getActiveRange();
  if (!range) {
    ui.alert('❌ Please select rows first');
    return;
  }
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  
  // Add missing columns if they don't exist
  let newColsAdded = false;
  const columnsToAdd = ['batch_id', 'second_round_delay_min', 'second_round_scheduled_at', 'second_round_status'];
  
  columnsToAdd.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
      newColsAdded = true;
    }
  });
  
  if (newColsAdded) {
    cols = getHeaderMap_(sh);
  }
  
  // Calculate when 2nd round will start (estimate)
  let scheduledAtText = '';
  if (config.delayMinutes > 0) {
    const estimatedFirstBatchMinutes = Math.max(5, numRows * 2);
    const estimatedScheduleTime = new Date(Date.now() + (estimatedFirstBatchMinutes + config.delayMinutes) * 60 * 1000);
    scheduledAtText = Utilities.formatDate(estimatedScheduleTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' (est.)';
  }
  
  // Update all selected rows with batch info
  const updatedLastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, updatedLastCol).getValues();
  
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    while (allData[i].length < updatedLastCol) {
      allData[i].push('');
    }
    
    if (cols.batch_id) {
      allData[i][cols.batch_id - 1] = batchId;
    }
    
    if (cols.second_round_delay_min) {
      allData[i][cols.second_round_delay_min - 1] = config.delayMinutes > 0 ? config.delayMinutes + ' min' : '';
    }
    
    if (cols.second_round_scheduled_at) {
      allData[i][cols.second_round_scheduled_at - 1] = config.delayMinutes > 0 ? scheduledAtText : '';
    }
    
    if (cols.second_round_status) {
      allData[i][cols.second_round_status - 1] = config.delayMinutes > 0 ? '⏳ Pending (waiting for 1st batch)' : 'No 2nd round';
    }
  }
  
  sh.getRange(startRow, 1, numRows, updatedLastCol).setValues(allData);
  SpreadsheetApp.flush();
  
 // Store the 2nd round config in Script Properties
if (config.delayMinutes > 0) {
  const secondRoundConfig = {
    batchId: batchId,
    delayMinutes: config.delayMinutes,
    statuses: config.statuses,
    firstBatchStartedAt: new Date().toISOString(),
    sheetName: sh.getName(),
    sheetId: sheetId,
    status: 'waiting_for_first_batch',
    autoSort: config.autoSort !== false,
    voicemailAssistant: config.voicemailAssistant || ''  // NEW: Store voicemail assistant
  };
  sp.setProperty('SECOND_ROUND_' + batchId, JSON.stringify(secondRoundConfig));
  
  createSecondRoundMonitorTrigger_();
}
  
  // Store autoSort preference
  sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Prompt for concurrency and start calling
  const concurrency = promptConcurrency_(ui, 'How many calls at once?', 1);
  if (!concurrency) return;
  
  sp.setProperty(concurrencyKey_(sheetId, sh.getName()), String(concurrency));
  vapiQueueRange_(sh, range);
  vapiStartProcessingActiveSheet_(concurrency);
  
  if (config.delayMinutes > 0) {
    ui.alert('✅ Batch started!\n\n' +
      '📞 Calling ' + numRows + ' rows now\n' +
      '⏰ 2nd round: ' + config.delayMinutes + ' min after 1st batch completes\n' +
      '🔄 Statuses for 2nd round: ' + config.statuses.join(', ') + '\n\n' +
      'Batch ID: ' + batchId);
  }
}

/**
 * Creates a trigger to monitor first batch completion
 */
function createSecondRoundMonitorTrigger_() {
  // Delete existing monitor triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'checkAndStartSecondRound_') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new trigger - runs every 5 minutes
  ScriptApp.newTrigger('checkAndStartSecondRound_')
    .timeBased()
    .everyMinutes(1)
    .create();
}

/**
 * Checks if any first batch is complete and starts 2nd round if needed
 */
/**
 * Checks if any first batch is complete and starts 2nd round if needed
 */
function checkAndStartSecondRound_() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      
      if (config.status === 'waiting_for_first_batch') {
        if (isFirstBatchComplete_(config)) {
          config.status = 'waiting_for_delay';
          config.firstBatchCompletedAt = new Date().toISOString();
          props.setProperty(key, JSON.stringify(config));
          
          let actualScheduledText = '';
          if (config.type === 'specific' && config.scheduledAt) {
            actualScheduledText = Utilities.formatDate(new Date(config.scheduledAt), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
          } else if (config.delayMinutes > 0) {
            const actualScheduledTime = new Date(Date.now() + config.delayMinutes * 60 * 1000);
            actualScheduledText = Utilities.formatDate(actualScheduledTime, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
          }
          
          updateSecondRoundScheduledTime_(config, actualScheduledText);
          updateSecondRoundStatusInSheet_(config, '⏳ 1st batch done, 2nd round at ' + actualScheduledText);
        }
      }
      
      if (config.status === 'waiting_for_delay') {
        let shouldStart = false;
        
        if (config.type === 'specific' && config.scheduledAt) {
          const scheduledAt = new Date(config.scheduledAt);
          shouldStart = new Date() >= scheduledAt;
        } else if (config.delayMinutes > 0) {
          const completedAt = new Date(config.firstBatchCompletedAt);
          const delayMs = config.delayMinutes * 60 * 1000;
          const shouldStartAt = new Date(completedAt.getTime() + delayMs);
          shouldStart = new Date() >= shouldStartAt;
        }
        
        if (shouldStart) {
          updateSecondRoundStatusInSheet_(config, '🚀 Starting 2nd round...');
          startSecondRoundAutomatically_(config);
          config.status = 'completed';
          props.setProperty(key, JSON.stringify(config));
          updateSecondRoundStatusInSheet_(config, '✅ 2nd round started');
        }
      }
    } catch (e) {
      Logger.log('Error processing second round config: ' + e.message);
    }
  }
  
  let hasPending = false;
  const updatedProps = props.getProperties();
  for (const k in updatedProps) {
    if (k.startsWith('SECOND_ROUND_')) {
      try {
        const c = JSON.parse(updatedProps[k]);
        if (c.status === 'waiting_for_first_batch' || c.status === 'waiting_for_delay') {
          hasPending = true;
          break;
        }
      } catch (e) {}
    }
  }
  
  if (!hasPending) {
    deleteTriggersByHandler_('checkAndStartSecondRound_');
  }
}

/**
 * Updates the second_round_scheduled_at column with actual time
 */
function updateSecondRoundScheduledTime_(config, scheduledText) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id || !cols.second_round_scheduled_at) return;
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return;
    
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const rowBatchId = String(data[i][cols.batch_id - 1] || '').trim();
      
      if (rowBatchId === config.batchId) {
        data[i][cols.second_round_scheduled_at - 1] = scheduledText;
      }
    }
    
    sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
    SpreadsheetApp.flush();
  } catch (e) {
    Logger.log('Error updating scheduled time: ' + e.message);
  }
}

/**
 * Updates the second_round_status column for all rows in a batch
 */
/**
 * Updates the second_round_status column for all rows in a batch
 * Respects skip status - rows that should be skipped show "To be Skipped"
 */
function updateSecondRoundStatusInSheet_(config, statusText) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id || !cols.second_round_status) return;
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return;
    
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const rowBatchId = String(data[i][cols.batch_id - 1] || '').trim();
      
      // Match original batch or R2 batch
      if (rowBatchId === config.batchId || rowBatchId === config.batchId + '_R2') {
        // Check if this row should be skipped based on current status
        const currentStatus = cols.status ? String(data[i][cols.status - 1] || '').trim() : '';
        const baseStatus = getBaseStatus_(currentStatus);
        
        if (shouldSkipStatus_(baseStatus)) {
          data[i][cols.second_round_status - 1] = '⏭️ To be Skipped';
        } else {
          data[i][cols.second_round_status - 1] = statusText;
        }
      }
    }
    
    sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
    SpreadsheetApp.flush();
  } catch (e) {
    Logger.log('Error updating second round status: ' + e.message);
  }
}

/**
 * Checks if all calls in the first batch are complete
 */
/**
 * Checks if all calls in the first batch are complete
 */
function isFirstBatchComplete_(config) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return false;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id || !cols.status) return false;
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return false;
    
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, sh.getLastColumn()).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowBatchId = String(row[cols.batch_id - 1] || '').trim();
      const status = String(row[cols.status - 1] || '').trim().toLowerCase();
      
      if (rowBatchId === config.batchId) {
        // Check if this row is still pending or in progress
        if (status === 'queued' || status === 'calling' || status === 'calling...' || status === 'in progress' || status === '') {
          return false; // Still in progress
        }
      }
    }
    
    return true; // All done
  } catch (e) {
    Logger.log('Error checking batch completion: ' + e.message);
    return false;
  }
}

/**
 * Automatically starts the second round of calls
 */
/**
 * Automatically starts the second round of calls
 */
/**
 * Automatically starts the second round of calls
 */
function startSecondRoundAutomatically_(config) {
  const ss = SpreadsheetApp.openById(config.sheetId);
  const sh = ss.getSheetByName(config.sheetName);
  if (!sh) {
    Logger.log('Sheet not found: ' + config.sheetName);
    return;
  }
  
  const cols = getHeaderMap_(sh);
  if (!cols.batch_id || !cols.status) {
    Logger.log('Missing batch_id or status column');
    return;
  }
  
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) {
    Logger.log('No data rows');
    return;
  }
  
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
  
  const rowsToCall = [];
  const fieldsToClear = ['call_id', 'started_at', 'ended_at', 'transcript', 'outcome_summary', 'recording_url', 
                         'callback_flag', 'callback_when', 'scheduled_at', 'scheduled_in_min', 
                         'auto_followup_status', 'auto_followup_preview'];
  
  Logger.log('Checking ' + data.length + ' rows for batch: ' + config.batchId);
  Logger.log('Looking for statuses: ' + JSON.stringify(config.statuses));
  Logger.log('Voicemail assistant: ' + (config.voicemailAssistant || 'default'));
  
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = HEADER_ROW_INDEX + 1 + i;
    const rowBatchId = String(row[cols.batch_id - 1] || '').trim();
    const status = String(row[cols.status - 1] || '').trim().toLowerCase();
    const originalAssistant = cols.assistant ? String(row[cols.assistant - 1] || '').trim() : '';
    
    if (rowBatchId !== config.batchId) continue;
    
    Logger.log('Row ' + rowNum + ': batchId=' + rowBatchId + ', status=' + status);
    
    // Check if status matches any of the configured statuses
    const shouldCall = config.statuses.some(function(s) {
      return status.includes(s.toLowerCase());
    });
    
    // Also check for callback_flag
    const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag - 1] || '').trim().toUpperCase() : '';
    const callbackRequested = (callbackFlag === 'TRUE') && config.statuses.includes('callback');
    
    Logger.log('  shouldCall=' + shouldCall + ', callbackRequested=' + callbackRequested);
    
// Check if this row should be SKIPPED (already spoke, hung up, etc.)
    const shouldSkip = DO_NOT_CALL_AGAIN_STATUSES.some(function(s) {
      return status.includes(s);
    });
    
    if (shouldSkip) {
      // Mark as skipped with reason in VAPI Status
      const currentStatus = String(row[cols.status - 1] || '').trim();
      row[cols.status - 1] = '⏭️ Skipped 2nd (' + currentStatus + ')';
      if (cols.second_round_status) {
        row[cols.second_round_status - 1] = '⏭️ Skipped (' + currentStatus + ')';
      }
      continue;
    }

    if (shouldCall || callbackRequested) {
      // Determine which assistant to use
      let assistantToUse = originalAssistant;
      
      // If this was a voicemail AND we have a special voicemail assistant configured
      if (status.includes('voicemail') && config.voicemailAssistant) {
        assistantToUse = config.voicemailAssistant;
        Logger.log('  Using voicemail assistant: ' + assistantToUse);
      }
      
      // Prepare row for 2nd round
      row[cols.status - 1] = 'Queued';
      
      // Update assistant if needed
      if (cols.assistant && assistantToUse) {
        row[cols.assistant - 1] = assistantToUse;
      }
      
      if (cols.call_attempt) {
        const currentAttempt = Number(row[cols.call_attempt - 1] || 0);
        row[cols.call_attempt - 1] = currentAttempt + 1;
      }
      
      // Clear call fields
      fieldsToClear.forEach(function(field) {
        if (cols[field]) row[cols[field] - 1] = '';
      });
      
      // Update batch ID for 2nd round
      row[cols.batch_id - 1] = config.batchId + '_R2';
      
      rowsToCall.push({ 
        rowNum: rowNum, 
        data: row, 
        wasVoicemail: status.includes('voicemail'),
        assistantUsed: assistantToUse
      });
    }
  }
  
  if (rowsToCall.length === 0) {
    Logger.log('No rows to call for 2nd round in batch: ' + config.batchId);
    return;
  }
  
  Logger.log('Found ' + rowsToCall.length + ' rows to call for 2nd round');
  
  // Write updated data back
  rowsToCall.forEach(function(item) {
    sh.getRange(item.rowNum, 1, 1, lastCol).setValues([item.data]);
  });
  
  SpreadsheetApp.flush();
  
  // Now trigger the calls via VAPI
  const vapiKey = getVapiKey_();
  if (!vapiKey) {
    Logger.log('No VAPI key found');
    return;
  }
  
  rowsToCall.forEach(function(item) {
    try {
      Logger.log('Triggering call for row ' + item.rowNum + ' (wasVoicemail: ' + item.wasVoicemail + ', assistant: ' + item.assistantUsed + ')');
      const rowData = getRowDataForCall_(sh, item.rowNum, cols);
      if (rowData && rowData.phone) {
        triggerVapiCall_(vapiKey, rowData, sh, item.rowNum, cols);
        Utilities.sleep(1000);
        Logger.log('Call triggered successfully for row ' + item.rowNum);
      } else {
        Logger.log('No phone for row ' + item.rowNum);
      }
    } catch (e) {
      Logger.log('Error calling row ' + item.rowNum + ': ' + e.message);
    }
  });
  
  Logger.log('Started 2nd round for batch ' + config.batchId + ' with ' + rowsToCall.length + ' calls');
}

/**
 * View and manage scheduled second rounds
 */
/**
 * View scheduled second rounds (now just opens the cancel dialog)
 */
function vapiViewScheduledSecondRounds() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  
  // Find all pending second rounds
  const pendingRounds = [];
  
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      if (config.status === 'waiting_for_first_batch' || config.status === 'waiting_for_delay') {
        let scheduledTime = '';
        let statusText = '';
        
        if (config.status === 'waiting_for_first_batch') {
          statusText = '⏳ Waiting for 1st batch to complete';
        } else if (config.status === 'waiting_for_delay' && config.firstBatchCompletedAt) {
          const completedAt = new Date(config.firstBatchCompletedAt);
          const scheduledAt = new Date(completedAt.getTime() + config.delayMinutes * 60 * 1000);
          scheduledTime = Utilities.formatDate(scheduledAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
          statusText = '⏰ Scheduled for ' + scheduledTime;
        }
        
        pendingRounds.push({
          batchId: config.batchId,
          statusText: statusText,
          delayMinutes: config.delayMinutes,
          statuses: config.statuses || [],
          sheetName: config.sheetName
        });
      }
    } catch (e) {}
  }
  
  if (pendingRounds.length === 0) {
    ui.alert('📋 No Scheduled Second Rounds\n\nThere are no pending second rounds scheduled.');
    return;
  }
  
  // Build the HTML dialog (view only)
  let roundOptionsHtml = '';
  pendingRounds.forEach(function(round) {
    const statusIcon = round.statusText.includes('Scheduled') ? '⏰' : '⏳';
    
    roundOptionsHtml += `
      <div class="round-row">
        <span class="round-info">
          <span class="round-id">${statusIcon} ${round.batchId}</span>
          <span class="round-status">${round.statusText}</span>
          <span class="round-details">
            Delay: <b>${round.delayMinutes} min</b> | 
            Sheet: <b>${round.sheetName}</b> | 
            Statuses: <b>${round.statuses.join(', ') || 'N/A'}</b>
          </span>
        </span>
      </div>
    `;
  });
  
  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
      h3 { margin: 0 0 16px 0; color: #1a73e8; }
      .round-row { padding: 12px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 8px; background: #f8f9fa; }
      .round-info { display: flex; flex-direction: column; gap: 4px; }
      .round-id { font-weight: 500; font-size: 13px; }
      .round-status { font-size: 12px; color: #1a73e8; }
      .round-details { font-size: 11px; color: #666; }
      .round-details b { color: #333; }
      .btn-row { display: flex; gap: 8px; margin-top: 20px; }
      button { padding: 10px 20px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
      .btn-primary { background: #1a73e8; color: white; }
      .btn-primary:hover { background: #1557b0; }
      .btn-secondary { background: #f1f1f1; color: #333; border: 1px solid #ccc; }
      .btn-secondary:hover { background: #e0e0e0; }
      .summary { background: #e8f0fe; padding: 10px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; color: #1a73e8; }
    </style>
    
    <h3>📋 Scheduled 2nd Rounds</h3>
    
    <div class="summary">
      📊 <b>${pendingRounds.length}</b> second round(s) scheduled
    </div>
    
    <div id="roundList">
      ${roundOptionsHtml}
    </div>
    
    <div class="btn-row">
      <button class="btn-secondary" onclick="google.script.host.close()">Close</button>
      <button class="btn-primary" onclick="google.script.host.close(); google.script.run.vapiCancelSecondRound();">❌ Cancel 2nd Rounds...</button>
    </div>
  `)
  .setWidth(500)
  .setHeight(400);
  
  ui.showModalDialog(html, 'View Scheduled 2nd Rounds');
}
/**
 * Auto-sort sheet after batch completes (called from doPost when queue is empty)
 */
/**
 * Auto-sort sheet after batch completes (called from doPost when queue is empty)
 */
function autoSortIfBatchComplete_(sheetId, sheetName) {
  try {
    Logger.log('autoSortIfBatchComplete_ called for sheet: ' + sheetName);
    
    const ss = SpreadsheetApp.openById(sheetId);
    const sh = ss.getSheetByName(sheetName);
    if (!sh) {
      Logger.log('Sheet not found: ' + sheetName);
      return;
    }
    
    const cols = getHeaderMap_(sh);
    if (!cols.status) {
      Logger.log('No status column');
      return;
    }
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) {
      Logger.log('No data rows');
      return;
    }
    
    const lastCol = sh.getLastColumn();
    const dataRange = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol);
    const data = dataRange.getValues();
    
    // Check if any calls are still in progress
    const hasActiveCall = data.some(function(row) {
      const status = String(row[cols.status - 1] || '').trim().toLowerCase();
      return status === 'queued' || status === 'calling...' || status === 'calling';
    });
    
    if (hasActiveCall) {
      Logger.log('Still has active calls, skipping sort');
      return;
    }
    
    // Check if autoSort is enabled for any batch in this sheet
    const sp = PropertiesService.getScriptProperties();
    let shouldSort = false;
    let batchIdsToClean = [];
    
    // Check batch-specific autoSort settings
    if (cols.batch_id) {
      const batchIds = new Set();
      data.forEach(function(row) {
        const batchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R2$/, '');
        if (batchId) batchIds.add(batchId);
      });
      
      Logger.log('Found batch IDs: ' + Array.from(batchIds).join(', '));
      
      batchIds.forEach(function(batchId) {
        // Check direct autoSort setting
        const autoSortSetting = sp.getProperty('BATCH_AUTOSORT_' + batchId);
        Logger.log('BATCH_AUTOSORT_' + batchId + ' = ' + autoSortSetting);
        
        if (autoSortSetting === 'true') {
          shouldSort = true;
          batchIdsToClean.push(batchId);
        }
        
        // Check 2nd round config
        const secondRoundConfigStr = sp.getProperty('SECOND_ROUND_' + batchId);
        if (secondRoundConfigStr) {
          try {
            const config = JSON.parse(secondRoundConfigStr);
            Logger.log('SECOND_ROUND config autoSort = ' + config.autoSort);
            if (config.autoSort !== false) {
              shouldSort = true;
              batchIdsToClean.push(batchId);
            }
          } catch (e) {
            Logger.log('Error parsing 2nd round config: ' + e.message);
          }
        }
      });
    } else {
      // No batch_id column - default to sorting if there's completed data
      Logger.log('No batch_id column, defaulting to sort');
      shouldSort = true;
    }
    
    if (!shouldSort) {
      Logger.log('Auto-sort not enabled for any batch');
      return;
    }
    
    Logger.log('Performing auto-sort...');
    
    // Sort: "Spoke to Human" first
    const sortedData = data.map(function(row, idx) {
      return { row: row, originalIndex: idx };
    }).sort(function(a, b) {
      const statusA = String(a.row[cols.status - 1] || '').trim().toLowerCase();
      const statusB = String(b.row[cols.status - 1] || '').trim().toLowerCase();
      
      const priorityA = getStatusPriority_(statusA);
      const priorityB = getStatusPriority_(statusB);
      
      if (priorityA !== priorityB) return priorityA - priorityB;
      return a.originalIndex - b.originalIndex;
    }).map(function(item) {
      return item.row;
    });
    
    dataRange.setValues(sortedData);
    SpreadsheetApp.flush();
    
    Logger.log('Auto-sort completed successfully');
    
    // Clean up autoSort settings for completed batches
    batchIdsToClean.forEach(function(batchId) {
      sp.deleteProperty('BATCH_AUTOSORT_' + batchId);
      Logger.log('Cleaned up BATCH_AUTOSORT_' + batchId);
    });
    
  } catch (e) {
    Logger.log('Error in autoSortIfBatchComplete_: ' + e.message);
  }
}

/**
 * Cancel a scheduled second round
 */
/**
 * Cancel scheduled second rounds via a dialog with checkboxes
 */
/**
 * Cancel scheduled follow-up rounds via a dialog with checkboxes
 * Handles BOTH old SECOND_ROUND_ and new MULTI_ROUND_ systems
 */
function vapiCancelSecondRound() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  
  // Find all pending campaigns (both old and new systems)
  const pendingRounds = [];
  
  // Check OLD system (SECOND_ROUND_)
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      if (config.status === 'waiting_for_first_batch' || config.status === 'waiting_for_delay') {
        let scheduledTime = '';
        let statusText = '';
        
        if (config.status === 'waiting_for_first_batch') {
          statusText = '⏳ Waiting for 1st batch to complete';
        } else if (config.status === 'waiting_for_delay' && config.firstBatchCompletedAt) {
          const completedAt = new Date(config.firstBatchCompletedAt);
          const scheduledAt = new Date(completedAt.getTime() + config.delayMinutes * 60 * 1000);
          scheduledTime = Utilities.formatDate(scheduledAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
          statusText = '⏰ Scheduled for ' + scheduledTime;
        }
        
        pendingRounds.push({
          key: key,
          batchId: config.batchId,
          system: 'old',
          statusText: statusText,
          delayMinutes: config.delayMinutes,
          statuses: config.statuses || [],
          sheetName: config.sheetName,
          totalRounds: 2,
          currentRound: 1
        });
      }
    } catch (e) {}
  }
  
  // Check NEW system (MULTI_ROUND_)
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      
      // Skip if campaign is already complete
      if (config.currentRound > config.totalRounds) continue;
      
      let statusText = '';
      if (config.currentRound === 1 && !config.round1CompletedAt) {
        statusText = '🔄 Round 1/' + config.totalRounds + ' in progress';
      } else if (config.currentRound === 1 && config.round1CompletedAt) {
        statusText = '⏳ Round 1 complete, waiting for Round 2';
      } else {
        statusText = '🔄 Round ' + config.currentRound + '/' + config.totalRounds + ' in progress';
      }
      
      // Get next round info
      let nextRoundInfo = '';
      if (config.rounds && config.rounds.length > 0) {
        const nextRoundIdx = config.currentRound - 1;
        if (nextRoundIdx < config.rounds.length) {
          const nextRound = config.rounds[nextRoundIdx];
          if (nextRound.type === 'delay') {
            nextRoundInfo = '+' + nextRound.delayMinutes + ' min';
          } else if (nextRound.scheduledAt) {
            nextRoundInfo = Utilities.formatDate(new Date(nextRound.scheduledAt), Session.getScriptTimeZone(), 'MMM d HH:mm');
          }
        }
      }
      
      pendingRounds.push({
        key: key,
        batchId: config.batchId,
        system: 'new',
        statusText: statusText,
        nextRoundInfo: nextRoundInfo,
        sheetName: config.sheetName,
        totalRounds: config.totalRounds,
        currentRound: config.currentRound,
        rounds: config.rounds
      });
    } catch (e) {
      Logger.log('Error parsing MULTI_ROUND_ config: ' + e.message);
    }
  }
  
  if (pendingRounds.length === 0) {
    ui.alert('📋 No Scheduled Follow-up Rounds\n\nThere are no pending follow-up rounds to cancel.');
    return;
  }
  
  // Build the HTML dialog
  let roundOptionsHtml = '';
  pendingRounds.forEach(function(round) {
    const statusIcon = round.system === 'new' ? '🔄' : '⏳';
    const systemLabel = round.system === 'new' ? 
      '<span style="background:#e3f2fd;padding:2px 6px;border-radius:4px;font-size:10px;color:#1565c0;">Multi-Round</span>' : 
      '<span style="background:#fff3e0;padding:2px 6px;border-radius:4px;font-size:10px;color:#e65100;">2-Round</span>';
    
    let detailsHtml = 'Sheet: <b>' + round.sheetName + '</b>';
    if (round.system === 'new') {
      detailsHtml += ' | Rounds: <b>' + round.currentRound + '/' + round.totalRounds + '</b>';
      if (round.nextRoundInfo) {
        detailsHtml += ' | Next: <b>' + round.nextRoundInfo + '</b>';
      }
    } else {
      detailsHtml += ' | Delay: <b>' + round.delayMinutes + ' min</b>';
      if (round.statuses && round.statuses.length > 0) {
        detailsHtml += ' | Retry: <b>' + round.statuses.join(', ') + '</b>';
      }
    }
    
    roundOptionsHtml += `
      <div class="round-row">
        <label>
          <input type="checkbox" name="round" value="${round.batchId}" data-system="${round.system}" />
          <span class="round-info">
            <span class="round-id">${statusIcon} ${round.batchId} ${systemLabel}</span>
            <span class="round-status">${round.statusText}</span>
            <span class="round-details">${detailsHtml}</span>
          </span>
        </label>
      </div>
    `;
  });
  
  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
      h3 { margin: 0 0 16px 0; color: #e67c00; }
      .round-row { padding: 12px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 8px; }
      .round-row:hover { background: #f5f5f5; }
      .round-row label { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
      .round-row input[type="checkbox"] { margin-top: 4px; width: 18px; height: 18px; cursor: pointer; }
      .round-info { display: flex; flex-direction: column; gap: 4px; }
      .round-id { font-weight: 500; font-size: 13px; display: flex; align-items: center; gap: 8px; }
      .round-status { font-size: 12px; color: #1a73e8; }
      .round-details { font-size: 11px; color: #666; }
      .round-details b { color: #333; }
      .btn-row { display: flex; gap: 8px; margin-top: 20px; }
      button { padding: 10px 20px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
      .btn-warning { background: #e67c00; color: white; flex: 1; }
      .btn-warning:hover { background: #cc6d00; }
      .btn-warning:disabled { background: #ccc; cursor: not-allowed; }
      .btn-secondary { background: #f1f1f1; color: #333; border: 1px solid #ccc; }
      .btn-secondary:hover { background: #e0e0e0; }
      .info { background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; color: #856404; }
      .select-all { margin-bottom: 12px; font-size: 12px; }
      .select-all a { color: #1a73e8; cursor: pointer; text-decoration: none; }
      .select-all a:hover { text-decoration: underline; }
      .summary { background: #e8f0fe; padding: 10px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; color: #1a73e8; }
    </style>
    
    <h3>❌ Cancel Follow-up Rounds</h3>
    
    <div class="info">
      ⚠️ This will cancel all scheduled follow-up rounds for the selected campaign(s). Completed calls will not be affected.
    </div>
    
    <div class="summary">
      📊 Found <b>${pendingRounds.length}</b> active campaign(s) with pending follow-up rounds
    </div>
    
    <div class="select-all">
      <a onclick="selectAll()">Select all</a> | 
      <a onclick="selectNone()">Clear selection</a>
    </div>
    
    <div id="roundList" style="max-height: 300px; overflow-y: auto;">
      ${roundOptionsHtml}
    </div>
    
    <div class="btn-row">
      <button class="btn-secondary" onclick="google.script.host.close()">Close</button>
      <button class="btn-warning" id="cancelBtn" onclick="cancelSelected()">❌ Cancel Selected</button>
    </div>
    
    <script>
      function selectAll() {
        document.querySelectorAll('input[name="round"]').forEach(function(cb) {
          cb.checked = true;
        });
      }
      
      function selectNone() {
        document.querySelectorAll('input[name="round"]').forEach(function(cb) {
          cb.checked = false;
        });
      }
      
      function cancelSelected() {
        const selected = [];
        document.querySelectorAll('input[name="round"]:checked').forEach(function(cb) {
          selected.push({
            batchId: cb.value,
            system: cb.getAttribute('data-system')
          });
        });
        
        if (selected.length === 0) {
          alert('Please select at least one campaign to cancel.');
          return;
        }
        
        const btn = document.getElementById('cancelBtn');
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
        
        google.script.run
          .withSuccessHandler(function(result) {
            alert(result);
            google.script.host.close();
          })
          .withFailureHandler(function(e) {
            alert('Error: ' + e.message);
            btn.disabled = false;
            btn.textContent = '❌ Cancel Selected';
          })
          .vapiCancelFollowupRoundsByIds(selected);
      }
    </script>
  `)
  .setWidth(550)
  .setHeight(500);
  
  ui.showModalDialog(html, 'Cancel Follow-up Rounds');
}

/**
 * Cancels multiple follow-up rounds by their batch IDs
 * Handles BOTH old SECOND_ROUND_ and new MULTI_ROUND_ systems
 */
function vapiCancelFollowupRoundsByIds(selections) {
  if (!selections || !Array.isArray(selections) || selections.length === 0) {
    throw new Error('No campaigns selected');
  }
  
  const props = PropertiesService.getScriptProperties();
  let cancelledCount = 0;
  
  selections.forEach(function(item) {
    const batchId = item.batchId;
    const system = item.system;
    
    if (system === 'old') {
      // OLD system: SECOND_ROUND_
      const key = 'SECOND_ROUND_' + batchId;
      const configStr = props.getProperty(key);
      
      if (configStr) {
        try {
          const config = JSON.parse(configStr);
          updateSecondRoundStatusInSheet_(config, '❌ Cancelled');
          props.deleteProperty(key);
          cancelledCount++;
          Logger.log('Cancelled SECOND_ROUND_ for batch: ' + batchId);
        } catch (e) {
          Logger.log('Error cancelling SECOND_ROUND_ for ' + batchId + ': ' + e.message);
        }
      }
    } else if (system === 'new') {
      // NEW system: MULTI_ROUND_
      const key = 'MULTI_ROUND_' + batchId;
      const configStr = props.getProperty(key);
      
      if (configStr) {
        try {
          const config = JSON.parse(configStr);
          
          // Update status columns in sheet
          updateMultiRoundStatusInSheet_(config, '❌ Cancelled');
          updateMultiRoundNextAtInSheet_(config, 'Cancelled by user');
          
          // Delete the config
          props.deleteProperty(key);
          cancelledCount++;
          Logger.log('Cancelled MULTI_ROUND_ for batch: ' + batchId);
        } catch (e) {
          Logger.log('Error cancelling MULTI_ROUND_ for ' + batchId + ': ' + e.message);
        }
      }
    }
    
    // Also clean up autoSort setting
    props.deleteProperty('BATCH_AUTOSORT_' + batchId);
  });
  
  // Clean up triggers if no more pending campaigns
  cleanupFollowupTriggers_();
  
  return '✅ Cancelled ' + cancelledCount + ' campaign(s) with pending follow-up rounds.';
}

/**
 * Cleans up triggers if no pending campaigns remain
 */
function cleanupFollowupTriggers_() {
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  
  // Check for any remaining SECOND_ROUND_ campaigns
  let hasOldPending = false;
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    try {
      const config = JSON.parse(allProps[key]);
      if (config.status === 'waiting_for_first_batch' || config.status === 'waiting_for_delay') {
        hasOldPending = true;
        break;
      }
    } catch (e) {}
  }
  
  if (!hasOldPending) {
    deleteTriggersByHandler_('checkAndStartSecondRound_');
  }
  
  // Check for any remaining MULTI_ROUND_ campaigns
  let hasNewPending = false;
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    try {
      const config = JSON.parse(allProps[key]);
      if (config.currentRound <= config.totalRounds) {
        hasNewPending = true;
        break;
      }
    } catch (e) {}
  }
  
  if (!hasNewPending) {
    deleteTriggersByHandler_('checkAndStartNextRound_');
  }
}

/**
 * Cancels multiple second rounds by their batch IDs
 * Now handles BOTH old SECOND_ROUND_ and new MULTI_ROUND_ systems
 */
function vapiCancelSecondRoundsByIds(batchIds) {
  if (!batchIds || !Array.isArray(batchIds) || batchIds.length === 0) {
    throw new Error('No campaigns selected');
  }
  
  const props = PropertiesService.getScriptProperties();
  let cancelledCount = 0;
  
  batchIds.forEach(function(batchId) {
    // Try OLD system first (SECOND_ROUND_)
    const oldKey = 'SECOND_ROUND_' + batchId;
    const oldConfigStr = props.getProperty(oldKey);
    
    if (oldConfigStr) {
      try {
        const config = JSON.parse(oldConfigStr);
        
        // Update sheet status
        updateSecondRoundStatusInSheet_(config, '❌ Cancelled');
        
        // Delete the config
        props.deleteProperty(oldKey);
        cancelledCount++;
        
        Logger.log('Cancelled SECOND_ROUND_ for batch: ' + batchId);
      } catch (e) {
        Logger.log('Error cancelling SECOND_ROUND_ for ' + batchId + ': ' + e.message);
      }
    }
    
    // Try NEW system (MULTI_ROUND_)
    const newKey = 'MULTI_ROUND_' + batchId;
    const newConfigStr = props.getProperty(newKey);
    
    if (newConfigStr) {
      try {
        const config = JSON.parse(newConfigStr);
        
        // Update sheet status columns
        updateMultiRoundStatusInSheet_(config, '❌ Cancelled');
        updateMultiRoundNextAtInSheet_(config, 'Cancelled by user');
        
        // Delete the config
        props.deleteProperty(newKey);
        cancelledCount++;
        
        Logger.log('Cancelled MULTI_ROUND_ for batch: ' + batchId);
      } catch (e) {
        Logger.log('Error cancelling MULTI_ROUND_ for ' + batchId + ': ' + e.message);
      }
    }
    
    // NOTE: We intentionally keep BATCH_AUTOSORT_ so "Spoke to Human" rows
    // still get sorted to the top when the batch completes
  });
  
  // Clean up OLD system trigger if no more pending
  let hasOldPending = false;
  const allProps = props.getProperties();
  for (const key in allProps) {
    if (key.startsWith('SECOND_ROUND_')) {
      try {
        const config = JSON.parse(allProps[key]);
        if (config.status === 'waiting_for_first_batch' || config.status === 'waiting_for_delay') {
          hasOldPending = true;
          break;
        }
      } catch (e) {}
    }
  }
  
  if (!hasOldPending) {
    deleteTriggersByHandler_('checkAndStartSecondRound_');
  }
  
  // Clean up NEW system trigger if no more pending
  let hasNewPending = false;
  for (const key in allProps) {
    if (key.startsWith('MULTI_ROUND_')) {
      try {
        const config = JSON.parse(allProps[key]);
        if (config.currentRound <= config.totalRounds) {
          hasNewPending = true;
          break;
        }
      } catch (e) {}
    }
  }
  
  if (!hasNewPending) {
    deleteTriggersByHandler_('checkAndStartNextRound_');
  }
  
  return '✅ Cancelled ' + cancelledCount + ' scheduled follow-up round(s).';
}
// ============================================================
// MISSING HELPER FUNCTIONS FOR AUTO 2ND ROUND
// ============================================================

function getVapiKey_() {
  return PropertiesService.getScriptProperties().getProperty('VAPI_API_KEY');
}

function getRowDataForCall_(sh, rowNum, cols) {
  const lastCol = sh.getLastColumn();
  const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  
  return {
    phone: normalizePhone_(rowVals[cols.phone - 1]),
    prospectName: cols.prospect_name ? String(rowVals[cols.prospect_name - 1] || '').trim() : '',
    prospectEmail: cols.prospect_email ? String(rowVals[cols.prospect_email - 1] || '').trim() : '',
    eventName: cols.event_name ? String(rowVals[cols.event_name - 1] || '').trim() : '',
    eventDate: cols.event_date ? formatEventDate_(rowVals[cols.event_date - 1]) : '',
    eventCity: cols.event_city ? String(rowVals[cols.event_city - 1] || '').trim() : '',
    eventTime: cols.event_time ? formatEventTime_(rowVals[cols.event_time - 1]) : '',
    eventFormat: cols.event_format ? String(rowVals[cols.event_format - 1] || '').trim() : '',
    eventContext: cols.event_context ? String(rowVals[cols.event_context - 1] || '').trim() : '',
    eventArea: cols.event_area ? String(rowVals[cols.event_area - 1] || '').trim() : String(rowVals[cols.event_city - 1] || '').trim(),
    eventVenue: cols.event_venue ? String(rowVals[cols.event_venue - 1] || '').trim() : '',
    targetAudience: cols.target_audience ? String(rowVals[cols.target_audience - 1] || '').trim() : '',
    callerName: cols.caller_name ? String(rowVals[cols.caller_name - 1] || 'Alex').trim() : 'Alex',
    hostName: cols.host_name ? String(rowVals[cols.host_name - 1] || '').trim() : '',
    hostFirstName: cols.host_first_name ? String(rowVals[cols.host_first_name - 1] || '').trim() : '',
    hostPronouns: cols.host_pronouns ? String(rowVals[cols.host_pronouns - 1] || 'they/them').trim() : 'they/them',
    voicemailLeftCount: cols.voicemail_left_count ? Number(rowVals[cols.voicemail_left_count - 1] || 0) : 0,
    assistantName: cols.assistant ? String(rowVals[cols.assistant - 1] || '').trim() : '',
    vapiNumber: cols.vapi_number ? String(rowVals[cols.vapi_number - 1] || '').trim() : ''
  };
}

function triggerVapiCall_(apiKey, rowData, sh, rowNum, cols) {
  const ss = sh.getParent();
  const sp = PropertiesService.getScriptProperties();
  
  const assistantId = resolveAssistantIdFromName_(ss, rowData.assistantName, sp.getProperty('VAPI_ASSISTANT_ID'));
  if (!assistantId) throw new Error('No assistant ID');
  
  const phoneNumberId = resolvePhoneNumberIdFromDisplay_(ss, rowData.vapiNumber, sp.getProperty('VAPI_PHONE_NUMBER_ID'));
  if (!phoneNumberId) throw new Error('No phone number ID');
  
  const variableValues = {
    prospect_name: rowData.prospectName,
    prospect_email: rowData.prospectEmail,
    event_name: rowData.eventName,
    event_date: rowData.eventDate,
    event_city: rowData.eventCity,
    event_area: rowData.eventArea,
    event_venue: rowData.eventVenue,
    caller_name: rowData.callerName,
    host_name: rowData.hostName,
    host_first_name: rowData.hostFirstName,
    host_pronouns: rowData.hostPronouns,
    event_time: rowData.eventTime,
    event_format: rowData.eventFormat,
    event_context: rowData.eventContext,
    target_audience: rowData.targetAudience,
    leave_voicemail: rowData.voicemailLeftCount >= 1 ? 'no' : 'yes',
    voicemail_action: rowData.voicemailLeftCount >= 1 ? 'hang_up_immediately' : 'leave_message',
    voicemail_left_count: String(rowData.voicemailLeftCount)
  };
  
  const payload = {
    assistantId: assistantId,
    phoneNumberId: phoneNumberId,
    customer: { number: rowData.phone, name: rowData.prospectName },
    metadata: { sheetName: sh.getName(), rowNum: rowNum },
    assistantOverrides: { variableValues: variableValues }
  };
  
  const call = vapiCreateCall_(apiKey, payload);
  
  if (call && call.id) {
    sh.getRange(rowNum, cols.call_id).setValue(call.id);
    sh.getRange(rowNum, cols.status).setValue('Calling...');
    sh.getRange(rowNum, cols.started_at).setValue(new Date());
    applyRowHygiene_(sh, rowNum, cols);
  }
  
 return call;
}

/**
 * Stop specific batches via a dialog with checkboxes
 */
function vapiStopSpecificBatch() {
  ensureSheetId_();
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  
  if (!cols.batch_id || !cols.status) {
    ui.alert('❌ Missing batch_id or status column');
    return;
  }
  
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) {
    ui.alert('No data.');
    return;
  }
  
  // Find all unique batch IDs with their stats
  const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, sh.getLastColumn()).getValues();
  const batchStats = {};
  
  data.forEach(function(row) {
    const batchId = String(row[cols.batch_id - 1] || '').trim();
    if (!batchId) return;
    
    const baseBatchId = batchId.replace(/_R2$/, '');
    const status = String(row[cols.status - 1] || '').trim().toLowerCase();
    
    if (!batchStats[baseBatchId]) {
      batchStats[baseBatchId] = { queued: 0, calling: 0, done: 0, total: 0 };
    }
    
    batchStats[baseBatchId].total++;
    if (status === 'queued') batchStats[baseBatchId].queued++;
    else if (status === 'calling...' || status === 'calling') batchStats[baseBatchId].calling++;
    else batchStats[baseBatchId].done++;
  });
  
  const batchIds = Object.keys(batchStats).sort().reverse(); // Most recent first
  
  if (batchIds.length === 0) {
    ui.alert('No batches found in this sheet.');
    return;
  }
  
  // Check if any batch has pending calls
  const hasActiveBatches = batchIds.some(function(id) {
    return batchStats[id].queued > 0 || batchStats[id].calling > 0;
  });
  
  if (!hasActiveBatches) {
    ui.alert('No active batches to stop.\n\nAll batches have completed.');
    return;
  }
  
  // Build the HTML dialog
  let batchOptionsHtml = '';
  batchIds.forEach(function(id) {
    const stats = batchStats[id];
    const isActive = stats.queued > 0 || stats.calling > 0;
    const statusIcon = isActive ? '🟢' : '✅';
    const disabled = isActive ? '' : 'disabled';
    const opacity = isActive ? '1' : '0.5';
    
    batchOptionsHtml += `
      <div class="batch-row" style="opacity: ${opacity};">
        <label>
          <input type="checkbox" name="batch" value="${id}" ${disabled} />
          <span class="batch-info">
            <span class="batch-id">${statusIcon} ${id}</span>
            <span class="batch-stats">
              Queued: <b>${stats.queued}</b> | 
              Calling: <b>${stats.calling}</b> | 
              Done: <b>${stats.done}</b>
            </span>
          </span>
        </label>
      </div>
    `;
  });
  
  const html = HtmlService.createHtmlOutput(`
    <style>
      body { font-family: Arial, sans-serif; padding: 16px; margin: 0; }
      h3 { margin: 0 0 16px 0; color: #c5221f; }
      .batch-row { padding: 12px; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 8px; }
      .batch-row:hover { background: #f5f5f5; }
      .batch-row label { display: flex; align-items: flex-start; gap: 12px; cursor: pointer; }
      .batch-row input[type="checkbox"] { margin-top: 4px; width: 18px; height: 18px; cursor: pointer; }
      .batch-row input[type="checkbox"]:disabled { cursor: not-allowed; }
      .batch-info { display: flex; flex-direction: column; gap: 4px; }
      .batch-id { font-weight: 500; font-size: 13px; }
      .batch-stats { font-size: 11px; color: #666; }
      .batch-stats b { color: #333; }
      .btn-row { display: flex; gap: 8px; margin-top: 20px; }
      button { padding: 10px 20px; border: none; border-radius: 4px; font-size: 14px; cursor: pointer; }
      .btn-danger { background: #c5221f; color: white; flex: 1; }
      .btn-danger:hover { background: #a31b18; }
      .btn-danger:disabled { background: #ccc; cursor: not-allowed; }
      .btn-secondary { background: #f1f1f1; color: #333; border: 1px solid #ccc; }
      .btn-secondary:hover { background: #e0e0e0; }
      .info { background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 16px; font-size: 12px; color: #856404; }
      .select-all { margin-bottom: 12px; font-size: 12px; }
      .select-all a { color: #1a73e8; cursor: pointer; text-decoration: none; }
      .select-all a:hover { text-decoration: underline; }
    </style>
    
    <h3>🛑 Stop Batch</h3>
    
    <div class="info">
      ⚠️ This will cancel all queued and in-progress calls for the selected batch(es).
    </div>
    
    <div class="select-all">
      <a onclick="selectAll()">Select all active</a> | 
      <a onclick="selectNone()">Clear selection</a>
    </div>
    
    <div id="batchList">
      ${batchOptionsHtml}
    </div>
    
    <div class="btn-row">
      <button class="btn-secondary" onclick="google.script.host.close()">Cancel</button>
      <button class="btn-danger" id="stopBtn" onclick="stopSelected()">🛑 Stop Selected</button>
    </div>
    
    <script>
      function selectAll() {
        document.querySelectorAll('input[name="batch"]:not(:disabled)').forEach(function(cb) {
          cb.checked = true;
        });
      }
      
      function selectNone() {
        document.querySelectorAll('input[name="batch"]').forEach(function(cb) {
          cb.checked = false;
        });
      }
      
      function stopSelected() {
        const selected = [];
        document.querySelectorAll('input[name="batch"]:checked').forEach(function(cb) {
          selected.push(cb.value);
        });
        
        if (selected.length === 0) {
          alert('Please select at least one batch to stop.');
          return;
        }
        
        const btn = document.getElementById('stopBtn');
        btn.disabled = true;
        btn.textContent = 'Stopping...';
        
        google.script.run
          .withSuccessHandler(function(result) {
            alert(result);
            google.script.host.close();
          })
          .withFailureHandler(function(e) {
            alert('Error: ' + e.message);
            btn.disabled = false;
            btn.textContent = '🛑 Stop Selected';
          })
          .vapiStopBatchesByIds(selected);
      }
    </script>
  `)
  .setWidth(450)
  .setHeight(500);
  
  ui.showModalDialog(html, 'Stop Batch');
}

/**
 * Stops multiple batches by their IDs
 */
function vapiStopBatchesByIds(batchIds) {
  if (!batchIds || !Array.isArray(batchIds) || batchIds.length === 0) {
    throw new Error('No batches selected');
  }
  
  const sh = SpreadsheetApp.getActiveSheet();
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  const cols = getHeaderMap_(sh);
  
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) {
    throw new Error('No data');
  }
  
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
  
  let totalCancelled = 0;
  const batchSet = new Set(batchIds);
  
  // Update statuses
  data.forEach(function(row, i) {
    const rowBatchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R2$/, '');
    
    if (batchSet.has(rowBatchId)) {
      const status = String(row[cols.status - 1] || '').trim().toLowerCase();
      
      if (status === 'queued' || status === 'calling...' || status === 'calling') {
        data[i][cols.status - 1] = 'Cancelled';
        totalCancelled++;
      }
      
      if (cols.second_round_status) {
        data[i][cols.second_round_status - 1] = '🛑 Stopped';
      }
    }
  });
  
  // Write back
  sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
  
  // Cancel scheduled 2nd rounds and clean up
  batchIds.forEach(function(batchId) {
    // Cancel 2nd round
    const secondRoundKey = 'SECOND_ROUND_' + batchId;
    if (sp.getProperty(secondRoundKey)) {
      sp.deleteProperty(secondRoundKey);
    }
    
    // Clear autoSort
    sp.deleteProperty('BATCH_AUTOSORT_' + batchId);
  });
  
  // Clear from queue
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  
  if (queue.length > 0) {
    const batchRows = new Set();
    data.forEach(function(row, i) {
      const rowBatchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R2$/, '');
      if (batchSet.has(rowBatchId)) {
        batchRows.add(HEADER_ROW_INDEX + 1 + i);
      }
    });
    
    queue = queue.filter(function(rowNum) {
      return !batchRows.has(rowNum);
    });
    
    sp.setProperty(qKey, JSON.stringify(queue));
  }
  
  SpreadsheetApp.flush();
  
  // Update status
  updateStatus_({ 
    'Script Status': '🛑 Stopped ' + batchIds.length + ' batch(es)',
    'Queued Rows': queue.length 
  }, sheetName);
  
  return '✅ Stopped ' + batchIds.length + ' batch(es)\n\nCancelled ' + totalCancelled + ' pending calls.';
}

/**
 * Sort sheet to move "Spoke to Human" rows to the top
 */
function vapiSortSpokeToHumanToTop() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  
  if (!cols.status) {
    ui.alert('❌ Missing status column');
    return;
  }
  
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) {
    ui.alert('No data.');
    return;
  }
  
  const lastCol = sh.getLastColumn();
  const dataRange = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol);
  const data = dataRange.getValues();
  
  // Sort: "Spoke to Human" first, then by status, then by original order
  const sortedData = data.map(function(row, idx) {
    return { row: row, originalIndex: idx };
  }).sort(function(a, b) {
    const statusA = String(a.row[cols.status - 1] || '').trim().toLowerCase();
    const statusB = String(b.row[cols.status - 1] || '').trim().toLowerCase();
    
    const isHumanA = statusA.includes('spoke to human') ? 0 : 1;
    const isHumanB = statusB.includes('spoke to human') ? 0 : 1;
    
    if (isHumanA !== isHumanB) return isHumanA - isHumanB;
    
    // Secondary sort: Interested > Callback > Others
    const priorityA = getStatusPriority_(statusA);
    const priorityB = getStatusPriority_(statusB);
    
    if (priorityA !== priorityB) return priorityA - priorityB;
    
    // Keep original order for same priority
    return a.originalIndex - b.originalIndex;
  }).map(function(item) {
    return item.row;
  });
  
  dataRange.setValues(sortedData);
  SpreadsheetApp.flush();
  
  // Count how many "Spoke to Human"
  const spokeCount = sortedData.filter(function(row) {
    return String(row[cols.status - 1] || '').toLowerCase().includes('spoke to human');
  }).length;
  
  ui.alert('✅ Sorted!\n\n' + spokeCount + ' "Spoke to Human" rows moved to top.');
}

/**
 * Get priority for status sorting (lower = higher priority)
 */
function getStatusPriority_(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('spoke to human')) return 0;
  if (s.includes('interested')) return 1;
  if (s.includes('callback')) return 2;
  if (s.includes('voicemail')) return 3;
  if (s.includes('no answer')) return 4;
  if (s.includes('busy')) return 5;
  if (s.includes('gatekeeper')) return 6;
  if (s.includes('number failed')) return 7;
  if (s.includes('hung up')) return 8;
  if (s.includes('cancelled')) return 9;
  return 10;
}

function getCurrentUserEmail() {
  return Session.getActiveUser().getEmail() || 'Unable to detect email';
}
function testAutoSort() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = SpreadsheetApp.getActiveSheet().getName();
  
  Logger.log('Testing autoSortIfBatchComplete_');
  autoSortIfBatchComplete_(sheetId, sheetName);
  Logger.log('Test complete - check logs');
}

/**
 * Generates a human-readable batch ID
 * Format: SheetName_Jan29_10-30AM
 */
function generateBatchId_(sheetName) {
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  
  // Clean sheet name (remove spaces and special chars)
  const cleanSheetName = String(sheetName || 'Batch');
  
  // Format: SheetName_Jan29_10-30AM
  return cleanSheetName + '_' + month + day + '_' + hour12 + '-' + minutes + ampm;
}

function debugPhoneColumn() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  
  Logger.log('=== HEADER MAP ===');
  Logger.log('phone column index: ' + cols.phone);
  Logger.log('first_phone_validation column index: ' + cols.first_phone_validation);
  
  // Show what headers are in the sheet
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  headers.forEach(function(h, i) {
    Logger.log('Column ' + (i + 1) + ': "' + h + '"');
  });
  
  // If we found a phone column, show what value is there
  if (cols.phone) {
    const phoneValue = sh.getRange(2, cols.phone).getValue();
    Logger.log('Phone value in row 2: "' + phoneValue + '"');
  }
}
function debugCallData() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  
  // Get row 2 data
  const rowNum = 2;
  const lastCol = sh.getLastColumn();
  const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  
  Logger.log('=== CALL DATA FOR ROW 2 ===');
  
  // Phone
  const rawPhone = rowVals[cols.phone - 1];
  const normalizedPhone = normalizePhone_(rawPhone);
  Logger.log('Raw phone: "' + rawPhone + '"');
  Logger.log('Normalized phone: "' + normalizedPhone + '"');
  
  // Prospect name
  const prospectName = cols.prospect_name ? rowVals[cols.prospect_name - 1] : 'NOT FOUND';
  Logger.log('Prospect name (col ' + cols.prospect_name + '): "' + prospectName + '"');
  
  // Email
  const email = cols.prospect_email ? rowVals[cols.prospect_email - 1] : 'NOT FOUND';
  Logger.log('Email (col ' + cols.prospect_email + '): "' + email + '"');
  
  // Assistant
  const assistant = cols.assistant ? rowVals[cols.assistant - 1] : 'NOT FOUND';
  Logger.log('Assistant (col ' + cols.assistant + '): "' + assistant + '"');
  
  // Vapi number
  const vapiNumber = cols.vapi_number ? rowVals[cols.vapi_number - 1] : 'NOT FOUND';
  Logger.log('Vapi number (col ' + cols.vapi_number + '): "' + vapiNumber + '"');
  
  // Status
  const status = cols.status ? rowVals[cols.status - 1] : 'NOT FOUND';
  Logger.log('Status (col ' + cols.status + '): "' + status + '"');
  
  // Check required columns
  Logger.log('');
  Logger.log('=== REQUIRED COLUMNS CHECK ===');
  const required = ['phone', 'status', 'assistant', 'vapi_number', 'prospect_name', 'prospect_email'];
  required.forEach(function(key) {
    const found = cols[key] ? '✅ Column ' + cols[key] : '❌ NOT FOUND';
    Logger.log(key + ': ' + found);
  });
  }
function debugStatusColumn() {
  const sh = SpreadsheetApp.getActiveSheet();
  const cols = getHeaderMap_(sh);
  
  Logger.log('=== STATUS COLUMN DEBUG ===');
  Logger.log('status column index: ' + cols.status);
  
  // Check what header is at that column
  if (cols.status) {
    const header = sh.getRange(1, cols.status).getValue();
    Logger.log('Header at status column: "' + header + '"');
  }
  
  // Show all headers with "status" or "vapi"
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Logger.log('');
  Logger.log('Headers containing "status" or "vapi":');
  headers.forEach(function(h, i) {
    const lower = String(h || '').toLowerCase();
    if (lower.includes('status') || lower.includes('vapi')) {
      Logger.log('  Column ' + (i + 1) + ': "' + h + '"');
    }
  });
}
function debugAutoSort() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sh = SpreadsheetApp.getActiveSheet();
  const sheetName = sh.getName();
  const cols = getHeaderMap_(sh);
  
  Logger.log('=== AUTO-SORT DEBUG ===');
  Logger.log('Sheet ID: ' + sheetId);
  Logger.log('Sheet Name: ' + sheetName);
  Logger.log('Status column: ' + cols.status);
  Logger.log('Batch ID column: ' + cols.batch_id);
  
  // Check batch IDs in the sheet
  if (cols.batch_id) {
    const lastRow = sh.getLastRow();
    const data = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
    
    const batchIds = new Set();
    data.forEach(function(row) {
      const batchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R2$/, '');
      if (batchId) batchIds.add(batchId);
    });
    
    Logger.log('');
    Logger.log('Batch IDs found: ' + Array.from(batchIds).join(', '));
    
    // Check autoSort settings for each batch
    Logger.log('');
    Logger.log('AutoSort settings:');
    batchIds.forEach(function(batchId) {
      const autoSortSetting = sp.getProperty('BATCH_AUTOSORT_' + batchId);
      const secondRoundConfig = sp.getProperty('SECOND_ROUND_' + batchId);
      
      Logger.log('  ' + batchId + ':');
      Logger.log('    BATCH_AUTOSORT_: ' + (autoSortSetting || 'not set'));
      
      if (secondRoundConfig) {
        try {
          const config = JSON.parse(secondRoundConfig);
          Logger.log('    SECOND_ROUND_ autoSort: ' + config.autoSort);
          Logger.log('    SECOND_ROUND_ status: ' + config.status);
        } catch (e) {
          Logger.log('    SECOND_ROUND_: parse error');
        }
      } else {
        Logger.log('    SECOND_ROUND_: not set');
      }
    });
  } else {
    Logger.log('No batch_id column found!');
  }
  
  // Check current statuses
  Logger.log('');
  Logger.log('Current status counts:');
  const lastRow = sh.getLastRow();
  const statusData = sh.getRange(2, cols.status, lastRow - 1, 1).getValues();
  const statusCounts = {};
  statusData.forEach(function(row) {
    const s = String(row[0] || '').trim() || '(empty)';
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  });
  Object.keys(statusCounts).sort().forEach(function(s) {
    Logger.log('  ' + s + ': ' + statusCounts[s]);
  });
}
function manualAutoSort() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = SpreadsheetApp.getActiveSheet().getName();
  
  Logger.log('Manually triggering autoSortIfBatchComplete_...');
  autoSortIfBatchComplete_(sheetId, sheetName);
  Logger.log('Done!');
}
// ============================================================
// MULTI-ROUND CAMPAIGN SYSTEM
// ============================================================

/**
 * Processes the multi-round campaign configuration from the dialog
 */
/**
 * Processes the multi-round campaign configuration from the dialog
 */
/**
 * Processes the multi-round campaign configuration from the dialog
 * Now accepts assistant and phone number from wizard
 */
function vapiScheduleMultiRoundCampaign(config) {
  ensureSheetId_();
  const sh = SpreadsheetApp.getActiveSheet();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const range = sh.getActiveRange();
  if (!range) throw new Error('Please select rows first');
  
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  const sheetName = sh.getName();
  
  const concurrency = Number(config.concurrency) || 3;
  if (concurrency < 1 || concurrency > 50) throw new Error('Concurrency must be 1-5');
  
  if (!config.assistant) throw new Error('Please select an assistant');
  if (!config.phoneNumber) throw new Error('Please select a phone number');
  
  const batchId = generateBatchId_(sheetName);
  
  // Calculate Round 1 start time
  let round1StartAt;
  let round1TimeDisplay;
  
  if (config.round1Type === 'specific') {
    round1StartAt = calculateSpecificTime_(config.round1Time, config.round1Timezone, config.round1DaysFromNow);
    const tzShort = config.round1Timezone.split('/').pop().replace('_', ' ');
    round1TimeDisplay = config.round1Time + ' ' + tzShort;
    if (config.round1DaysFromNow > 0) round1TimeDisplay += ' (+' + config.round1DaysFromNow + 'd)';
  } else {
    const round1Delay = Number(config.round1DelayMin) || 1;
    if (round1Delay < 1 || round1Delay > 10080) throw new Error('Start time must be 1-10080 minutes');
    round1StartAt = new Date(Date.now() + round1Delay * 60000);
    round1TimeDisplay = 'in ' + round1Delay + ' min';
  }
  
  // Ensure columns exist (added campaign_status and next_round_at)
  let cols = getHeaderMap_(sh);
  const columnsToEnsure = ['call_attempt', 'batch_id', 'assistant', 'vapi_number', 'campaign_status', 'next_round_at'];
  columnsToEnsure.forEach(function(colName) {
    if (!cols[colName]) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue(colName);
    }
  });
  
  ensureScheduleColumns_(sh);
  cols = getHeaderMap_(sh);
  
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  const lastCol = sh.getLastColumn();
  const allData = sh.getRange(startRow, 1, numRows, lastCol).getValues();
  
  // Calculate total rounds for display
  const totalRounds = 1 + (config.rounds ? config.rounds.length : 0);
  
  let queuedCount = 0;
  for (let i = 0; i < numRows; i++) {
    const rowNum = startRow + i;
    if (rowNum <= HEADER_ROW_INDEX) continue;
    
    while (allData[i].length < lastCol) allData[i].push('');
    
    // Set status to Queued
    if (cols.status) {
      const currentStatus = String(allData[i][cols.status - 1] || '').trim();
      if (!currentStatus || currentStatus === 'Queued') {
        allData[i][cols.status - 1] = 'Queued';
        queuedCount++;
      }
    }
    
    // Set batch ID
    if (cols.batch_id) allData[i][cols.batch_id - 1] = batchId;
    
    // Set assistant from wizard
    if (cols.assistant) allData[i][cols.assistant - 1] = config.assistant;
    
    // Set phone number from wizard
    if (cols.vapi_number) allData[i][cols.vapi_number - 1] = config.phoneNumber;
    
    // Set call attempt
    if (cols.call_attempt) {
      const current = Number(allData[i][cols.call_attempt - 1] || 0);
      if (!current) allData[i][cols.call_attempt - 1] = 1;
    }
    
    // Set scheduled time
    if (cols.scheduled_at) allData[i][cols.scheduled_at - 1] = round1StartAt;
    
    // Set campaign status (NEW)
    if (cols.campaign_status) {
      if (totalRounds > 1) {
        allData[i][cols.campaign_status - 1] = '⏰ Scheduled: ' + totalRounds + ' rounds';
      } else {
        allData[i][cols.campaign_status - 1] = '⏰ Scheduled';
      }
    }
    
    
  }
  
  sh.getRange(startRow, 1, numRows, lastCol).setValues(allData);
  
  // Set scheduled_in_min formula
  if (cols.scheduled_in_min && cols.scheduled_at) {
    const atColLetter = colToA1_(cols.scheduled_at);
    const formulas = [];
    for (let i = 0; i < numRows; i++) {
      const r = startRow + i;
      formulas.push(['=IF(' + atColLetter + r + '="","",IF(' + atColLetter + r + '<=NOW(),"due","in "&ROUND((' + atColLetter + r + '-NOW())*1440,0)&" min"))']);
    }
    sh.getRange(startRow, cols.scheduled_in_min, numRows, 1).setFormulas(formulas);
  }
  
  SpreadsheetApp.flush();
  
  // Store multi-round config
  const multiRoundConfig = {
    batchId: batchId,
    sheetId: sheetId,
    sheetName: sheetName,
    concurrency: concurrency,
    assistant: config.assistant,
    phoneNumber: config.phoneNumber,
    retryAssistant: config.retryAssistant || config.assistant,
    autoSort: config.autoSort !== false,
    currentRound: 1,
    totalRounds: totalRounds,
    rounds: config.rounds || [],
    round1StartedAt: null,
    round1CompletedAt: null,
    createdAt: new Date().toISOString()
  };
  
  // Calculate scheduled times for specific time rounds
  multiRoundConfig.rounds.forEach(function(round) {
    if (round.type === 'specific') {
      const targetDate = calculateSpecificTime_(round.time, round.timezone, round.daysFromNow);
      round.scheduledAt = targetDate.toISOString();
    }
  });
  
  sp.setProperty('MULTI_ROUND_' + batchId, JSON.stringify(multiRoundConfig));
  
  // Store settings
  sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency));
  sp.setProperty(schedSheetKey_(sheetId), sheetName);
  sp.setProperty(schedConcurrencyKey_(sheetId), String(concurrency));
  sp.setProperty(schedStartAtKey_(sheetId), String(round1StartAt.getTime()));
  sp.setProperty('BATCH_AUTOSORT_' + batchId, config.autoSort !== false ? 'true' : 'false');
  
  // Queue rows
  const qKey = queueKey_(sheetId, sheetName);
  let queue = loadJson_(sp, qKey, []);
  for (let i = 0; i < numRows; i++) {
    const r = startRow + i;
    if (r > HEADER_ROW_INDEX && queue.indexOf(r) === -1) queue.push(r);
  }
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  
  // Create triggers
  deleteTriggersByHandler_('vapiScheduledKickoff_');
  ScriptApp.newTrigger('vapiScheduledKickoff_').timeBased().at(round1StartAt).create();
  
  if (config.rounds && config.rounds.length > 0) {
    createMultiRoundMonitorTrigger_();
  }
  
  updateStatus_({ 
    'Script Status': '⏰ Round 1 scheduled for ' + Utilities.formatDate(round1StartAt, Session.getScriptTimeZone(), 'HH:mm'),
    'Queued Rows': queue.length,
    'Concurrency Setting': concurrency
  }, sheetName);
  
  // Build result message
  let message = '✅ Campaign Scheduled!\n\n';
  message += '📋 Batch ID: ' + batchId + '\n';
  message += '📞 ' + queuedCount + ' rows queued\n';
  message += '🎙️ Assistant: ' + config.assistant + '\n';
  message += '📱 Phone: ' + config.phoneNumber + '\n';
  message += '🔄 Concurrency: ' + concurrency + '\n\n';
  message += '━━━━━━━━━━━━━━━━━━━━\n\n';
  message += '1️⃣ Round 1: ' + Utilities.formatDate(round1StartAt, Session.getScriptTimeZone(), 'MMM d, HH:mm');
  if (config.round1Type === 'specific') {
    message += ' (' + config.round1Timezone.split('/').pop() + ')';
  }
  message += '\n';
  
  if (config.rounds && config.rounds.length > 0) {
    config.rounds.forEach(function(round, idx) {
      const emoji = ['2️⃣', '3️⃣', '4️⃣', '5️⃣'][idx] || '📞';
      let timeStr = '';
      if (round.type === 'delay') {
        const hours = Math.floor(round.delayMinutes / 60);
        const mins = round.delayMinutes % 60;
        timeStr = '+' + (hours > 0 ? hours + 'h ' : '') + (mins > 0 ? mins + 'm' : '') + ' after R' + (round.roundNum - 1);
      } else {
        timeStr = round.time + ' (' + round.timezone.split('/').pop().replace('_', ' ') + ')';
        if (round.daysFromNow > 0) timeStr += ' +' + round.daysFromNow + 'd';
      }
      message += emoji + ' Round ' + round.roundNum + ': ' + timeStr + '\n';
    });
  }
  
  return message;
}

/**
 * Calculate specific time in a timezone
 */
function calculateSpecificTime_(timeStr, timezone, daysFromNow) {
  const parts = timeStr.split(':');
  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  
  const now = new Date();
  const targetDate = new Date(now.getTime() + (daysFromNow || 0) * 24 * 60 * 60 * 1000);
  const dateStr = Utilities.formatDate(targetDate, timezone, 'yyyy-MM-dd');
  const timeString = dateStr + 'T' + String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':00';
  
  const formatted = Utilities.formatDate(
    Utilities.parseDate(timeString, timezone, "yyyy-MM-dd'T'HH:mm:ss"),
    'UTC',
    "yyyy-MM-dd'T'HH:mm:ss'Z'"
  );
  
  return new Date(formatted);
}

/**
 * Creates a trigger to monitor multi-round campaigns
 */
function createMultiRoundMonitorTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(function(t) { return t.getHandlerFunction() === 'checkAndStartNextRound_'; });
  if (!exists) {
    ScriptApp.newTrigger('checkAndStartNextRound_').timeBased().everyMinutes(1).create();
  }
}

/**
 * Checks all multi-round campaigns and starts next rounds when ready
 */
/**
 * Checks all multi-round campaigns and starts next rounds when ready
 */
function checkAndStartNextRound_() {
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  let hasActiveCampaigns = false;
  
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      
      // Skip completed campaigns
      if (config.currentRound > config.totalRounds) continue;
      if (!config.rounds || config.rounds.length === 0) continue;
      
      hasActiveCampaigns = true;
      
      // Check if current round is complete
      if (!isMultiRoundComplete_(config)) continue;
      
      // Mark current round as complete
      if (!config['round' + config.currentRound + 'CompletedAt']) {
        config['round' + config.currentRound + 'CompletedAt'] = new Date().toISOString();
        sp.setProperty(key, JSON.stringify(config));
        Logger.log('Round ' + config.currentRound + ' completed for batch: ' + config.batchId);
        
        // Update status in sheet
        updateMultiRoundStatusInSheet_(config, '✅ Round ' + config.currentRound + '/' + config.totalRounds + ' complete');
      }
      
      // Find next round
      const nextRoundIdx = config.currentRound - 1; // rounds array is 0-indexed for rounds 2+
      if (nextRoundIdx >= config.rounds.length) continue;
      
      const nextRound = config.rounds[nextRoundIdx];
      let shouldStart = false;
      let nextRoundTime = null;
      
      if (nextRound.type === 'delay') {
        const prevCompletedAt = new Date(config['round' + config.currentRound + 'CompletedAt']);
        nextRoundTime = new Date(prevCompletedAt.getTime() + nextRound.delayMinutes * 60 * 1000);
        shouldStart = new Date() >= nextRoundTime;
        
        if (!shouldStart) {
          // Update sheet with countdown
          const minsLeft = Math.round((nextRoundTime - new Date()) / 60000);
          updateMultiRoundNextAtInSheet_(config, 'R' + nextRound.roundNum + ' in ' + minsLeft + ' min');
          Logger.log('Round ' + nextRound.roundNum + ' waiting. ' + minsLeft + ' min left');
        }
      } else if (nextRound.type === 'specific') {
        nextRoundTime = new Date(nextRound.scheduledAt);
        shouldStart = new Date() >= nextRoundTime;
        
        if (!shouldStart) {
          updateMultiRoundNextAtInSheet_(config, 'R' + nextRound.roundNum + ': ' + Utilities.formatDate(nextRoundTime, Session.getScriptTimeZone(), 'MMM d HH:mm'));
          Logger.log('Round ' + nextRound.roundNum + ' waiting for specific time: ' + nextRoundTime);
        }
      }
      
      if (shouldStart) {
        Logger.log('Starting round ' + nextRound.roundNum + ' for batch: ' + config.batchId);
        
        // Update status before starting
        updateMultiRoundStatusInSheet_(config, '🚀 Starting Round ' + nextRound.roundNum + '/' + config.totalRounds + '...');
        
        startMultiRoundAutomatically_(config, nextRound);
        
        config.currentRound = nextRound.roundNum;
        config['round' + nextRound.roundNum + 'StartedAt'] = new Date().toISOString();
        sp.setProperty(key, JSON.stringify(config));
        
        // Update status after starting
        updateMultiRoundStatusInSheet_(config, '🔄 Round ' + nextRound.roundNum + '/' + config.totalRounds + ' in progress');
        
        // Update next round info
        if (nextRoundIdx + 1 < config.rounds.length) {
          const followingRound = config.rounds[nextRoundIdx + 1];
          if (followingRound.type === 'delay') {
            updateMultiRoundNextAtInSheet_(config, 'R' + followingRound.roundNum + ': +' + followingRound.delayMinutes + ' min after R' + nextRound.roundNum);
          } else {
            const followingTime = new Date(followingRound.scheduledAt);
            updateMultiRoundNextAtInSheet_(config, 'R' + followingRound.roundNum + ': ' + Utilities.formatDate(followingTime, Session.getScriptTimeZone(), 'MMM d HH:mm'));
          }
        } else {
          updateMultiRoundNextAtInSheet_(config, 'Final round in progress');
        }
      }
      
    } catch (e) {
      Logger.log('Error processing multi-round config: ' + e.message);
    }
  }
  
  // Check if all campaigns are complete
  let allComplete = true;
  const updatedProps = sp.getProperties();
  for (const k in updatedProps) {
    if (!k.startsWith('MULTI_ROUND_')) continue;
    try {
      const c = JSON.parse(updatedProps[k]);
      if (c.currentRound <= c.totalRounds && c.rounds && c.rounds.length > 0) {
        // Check if final round is complete
        if (!isMultiRoundComplete_(c)) {
          allComplete = false;
          break;
        } else if (c.currentRound < c.totalRounds) {
          allComplete = false;
          break;
        } else {
          // Final round complete - mark campaign as done
          c.currentRound = c.totalRounds + 1;
          sp.setProperty(k, JSON.stringify(c));
          updateMultiRoundStatusInSheet_(c, '✅ Campaign complete (' + c.totalRounds + ' rounds)');
          updateMultiRoundNextAtInSheet_(c, 'All rounds finished');
        }
      }
    } catch (e) {}
  }
  
  // Clean up trigger if no active campaigns
  if (!hasActiveCampaigns || allComplete) {
    deleteTriggersByHandler_('checkAndStartNextRound_');
  }
}

/**
 * Updates the campaign_status column for all rows in a batch
 */
function updateMultiRoundStatusInSheet_(config, statusText) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id) return;
    
    // Add campaign_status column if it doesn't exist
    if (!cols.campaign_status) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue('campaign_status');
      cols.campaign_status = newCol;
    }
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return;
    
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const rowBatchId = String(data[i][cols.batch_id - 1] || '').trim();
      
      // Match any round of this batch
      if (rowBatchId.startsWith(config.batchId)) {
        data[i][cols.campaign_status - 1] = statusText;
      }
    }
    
    sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
    SpreadsheetApp.flush();
  } catch (e) {
    Logger.log('Error updating multi-round status: ' + e.message);
  }
}

/**
 * Updates the next_round_at column for all rows in a batch
 */
/**
 * Updates the next_round_at column for all rows in a batch
 * Respects skip status - rows that should be skipped show "To be Skipped"
 */
function updateMultiRoundNextAtInSheet_(config, nextAtText) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id) return;
    
    // Add next_round_at column if it doesn't exist
    if (!cols.next_round_at) {
      const newCol = sh.getLastColumn() + 1;
      sh.getRange(HEADER_ROW_INDEX, newCol).setValue('next_round_at');
      cols.next_round_at = newCol;
    }
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return;
    
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const rowBatchId = String(data[i][cols.batch_id - 1] || '').trim();
      
      // Match any round of this batch
      if (rowBatchId.startsWith(config.batchId)) {
        // Check if this row should be skipped based on current status
        const currentStatus = cols.status ? String(data[i][cols.status - 1] || '').trim() : '';
        const baseStatus = getBaseStatus_(currentStatus);
        
        if (shouldSkipStatus_(baseStatus)) {
          data[i][cols.next_round_at - 1] = '⏭️ To be Skipped';
        } else {
          data[i][cols.next_round_at - 1] = nextAtText;
        }
      }
    }
    
    sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
    SpreadsheetApp.flush();
  } catch (e) {
    Logger.log('Error updating next_round_at: ' + e.message);
  }
}

/**
 * Checks if a round is complete
 */
function isMultiRoundComplete_(config) {
  try {
    const ss = SpreadsheetApp.openById(config.sheetId);
    const sh = ss.getSheetByName(config.sheetName);
    if (!sh) return false;
    
    const cols = getHeaderMap_(sh);
    if (!cols.batch_id || !cols.status) return false;
    
    const lastRow = sh.getLastRow();
    if (lastRow <= HEADER_ROW_INDEX) return false;
    
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, sh.getLastColumn()).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const rowBatchId = String(data[i][cols.batch_id - 1] || '').trim();
      
      // Check if this row belongs to current round of this batch
      const expectedBatchId = config.currentRound === 1 ? config.batchId : config.batchId + '_R' + config.currentRound;
      if (!rowBatchId.startsWith(config.batchId)) continue;
      
      const status = String(data[i][cols.status - 1] || '').trim().toLowerCase();
      if (status === 'queued' || status === 'calling' || status === 'calling...') {
        return false;
      }
    }
    
    return true;
  } catch (e) {
    Logger.log('Error checking round completion: ' + e.message);
    return false;
  }
}

/**
 * Starts a round automatically
 */
/**
 * Starts a round automatically
 */
function startMultiRoundAutomatically_(config, round) {
  const ss = SpreadsheetApp.openById(config.sheetId);
  const sh = ss.getSheetByName(config.sheetName);
  if (!sh) return;
  
  const cols = getHeaderMap_(sh);
  if (!cols.batch_id || !cols.status) return;
  
  const lastRow = sh.getLastRow();
  if (lastRow <= HEADER_ROW_INDEX) return;
  
  const lastCol = sh.getLastColumn();
  const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
  
  const sp = PropertiesService.getScriptProperties();
  const roundSuffix = getRoundSuffix_(round.roundNum);
  
  const fieldsToClear = ['call_id', 'started_at', 'ended_at', 'transcript', 'outcome_summary', 'recording_url', 
                         'callback_flag', 'callback_when', 'scheduled_at', 'scheduled_in_min',
                         'auto_followup_status', 'auto_followup_preview'];
  
  const rowsToCall = [];
  
  Logger.log('Processing round ' + round.roundNum + ' for batch ' + config.batchId);
  Logger.log('Looking for statuses: ' + JSON.stringify(round.statuses));
  
  for (let i = 0; i < data.length; i++) {
    const rowNum = HEADER_ROW_INDEX + 1 + i;
    const row = data[i];
    const rowBatchId = String(row[cols.batch_id - 1] || '').trim();
    
    // Only process rows from this batch
    if (!rowBatchId.startsWith(config.batchId)) continue;
    
    const currentStatus = String(row[cols.status - 1] || '').trim();
    const baseStatus = getBaseStatus_(currentStatus).toLowerCase();
    
    // Check if should skip (already spoke to human, etc.)
    const shouldSkip = DO_NOT_CALL_AGAIN_STATUSES.some(function(s) {
      return baseStatus.includes(s);
    });
    
    if (shouldSkip) {
      data[i][cols.status - 1] = '⏭️ Skipped' + roundSuffix + ' (' + currentStatus + ')';
      Logger.log('Row ' + rowNum + ' skipped: ' + currentStatus);
      continue;
    }
    
    // Check if status matches retry criteria
    const shouldCall = round.statuses.some(function(s) {
      return baseStatus.includes(s.toLowerCase());
    });
    
    // Also check callback flag
    const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag - 1] || '').trim().toUpperCase() : '';
    const callbackRequested = (callbackFlag === 'TRUE') && round.statuses.includes('callback');
    
    if (shouldCall || callbackRequested) {
      // Prepare for calling
      data[i][cols.status - 1] = 'Queued';
      data[i][cols.batch_id - 1] = config.batchId + '_R' + round.roundNum;
      
      // Increment call_attempt
      if (cols.call_attempt) {
        const currentAttempt = Number(data[i][cols.call_attempt - 1] || 0);
        data[i][cols.call_attempt - 1] = currentAttempt + 1;
      }
      
      // Use retry assistant for voicemail callbacks, or keep original assistant
      if (cols.assistant) {
        if (config.retryAssistant && baseStatus.includes('voicemail')) {
          data[i][cols.assistant - 1] = config.retryAssistant;
        } else if (config.assistant) {
          data[i][cols.assistant - 1] = config.assistant;
        }
      }
      
      // Keep using the same phone number from config
      if (cols.vapi_number && config.phoneNumber) {
        data[i][cols.vapi_number - 1] = config.phoneNumber;
      }
      
      // Clear call fields
      fieldsToClear.forEach(function(field) {
        if (cols[field]) data[i][cols[field] - 1] = '';
      });
      
      rowsToCall.push(rowNum);
      Logger.log('Row ' + rowNum + ' queued for round ' + round.roundNum);
    } else {
      data[i][cols.status - 1] = '⏭️ Skipped' + roundSuffix + ' (' + currentStatus + ')';
      Logger.log('Row ' + rowNum + ' skipped (no match): ' + currentStatus);
    }
  }
  
  // Write data back
  sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
  SpreadsheetApp.flush();
  
  Logger.log('Round ' + round.roundNum + ': ' + rowsToCall.length + ' rows to call');
  
  if (rowsToCall.length === 0) {
    Logger.log('No rows to call for round ' + round.roundNum);
    return;
  }
  
  // Queue the rows
  const qKey = queueKey_(config.sheetId, config.sheetName);
  let queue = loadJson_(sp, qKey, []);
  rowsToCall.forEach(function(rowNum) {
    if (queue.indexOf(rowNum) === -1) queue.push(rowNum);
  });
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));
  
  // Set concurrency
  sp.setProperty(concurrencyKey_(config.sheetId, config.sheetName), String(config.concurrency));
  
  // Start processing
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (apiKey) {
    processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), config.concurrency);
  }
  
  Logger.log('Started round ' + round.roundNum + ' with ' + rowsToCall.length + ' calls');
}
/**
 * View scheduled multi-round campaigns
 */
function vapiViewMultiRoundCampaigns() {
  const ui = SpreadsheetApp.getUi();
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  
  const campaigns = [];
  
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      let status = '';
      
      if (config.currentRound > config.totalRounds) {
        status = '✅ Completed';
      } else if (config.currentRound === 1 && !config.round1CompletedAt) {
        status = '🔄 Round 1 in progress';
      } else {
        status = '⏳ Waiting for Round ' + (config.currentRound + 1);
      }
      
      campaigns.push({
        batchId: config.batchId,
        sheetName: config.sheetName,
        currentRound: config.currentRound,
        totalRounds: config.totalRounds,
        status: status
      });
    } catch (e) {}
  }
  
  if (campaigns.length === 0) {
    ui.alert('No multi-round campaigns found.');
    return;
  }
  
  let message = '=== MULTI-ROUND CAMPAIGNS ===\n\n';
  campaigns.forEach(function(c) {
    message += '📋 ' + c.batchId + '\n';
    message += '   Sheet: ' + c.sheetName + '\n';
    message += '   Progress: Round ' + c.currentRound + '/' + c.totalRounds + '\n';
    message += '   Status: ' + c.status + '\n\n';
  });
  
  ui.alert(message);
}

/**
 * Cancel a multi-round campaign
 */
function vapiCancelMultiRoundCampaign() {
  const ui = SpreadsheetApp.getUi();
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  
  const campaigns = [];
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    try {
      const config = JSON.parse(allProps[key]);
      if (config.currentRound <= config.totalRounds) {
        campaigns.push({ key: key, batchId: config.batchId });
      }
    } catch (e) {}
  }
  
  if (campaigns.length === 0) {
    ui.alert('No active multi-round campaigns to cancel.');
    return;
  }
  
  const response = ui.prompt(
    'Cancel Multi-Round Campaign',
    'Enter batch ID to cancel:\n\n' + campaigns.map(function(c) { return '• ' + c.batchId; }).join('\n'),
    ui.ButtonSet.OK_CANCEL
  );
  
  if (response.getSelectedButton() !== ui.Button.OK) return;
  
  const batchIdToCancel = response.getResponseText().trim();
  const campaign = campaigns.find(function(c) { return c.batchId === batchIdToCancel; });
  
  if (!campaign) {
    ui.alert('Batch ID not found: ' + batchIdToCancel);
    return;
  }
  
  sp.deleteProperty(campaign.key);
  sp.deleteProperty('BATCH_AUTOSORT_' + batchIdToCancel);
  
  ui.alert('✅ Cancelled multi-round campaign: ' + batchIdToCancel);
}
function debugHeaders() {
  const sh = SpreadsheetApp.getActiveSheet();
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  
  Logger.log('=== RAW HEADERS IN ROW 1 ===');
  headers.forEach(function(h, i) {
    const raw = String(h || '');
    const cleaned = raw.toLowerCase().replace(/\n+/g, ' ').replace(/_/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
    Logger.log('Column ' + (i + 1) + ': "' + raw + '" → cleaned: "' + cleaned + '"');
  });
  
  Logger.log('');
  Logger.log('=== HEADER MAP RESULT ===');
  const cols = getHeaderMap_(sh);
  Object.keys(cols).sort().forEach(function(key) {
    Logger.log(key + ': column ' + cols[key]);
  });
  
  Logger.log('');
  Logger.log('=== CHECKING KEY COLUMNS ===');
  const keyCols = ['prospect_name', 'phone', 'status', 'call_id'];
  keyCols.forEach(function(key) {
    const aliases = HEADER_ALIASES[key] || [];
    Logger.log(key + ' aliases: ' + JSON.stringify(aliases));
    Logger.log('  → Found at column: ' + (cols[key] || 'NOT FOUND'));
  });
}
function countCells() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let totalCells = 0;
  
  ss.getSheets().forEach(function(sheet) {
    const rows = sheet.getMaxRows();
    const cols = sheet.getMaxColumns();
    const cells = rows * cols;
    totalCells += cells;
    Logger.log(sheet.getName() + ': ' + rows + ' rows × ' + cols + ' cols = ' + cells.toLocaleString() + ' cells');
  });
  
  Logger.log('');
  Logger.log('TOTAL: ' + totalCells.toLocaleString() + ' cells');
  Logger.log('Limit: 10,000,000 cells');
  Logger.log('Used: ' + (totalCells / 10000000 * 100).toFixed(1) + '%');
}

// ============================================================
// FOLLOW-UP TEMPLATE MANAGEMENT
// ============================================================

/**
 * Gets all data needed for the follow-up wizard
 */
function getFollowupWizardData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const currentSheet = ss.getActiveSheet().getName();
  
  // Get all sheet names (excluding system sheets)
  const sheets = ss.getSheets()
    .map(function(s) { return s.getName(); })
    .filter(function(name) { return !name.startsWith('_'); });
  
  // Get saved templates
  const sp = PropertiesService.getScriptProperties();
  const templates = {};
  const allProps = sp.getProperties();
  
  for (const key in allProps) {
    if (key.startsWith('FOLLOWUP_TEMPLATE__')) {
      const sheetName = key.replace('FOLLOWUP_TEMPLATE__', '');
      try {
        templates[sheetName] = JSON.parse(allProps[key]);
      } catch (e) {}
    }
  }
  
  // Get preview data
  const preview = getBothWizardPreview();
  
  return {
    preview: preview,
    sheets: sheets,
    templates: templates,
    currentSheet: currentSheet
  };
}

/**
 * Saves a follow-up template for a specific sheet/campaign
 */
function saveFollowupTemplate(sheetName, template) {
  if (!sheetName) throw new Error('Sheet name is required');
  if (!template) throw new Error('Template is required');
  
  const sp = PropertiesService.getScriptProperties();
  const key = 'FOLLOWUP_TEMPLATE__' + sheetName;
  
  sp.setProperty(key, JSON.stringify(template));
  
  return { success: true };
}

/**
 * Deletes a follow-up template
 */
function deleteFollowupTemplate(sheetName) {
  if (!sheetName) throw new Error('Sheet name is required');
  
  const sp = PropertiesService.getScriptProperties();
  const key = 'FOLLOWUP_TEMPLATE__' + sheetName;
  
  sp.deleteProperty(key);
  
  return { success: true };
}

/**
 * Opens the unified follow-up wizard
 */
function openFollowupWizard() {
  const html = HtmlService.createHtmlOutputFromFile("EmailWizard").setWidth(580).setHeight(880);
  SpreadsheetApp.getUi().showModalDialog(html, "📧💬 Follow-up Wizard");
}

/**
 * Checks if a status should be skipped in future rounds
 */
function shouldSkipStatus_(status) {
  const s = String(status || '').toLowerCase();
  return DO_NOT_CALL_AGAIN_STATUSES.some(function(skipStatus) {
    return s.includes(skipStatus);
  });
}
// ============================================================
// DEBUG FUNCTIONS - Add these to your VAPI script
// ============================================================

/**
 * Debug function to check which assistant will be used for each round
 * Run this from the Script Editor to see the configuration
 */
function debugMultiRoundAssistants() {
  const sp = PropertiesService.getScriptProperties();
  const sh = SpreadsheetApp.getActiveSheet();
  const sheetName = sh.getName();
  const cols = getHeaderMap_(sh);
  
  Logger.log('========================================');
  Logger.log('DEBUG: Multi-Round Assistant Configuration');
  Logger.log('========================================');
  Logger.log('Current Sheet: ' + sheetName);
  Logger.log('');
  
  // Check for MULTI_ROUND_ configs
  const allProps = sp.getProperties();
  let foundConfigs = 0;
  
  for (const key in allProps) {
    if (!key.startsWith('MULTI_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      
      if (config.sheetName === sheetName) {
        foundConfigs++;
        Logger.log('--- Campaign: ' + config.batchId + ' ---');
        Logger.log('  Status: Round ' + config.currentRound + ' of ' + config.totalRounds);
        Logger.log('  Round 1 Assistant: ' + (config.assistant || 'NOT SET'));
        Logger.log('  Retry Assistant: ' + (config.retryAssistant || 'SAME AS ROUND 1'));
        Logger.log('  Phone Number: ' + (config.phoneNumber || 'NOT SET'));
        Logger.log('  Concurrency: ' + (config.concurrency || 'NOT SET'));
        Logger.log('  Auto Sort: ' + (config.autoSort !== false ? 'YES' : 'NO'));
        Logger.log('');
        
        if (config.rounds && config.rounds.length > 0) {
          Logger.log('  Scheduled Rounds:');
          config.rounds.forEach(function(round, idx) {
            let timing = '';
            if (round.type === 'delay') {
              timing = '+' + round.delayMinutes + ' min after previous round';
            } else {
              timing = round.time + ' (' + round.timezone + ') +' + round.daysFromNow + ' days';
            }
            Logger.log('    Round ' + round.roundNum + ': ' + timing);
            Logger.log('      Statuses to retry: ' + (round.statuses ? round.statuses.join(', ') : 'voicemail, no answer'));
          });
        }
        Logger.log('');
      }
    } catch (e) {
      Logger.log('Error parsing config ' + key + ': ' + e.message);
    }
  }
  
  // Also check SECOND_ROUND_ configs (old system)
  for (const key in allProps) {
    if (!key.startsWith('SECOND_ROUND_')) continue;
    
    try {
      const config = JSON.parse(allProps[key]);
      
      if (config.sheetName === sheetName) {
        foundConfigs++;
        Logger.log('--- [OLD SYSTEM] Campaign: ' + config.batchId + ' ---');
        Logger.log('  Status: ' + config.status);
        Logger.log('  Voicemail Assistant: ' + (config.voicemailAssistant || 'SAME AS ROUND 1'));
        Logger.log('  Delay: ' + config.delayMinutes + ' minutes');
        Logger.log('  Statuses to retry: ' + (config.statuses ? config.statuses.join(', ') : 'NOT SET'));
        Logger.log('');
      }
    } catch (e) {}
  }
  
  if (foundConfigs === 0) {
    Logger.log('No active campaigns found for this sheet.');
    Logger.log('');
  }
  
  // Check what's in the sheet rows
  Logger.log('========================================');
  Logger.log('DEBUG: Sample Row Data (first 5 data rows)');
  Logger.log('========================================');
  
  const lastRow = Math.min(sh.getLastRow(), HEADER_ROW_INDEX + 5);
  if (lastRow > HEADER_ROW_INDEX) {
    const lastCol = sh.getLastColumn();
    const data = sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).getValues();
    
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const rowNum = HEADER_ROW_INDEX + 1 + i;
      
      Logger.log('Row ' + rowNum + ':');
      Logger.log('  Batch ID: ' + (cols.batch_id ? row[cols.batch_id - 1] : 'NO COLUMN'));
      Logger.log('  Status: ' + (cols.status ? row[cols.status - 1] : 'NO COLUMN'));
      Logger.log('  Assistant: ' + (cols.assistant ? row[cols.assistant - 1] : 'NO COLUMN'));
      Logger.log('  Vapi Number: ' + (cols.vapi_number ? row[cols.vapi_number - 1] : 'NO COLUMN'));
      Logger.log('  Call Attempt: ' + (cols.call_attempt ? row[cols.call_attempt - 1] : 'NO COLUMN'));
      Logger.log('  Voicemail Count: ' + (cols.voicemail_left_count ? row[cols.voicemail_left_count - 1] : 'NO COLUMN'));
      Logger.log('  leave_voicemail would be: ' + (cols.voicemail_left_count && Number(row[cols.voicemail_left_count - 1] || 0) >= 1 ? 'NO' : 'YES'));
      Logger.log('');
    }
  }
  
  // Show what assistant IDs are available
  Logger.log('========================================');
  Logger.log('DEBUG: Available Assistants');
  Logger.log('========================================');
  
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const assistantSheet = ss.getSheetByName('_VapiAssistants');
  
  if (assistantSheet) {
    const assistantData = assistantSheet.getDataRange().getValues();
    for (let i = 1; i < assistantData.length; i++) {
      const name = assistantData[i][0];
      const id = assistantData[i][1];
      Logger.log('  ' + name + ' → ' + id);
    }
  } else {
    Logger.log('  No _VapiAssistants sheet found!');
  }
  
  Logger.log('');
  Logger.log('========================================');
  Logger.log('DEBUG COMPLETE - Check the Logs above');
  Logger.log('========================================');
}

/**
 * Debug function to simulate what would happen for a specific row on retry
 */
function debugRowRetryConfig() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getActiveRange();
  
  if (!range) {
    ui.alert('Please select a row first');
    return;
  }
  
  const rowNum = range.getRow();
  if (rowNum <= 1) {
    ui.alert('Please select a data row (not the header)');
    return;
  }
  
  const cols = getHeaderMap_(sh);
  const lastCol = sh.getLastColumn();
  const rowData = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  const sp = PropertiesService.getScriptProperties();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Get batch ID
  const batchId = cols.batch_id ? String(rowData[cols.batch_id - 1] || '').trim() : '';
  const baseBatchId = batchId.replace(/_R\d+$/, '');
  
  // Get current values
  const currentAssistant = cols.assistant ? String(rowData[cols.assistant - 1] || '').trim() : '';
  const currentStatus = cols.status ? String(rowData[cols.status - 1] || '').trim() : '';
  const voicemailCount = cols.voicemail_left_count ? Number(rowData[cols.voicemail_left_count - 1] || 0) : 0;
  const callAttempt = cols.call_attempt ? Number(rowData[cols.call_attempt - 1] || 0) : 0;
  
  // Find config
  let config = null;
  const multiRoundKey = 'MULTI_ROUND_' + baseBatchId;
  const secondRoundKey = 'SECOND_ROUND_' + baseBatchId;
  
  const multiRoundConfig = sp.getProperty(multiRoundKey);
  const secondRoundConfig = sp.getProperty(secondRoundKey);
  
  if (multiRoundConfig) {
    config = JSON.parse(multiRoundConfig);
  } else if (secondRoundConfig) {
    config = JSON.parse(secondRoundConfig);
  }
  
  // Determine what assistant would be used
  let nextAssistant = currentAssistant;
  let reason = 'No config found, would use current assistant from column';
  
  if (config) {
    if (config.retryAssistant) {
      // Check if status is voicemail
      if (currentStatus.toLowerCase().includes('voicemail')) {
        nextAssistant = config.retryAssistant;
        reason = 'Status is Voicemail → Using retryAssistant from config';
      } else {
        nextAssistant = config.assistant || currentAssistant;
        reason = 'Status is NOT Voicemail → Using main assistant from config';
      }
    } else if (config.voicemailAssistant) {
      // Old system
      if (currentStatus.toLowerCase().includes('voicemail')) {
        nextAssistant = config.voicemailAssistant;
        reason = 'Status is Voicemail → Using voicemailAssistant from config (old system)';
      } else {
        nextAssistant = currentAssistant;
        reason = 'Status is NOT Voicemail → Using current assistant';
      }
    } else {
      nextAssistant = config.assistant || currentAssistant;
      reason = 'No retry assistant configured → Using main assistant';
    }
  }
  
  // Build message
  let msg = '=== ROW ' + rowNum + ' RETRY DEBUG ===\n\n';
  msg += 'CURRENT STATE:\n';
  msg += '• Batch ID: ' + (batchId || '(none)') + '\n';
  msg += '• Status: ' + (currentStatus || '(empty)') + '\n';
  msg += '• Current Assistant: ' + (currentAssistant || '(empty)') + '\n';
  msg += '• Call Attempt: ' + callAttempt + '\n';
  msg += '• Voicemail Count: ' + voicemailCount + '\n';
  msg += '• leave_voicemail would be: ' + (voicemailCount >= 1 ? 'NO' : 'YES') + '\n\n';
  
  msg += 'CONFIG FOUND:\n';
  if (config) {
    msg += '• Config Key: ' + (multiRoundConfig ? multiRoundKey : secondRoundKey) + '\n';
    msg += '• Main Assistant: ' + (config.assistant || '(not set)') + '\n';
    msg += '• Retry/Voicemail Assistant: ' + (config.retryAssistant || config.voicemailAssistant || '(not set)') + '\n';
  } else {
    msg += '• No campaign config found for batch: ' + baseBatchId + '\n';
  }
  
  msg += '\nON NEXT RETRY:\n';
  msg += '• Assistant that WOULD be used: ' + nextAssistant + '\n';
  msg += '• Reason: ' + reason + '\n';
  
  // Resolve to ID
  const assistantId = resolveAssistantIdFromName_(ss, nextAssistant, sp.getProperty('VAPI_ASSISTANT_ID'));
  msg += '• Resolved Assistant ID: ' + (assistantId || 'COULD NOT RESOLVE!') + '\n';
  
  ui.alert(msg);
}

/**
 * Debug: Show all active campaign configs
 */
function debugShowAllCampaignConfigs() {
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  
  Logger.log('========================================');
  Logger.log('ALL CAMPAIGN CONFIGURATIONS');
  Logger.log('========================================');
  
  let count = 0;
  
  for (const key in allProps) {
    if (key.startsWith('MULTI_ROUND_') || key.startsWith('SECOND_ROUND_')) {
      count++;
      Logger.log('');
      Logger.log('KEY: ' + key);
      try {
        const config = JSON.parse(allProps[key]);
        Logger.log(JSON.stringify(config, null, 2));
      } catch (e) {
        Logger.log('ERROR parsing: ' + e.message);
        Logger.log('Raw value: ' + allProps[key]);
      }
    }
  }
  
  if (count === 0) {
    Logger.log('No campaign configurations found.');
  }
  
  Logger.log('');
  Logger.log('Total configs: ' + count);
}

/**
 * Debug: Test what leave_voicemail value would be sent for a row
 */
function debugLeaveVoicemailValue() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const range = sh.getActiveRange();
  
  if (!range) {
    ui.alert('Please select a row first');
    return;
  }
  
  const rowNum = range.getRow();
  if (rowNum <= 1) {
    ui.alert('Please select a data row');
    return;
  }
  
  const cols = getHeaderMap_(sh);
  const lastCol = sh.getLastColumn();
  const rowData = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];
  
  const voicemailCount = cols.voicemail_left_count ? Number(rowData[cols.voicemail_left_count - 1] || 0) : 0;
  const leaveVoicemail = voicemailCount >= 1 ? 'no' : 'yes';
  
  let msg = '=== LEAVE_VOICEMAIL DEBUG ===\n\n';
  msg += 'Row: ' + rowNum + '\n';
  msg += 'voicemail_left_count column value: ' + (cols.voicemail_left_count ? rowData[cols.voicemail_left_count - 1] : 'NO COLUMN') + '\n';
  msg += 'Parsed as number: ' + voicemailCount + '\n';
  msg += '\n';
  msg += '→ leave_voicemail would be: "' + leaveVoicemail + '"\n';
  msg += '\n';
  msg += 'This means:\n';
  if (leaveVoicemail === 'yes') {
    msg += '• AI WILL leave a voicemail if it reaches one\n';
    msg += '• This is typically the FIRST call attempt';
  } else {
    msg += '• AI should NOT leave a voicemail (hang up immediately)\n';
    msg += '• This is a RETRY call (voicemail already left before)';
  }
  
  ui.alert(msg);
}
function emergencyUnstick() {
  const sp = PropertiesService.getScriptProperties();
  const sh = SpreadsheetApp.getActiveSheet();
  const sheetName = sh.getName();
  const sheetId = sp.getProperty('SHEET_ID');
  
  // Clear queue and active
  sp.deleteProperty(queueKey_(sheetId, sheetName));
  sp.deleteProperty(activeKey_(sheetId, sheetName));
  sp.deleteProperty(processingKey_(sheetId, sheetName));
  
  // Fix any stuck "Calling..." rows
  const cols = getHeaderMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow > 1 && cols.status) {
    const statuses = sh.getRange(2, cols.status, lastRow - 1, 1).getValues();
    for (let i = 0; i < statuses.length; i++) {
      if (String(statuses[i][0]).trim() === 'Calling...') {
        statuses[i][0] = 'Error - Stuck';
      }
    }
    sh.getRange(2, cols.status, lastRow - 1, 1).setValues(statuses);
  }
  
  updateStatus_({ 'Script Status': '⚪ Idle', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName);
  SpreadsheetApp.getUi().alert('✅ Unstuck! Queue cleared.');
}

/**
 * Watchdog: checks every 2 minutes if campaign is stuck and resumes it
 */
function vapiWatchdog_() {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  if (!sheetId) return;
  
  const ss = SpreadsheetApp.openById(sheetId);
  const sheets = ss.getSheets();
  
  for (const sh of sheets) {
    const sheetName = sh.getName();
    if (sheetName.startsWith('_')) continue; // skip helper sheets
    
    const qKey = queueKey_(sheetId, sheetName);
    const aKey = activeKey_(sheetId, sheetName);
    const queue = loadJson_(sp, qKey, []);
    let active = loadJson_(sp, aKey, {});
    
    // Skip if nothing to do
    if (queue.length === 0 && Object.keys(active).length === 0) continue;
    
    // Clean stale active calls (older than 10 minutes)
    const cols = getHeaderMap_(sh);
    const now = Date.now();
    let cleaned = false;
    
    for (const [callId, rowNum] of Object.entries(active)) {
      try {
        const r = Number(rowNum);
        if (!r || r <= HEADER_ROW_INDEX) { delete active[callId]; cleaned = true; continue; }
        
        const startedAt = cols.started_at ? sh.getRange(r, cols.started_at).getValue() : null;
        const status = cols.status ? String(sh.getRange(r, cols.status).getValue()).trim() : '';
        
        // If call started more than 10 min ago and still "Calling...", it's stuck
        if (startedAt instanceof Date && (now - startedAt.getTime()) > 350000 && status === 'Calling...') {
          sh.getRange(r, cols.status).setValue('Auto-cleared (stale)');
          delete active[callId];
          cleaned = true;
        }
        
        // If status is no longer "Calling..." (webhook already processed it), remove from active
        if (status !== 'Calling...' && status !== '') {
          delete active[callId];
          cleaned = true;
        }
      } catch (e) {
        delete active[callId];
        cleaned = true;
      }
    }
    
    if (cleaned) {
      sp.setProperty(aKey, JSON.stringify(active));
    }
    
    // If there's queue and room for more calls, resume processing
    const concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 1);
    
    if (queue.length > 0 && Object.keys(active).length < concurrency) {
      const apiKey = sp.getProperty('VAPI_API_KEY');
      if (apiKey) {
        updateStatus_({ 'Script Status': '🔄 Watchdog resuming...', 'Heartbeat': new Date().toLocaleTimeString() }, sheetName);
        processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
      }
    }
    
    // If everything is done, mark complete and remove watchdog
    if (queue.length === 0 && Object.keys(active).length === 0) {
        updateStatus_({ 'Script Status': '✅ Complete', 'Active Calls': '', 'Queued Rows': 'Completed', 'Concurrency': '', 'Last Updated': '' }, sheetName);
      sp.deleteProperty(processingKey_(sheetId, sheetName));
      removeWatchdog_();
      autoSortIfBatchComplete_(sheetId, sheetName);
      removeWatchdog_();
    }
  }
}

/** Start the watchdog trigger (runs every 2 minutes) */
function startWatchdog_() {
  removeWatchdog_(); // clear any existing one first
  ScriptApp.newTrigger('vapiWatchdog_')
    .timeBased()
    .everyMinutes(1)
    .create();
}

/** Remove the watchdog trigger */
function removeWatchdog_() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'vapiWatchdog_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}
// ============================================================
// DAILY BUDGET TRACKING
// ============================================================

const DAILY_BUDGET_USD = 100;

function getDailySpendKey_() {
  return 'DAILY_SPEND_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function getDailySpend_() {
  return Number(PropertiesService.getScriptProperties().getProperty(getDailySpendKey_()) || 0);
}

function addToDailySpend_(amount) {
  var sp = PropertiesService.getScriptProperties();
  var current = Number(sp.getProperty(getDailySpendKey_()) || 0);
  sp.setProperty(getDailySpendKey_(), String(current + amount));
}

function isUnderBudget_() {
  const spent = getDailySpend_();
  const budget = DAILY_BUDGET_USD;
  
  // Check if we've hit the hard limit
  if (spent >= budget) {
    return false;
  }
  
  // Check if we've hit warning thresholds and should alert
  const percentUsed = (spent / budget) * 100;
  
  if (percentUsed >= 80 && percentUsed < 90) {
    // 80% warning - only show once
    const sp = PropertiesService.getScriptProperties();
    const todayKey = 'BUDGET_WARNING_80_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (!sp.getProperty(todayKey)) {
      sp.setProperty(todayKey, 'true');
      showBudgetWarning_(80, spent, budget);
    }
  } else if (percentUsed >= 90) {
    // 90% warning - only show once
    const sp = PropertiesService.getScriptProperties();
    const todayKey = 'BUDGET_WARNING_90_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (!sp.getProperty(todayKey)) {
      sp.setProperty(todayKey, 'true');
      showBudgetWarning_(90, spent, budget);
    }
  }
  
  return true;
}

function showBudgetWarning_(threshold, spent, budget) {
  const remaining = budget - spent;
  const percentUsed = (spent / budget) * 100;
  
  let emoji = '⚠️';
  let urgency = 'WARNING';
  let color = '#ff9800';
  
  if (threshold >= 90) {
    emoji = '🚨';
    urgency = 'CRITICAL';
    color = '#f44336';
  }
  
  // Log the warning
  Logger.log(emoji + ' BUDGET ' + urgency + ': $' + spent.toFixed(2) + ' / $' + budget + ' (' + percentUsed.toFixed(1) + '%)');
  
  // Try to show UI alert if possible (only works if script is triggered by user action)
  try {
    const ui = SpreadsheetApp.getUi();
    const message = emoji + ' BUDGET ' + urgency + '!\n\n' +
      'Spent today: $' + spent.toFixed(2) + ' (' + percentUsed.toFixed(1) + '%)\n' +
      'Budget: $' + budget + '\n' +
      'Remaining: $' + remaining.toFixed(2) + '\n\n' +
      (threshold >= 90 
        ? '🚨 Calls will STOP automatically at $100!' 
        : '⚠️ Approaching daily limit. Monitor closely!');
    
    ui.alert(urgency + ': Budget at ' + threshold + '%', message, ui.ButtonSet.OK);
  } catch (e) {
    // Can't show UI (webhook context) - just log it
    Logger.log('Could not show UI alert (webhook context)');
  }
  
  // Update status in all active sheets
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheets = ss.getSheets();
    sheets.forEach(function(sh) {
      if (!sh.getName().startsWith('_')) {
        updateStatus_({ 
          'Script Status': emoji + ' Budget ' + urgency + ': $' + spent.toFixed(2) + '/$' + budget 
        }, sh.getName());
      }
    });
  } catch (e) {
    Logger.log('Could not update status sheets: ' + e.message);
  }
}

function getCallCostFromVapi_(apiKey, callId) {
  try {
    var res = UrlFetchApp.fetch('https://api.vapi.ai/call/' + callId, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + apiKey },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) return 0;
    var data = JSON.parse(res.getContentText());
    return Number(data.cost || (data.costBreakdown && data.costBreakdown.total) || 0);
  } catch (e) {
    Logger.log('getCallCostFromVapi_ error: ' + e.message);
    return 0;
  }
}

/**
 * Shows daily spend with link to VAPI logs
 */
/**
 * Shows daily spend with link to VAPI logs
 */
function vapiShowBudget() {
  const sp = PropertiesService.getScriptProperties();
  const apiKey = sp.getProperty('VAPI_API_KEY');
  
  if (!apiKey) {
    SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY');
    return;
  }
  
  // Get today's date boundaries in UTC
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  
  let totalCost = 0;
  let callCount = 0;
  let avgCostPerCall = 0;
  let totalMinutes = 0;
  let errors = [];
  
  try {
    // Fetch recent calls from VAPI API (simplified - no date filters)
    const url = 'https://api.vapi.ai/call?limit=100';
    
    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + apiKey },
      muteHttpExceptions: true
    });
    
    if (res.getResponseCode() >= 300) {
      errors.push('API error ' + res.getResponseCode() + ': ' + res.getContentText());
    } else {
      const data = JSON.parse(res.getContentText());
      let allCalls = Array.isArray(data) ? data : (data.results || data.data || []);
      
      // Filter for today's calls manually
      allCalls = allCalls.filter(function(call) {
        if (!call.createdAt) return false;
        const callDate = new Date(call.createdAt);
        return callDate >= todayStart && callDate <= todayEnd;
      });
      
      // Calculate totals
      allCalls.forEach(function(call) {
        const cost = Number(call.cost || 0);
        totalCost += cost;
        callCount++;
        
        // Calculate duration
        if (call.startedAt && call.endedAt) {
          const duration = (new Date(call.endedAt) - new Date(call.startedAt)) / 60000;
          totalMinutes += duration;
        }
      });
      
      if (callCount > 0) {
        avgCostPerCall = totalCost / callCount;
      }
    }
    
  } catch (e) {
    errors.push(e.message);
  }
  
  // Build the HTML popup
  const remaining = Math.max(0, DAILY_BUDGET_USD - totalCost);
  const percentUsed = DAILY_BUDGET_USD > 0 ? Math.min(100, (totalCost / DAILY_BUDGET_USD) * 100) : 0;
  
  let statusEmoji = '🟢';
  let statusText = 'Under budget';
  let barColor = '#4caf50';
  
  if (percentUsed >= 90) {
    statusEmoji = '🔴';
    statusText = 'Almost at limit!';
    barColor = '#f44336';
  } else if (percentUsed >= 70) {
    statusEmoji = '🟡';
    statusText = 'Getting close';
    barColor = '#ff9800';
  }
  
  const todayStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'EEEE, MMMM d, yyyy');
  
  // Calculate exact server midnight
    const scriptTz = Session.getScriptTimeZone();
    const todayDateStr = Utilities.formatDate(now, scriptTz, 'yyyy-MM-dd');
    const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowDateStr = Utilities.formatDate(tomorrowDate, scriptTz, 'yyyy-MM-dd');
    const serverMidnightMs = Utilities.parseDate(tomorrowDateStr + ' 00:00:00', scriptTz, 'yyyy-MM-dd HH:mm:ss').getTime();

  const html = HtmlService.createHtmlOutput(`
    <style>
      * { box-sizing: border-box; }
      body { font-family: Arial, sans-serif; padding: 20px; margin: 0; background: #f8f9fa; }
      .header { text-align: center; margin-bottom: 20px; }
      .header h2 { margin: 0 0 4px 0; color: #1a73e8; }
      .header .date { font-size: 12px; color: #666; }
      
      .budget-card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
      
      .big-number { font-size: 36px; font-weight: bold; text-align: center; margin: 10px 0; }
      .big-number .currency { font-size: 20px; color: #666; vertical-align: top; }
      .big-number .amount { color: #1a73e8; }
      
      .budget-bar { background: #e0e0e0; border-radius: 10px; height: 20px; margin: 16px 0; overflow: hidden; }
      .budget-bar-fill { height: 100%; border-radius: 10px; transition: width 0.5s; }
      
      .budget-label { display: flex; justify-content: space-between; font-size: 12px; color: #666; }
      
      .status-badge { text-align: center; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; margin: 12px auto; display: inline-block; }
      .status-green { background: #e8f5e9; color: #2e7d32; }
      .status-yellow { background: #fff3e0; color: #e65100; }
      .status-red { background: #fce4ec; color: #c62828; }
      
      .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
      .stat { background: #f5f5f5; padding: 12px; border-radius: 8px; text-align: center; }
      .stat-value { font-size: 20px; font-weight: bold; color: #333; }
      .stat-label { font-size: 11px; color: #888; margin-top: 4px; }
      
      .link-section { background: white; border-radius: 12px; padding: 16px; margin-top: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
      .vapi-link { display: inline-block; padding: 12px 24px; background: #1a73e8; color: white; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: bold; margin-top: 8px; }
      .vapi-link:hover { background: #1557b0; }
      .vapi-link-hint { font-size: 11px; color: #888; margin-top: 8px; }
      
      .error-box { background: #fff3cd; padding: 10px; border-radius: 4px; font-size: 12px; color: #856404; margin-top: 12px; }
      
      .close-btn { display: block; width: 100%; padding: 12px; background: #f1f1f1; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; cursor: pointer; margin-top: 16px; }
      .close-btn:hover { background: #e0e0e0; }
      .reset-card { background: white; border-radius: 12px; padding: 16px; margin-top: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; }
      .reset-icon { font-size: 24px; }
      .reset-label { font-size: 12px; color: #888; margin-top: 4px; }
      .reset-countdown { font-size: 28px; font-weight: bold; color: #1a73e8; margin: 8px 0; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
      .reset-hint { font-size: 11px; color: #aaa; }
    </style>
    
    <div class="header">
      <h2>💰 Daily Spend Tracker</h2>
      <div class="date">${todayStr}</div>
    </div>
    
    <div class="budget-card">
      <div class="big-number">
        <span class="currency">$</span><span class="amount">${totalCost.toFixed(2)}</span>
      </div>
      
      <div class="budget-bar">
        <div class="budget-bar-fill" style="width: ${percentUsed.toFixed(1)}%; background: ${barColor};"></div>
      </div>
      
      <div class="budget-label">
        <span>$0</span>
        <span>${statusEmoji} ${percentUsed.toFixed(1)}% used</span>
        <span>$${DAILY_BUDGET_USD}</span>
      </div>
      
      <div style="text-align: center; margin-top: 12px;">
        <span class="status-badge ${percentUsed >= 90 ? 'status-red' : percentUsed >= 70 ? 'status-yellow' : 'status-green'}">
          ${statusEmoji} ${statusText} — $${remaining.toFixed(2)} remaining
        </span>
      </div>
      
      <div class="stats-grid">
        <div class="stat">
          <div class="stat-value">${callCount}</div>
          <div class="stat-label">Calls Today</div>
        </div>
        <div class="stat">
          <div class="stat-value">$${avgCostPerCall.toFixed(3)}</div>
          <div class="stat-label">Avg Cost/Call</div>
        </div>
        <div class="stat">
          <div class="stat-value">${totalMinutes.toFixed(1)}</div>
          <div class="stat-label">Total Minutes</div>
        </div>
        <div class="stat">
          <div class="stat-value">${callCount > 0 ? (totalMinutes / callCount).toFixed(1) : '0'}</div>
          <div class="stat-label">Avg Min/Call</div>
        </div>
      </div>
    </div>
    
    <div class="link-section">
      <div style="font-size: 13px; color: #555;">🔍 Verify on VAPI Dashboard</div>
      <a class="vapi-link" href="https://dashboard.vapi.ai/logs" target="_blank" onclick="window.open('https://dashboard.vapi.ai/logs', '_blank');">
        📊 Open VAPI Call Logs →
      </a>
      <div class="vapi-link-hint">Opens in a new tab. Filter by today's date to cross-check.</div>
    </div>
    
    ${errors.length > 0 ? '<div class="error-box">⚠️ API Error: ' + errors.join('; ') + '</div>' : ''}
    
    <div class="reset-card">
      <div class="reset-icon">🔄</div>
      <div class="reset-label">Budget resets in</div>
      <div class="reset-countdown" id="countdown">Calculating...</div>
      <div class="reset-hint">Resets at midnight (${Session.getScriptTimeZone().split('/').pop().replace('_', ' ')})</div>
    </div>
    
    <button class="close-btn" onclick="google.script.host.close()">Close</button>
    
    <script>
      function updateCountdown() {
        var now = new Date();
        var midnight = new Date(${serverMidnightMs});
        
        var diff = midnight - now;
        if (diff <= 0) {
          document.getElementById('countdown').textContent = '🎉 Resetting now!';
          return;
        }
        
        var hours = Math.floor(diff / 3600000);
        var minutes = Math.floor((diff % 3600000) / 60000);
        var seconds = Math.floor((diff % 60000) / 1000);
        
        var parts = [];
        if (hours > 0) parts.push(hours + 'h');
        parts.push(String(minutes).padStart(2, '0') + 'm');
        parts.push(String(seconds).padStart(2, '0') + 's');
        
        document.getElementById('countdown').textContent = parts.join(' ');
      }
      
      updateCountdown();
      setInterval(updateCountdown, 1000);
    </script>
  `).setWidth(420).setHeight(640);
  
  SpreadsheetApp.getUi().showModalDialog(html, '💰 Daily Spend');
}

function test(){
  logToProjectTagSheet_("99999999", "TEST POOF");
}

function logToProjectTagSheet_(toNumber, projectTag) {
  var targetSS = SpreadsheetApp.openById("1YsRylkQKuOevTuzoh2F9EuFTjwc_nh674Vm6XATe5tU");
  var logSheet = targetSS.getSheetByName("Key: Project Tag and Numbers");
  if (!logSheet) {
    Logger.log("Sheet 'Key: Project Tag and Numbers' not found.");
    return;
  }
  var cleanNumber = String(toNumber).replace(/[^0-9]/g, '');
  var lastRow = logSheet.getLastRow() + 1;
  logSheet.getRange(lastRow, 2).setValue(cleanNumber);   // Phone
  logSheet.getRange(lastRow, 4).setValue(projectTag);    // Project Tag (batch_id)
  logSheet.getRange(lastRow, 5).setValue(new Date());    // Date
}

function wasMessagedThisWeek_(phoneNumber) {              
    try {                                                                                                                                                                           
      const cleanTarget = String(phoneNumber || '').replace(/[^0-9]/g, '');
      if (!cleanTarget) return false;                                                                                                                                               
                                                            
      const targetSS = SpreadsheetApp.openById("1YsRylkQKuOevTuzoh2F9EuFTjwc_nh674Vm6XATe5tU");                                                                                     
      const logSheet = targetSS.getSheetByName("Key: Project Tag and Numbers");
      if (!logSheet) return false;                                                                                                                                                  
                                                            
      const lastRow = logSheet.getLastRow();                                                                                                                                        
      if (lastRow < 2) return false;                        
                                         
      // Columns B (phone) through E (date)                                                                                                                                         
      const data = logSheet.getRange(2, 2, lastRow - 1, 4).getValues();
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);                                                                                                                  
                                                                                                                                                                                    
      for (let i = 0; i < data.length; i++) {                                                                                                                                       
        const rowPhone = String(data[i][0] || '').replace(/[^0-9]/g, '');                                                                                                           
        if (rowPhone !== cleanTarget) continue;                                                                                                                                     
        const rowDate = data[i][3]; // column E
        if (rowDate instanceof Date && rowDate.getTime() >= sevenDaysAgo) {                                                                                                         
          return true;                                                                                                                                                              
        }                                                                                                                                                                           
      }                                                                                                                                                                             
      return false;                                         
    } catch (e) {                        
      Logger.log('wasMessagedThisWeek_ error: ' + e.message);
      return false; // fail open — don't block sends on transient read errors                                                                                                       
    }                                                                                                                                                                               
  }   
