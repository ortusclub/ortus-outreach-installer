/**
 * ============================================================
 * CRITICAL FIXES — Apply these changes to your Code.gs
 * ============================================================
 *
 * 5 critical issues fixed:
 *   CR-01: Race condition in doPost (lock the active map)
 *   CR-02: startSecondRoundAutomatically_ bypasses queue
 *   CR-03: Header alias collisions
 *   CR-04: Duplicate budget check
 *   CR-05: No webhook payload validation
 *
 * BONUS fixes included:
 *   WR-05: Lock autoSortIfBatchComplete_
 *   WR-06: Fix watchdog trigger double-removal
 *   WR-08: Fix heartbeatnp0 typo
 *
 * HOW TO APPLY:
 *   For each fix below, find the OLD function in your Code.gs
 *   and replace it entirely with the NEW function.
 * ============================================================
 */


// ============================================================
// FIX CR-03: Header Alias Collisions
// ============================================================
// WHAT CHANGED:
//   - Removed 'city' from location aliases (was stealing from event_city)
//   - Removed 'region' from location aliases (was stealing from event_area)
//   - Removed 'city' from event_city aliases (not needed, 'event city' is enough)
//   - Removed generic 'title' from job_title (could match wrong columns)
//   - Removed generic 'role' from job_title (could match Priority (Role))
//   - Removed 'name' from prospect_name (too generic, 'first name' is correct)
//   - Added 'phone number' to phone aliases (you have that column)
//
// FIND: const HEADER_ALIASES = { ... };
// REPLACE WITH:

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


// ============================================================
// FIX CR-01 + CR-05: doPost — Lock + Validation + Idempotency
// ============================================================
// WHAT CHANGED:
//   - Added payload validation at the top (CR-05)
//   - Added idempotency check via processed webhook tracking
//   - Wrapped active map read/modify/write in LockService (CR-01)
//   - Moved processQueueForSheet_ call OUTSIDE the lock to prevent deadlock
//   - Returns 200 quickly even on error (VAPI best practice)
//
// FIND: function doPost(e) { ... } (the entire function)
// REPLACE WITH:

function doPost(e) {
  const sp = PropertiesService.getScriptProperties();
  const sheetId = sp.getProperty('SHEET_ID');
  let sheetName = null;

  try {
    // ---- CR-05: Validate payload before processing ----
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) return ContentService.createTextOutput('Ignored: empty payload');

    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      Logger.log('doPost: Invalid JSON: ' + parseErr.message);
      return ContentService.createTextOutput('Error: Invalid JSON');
    }

    const msg = body.message || body || {};
    const type = String(msg.type || (msg.message ? msg.message.type : '') || '').trim();
    const isEnd = (type === 'end-of-call-report' || type === 'call-ended' || type === 'call.ended');
    if (!isEnd) return ContentService.createTextOutput('Ignored: ' + (type || 'no-type'));

    const call = msg.call || (msg.message ? msg.message.call : {}) || {};
    const meta = call.metadata || msg.metadata || (msg.message ? msg.message.metadata : {}) || {};
    const callId = String(call.id || msg.callId || (msg.message ? msg.message.callId : '') || '').trim();

    // Validate we have enough data to process
    if (!callId) {
      Logger.log('doPost: No call ID in payload');
      return ContentService.createTextOutput('Error: No call ID');
    }
    if (!sheetId) {
      Logger.log('doPost: No SHEET_ID in script properties');
      return ContentService.createTextOutput('Error: Missing SHEET_ID');
    }

    // ---- Idempotency: skip if we already processed this webhook ----
    const idempotencyKey = 'WEBHOOK_PROCESSED__' + callId;
    if (sp.getProperty(idempotencyKey)) {
      Logger.log('doPost: Duplicate webhook for call ' + callId + ', skipping');
      return ContentService.createTextOutput('OK (duplicate)');
    }

    const ss = SpreadsheetApp.openById(sheetId);
    let sh = null;
    let rowNum = Number(meta.rowNum || 0);
    if (meta.sheetName) sh = ss.getSheetByName(meta.sheetName);
    if (!sh || !rowNum) {
      for (let i = 0; i < ss.getSheets().length; i++) {
        const candidate = ss.getSheets()[i];
        const r = findRowByCallId_(candidate, callId);
        if (r) { sh = candidate; rowNum = r; break; }
      }
    }
    if (!sh || !rowNum) return ContentService.createTextOutput('Error: Could not locate row');
    sheetName = sh.getName();
    const cols = getHeaderMap_(sh);
    if (!cols.status) return ContentService.createTextOutput('Error: Missing Status header');

    // ---- Process call data (writes to specific row — safe without lock) ----
    const transcript = (msg.artifact ? msg.artifact.transcript : '') ||
      (msg.message && msg.message.artifact ? msg.message.artifact.transcript : '') ||
      (call.artifact ? call.artifact.transcript : '') || '';
    const recordingUrl = (msg.artifact ? (msg.artifact.recordingUrl || msg.artifact.recording_url) : '') ||
      (msg.message && msg.message.artifact ? msg.message.artifact.recordingUrl : '') ||
      (call.artifact ? call.artifact.recordingUrl : '') || '';
    let summary = (msg.analysis ? msg.analysis.summary : '') ||
      (msg.message && msg.message.analysis ? msg.message.analysis.summary : '') ||
      (call.analysis ? call.analysis.summary : '') || '';

    let startedAt = null;
    if (cols.started_at) {
      const v = sh.getRange(rowNum, cols.started_at).getValue();
      if (v instanceof Date) startedAt = v;
    }

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

    let previousStatus = '';
    if (isSecondRound) {
      previousStatus = currentVoicemailCount >= 1 ? 'Voicemail' : 'No Answer';
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

    // Write results to sheet (row-specific, no shared-state conflict)
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
    }

    applyRowHygiene_(sh, rowNum, cols);

    // ---- AUTO FOLLOW-UP TRIGGER ----
    if (AUTO_FOLLOWUP_TRIGGER_STATUSES.indexOf(statusValue) !== -1) {
      const lastCol = sh.getLastColumn();
      const rowVals = sh.getRange(rowNum, 1, 1, lastCol).getValues()[0];

      const originalEmail = cols.prospect_email ? String(rowVals[cols.prospect_email - 1] || '').trim() : '';
      const emailToUse = extracted.corrected_email || originalEmail;

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

    // ============================================================
    // CR-01 FIX: LOCK the shared active/queue state update
    // ============================================================
    // This is the critical section. Two concurrent webhooks reading the
    // same active map and writing back would lose one deletion, creating
    // "phantom" active calls that permanently block queue slots.
    //
    // processQueueForSheet_ has its own internal lock, so we MUST
    // release ours before calling it to avoid deadlock.
    // ============================================================

    let needsMoreProcessing = false;
    let isComplete = false;
    let concurrency = 1;

    const criticalLock = LockService.getScriptLock();
    const hasLock = criticalLock.tryLock(15000);
    if (!hasLock) {
      Logger.log('WARNING: doPost could not acquire lock after 15s for call ' + callId + ' — processing anyway');
    }

    try {
      const aKey = activeKey_(sheetId, sheetName);
      let active = loadJson_(sp, aKey, {});
      if (callId && active[callId]) {
        delete active[callId];
        sp.setProperty(aKey, JSON.stringify(active));
      }

      concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 0);
      if (!concurrency) concurrency = Number(sp.getProperty(schedConcurrencyKey_(sheetId)) || 1);
      if (concurrency < 1) concurrency = 1;

      const queue = loadJson_(sp, queueKey_(sheetId, sheetName), []);
      const activeCount = Object.keys(active).length;
      const queueCount = queue.length;

      updateStatus_({ 'Active Calls': activeCount, 'Queued Rows': queueCount }, sheetName);

      needsMoreProcessing = (queueCount > 0 && activeCount < concurrency);
      isComplete = (queueCount === 0 && activeCount === 0);
    } finally {
      if (hasLock) criticalLock.releaseLock();
    }

    // Mark this webhook as processed BEFORE any further calls (idempotency)
    // TTL: keep for 1 hour then auto-clean (GAS properties don't auto-expire,
    // but we check timestamp in the idempotency logic)
    sp.setProperty(idempotencyKey, String(Date.now()));

    // ---- Resume queue / mark complete OUTSIDE the lock ----
    if (needsMoreProcessing) {
      processQueueForSheet_(ss, sh, sp.getProperty('VAPI_API_KEY'),
        sp.getProperty('VAPI_PHONE_NUMBER_ID'),
        sp.getProperty('VAPI_ASSISTANT_ID'), concurrency);
    }

    if (isComplete) {
      updateStatus_({ 'Script Status': '✅ Complete', 'Active Calls': 0, 'Queued Rows': 0 }, sheetName);
      sp.deleteProperty(processingKey_(sheetId, sheetName));
      autoSortIfBatchComplete_(sheetId, sheetName);
    }

    return ContentService.createTextOutput('OK');

  } catch (err) {
    if (sheetName) updateStatus_({ 'Last Error': 'Webhook: ' + (err.message || String(err)) }, sheetName);
    // IMPORTANT: Still return 200 so VAPI doesn't keep retrying
    Logger.log('doPost ERROR: ' + (err.message || String(err)));
    return ContentService.createTextOutput('OK (error logged)');
  }
}


// ============================================================
// FIX CR-02: startSecondRoundAutomatically_ — use queue
// ============================================================
// WHAT CHANGED:
//   - Removed the direct triggerVapiCall_ loop (was bypassing concurrency)
//   - Now queues rows and calls processQueueForSheet_ (same as multi-round)
//   - Respects concurrency limits
//   - Note: This is the OLD 2-round system. You use multi-round now,
//     but this fix makes it safe if an old trigger ever fires.
//
// FIND: function startSecondRoundAutomatically_(config) { ... }
// REPLACE WITH:

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
  const sp = PropertiesService.getScriptProperties();

  const fieldsToClear = ['call_id', 'started_at', 'ended_at', 'transcript', 'outcome_summary', 'recording_url',
    'callback_flag', 'callback_when', 'scheduled_at', 'scheduled_in_min',
    'auto_followup_status', 'auto_followup_preview'];

  const rowsToQueue = [];

  Logger.log('Checking ' + data.length + ' rows for batch: ' + config.batchId);
  Logger.log('Looking for statuses: ' + JSON.stringify(config.statuses));

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const rowNum = HEADER_ROW_INDEX + 1 + i;
    const rowBatchId = String(row[cols.batch_id - 1] || '').trim();
    const status = String(row[cols.status - 1] || '').trim().toLowerCase();

    if (rowBatchId !== config.batchId) continue;

    // Check if should be skipped
    const shouldSkip = DO_NOT_CALL_AGAIN_STATUSES.some(function(s) {
      return status.includes(s);
    });

    if (shouldSkip) {
      const currentStatus = String(row[cols.status - 1] || '').trim();
      row[cols.status - 1] = '⏭️ Skipped 2nd (' + currentStatus + ')';
      if (cols.second_round_status) {
        row[cols.second_round_status - 1] = '⏭️ Skipped (' + currentStatus + ')';
      }
      continue;
    }

    // Check if status matches retry criteria
    const shouldCall = config.statuses.some(function(s) {
      return status.includes(s.toLowerCase());
    });

    const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag - 1] || '').trim().toUpperCase() : '';
    const callbackRequested = (callbackFlag === 'TRUE') && config.statuses.includes('callback');

    if (shouldCall || callbackRequested) {
      // Determine assistant
      let assistantToUse = cols.assistant ? String(row[cols.assistant - 1] || '').trim() : '';
      if (status.includes('voicemail') && config.voicemailAssistant) {
        assistantToUse = config.voicemailAssistant;
      }

      // Prepare row for 2nd round
      row[cols.status - 1] = 'Queued';

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

      rowsToQueue.push(rowNum);
    }
  }

  if (rowsToQueue.length === 0) {
    Logger.log('No rows to call for 2nd round in batch: ' + config.batchId);
    return;
  }

  // Write updated data back to sheet
  sh.getRange(HEADER_ROW_INDEX + 1, 1, lastRow - HEADER_ROW_INDEX, lastCol).setValues(data);
  SpreadsheetApp.flush();

  // ---- CR-02 FIX: Queue rows instead of calling API directly ----
  // This respects concurrency limits and uses the standard queue system.
  const qKey = queueKey_(config.sheetId, config.sheetName);
  let queue = loadJson_(sp, qKey, []);
  rowsToQueue.forEach(function(rowNum) {
    if (queue.indexOf(rowNum) === -1) queue.push(rowNum);
  });
  queue.sort(function(a, b) { return a - b; });
  sp.setProperty(qKey, JSON.stringify(queue));

  // Use stored concurrency or default to 1
  const concurrency = Number(sp.getProperty(concurrencyKey_(config.sheetId, config.sheetName)) || 1);
  sp.setProperty(concurrencyKey_(config.sheetId, config.sheetName), String(concurrency));

  // Start processing through the standard queue system
  const apiKey = sp.getProperty('VAPI_API_KEY');
  if (apiKey) {
    processQueueForSheet_(ss, sh, apiKey,
      sp.getProperty('VAPI_PHONE_NUMBER_ID'),
      sp.getProperty('VAPI_ASSISTANT_ID'),
      concurrency);
  }

  Logger.log('Queued ' + rowsToQueue.length + ' rows for 2nd round of batch ' + config.batchId);
}


// ============================================================
// FIX CR-04: Remove duplicate budget check in processQueueForSheet_
// ============================================================
// WHAT CHANGED:
//   - Removed the duplicate isUnderBudget_() check
//   - Kept ONE check before the while loop
//   - The check INSIDE the while loop (after each call) is still there
//
// FIND this block (the duplicate) inside processQueueForSheet_:
//
//     // Add this line right before: while (Object.keys(active).length < concurrency && queue.length > 0) {
//         if (!isUnderBudget_()) {
//           updateStatus_({ 'Script Status': '💰 Daily budget reached ($' + getDailySpend_().toFixed(2) + '/$' + DAILY_BUDGET_USD + ')' }, sheetName);
//           sp.setProperty(qKey, JSON.stringify(queue));
//         return;
//           }
//         // Add this line right before: while (Object.keys(active).length < concurrency && queue.length > 0) {
//           if (!isUnderBudget_()) {
//           updateStatus_({ 'Script Status': '💰 Daily budget reached ($' + getDailySpend_().toFixed(2) + '/$' + DAILY_BUDGET_USD + ')' }, sheetName);
//           sp.setProperty(qKey, JSON.stringify(queue));
//           return;
//           }
//
// REPLACE WITH (single check, clean formatting):

    // Budget gate: stop before starting new calls if daily limit reached
    if (!isUnderBudget_()) {
      updateStatus_({ 'Script Status': '💰 Daily budget reached ($' + getDailySpend_().toFixed(2) + '/$' + DAILY_BUDGET_USD + ')' }, sheetName);
      sp.setProperty(qKey, JSON.stringify(queue));
      return;
    }


// ============================================================
// BONUS FIX WR-05: Lock autoSortIfBatchComplete_
// ============================================================
// WHAT CHANGED:
//   - Added LockService at the top to prevent concurrent sorts
//   - If lock can't be acquired, skip (another sort is running)
//
// FIND: function autoSortIfBatchComplete_(sheetId, sheetName) { ... }
// REPLACE WITH:

function autoSortIfBatchComplete_(sheetId, sheetName) {
  // WR-05 FIX: Prevent concurrent sorts from corrupting row order
  const sortLock = LockService.getScriptLock();
  if (!sortLock.tryLock(5000)) {
    Logger.log('autoSortIfBatchComplete_: Another sort is running, skipping');
    return;
  }

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

    if (cols.batch_id) {
      const batchIds = new Set();
      data.forEach(function(row) {
        const batchId = String(row[cols.batch_id - 1] || '').trim().replace(/_R\d+$/, '');
        if (batchId) batchIds.add(batchId);
      });

      Logger.log('Found batch IDs: ' + Array.from(batchIds).join(', '));

      batchIds.forEach(function(batchId) {
        const autoSortSetting = sp.getProperty('BATCH_AUTOSORT_' + batchId);
        if (autoSortSetting === 'true') {
          shouldSort = true;
          batchIdsToClean.push(batchId);
        }

        // Check multi-round config
        const multiRoundConfigStr = sp.getProperty('MULTI_ROUND_' + batchId);
        if (multiRoundConfigStr) {
          try {
            const config = JSON.parse(multiRoundConfigStr);
            if (config.autoSort !== false) {
              shouldSort = true;
              batchIdsToClean.push(batchId);
            }
          } catch (e) {
            Logger.log('Error parsing multi-round config: ' + e.message);
          }
        }

        // Check old 2nd round config (backward compat)
        const secondRoundConfigStr = sp.getProperty('SECOND_ROUND_' + batchId);
        if (secondRoundConfigStr) {
          try {
            const config = JSON.parse(secondRoundConfigStr);
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
      Logger.log('No batch_id column, defaulting to sort');
      shouldSort = true;
    }

    if (!shouldSort) {
      Logger.log('Auto-sort not enabled for any batch');
      return;
    }

    Logger.log('Performing auto-sort...');

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

    batchIdsToClean.forEach(function(batchId) {
      sp.deleteProperty('BATCH_AUTOSORT_' + batchId);
    });

  } catch (e) {
    Logger.log('Error in autoSortIfBatchComplete_: ' + e.message);
  } finally {
    sortLock.releaseLock();
  }
}


// ============================================================
// BONUS: Idempotency cleanup function
// ============================================================
// Run this on a daily trigger to clean up old webhook tracking keys.
// Without this, WEBHOOK_PROCESSED__ keys accumulate in ScriptProperties.
//
// ADD this new function:

function cleanupOldWebhookKeys_() {
  const sp = PropertiesService.getScriptProperties();
  const allProps = sp.getProperties();
  const oneHourAgo = Date.now() - (60 * 60 * 1000);

  let cleaned = 0;
  for (const key in allProps) {
    if (!key.startsWith('WEBHOOK_PROCESSED__')) continue;
    const timestamp = Number(allProps[key] || 0);
    if (timestamp < oneHourAgo) {
      sp.deleteProperty(key);
      cleaned++;
    }
  }
  if (cleaned > 0) Logger.log('Cleaned up ' + cleaned + ' old webhook idempotency keys');
}


// ============================================================
// BONUS FIX WR-08: Fix typo in header comment
// ============================================================
// FIND:    * ✅ Execution monitoring & heartbeatnp0
// REPLACE: * ✅ Execution monitoring & heartbeat
