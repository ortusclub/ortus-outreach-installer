/** ======================================================================
 * VAPI CALLING + OUTREACH WIZARDS — UNIFIED SCRIPT
 * Version: 4.1 (Critical fixes applied)
 *
 * FIXES: CR-01 webhook lock, CR-02 queue bypass, CR-03 alias collisions,
 *        CR-04 duplicate budget check, CR-05 payload validation,
 *        WR-05 sort lock, idempotency for VAPI retries
 * ====================================================================== */

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
const DO_NOT_CALL_AGAIN_STATUSES = ['spoke to human', 'ai gatekeeper', 'hung up (≤30s)', 'hung up', 'number failed', 'cancelled', 'error', 'no answer 2nd'];
const VAPI_PHONE_NUMBERS = [
  { display: '+65 3129 5117', e164: '+6531295117', id: '612a2ede-3291-4303-8484-6b4ea68c3fc9' },
  { display: '+44 131 381 2021', e164: '+441313812021', id: '75651434-250e-497f-a3ab-d3c086528fc1' },
  { display: '+1 617 600 0320', e164: '+16176000320', id: '365601af-e5d3-41b5-8d39-887503ef64b9' },
];

// CR-03 FIX: Removed ambiguous aliases (city, region, title, role, name)
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

function _s_(v) { return String(v == null ? "" : v).trim(); }
function _n_(v) { const num = Number(String(v == null ? "" : v).trim()); return isNaN(num) ? NaN : num; }
function _norm_(s) { return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function getHeaderMap_(sh) {
  const headerRow = sh.getRange(HEADER_ROW_INDEX, 1, 1, sh.getLastColumn()).getValues()[0];
  const norm = (v) => String(v || '').toLowerCase().replace(/\n+/g, ' ').replace(/_/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const normalized = headerRow.map(norm);
  const map = {};
  Object.keys(HEADER_ALIASES).forEach(key => {
    const aliases = (HEADER_ALIASES[key] || []).map(norm);
    for (let i = 0; i < normalized.length; i++) { if (aliases.includes(normalized[i])) { map[key] = i + 1; break; } }
  });
  return map;
}

function _buildNormHeaderMap_(sheet) { const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]; const map = {}; headers.forEach((h, idx) => { const raw = String(h || "").trim(); if (!raw) return; map[_norm_(raw)] = { index0: idx, raw }; }); return map; }
function _resolveCol_(normMap, aliasList) { for (const a of aliasList) { const hit = normMap[_norm_(a)]; if (hit) return hit; } return null; }
function normalizePhone_(p) { const s = String(p || '').replace(/[^\d+]/g, ''); return s ? (s.startsWith('+') ? s : '+' + s) : ''; }
function formatEventDate_(d) { if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMMM d, yyyy'); return String(d || '').trim(); }
function formatEventTime_(t) { if (t instanceof Date) return Utilities.formatDate(t, Session.getScriptTimeZone(), 'h:mm a'); return String(t || '').trim(); }
function loadJson_(p, k, f) { try { const raw = p.getProperty(k); if (!raw) return f; const parsed = JSON.parse(raw); return parsed ? parsed : f; } catch (e) { return f; } }
function colToA1_(colNum) { let col = colNum, letters = ''; while (col > 0) { const mod = (col - 1) % 26; letters = String.fromCharCode(65 + mod) + letters; col = Math.floor((col - 1) / 26); } return letters; }
function getRoundSuffix_(roundNum) { if (!roundNum || roundNum <= 1) return ''; if (roundNum === 2) return ' 2nd'; if (roundNum === 3) return ' 3rd'; return ' ' + roundNum + 'th'; }
function getBaseStatus_(status) { return String(status || '').replace(/\s+(2nd|3rd|4th|5th)$/i, '').trim(); }
function promptConcurrency_(ui, title, defaultVal) { const res = ui.prompt(title, 'Enter a number (e.g. 1, 3, 10).\n\nDefault: ' + defaultVal, ui.ButtonSet.OK_CANCEL); if (res.getSelectedButton() !== ui.Button.OK) return 0; const n = Number(String(res.getResponseText() || '').trim()); if (!Number.isFinite(n) || n <= 0 || n > 50) { ui.alert('Please enter a valid number between 1 and 50.'); return 0; } return Math.floor(n); }
function deleteTriggersByHandler_(handlerName) { ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t); }); }

function queueKey_(id, name) { return KEY_PREFIX + 'QUEUE__' + id + '__' + name; }
function activeKey_(id, name) { return KEY_PREFIX + 'ACTIVE__' + id + '__' + name; }
function concurrencyKey_(id, name) { return KEY_PREFIX + 'CONCURRENCY__' + id + '__' + name; }
function processingKey_(id, name) { return KEY_PREFIX + 'PROCESSING__' + id + '__' + name; }
function heartbeatKey_(id, name) { return KEY_PREFIX + 'HEARTBEAT__' + id + '__' + name; }
function processingStartKey_(id, name) { return KEY_PREFIX + 'PROC_START__' + id + '__' + name; }
function schedSheetKey_(id) { return KEY_PREFIX + 'SCHED_SHEET__' + id; }
function schedConcurrencyKey_(id) { return KEY_PREFIX + 'SCHED_CONCURRENCY__' + id; }
function schedStartAtKey_(id) { return KEY_PREFIX + 'SCHED_STARTAT__' + id; }
function autoFollowupConfigKey_(sheetName) { if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName(); return KEY_PREFIX + 'AUTO_FOLLOWUP_CONFIG__' + sheetName; }
function autoFollowupQueueKey_(sheetName) { if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName(); return KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__' + sheetName; }

function ensureSheetId_() { const ss = SpreadsheetApp.getActiveSpreadsheet(); const sp = PropertiesService.getScriptProperties(); if (!sp.getProperty('SHEET_ID')) sp.setProperty('SHEET_ID', ss.getId()); }

function vapiSetupCheck() {
  ensureSheetId_(); const sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('VAPI_API_KEY')) { SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY'); return; }
  const sh = SpreadsheetApp.getActiveSheet(); const cols = getHeaderMap_(sh);
  const required = ['prospect_name','prospect_email','phone','status','assistant','vapi_number','call_id','started_at','ended_at','outcome_summary','transcript','recording_url','event_name','event_date','event_city','caller_name','host_name','host_first_name','host_pronouns','event_time','event_format','target_audience','event_area','event_venue','callback_flag','callback_when','voicemail_left_count'];
  const missing = required.filter(k => !cols[k]);
  if (missing.length) { SpreadsheetApp.getUi().alert('❌ Missing headers:\n\n' + missing.map(x => '- ' + x).join('\n')); return; }
  SpreadsheetApp.getUi().alert('✅ Setup OK.');
}

function openAutoFollowupWizard() { const html = HtmlService.createHtmlOutputFromFile("AutoFollowupWizard").setWidth(620).setHeight(700); SpreadsheetApp.getUi().showModalDialog(html, "⚡ Configure Auto Follow-up"); }

function getAutoFollowupConfig(sheetName) {
  const sp = PropertiesService.getScriptProperties(); if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
  if (!config) return { enabled: false, channels: 'both', delayMinutes: 5, triggerStatuses: ['Voicemail', 'No Answer'], emailSubject: 'Sorry I missed you!', emailTemplate: 'Hi <b>{{prospect_name}}</b>,<br><br>I just tried to give you a call about <b>{{event_name}}</b> on {{event_date}} in {{event_city}}, but couldn\'t get through.<br><br>Best regards,<br><b>{{caller_name}}</b>', smsTemplate: 'Hi {{prospect_name}}! It\'s {{caller_name}} — I just tried calling about {{event_name}} on {{event_date}}. When\'s a good time to chat?' };
  return config;
}

function saveAutoFollowupConfig(config, sheetName) {
  const sp = PropertiesService.getScriptProperties(); if (!sheetName) sheetName = SpreadsheetApp.getActiveSheet().getName();
  if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
  let channelsValue = config.channels;
  if (Array.isArray(channelsValue)) { if (channelsValue.includes('email') && channelsValue.includes('sms')) channelsValue = 'both'; else if (channelsValue.includes('email')) channelsValue = 'email'; else if (channelsValue.includes('sms')) channelsValue = 'sms'; else channelsValue = 'both'; }
  const validConfig = { enabled: Boolean(config.enabled), channels: ['email','sms','both'].includes(channelsValue) ? channelsValue : 'both', delayMinutes: Math.max(0, Math.min(1440, Number(config.delayMinutes) || 5)), specificTime: config.specificTime || null, specificDays: Number(config.specificDays) || 0, triggerStatuses: Array.isArray(config.triggerStatuses) ? config.triggerStatuses : ['Voicemail','No Answer'], emailSubject: String(config.emailSubject || 'Sorry I missed you!').trim(), emailTemplate: String(config.emailTemplate || config.emailBody || '').trim(), smsTemplate: String(config.smsTemplate || config.smsBody || '').trim() };
  sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(validConfig));
  if (validConfig.enabled) setupAutoFollowupTrigger_(); else removeAutoFollowupTrigger_();
  return { success: true, config: validConfig };
}

function scheduleAutoFollowup_(sheetId, sheetName, rowNum, status, prospectData) {
  const sp = PropertiesService.getScriptProperties(); const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
  if (!config || !config.enabled) return; if (!config.triggerStatuses.includes(status)) return;
  var channels = config.channels;
  if ((channels === 'email' || channels === 'both') && prospectData.emailVerificationScore !== undefined && prospectData.emailVerificationScore !== null) {
    const score = Number(prospectData.emailVerificationScore);
    if (isNaN(score) || score <= 95) {
      if (channels === 'email') { try { const ss = SpreadsheetApp.openById(sheetId); const sh = ss.getSheetByName(sheetName); if (sh) { const cols = getHeaderMap_(sh); if (cols.auto_followup_status) sh.getRange(rowNum, cols.auto_followup_status).setValue('⏭️ Skipped (email score ≤95)'); } } catch(e){} return; }
      if (channels === 'both') channels = 'sms';
    }
  }
  var sendAt; if (config.specificTime) { var timeParts = config.specificTime.split(':'); var targetDate = new Date(); targetDate.setDate(targetDate.getDate() + (config.specificDays || 0)); targetDate.setHours(parseInt(timeParts[0]), parseInt(timeParts[1]), 0, 0); sendAt = targetDate.getTime(); } else { sendAt = Date.now() + ((config.delayMinutes || 0) * 60 * 1000); }
  const queueKey = autoFollowupQueueKey_(sheetName); const queue = loadJson_(sp, queueKey, []);
  const existingIndex = queue.findIndex(function(item) { return item.sheetId === sheetId && item.sheetName === sheetName && item.rowNum === rowNum; });
  const entry = { sheetId: sheetId, sheetName: sheetName, rowNum: rowNum, status: status, sendAt: sendAt, prospectData: prospectData, channels: channels, createdAt: Date.now() };
  if (existingIndex >= 0) queue[existingIndex] = entry; else queue.push(entry);
  sp.setProperty(queueKey, JSON.stringify(queue));
  try { const ss = SpreadsheetApp.openById(sheetId); const sh = ss.getSheetByName(sheetName); if (sh) { const cols = getHeaderMap_(sh); if (cols.auto_followup_status) { const timeStr = Utilities.formatDate(new Date(sendAt), Session.getScriptTimeZone(), 'HH:mm'); sh.getRange(rowNum, cols.auto_followup_status).setValue('⏳ Scheduled ' + timeStr); } if (cols.auto_followup_preview) sh.getRange(rowNum, cols.auto_followup_preview).setValue(generateFollowupPreview_(config, prospectData)); } } catch(e){}
}

function processAutoFollowupQueue_() {
  const sp = PropertiesService.getScriptProperties(); const allProps = sp.getProperties();
  for (const key in allProps) {
    if (!key.startsWith(KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__')) continue;
    const sheetName = key.replace(KEY_PREFIX + 'AUTO_FOLLOWUP_QUEUE__', '');
    const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null);
    if (!config || !config.enabled) continue;
    const queue = loadJson_(sp, key, []); if (queue.length === 0) continue;
    const now = Date.now(); const toProcess = [], remaining = [];
    queue.forEach(function(item) { if (item.sendAt <= now) toProcess.push(item); else remaining.push(item); });
    if (toProcess.length === 0) continue;
    const sentThisRun = new Set();
    toProcess.forEach(function(item) { try { const phoneKey = String((item.prospectData && item.prospectData.phone) || '').replace(/[^0-9]/g, ''); if (phoneKey && sentThisRun.has(phoneKey)) { updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, '⏭️  Skipped (duplicate in same run)'); return; } sendAutoFollowup_(item, config); if (phoneKey) sentThisRun.add(phoneKey); } catch (e) { updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, '❌ ' + e.message); } });
    sp.setProperty(key, JSON.stringify(remaining));
  }
}

function sendAutoFollowup_(item, config) {
  const prospectData = item.prospectData; var channels = item.channels || config.channels; const results = { emailSent: false, smsSent: false, errors: [] };
  const vars = { prospect_name: prospectData.prospectName || 'there', prospect_email: prospectData.prospectEmail || '', phone: prospectData.phone || '', event_name: prospectData.eventName || '', event_date: prospectData.eventDate || '', event_city: prospectData.eventCity || '', event_time: prospectData.eventTime || '', event_venue: prospectData.eventVenue || '', caller_name: prospectData.callerName || 'Your contact', host_name: prospectData.hostName || '' };
  if ((channels === 'email' || channels === 'both') && vars.prospect_email && vars.prospect_email.indexOf('@') !== -1) { try { const subject = replaceTemplateVars_(config.emailSubject, vars); const htmlBody = replaceTemplateVars_(config.emailTemplate, vars); const plainBody = htmlBody.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''); GmailApp.sendEmail(vars.prospect_email, subject, plainBody, { htmlBody: htmlBody }); results.emailSent = true; } catch (e) { results.errors.push('Email: ' + e.message); } }
  if ((channels === 'sms' || channels === 'both') && vars.phone && vars.phone.startsWith('+')) {
    if (wasMessagedThisWeek_(vars.phone)) { results.errors.push('SMS: Skipped (sent within 7d)'); }
    else { try { const sp = PropertiesService.getScriptProperties(); const sid = sp.getProperty("TWILIO_ACCOUNT_SID"); const token = sp.getProperty("TWILIO_AUTH_TOKEN"); const fromNumber = sp.getProperty("TWILIO_FROM_NUMBER"); if (sid && token && fromNumber) { _twilioSendSms_(sid, token, fromNumber, vars.phone, replaceTemplateVars_(config.smsTemplate, vars)); results.smsSent = true; logToProjectTagSheet_(vars.phone, prospectData.batchId || 'auto_followup'); } else { results.errors.push('SMS: Missing Twilio credentials'); } } catch (e) { results.errors.push('SMS: ' + e.message); } }
  }
  let statusText = ''; if (results.emailSent && results.smsSent) statusText = '✅ Email + SMS Sent'; else if (results.emailSent) statusText = '✅ Email Sent'; else if (results.smsSent) statusText = '✅ SMS Sent'; else if (results.errors.length > 0) statusText = '❌ ' + results.errors.join('; '); else statusText = '⚠️ No valid contact';
  updateAutoFollowupStatus_(item.sheetId, item.sheetName, item.rowNum, statusText);
}

function disableAutoFollowup() { const sp = PropertiesService.getScriptProperties(); const sheetName = SpreadsheetApp.getActiveSheet().getName(); const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), {}); config.enabled = false; sp.setProperty(autoFollowupConfigKey_(sheetName), JSON.stringify(config)); SpreadsheetApp.getUi().alert('✅ Auto Follow-up disabled for ' + sheetName + '.'); }
function viewAutoFollowupStatus() { const sp = PropertiesService.getScriptProperties(); const sheetName = SpreadsheetApp.getActiveSheet().getName(); const config = loadJson_(sp, autoFollowupConfigKey_(sheetName), null); const queue = loadJson_(sp, autoFollowupQueueKey_(sheetName), []); if (!config) { SpreadsheetApp.getUi().alert('Auto Follow-up not configured.'); return; } SpreadsheetApp.getUi().alert('Status: ' + (config.enabled ? '🟢 ENABLED' : '🔴 DISABLED') + '\nChannel: ' + config.channels + '\nDelay: ' + config.delayMinutes + ' min\nPending: ' + queue.length); }
function setupAutoFollowupTrigger_() { removeAutoFollowupTrigger_(); ScriptApp.newTrigger('processAutoFollowupQueue_').timeBased().everyMinutes(1).create(); }
function removeAutoFollowupTrigger_() { deleteTriggersByHandler_('processAutoFollowupQueue_'); }
function updateAutoFollowupStatus_(sheetId, sheetName, rowNum, statusText) { try { const ss = SpreadsheetApp.openById(sheetId); const sh = ss.getSheetByName(sheetName); if (sh) { const cols = getHeaderMap_(sh); if (cols.auto_followup_status) sh.getRange(rowNum, cols.auto_followup_status).setValue(statusText); } } catch(e){} }
function replaceTemplateVars_(template, vars) { let result = template; Object.keys(vars).forEach(key => { result = result.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'gi'), vars[key] || ''); }); return result; }
function generateFollowupPreview_(config, prospectData) { const vars = { prospect_name: prospectData.prospectName || '[Name]', prospect_email: prospectData.prospectEmail || '[Email]', phone: prospectData.phone || '[Phone]', event_name: prospectData.eventName || '[Event]', event_date: prospectData.eventDate || '[Date]', event_city: prospectData.eventCity || '[City]', event_time: prospectData.eventTime || '[Time]', event_venue: prospectData.eventVenue || '[Venue]', caller_name: prospectData.callerName || '[Caller]', host_name: prospectData.hostName || '[Host]' }; const parts = []; if (config.channels === 'email' || config.channels === 'both') parts.push('📧 SUBJECT: ' + replaceTemplateVars_(config.emailSubject, vars)); if (config.channels === 'sms' || config.channels === 'both') parts.push('💬 SMS: ' + replaceTemplateVars_(config.smsTemplate, vars)); return parts.join('\n\n---\n\n'); }

// ============================================================
// STATUS MONITORING
// ============================================================
function getStatusSheet_() { const ss = SpreadsheetApp.getActiveSpreadsheet(); let statusSh = ss.getSheetByName(STATUS_SHEET_NAME); if (!statusSh) { statusSh = ss.insertSheet(STATUS_SHEET_NAME); statusSh.getRange('A1').setValue('Metric'); statusSh.getRange('A2:A10').setValues([['Script Status'],['Last Heartbeat'],['Seconds Since Heartbeat'],['Active Calls'],['Queued Rows'],['Concurrency Setting'],['Campaign Sheet'],['Processing Started'],['Last Error']]); statusSh.getRange('A1').setFontWeight('bold'); statusSh.setColumnWidth(1, 180); } return statusSh; }
function getStatusColumnForSheet_(statusSh, sheetName) { const headerRow = statusSh.getRange(1, 1, 1, statusSh.getLastColumn()).getValues()[0]; for (let i = 1; i < headerRow.length; i++) { if (headerRow[i] === sheetName) return i + 1; } const newCol = Math.max(2, statusSh.getLastColumn() + 1); statusSh.getRange(1, newCol).setValue(sheetName).setFontWeight('bold'); statusSh.setColumnWidth(newCol, 250); const colLetter = colToA1_(newCol); statusSh.getRange(4, newCol).setFormula('=IF(' + colLetter + '3="","N/A",ROUND((NOW()-' + colLetter + '3)*86400,0)&" sec ago")'); statusSh.getRange(8, newCol).setValue(sheetName); return newCol; }
function updateStatus_(updates, sheetName) { try { if (!sheetName) { try { sheetName = SpreadsheetApp.getActiveSheet().getName(); } catch(e) { return; } } if (sheetName.startsWith('_Vapi')) return; const statusSh = getStatusSheet_(); const col = getStatusColumnForSheet_(statusSh, sheetName); const metrics = { 'Script Status': 2, 'Last Heartbeat': 3, 'Active Calls': 5, 'Queued Rows': 6, 'Concurrency Setting': 7, 'Campaign Sheet': 8, 'Processing Started': 9, 'Last Error': 10 }; Object.entries(updates).forEach(function(entry) { const row = metrics[entry[0]]; if (row) statusSh.getRange(row, col).setValue(entry[1]); }); } catch(e){} }
function recordHeartbeat_(sheetId, sheetName) { const sp = PropertiesService.getScriptProperties(); const now = Date.now(); sp.setProperty(heartbeatKey_(sheetId, sheetName), String(now)); updateStatus_({ 'Last Heartbeat': new Date(now) }, sheetName); }
function vapiShowStatus() { const sp = PropertiesService.getScriptProperties(); const sheetId = sp.getProperty('SHEET_ID'); const sh = SpreadsheetApp.getActiveSheet(); const sheetName = sh.getName(); const queue = loadJson_(sp, queueKey_(sheetId, sheetName), []); const active = loadJson_(sp, activeKey_(sheetId, sheetName), {}); const concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 1); const isProcessing = sp.getProperty(processingKey_(sheetId, sheetName)) === 'true'; const lastHeartbeat = sp.getProperty(heartbeatKey_(sheetId, sheetName)); let heartbeatAge = 'N/A'; if (lastHeartbeat) heartbeatAge = Math.round((Date.now() - Number(lastHeartbeat)) / 1000) + 's ago'; let status = '⚪ Idle'; if (isProcessing) { const age = lastHeartbeat ? Math.round((Date.now() - Number(lastHeartbeat)) / 1000) : 999; if (age < 60) status = '🟢 Running'; else if (age < 120) status = '🟡 Slow'; else status = '🔴 Frozen?'; } SpreadsheetApp.getUi().alert('=== VAPI STATUS ===\n\nStatus: ' + status + '\nHeartbeat: ' + heartbeatAge + '\nActive: ' + Object.keys(active).length + '\nQueued: ' + queue.length + '\nConcurrency: ' + concurrency); }
function vapiForceRestart() { const ui = SpreadsheetApp.getUi(); if (ui.alert('Force Restart', 'Clear locks and restart?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return; const sp = PropertiesService.getScriptProperties(); const sheetId = sp.getProperty('SHEET_ID'); const sh = SpreadsheetApp.getActiveSheet(); const sheetName = sh.getName(); sp.deleteProperty(processingKey_(sheetId, sheetName)); removeWatchdog_(); let concurrency = Number(sp.getProperty(concurrencyKey_(sheetId, sheetName)) || 0); if (!concurrency) { concurrency = promptConcurrency_(ui, 'Set concurrency:', 1); if (!concurrency) return; } updateStatus_({ 'Script Status': '🔄 Restarting...', 'Last Error': '' }, sheetName); vapiStartProcessingActiveSheet_(concurrency); ui.alert('✅ Restarted.'); }

// ============================================================
// 2ND ROUND CALLING
// ============================================================
function vapiShowCallbackSummary() { const sh = SpreadsheetApp.getActiveSheet(); const cols = getHeaderMap_(sh); if (!cols.status) return SpreadsheetApp.getUi().alert('❌ Missing Status header'); const lastRow = sh.getLastRow(); if (lastRow <= HEADER_ROW_INDEX) return SpreadsheetApp.getUi().alert('No data.'); const statuses = sh.getRange(HEADER_ROW_INDEX + 1, cols.status, lastRow - HEADER_ROW_INDEX, 1).getValues(); const statusCounts = {}; statuses.forEach(function(row) { const s = String(row[0] || '').trim() || '(empty)'; statusCounts[s] = (statusCounts[s] || 0) + 1; }); let callbackCount = 0, doNotCallCount = 0; Object.entries(statusCounts).forEach(function(entry) { const n = entry[0].toLowerCase(); if (CALLBACK_WORTHY_STATUSES.some(function(s) { return n.includes(s); })) callbackCount += entry[1]; else if (DO_NOT_CALL_AGAIN_STATUSES.some(function(s) { return n.includes(s); })) doNotCallCount += entry[1]; }); const summary = Object.entries(statusCounts).sort(function(a,b){return b[1]-a[1];}).map(function(e){return '  '+e[0]+': '+e[1];}).join('\n'); SpreadsheetApp.getUi().alert('=== STATUS SUMMARY ===\n\n' + summary + '\n\n📞 Callback worthy: ' + callbackCount + '\n🚫 Do not call: ' + doNotCallCount); }

function vapiSelectForCallback() { const ui = SpreadsheetApp.getUi(); const sh = SpreadsheetApp.getActiveSheet(); const cols = getHeaderMap_(sh); if (!cols.status) return ui.alert('❌ Missing Status header'); const lastRow = sh.getLastRow(); if (lastRow <= HEADER_ROW_INDEX) return ui.alert('No data.'); const lastCol = sh.getLastColumn(); const allData = sh.getRange(HEADER_ROW_INDEX+1,1,lastRow-HEADER_ROW_INDEX,lastCol).getValues(); const rowsToSelect = []; for (let i = 0; i < allData.length; i++) { const row = allData[i]; const status = String(row[cols.status-1]||'').trim().toLowerCase(); const callbackFlag = cols.callback_flag ? String(row[cols.callback_flag-1]||'').trim().toUpperCase() : ''; if (CALLBACK_WORTHY_STATUSES.some(function(s){return status.includes(s);}) || callbackFlag === 'TRUE') rowsToSelect.push(HEADER_ROW_INDEX+1+i); } if (rowsToSelect.length === 0) return ui.alert('No rows for 2nd round.'); sh.setActiveRangeList(sh.getRangeList(rowsToSelect.map(function(r){return r+':'+r;}))); ui.alert('✅ Selected ' + rowsToSelect.length + ' rows.'); }

function vapiPrepareSecondRound() { const ui = SpreadsheetApp.getUi(); const sh = SpreadsheetApp.getActiveSheet(); const range = sh.getActiveRange(); if (!range) return ui.alert('Select rows first.'); const cols = getHeaderMap_(sh); if (!cols.status) return ui.alert('❌ Missing Status header'); if (ui.alert('Prepare 2nd Round', 'Reset call fields for ' + range.getNumRows() + ' rows?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return; const startRow = range.getRow(); const numRows = range.getNumRows(); const lastCol = sh.getLastColumn(); const allData = sh.getRange(startRow,1,numRows,lastCol).getValues(); const fieldsToClear = ['call_id','started_at','ended_at','transcript','outcome_summary','recording_url','callback_flag','callback_when','scheduled_at','scheduled_in_min','auto_followup_status','auto_followup_preview']; let count = 0; for (let i = 0; i < numRows; i++) { const rowNum = startRow+i; if (rowNum <= HEADER_ROW_INDEX) continue; allData[i][cols.status-1] = 'Queued'; if (cols.call_attempt) { allData[i][cols.call_attempt-1] = Number(allData[i][cols.call_attempt-1]||0)+1; } fieldsToClear.forEach(function(f){if(cols[f]) allData[i][cols[f]-1]='';});count++;} sh.getRange(startRow,1,numRows,lastCol).setValues(allData); for(let i=0;i<numRows;i++){const rn=startRow+i;if(rn>HEADER_ROW_INDEX)applyRowHygiene_(sh,rn,cols);} SpreadsheetApp.flush(); ui.alert('✅ Prepared '+count+' rows for 2nd round.'); }

// ============================================================
// MAIN CALLING ACTIONS
// ============================================================
function vapiCallHighlightedNow() { ensureSheetId_(); const ui = SpreadsheetApp.getUi(); const sh = SpreadsheetApp.getActiveSheet(); const range = sh.getActiveRange(); if (!range) return ui.alert('Select rows first.'); const concurrency = promptConcurrency_(ui, 'How many calls at once?', 1); if (!concurrency) return; const sp = PropertiesService.getScriptProperties(); sp.setProperty(concurrencyKey_(sp.getProperty('SHEET_ID'), sh.getName()), String(concurrency)); vapiQueueRange_(sh, range); vapiStartProcessingActiveSheet_(concurrency); }
function vapiStartProcessingActiveSheet_(concurrency) { const ss = SpreadsheetApp.getActiveSpreadsheet(); const sh = ss.getActiveSheet(); const sp = PropertiesService.getScriptProperties(); const apiKey = sp.getProperty('VAPI_API_KEY'); if (!apiKey) return SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY'); const sheetId = sp.getProperty('SHEET_ID'); const sheetName = sh.getName(); sp.setProperty(concurrencyKey_(sheetId, sheetName), String(concurrency)); updateStatus_({ 'Script Status': '🟢 Starting...', 'Concurrency Setting': concurrency, 'Campaign Sheet': sheetName, 'Processing Started': new Date() }, sheetName); processQueueForSheet_(ss, sh, apiKey, sp.getProperty('VAPI_PHONE_NUMBER_ID'), sp.getProperty('VAPI_ASSISTANT_ID'), concurrency); }

// ============================================================
// QUEUE MANAGEMENT
// ============================================================
function vapiQueueRange_(sh, range) { const sp = PropertiesService.getScriptProperties(); const sheetId = sp.getProperty('SHEET_ID'); const sheetName = sh.getName(); const cols = getHeaderMap_(sh); if (!cols.status) throw new Error('Missing Status header'); const qKey = queueKey_(sheetId, sheetName); let queue = loadJson_(sp, qKey, []); const startRow = range.getRow(); const numRows = range.getNumRows(); const statusVals = sh.getRange(startRow, cols.status, numRows, 1).getValues().map(function(r){return String(r[0]||'').trim();}); const statusOut = []; let changed = false; for (let i = 0; i < numRows; i++) { const r = startRow+i; if (r <= HEADER_ROW_INDEX) { statusOut.push([statusVals[i]]); continue; } const status = statusVals[i]; if (status && status !== 'Queued') { statusOut.push([status]); continue; } if (queue.indexOf(r) === -1) { queue.push(r); statusOut.push(['Queued']); changed = true; } else statusOut.push([status || 'Queued']); } if (changed) { sh.getRange(startRow, cols.status, numRows, 1).setValues(statusOut); queue.sort(function(a,b){return a-b;}); sp.setProperty(qKey, JSON.stringify(queue)); updateStatus_({ 'Queued Rows': queue.length }, sheetName); } }
function vapiStopQueue() { ensureSheetId_(); const sh = SpreadsheetApp.getActiveSheet(); const sp = PropertiesService.getScriptProperties(); const cols = getHeaderMap_(sh); if (!cols.status) return SpreadsheetApp.getUi().alert('❌ Missing Status header'); const sheetId = sp.getProperty('SHEET_ID'); const sheetName = sh.getName(); const lastRow = sh.getLastRow(); let changeCount = 0; if (lastRow > HEADER_ROW_INDEX) { const statusRange = sh.getRange(HEADER_ROW_INDEX+1, cols.status, lastRow-HEADER_ROW_INDEX, 1); const statuses = statusRange.getValues(); for(let i=0;i<statuses.length;i++){if(String(statuses[i][0]).trim()==='Queued'){statuses[i][0]='Cancelled';changeCount++;}} if(changeCount>0)statusRange.setValues(statuses); } sp.deleteProperty(queueKey_(sheetId,sheetName)); sp.deleteProperty(activeKey_(sheetId,sheetName)); sp.deleteProperty(processingKey_(sheetId,sheetName)); sp.deleteProperty(heartbeatKey_(sheetId,sheetName)); updateStatus_({'Script Status':'🛑 Stopped','Active Calls':0,'Queued Rows':0},sheetName); SpreadsheetApp.getUi().alert('🛑 Stopped. '+changeCount+' cancelled.'); }
function ensureScheduleColumns_(sh) { const cols = getHeaderMap_(sh); let lastCol = sh.getLastColumn(); if (!cols.scheduled_at) { lastCol++; sh.getRange(HEADER_ROW_INDEX, lastCol).setValue('scheduled_at'); } if (!cols.scheduled_in_min) { lastCol++; sh.getRange(HEADER_ROW_INDEX, lastCol).setValue('scheduled_in_min'); } }
function applyRowHygiene_(sh, rowNum, cols) { try { sh.setRowHeight(rowNum, DEFAULT_ROW_HEIGHT); [cols.prospect_name,cols.prospect_email,cols.phone,cols.status,cols.assistant,cols.vapi_number,cols.call_id,cols.outcome_summary,cols.transcript,cols.recording_url,cols.event_name,cols.event_city,cols.callback_when,cols.auto_followup_status,cols.auto_followup_preview].filter(Boolean).forEach(function(colNum){try{sh.getRange(rowNum,colNum,1,1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);}catch(e){}}); } catch(e){} }

// ============================================================
// PROCESS QUEUE — CR-04 FIX: removed duplicate budget check
// ============================================================
function processQueueForSheet_(ss, sh, apiKey, fallbackPhoneNumberId, fallbackAssistantId, concurrency) {
  const sheetName = sh.getName(); const lock = LockService.getScriptLock(); if (!lock.tryLock(5000)) { Logger.log('Could not acquire lock for '+sheetName); return; } const sp = PropertiesService.getScriptProperties(); const sheetId = sp.getProperty('SHEET_ID');
  try {
    sp.setProperty(processingKey_(sheetId,sheetName),'true'); sp.setProperty(processingStartKey_(sheetId,sheetName),String(Date.now())); const cols = getHeaderMap_(sh);
    const required = ['phone','status','call_id','started_at','prospect_name','prospect_email','event_name','event_date','event_city','caller_name','host_name','host_first_name','host_pronouns','event_time','event_format','target_audience','event_area','event_venue','voicemail_left_count','callback_flag','callback_when'];
    const missing = required.filter(function(k){return !cols[k];}); if (missing.length) { updateStatus_({'Script Status':'❌ Missing headers','Last Error':missing.join(', ')},sheetName); return; }
    const qKey = queueKey_(sheetId,sheetName); const aKey = activeKey_(sheetId,sheetName); let queue = loadJson_(sp,qKey,[]); let active = loadJson_(sp,aKey,{}); queue.sort(function(a,b){return a-b;}); active = cleanupStaleActive_(sh,active); sp.setProperty(aKey,JSON.stringify(active)); const lastCol = sh.getLastColumn(); recordHeartbeat_(sheetId,sheetName);
    const batchConfigs = {}; const allProps = sp.getProperties();
    for (const key in allProps) { if (!key.startsWith('MULTI_ROUND_')) continue; try { const config = JSON.parse(allProps[key]); if (config.sheetName === sheetName) batchConfigs[config.batchId] = config; } catch(e){} }
    for (const key in allProps) { if (!key.startsWith('SECOND_ROUND_')) continue; try { const config = JSON.parse(allProps[key]); if (config.sheetName === sheetName) batchConfigs[config.batchId] = config; } catch(e){} }
    let callsMade = 0; const startTime = Date.now();
    if (!isUnderBudget_()) { updateStatus_({'Script Status':'💰 Daily budget reached ($'+getDailySpend_().toFixed(2)+'/$'+DAILY_BUDGET_USD+')'},sheetName); sp.setProperty(qKey,JSON.stringify(queue)); return; }
    while (Object.keys(active).length < concurrency && queue.length > 0) {
      if (Date.now()-startTime > MAX_PROCESSING_TIME_MS) { updateStatus_({'Script Status':'⚠️ Timeout'},sheetName); break; }
      recordHeartbeat_(sheetId,sheetName); const rowNum = queue.shift(); const rowVals = sh.getRange(rowNum,1,1,lastCol).getValues()[0]; const phone = normalizePhone_(rowVals[cols.phone-1]);
      if (!phone) { sh.getRange(rowNum,cols.status).setValue('Skipped: Invalid Phone'); applyRowHygiene_(sh,rowNum,cols); continue; }
      const rowBatchId = cols.batch_id ? String(rowVals[cols.batch_id-1]||'').trim() : ''; const baseBatchId = rowBatchId.replace(/_R\d+$/,''); const batchConfig = batchConfigs[baseBatchId] || null;
      let assistantName = '', assistantId = '';
      if (batchConfig && batchConfig.assistant) { assistantName = batchConfig.assistant; if (batchConfig.retryAssistant && rowBatchId !== baseBatchId) { const currentAttempt = cols.call_attempt ? Number(rowVals[cols.call_attempt-1]||1):1; if (currentAttempt>1) assistantName = batchConfig.retryAssistant; } assistantId = resolveAssistantIdFromName_(ss,assistantName,fallbackAssistantId); } else if (cols.assistant) { assistantName = String(rowVals[cols.assistant-1]||'').trim(); assistantId = resolveAssistantIdFromName_(ss,assistantName,fallbackAssistantId); } else { assistantId = fallbackAssistantId; }
      if (!assistantId) { sh.getRange(rowNum,cols.status).setValue('Skipped: No Assistant'); applyRowHygiene_(sh,rowNum,cols); continue; }
      let phoneNumberDisplay = '', phoneNumberId = '';
      if (batchConfig && batchConfig.phoneNumber) { phoneNumberDisplay = batchConfig.phoneNumber; phoneNumberId = resolvePhoneNumberIdFromDisplay_(ss,phoneNumberDisplay,fallbackPhoneNumberId); } else if (cols.vapi_number) { phoneNumberDisplay = String(rowVals[cols.vapi_number-1]||'').trim(); phoneNumberId = resolvePhoneNumberIdFromDisplay_(ss,phoneNumberDisplay,fallbackPhoneNumberId); } else { phoneNumberId = fallbackPhoneNumberId; }
      if (!phoneNumberId) { sh.getRange(rowNum,cols.status).setValue('Skipped: No Vapi Number'); applyRowHygiene_(sh,rowNum,cols); continue; }
      const eventDateStr = formatEventDate_(rowVals[cols.event_date-1]); const eventTimeStr = formatEventTime_(rowVals[cols.event_time-1]); const eventArea = String(rowVals[cols.event_area-1]||'').trim() || String(rowVals[cols.event_city-1]||'').trim(); const eventVenue = String(rowVals[cols.event_venue-1]||'').trim(); const voicemailLeftCount = Number(rowVals[cols.voicemail_left_count-1]||0)||0;
      const variableValues = { prospect_name: String(rowVals[cols.prospect_name-1]||'').trim(), prospect_email: String(rowVals[cols.prospect_email-1]||'').trim(), event_name: String(rowVals[cols.event_name-1]||'').trim(), event_date: eventDateStr, event_city: String(rowVals[cols.event_city-1]||'').trim(), event_area: eventArea, event_venue: eventVenue, caller_name: String(rowVals[cols.caller_name-1]||'Alex').trim(), host_name: String(rowVals[cols.host_name-1]||'').trim(), host_first_name: String(rowVals[cols.host_first_name-1]||'').trim(), host_pronouns: String(rowVals[cols.host_pronouns-1]||'they/them').trim(), event_time: eventTimeStr, event_format: String(rowVals[cols.event_format-1]||'').trim(), event_context: cols.event_context ? String(rowVals[cols.event_context-1]||'').trim() : '', target_audience: String(rowVals[cols.target_audience-1]||'').trim(), leave_voicemail: voicemailLeftCount >= 1 ? 'no' : 'yes', voicemail_action: voicemailLeftCount >= 1 ? 'hang_up_immediately' : 'leave_message', voicemail_left_count: String(voicemailLeftCount) };
      const payload = { assistantId: assistantId, phoneNumberId: phoneNumberId, customer: { number: phone, name: variableValues.prospect_name }, metadata: { sheetName: sheetName, rowNum: rowNum }, assistantOverrides: { variableValues: variableValues } };
      try { const call = vapiCreateCall_(apiKey, payload); if (call && call.id) { active[call.id] = rowNum; sh.getRange(rowNum,cols.call_id).setValue(call.id); sh.getRange(rowNum,cols.status).setValue('Calling...'); sh.getRange(rowNum,cols.started_at).setValue(new Date()); applyRowHygiene_(sh,rowNum,cols); callsMade++; if (!isUnderBudget_()) { Logger.log('Daily budget reached'); break; } updateStatus_({'Script Status':'🟢 Running ('+callsMade+' calls)','Active Calls':Object.keys(active).length},sheetName); } else { sh.getRange(rowNum,cols.status).setValue('Error: No call.id'); applyRowHygiene_(sh,rowNum,cols); } } catch(err) { sh.getRange(rowNum,cols.status).setValue('Error: '+(err.message||String(err)).slice(0,100)); applyRowHygiene_(sh,rowNum,cols); updateStatus_({'Last Error':'Row '+rowNum+': '+(err.message||'').slice(0,200)},sheetName); }
      Utilities.sleep(500);
    }
    sp.setProperty(qKey,JSON.stringify(queue)); sp.setProperty(aKey,JSON.stringify(active));
    const activeCount = Object.keys(active).length; const queuedCount = queue.length;
    if (activeCount===0 && queuedCount===0) { updateStatus_({'Script Status':'✅ Complete','Active Calls':0,'Queued Rows':0},sheetName); sp.deleteProperty(processingKey_(sheetId,sheetName)); autoSortIfBatchComplete_(sheetId,sheetName); }
    else updateStatus_({'Script Status':'🟢 Running ('+activeCount+' active, '+queuedCount+' queued)','Active Calls':activeCount,'Queued Rows':queuedCount},sheetName);
  } catch(err) { updateStatus_({'Script Status':'❌ Error','Last Error':err.message||String(err)},sheetName); throw err; }
  finally { lock.releaseLock(); }
}
function cleanupStaleActive_(sh, activeMap) { const cols = getHeaderMap_(sh); if (!cols.started_at || !cols.status) return activeMap || {}; const now = Date.now(); const cleaned = {}; Object.entries(activeMap||{}).forEach(function(entry) { const callId = entry[0], rowNum = entry[1]; try { const r = Number(rowNum); if (!r || r <= HEADER_ROW_INDEX) return; const startedAt = sh.getRange(r,cols.started_at).getValue(); const status = String(sh.getRange(r,cols.status).getValue()||'').trim(); if (!(startedAt instanceof Date)) { if (status==='Calling...') { sh.getRange(r,cols.status).setValue('Auto-cleared'); applyRowHygiene_(sh,r,cols); } return; } const ageMin = (now-startedAt.getTime())/60000; if (ageMin < STALE_ACTIVE_MINUTES && status==='Calling...') { cleaned[callId] = r; return; } if (status==='Calling...') { sh.getRange(r,cols.status).setValue('Auto-cleared (stale)'); applyRowHygiene_(sh,r,cols); } } catch(e){} }); return cleaned; }

// ============================================================
// WEBHOOK (doPost) — CR-01 + CR-05 FIX: Lock + Validation + Idempotency
// ============================================================
function doPost(e) {
  const sp = PropertiesService.getScriptProperties(); const sheetId = sp.getProperty('SHEET_ID'); let sheetName = null;
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) return ContentService.createTextOutput('Ignored: empty');
    let body; try { body = JSON.parse(raw); } catch(parseErr) { return ContentService.createTextOutput('OK'); }
    const msg = body.message || body || {};
    const type = String(msg.type || (msg.message ? msg.message.type : '') || '').trim();
    const isEnd = (type==='end-of-call-report' || type==='call-ended' || type==='call.ended');
    if (!isEnd) return ContentService.createTextOutput('Ignored: '+(type||'no-type'));
    const call = msg.call || (msg.message ? msg.message.call : {}) || {};
    const meta = call.metadata || msg.metadata || (msg.message ? msg.message.metadata : {}) || {};
    const callId = String(call.id || msg.callId || (msg.message ? msg.message.callId : '') || '').trim();
    if (!callId || !sheetId) return ContentService.createTextOutput('OK');
    // Idempotency: skip duplicate webhooks from VAPI retries
    const idempotencyKey = 'WEBHOOK_PROCESSED__' + callId;
    if (sp.getProperty(idempotencyKey)) return ContentService.createTextOutput('OK');
    const ss = SpreadsheetApp.openById(sheetId); let sh = null; let rowNum = Number(meta.rowNum||0);
    if (meta.sheetName) sh = ss.getSheetByName(meta.sheetName);
    if (!sh || !rowNum) { for (let i=0;i<ss.getSheets().length;i++) { const candidate = ss.getSheets()[i]; const r = findRowByCallId_(candidate,callId); if (r) { sh=candidate; rowNum=r; break; } } }
    if (!sh || !rowNum) return ContentService.createTextOutput('Error: Could not locate row');
    sheetName = sh.getName(); const cols = getHeaderMap_(sh); if (!cols.status) return ContentService.createTextOutput('Error: Missing Status header');
    const transcript = (msg.artifact?msg.artifact.transcript:'') || (msg.message&&msg.message.artifact?msg.message.artifact.transcript:'') || (call.artifact?call.artifact.transcript:'') || '';
    const recordingUrl = (msg.artifact?(msg.artifact.recordingUrl||msg.artifact.recording_url):'') || (msg.message&&msg.message.artifact?msg.message.artifact.recordingUrl:'') || (call.artifact?call.artifact.recordingUrl:'') || '';
    let summary = (msg.analysis?msg.analysis.summary:'') || (msg.message&&msg.message.analysis?msg.message.analysis.summary:'') || (call.analysis?call.analysis.summary:'') || '';
    let startedAt = null; if (cols.started_at) { const v = sh.getRange(rowNum,cols.started_at).getValue(); if (v instanceof Date) startedAt = v; }
    const extracted = extractStructured_(msg);
    if (!extracted.corrected_email && transcript) { const emailFromTranscript = extractCorrectedEmailFromTranscript_(transcript); if (emailFromTranscript) extracted.corrected_email = emailFromTranscript; }
    if (cols.corrected_email && extracted.corrected_email) { const originalEmail = cols.prospect_email ? String(sh.getRange(rowNum,cols.prospect_email).getValue()||'').trim().toLowerCase() : ''; if (extracted.corrected_email !== originalEmail) sh.getRange(rowNum,cols.corrected_email).setValue(extracted.corrected_email); }
    if (extracted.callback_requested && extracted.callback_when) { const tag = 'Callback requested: '+extracted.callback_when; const s = String(summary||'').trim(); if (s.toLowerCase().indexOf('callback requested')===-1) summary = s?(tag+' | '+s):tag; }
    if (detectNumberFailed_(transcript,summary)) { const s = String(summary||'').trim(); if (s.toLowerCase().indexOf('number failed')===-1) summary = 'Number failed: '+(s||'Call could not be completed.'); }
    const batchId = cols.batch_id ? String(sh.getRange(rowNum,cols.batch_id).getValue()||'').trim() : '';
    const isSecondRound = batchId.endsWith('_R2');
    const callAttempt = cols.call_attempt ? Number(sh.getRange(rowNum,cols.call_attempt).getValue()||0) : 0;
    const currentVoicemailCount = cols.voicemail_left_count ? Number(sh.getRange(rowNum,cols.voicemail_left_count).getValue()||0) : 0;
    let previousStatus = ''; if (isSecondRound) previousStatus = currentVoicemailCount >= 1 ? 'Voicemail' : 'No Answer';
    const statusValue = determineStatus_(msg,transcript,summary,startedAt,{isSecondRound:isSecondRound,callAttempt:callAttempt,voicemailLeftCount:currentVoicemailCount,previousStatus:previousStatus});
    let leadQuality = ''; if (extracted.success===true) leadQuality='GOOD'; else if (extracted.success===false) leadQuality='BAD'; else leadQuality = calculateLeadQuality_(statusValue,extracted.outcome,extracted.callback_requested,summary+' '+transcript);
    if (statusValue==='Voicemail' && cols.voicemail_left_count) { sh.getRange(rowNum,cols.voicemail_left_count).setValue(Number(sh.getRange(rowNum,cols.voicemail_left_count).getValue()||0)+1); }
    if (cols.call_attempt) { if (Number(sh.getRange(rowNum,cols.call_attempt).getValue()||0)===0) sh.getRange(rowNum,cols.call_attempt).setValue(1); }
    let finalStatus = statusValue; if (cols.call_attempt) { const attempt = Number(sh.getRange(rowNum,cols.call_attempt).getValue()||1); if (attempt > 1) finalStatus = statusValue + getRoundSuffix_(attempt); }
    sh.getRange(rowNum,cols.status).setValue(finalStatus);
    if (cols.ended_at) sh.getRange(rowNum,cols.ended_at).setValue(new Date());
    if (cols.outcome_summary) sh.getRange(rowNum,cols.outcome_summary).setValue(summary||'');
    if (cols.transcript) sh.getRange(rowNum,cols.transcript).setValue(transcript||'');
    if (cols.recording_url) sh.getRange(rowNum,cols.recording_url).setValue(recordingUrl||'');
    if (callId) { const apiKey = sp.getProperty('VAPI_API_KEY'); const cost = getCallCostFromVapi_(apiKey,callId); if (cost>0) { addToDailySpend_(cost); Logger.log('Call cost: $'+cost.toFixed(4)+' | Daily: $'+getDailySpend_().toFixed(2)); } }
    if (cols.lead_quality) sh.getRange(rowNum,cols.lead_quality).setValue(leadQuality||'');
    if (cols.next_round_at) { if (shouldSkipStatus_(getBaseStatus_(finalStatus))) sh.getRange(rowNum,cols.next_round_at).setValue('⏭️ To be Skipped'); }
    applyRowHygiene_(sh,rowNum,cols);
    // Auto follow-up trigger
    if (AUTO_FOLLOWUP_TRIGGER_STATUSES.indexOf(statusValue) !== -1) {
      const lastCol = sh.getLastColumn(); const rowVals = sh.getRange(rowNum,1,1,lastCol).getValues()[0];
      const originalEmail = cols.prospect_email ? String(rowVals[cols.prospect_email-1]||'').trim() : ''; const emailToUse = extracted.corrected_email || originalEmail;
      let emailVerificationScore = null; if (cols.email_verification) { emailVerificationScore = Number(rowVals[cols.email_verification-1]); if (isNaN(emailVerificationScore)) emailVerificationScore = null; }
      scheduleAutoFollowup_(sheetId,sheetName,rowNum,statusValue,{ prospectName: cols.prospect_name?String(rowVals[cols.prospect_name-1]||'').trim():'', prospectEmail: emailToUse, phone: cols.phone?normalizePhone_(rowVals[cols.phone-1]):'', eventName: cols.event_name?String(rowVals[cols.event_name-1]||'').trim():'', eventDate: cols.event_date?formatEventDate_(rowVals[cols.event_date-1]):'', eventCity: cols.event_city?String(rowVals[cols.event_city-1]||'').trim():'', eventTime: cols.event_time?formatEventTime_(rowVals[cols.event_time-1]):'', eventVenue: cols.event_venue?String(rowVals[cols.event_venue-1]||'').trim():'', callerName: cols.caller_name?String(rowVals[cols.caller_name-1]||'').trim():'', hostName: cols.host_name?String(rowVals[cols.host_name-1]||'').trim():'', batchId: cols.batch_id?String(rowVals[cols.batch_id-1]||'').trim():'', emailVerificationScore: emailVerificationScore });
    }
    // CR-01 FIX: Lock the shared active/queue state update
    let needsMoreProcessing = false, isComplete = false, concurrency = 1;
    const criticalLock = LockService.getScriptLock(); const hasLock = criticalLock.tryLock(15000);
    if (!hasLock) Logger.log('WARNING: doPost could not acquire lock after 15s for call '+callId);
    try {
      const aKey = activeKey_(sheetId,sheetName); let active = loadJson_(sp,aKey,{});
      if (callId && active[callId]) { delete active[callId]; sp.setProperty(aKey,JSON.stringify(active)); }
      concurrency = Number(sp.getProperty(concurrencyKey_(sheetId,sheetName))||0); if (!concurrency) concurrency = Number(sp.getProperty(schedConcurrencyKey_(sheetId))||1); if (concurrency<1) concurrency=1;
      const queue = loadJson_(sp,queueKey_(sheetId,sheetName),[]); const activeCount = Object.keys(active).length; const queueCount = queue.length;
      updateStatus_({'Active Calls':activeCount,'Queued Rows':queueCount},sheetName);
      needsMoreProcessing = (queueCount>0 && activeCount<concurrency); isComplete = (queueCount===0 && activeCount===0);
    } finally { if (hasLock) criticalLock.releaseLock(); }
    sp.setProperty(idempotencyKey, String(Date.now()));
    if (needsMoreProcessing) processQueueForSheet_(ss,sh,sp.getProperty('VAPI_API_KEY'),sp.getProperty('VAPI_PHONE_NUMBER_ID'),sp.getProperty('VAPI_ASSISTANT_ID'),concurrency);
    if (isComplete) { updateStatus_({'Script Status':'✅ Complete','Active Calls':0,'Queued Rows':0},sheetName); sp.deleteProperty(processingKey_(sheetId,sheetName)); autoSortIfBatchComplete_(sheetId,sheetName); }
    return ContentService.createTextOutput('OK');
  } catch(err) { if (sheetName) updateStatus_({'Last Error':'Webhook: '+(err.message||String(err))},sheetName); Logger.log('doPost ERROR: '+(err.message||String(err))); return ContentService.createTextOutput('OK'); }
}
function doGet() { return ContentService.createTextOutput('OK - Web App reachable'); }

// ============================================================
// STATUS LOGIC
// ============================================================
function determineStatus_(msg, transcript, summary, startedAt, context) {
  context = context || {}; const extracted = extractStructured_(msg); const fromVapi = normalizeStatus_(extracted.call_status);
  const tRaw = String(transcript||'').trim(); const sRaw = String(summary||'').trim(); const t = tRaw.toLowerCase(); const s = sRaw.toLowerCase();
  let durationSec = null; if (startedAt instanceof Date) durationSec = Math.round((Date.now()-startedAt.getTime())/1000);
  const hasVoicemailIndicator = s.indexOf('voicemail')!==-1||t.indexOf('voicemail')!==-1||t.indexOf('leave a message')!==-1||t.indexOf('after the beep')!==-1||t.indexOf('after the tone')!==-1||t.indexOf('not available')!==-1;
  const automatedPhrases = ['please leave','after the','beep','tone','not available','voicemail','message','record your'];
  const hasOnlyAutomated = automatedPhrases.some(function(phrase){return t.indexOf(phrase)!==-1;});
  if (fromVapi) return getBaseStatus_(fromVapi);
  const gatekeeperResult = detectAiGatekeeper_(tRaw); if (gatekeeperResult.detected && gatekeeperResult.rejected) return 'AI Gatekeeper';
  if (detectNumberFailed_(tRaw,sRaw)) return 'Number Failed';
  if (hasVoicemailIndicator) return 'Voicemail';
  if (durationSec!==null && durationSec<=30 && tRaw.length>0) { if (tRaw.length<100||hasOnlyAutomated) return 'No Answer'; return 'Hung Up (≤30s)'; }
  if (!tRaw) return 'No Answer'; if (tRaw.length<100||hasOnlyAutomated) return 'No Answer';
  return 'Spoke to Human';
}
function normalizeStatus_(s) { const v = String(s||'').trim().toLowerCase(); if (!v) return ''; if (v.indexOf('ai gatekeeper')!==-1) return 'AI Gatekeeper'; if (v.indexOf('spoke')!==-1) return 'Spoke to Human'; if (v.indexOf('voicemail')!==-1) return 'Voicemail'; if (v.indexOf('number failed')!==-1||v.indexOf('invalid')!==-1||v.indexOf('not in service')!==-1||v.indexOf('disconnected')!==-1) return 'Number Failed'; if (v.indexOf('no answer')!==-1||v.indexOf('no_answer')!==-1) return 'No Answer'; if (v.indexOf('hung up')!==-1||v.indexOf('hangup')!==-1||v.indexOf('≤30')!==-1) return 'Hung Up (≤30s)'; return ''; }
function extractStructured_(msg) {
  const out = { call_status:'', callback_requested:false, callback_when:'', success:null, outcome:'', corrected_email:'' };
  const analysis = msg.analysis || (msg.message ? msg.message.analysis : null);
  const candidates = [analysis?analysis.structuredData:null, analysis?analysis.structured_data:null, analysis?analysis.json:null, analysis?analysis.extraction:null, analysis?analysis.extractions:null, analysis?analysis.output:null, analysis].filter(Boolean);
  let data = null; for (let i=0;i<candidates.length;i++) { const c = candidates[i]; if (typeof c==='string') { try { const parsed = JSON.parse(c); if (parsed&&typeof parsed==='object') { data=parsed; break; } } catch(e){} } else if (c&&typeof c==='object') { data=c; break; } }
  if (data&&typeof data==='object') {
    const cs = data.call_status||data.callStatus||data['call status']||data.status; if (typeof cs==='string') out.call_status = cs.trim();
    const cr = data.callback_requested||data.callbackRequested||data['callback requested']; if (typeof cr==='boolean') out.callback_requested=cr; if (typeof cr==='string') out.callback_requested=cr.trim().toLowerCase()==='true';
    const cw = data.callback_when||data.callbackWhen||data['callback when']; if (typeof cw==='string') out.callback_when=cw.trim();
    const sf = data.success||data.Success||data['Success Evaluation - Pass/Fail']||data['Success Evaluation']||data.successEvaluation||data.result||data.passed||data.pass||data.evaluation; if (typeof sf==='boolean') out.success=sf; else if (typeof sf==='string') { const val=sf.trim().toLowerCase(); if (val==='true'||val==='yes'||val==='pass'||val==='good') out.success=true; else if (val==='false'||val==='no'||val==='fail'||val==='bad') out.success=false; }
    const oc = data.outcome||data.Outcome; if (typeof oc==='string') out.outcome=oc.trim();
    const ce = data.corrected_email||data.correctedEmail||data['corrected email']||data.new_email||data.newEmail||data['new email']||data.updated_email||data.updatedEmail||data['updated email']||data.email_correction||data.emailCorrection; if (typeof ce==='string'&&ce.includes('@')) out.corrected_email=ce.trim().toLowerCase();
  }
  if (!out.corrected_email) { const transcript = (msg.artifact?msg.artifact.transcript:'') || (msg.message&&msg.message.artifact?msg.message.artifact.transcript:'') || ''; const extractedEmail = extractEmailFromTranscript_(transcript); if (extractedEmail) out.corrected_email = extractedEmail; }
  return out;
}
function extractCorrectedEmailFromTranscript_(transcript) { if (!transcript) return ''; const t = String(transcript).toLowerCase(); const pattern = /(?:send\s+(?:it\s+)?to|it'?s|email\s+is|address\s+is|to)\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+at\s+([a-z0-9]+(?:\s+[a-z0-9]+)*)\s+dot\s+([a-z]+)/gi; let match; while ((match=pattern.exec(t))!==null) { const email = match[1].replace(/\s+/g,'')+('@')+match[2].replace(/\s+/g,'')+'.'+match[3].replace(/\s+/g,''); if (email.length>5) return email.toLowerCase(); } const standardMatch = t.match(/([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi); if (standardMatch&&standardMatch.length>0) return standardMatch[standardMatch.length-1].toLowerCase(); return ''; }
function extractEmailFromTranscript_(transcript) { if (!transcript) return ''; const t = String(transcript).toLowerCase(); const correctionPatterns = [/(?:no[,.]?\s*)?(?:actually[,.]?\s*)?(?:it'?s|my email is|send (?:it |the )?(?:details |invite |invitation )?to)\s+([a-z0-9][a-z0-9._%+-]*\s*(?:at|@)\s*[a-z0-9][a-z0-9.-]*\s*(?:dot|\.)\s*[a-z]{2,})/gi, /(?:email is|address is|send to|mail to)\s+([a-z0-9][a-z0-9._%+-]*\s*(?:at|@)\s*[a-z0-9][a-z0-9.-]*\s*(?:dot|\.)\s*[a-z]{2,})/gi]; for (const pattern of correctionPatterns) { const matches = t.matchAll(pattern); for (const match of matches) { if (match[1]) { const found = normalizeSpokenEmail_(match[1]); if (found) return found; } } } return ''; }
function normalizeSpokenEmail_(spokenEmail) { if (!spokenEmail) return ''; let email = String(spokenEmail).toLowerCase().trim().replace(/\s+at\s+/g,'@').replace(/\s+dot\s+/g,'.').replace(/\s+dash\s+/g,'-').replace(/\s+underscore\s+/g,'_').replace(/\s+/g,''); if (email.includes('@')&&email.includes('.')&&email.length>5) { if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return email; } return ''; }
function calculateLeadQuality_(status, outcome, callbackRequested, summaryAndTranscript) { const s = String(status||'').toLowerCase(); const o = String(outcome||'').toLowerCase(); const text = String(summaryAndTranscript||'').toLowerCase(); const declinePhrases=['not interested','no thanks','no thank you',"don't call",'dont call','stop calling','remove me','take me off','not for me',"i'm good",'no need','declined','rejected',"don't contact",'dont contact','leave me alone']; const interestPhrases=['interested','sounds good','sounds great','tell me more','send it','resend','bump the email','bump it',"i'll look",'i will look',"i'll check",'i will check','yes','sure','okay',"i'd love",'i would love','count me in','sign me up']; if(s.indexOf('number failed')!==-1||s.indexOf('hung up')!==-1)return'BAD'; if(o.indexOf('declined')!==-1||o.indexOf('remove')!==-1||o.indexOf('not interested')!==-1)return'BAD'; for(let i=0;i<declinePhrases.length;i++){if(text.indexOf(declinePhrases[i])!==-1)return'BAD';} if(callbackRequested||o.indexOf('interested')!==-1||o.indexOf('callback')!==-1)return'GOOD'; for(let i=0;i<interestPhrases.length;i++){if(text.indexOf(interestPhrases[i])!==-1)return'GOOD';} if(s.indexOf('voicemail')!==-1||s.indexOf('no answer')!==-1)return'GOOD'; if(s.indexOf('ai gatekeeper')!==-1)return'BAD'; if(s.indexOf('spoke to human')!==-1)return'BAD'; return'BAD'; }
function detectAiGatekeeper_(transcript) { const t = String(transcript||'').toLowerCase().replace(/['']/g,"'").replace(/[^a-z0-9\s']/g,' ').replace(/\s+/g,' ').trim(); const g=["record your name","reason for calling","see if this person is available"]; const r=["this person is not available","leave an additional message","please reply after the tone","not available right now","cannot take your call","is not available if you would like"]; let detected=true; for(let i=0;i<g.length;i++){if(t.indexOf(g[i])===-1){detected=false;break;}} let rejected=false; for(let i=0;i<r.length;i++){if(t.indexOf(r[i])!==-1){rejected=true;break;}} return{detected:detected,rejected:rejected}; }
function detectNumberFailed_(transcript, summary) { const text = (String(summary||'')+' '+String(transcript||'')).toLowerCase(); const patterns=['number is not in service','not in service','invalid number','call could not be completed','could not be completed','failed to connect','connection failed','twilio connection failed','unallocated number','disconnected','no route to destination','carrier error','sip error','hangup cause']; for(let i=0;i<patterns.length;i++){if(text.indexOf(patterns[i])!==-1)return true;} return false; }
function findRowByCallId_(sh, callId) { if (!callId) return 0; const cols = getHeaderMap_(sh); if (!cols.call_id) return 0; const lastRow = sh.getLastRow(); if (lastRow<=HEADER_ROW_INDEX) return 0; const values = sh.getRange(HEADER_ROW_INDEX+1,cols.call_id,lastRow-HEADER_ROW_INDEX,1).getValues(); for(let i=0;i<values.length;i++){if(String(values[i][0]||'').trim()===callId)return HEADER_ROW_INDEX+1+i;} return 0; }

// ============================================================
// VAPI API & RESOLVERS
// ============================================================
function vapiCreateCall_(apiKey, payload) { const res = UrlFetchApp.fetch('https://api.vapi.ai/call',{method:'post',contentType:'application/json',headers:{Authorization:'Bearer '+apiKey},payload:JSON.stringify(payload),muteHttpExceptions:true}); if(res.getResponseCode()>=300)throw new Error(res.getContentText().slice(0,300)); return JSON.parse(res.getContentText()); }
function resolveAssistantIdFromName_(ss, name, fallback) { const target = String(name||'').trim(); if (target) { const aSh = ss.getSheetByName(ASSISTANTS_SHEET_NAME); if (aSh) { const vals = aSh.getDataRange().getValues(); for(let i=1;i<vals.length;i++){if(String(vals[i][0]).trim()===target)return String(vals[i][1]).trim();} } } return fallback?String(fallback).trim():''; }
function resolvePhoneNumberIdFromDisplay_(ss, display, fallback) { const target = String(display||'').trim(); if (target) { const pSh = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME); if (pSh) { const vals = pSh.getDataRange().getValues(); for(let i=1;i<vals.length;i++){if(String(vals[i][0]).trim()===target)return String(vals[i][2]).trim();} } } return fallback?String(fallback).trim():''; }
function vapiRefreshAssistantDropdown() { ensureSheetId_(); const ss = SpreadsheetApp.getActiveSpreadsheet(); const sh = ss.getActiveSheet(); const sp = PropertiesService.getScriptProperties(); const apiKey = sp.getProperty('VAPI_API_KEY'); if (!apiKey) return SpreadsheetApp.getUi().alert('❌ Missing VAPI_API_KEY'); const cols = getHeaderMap_(sh); if (!cols.assistant) return SpreadsheetApp.getUi().alert('❌ Missing Assistant header'); try { const res = UrlFetchApp.fetch('https://api.vapi.ai/assistant',{method:'get',headers:{Authorization:'Bearer '+apiKey},muteHttpExceptions:true}); const assistants = JSON.parse(res.getContentText()); const arr = Array.isArray(assistants)?assistants:(assistants.data||[]); let aSh = ss.getSheetByName(ASSISTANTS_SHEET_NAME)||ss.insertSheet(ASSISTANTS_SHEET_NAME); aSh.clear().getRange(1,1,1,2).setValues([['Name','ID']]); if(arr.length){const rows=arr.map(function(a){return[String(a.name||a.id).trim(),String(a.id).trim()];}); aSh.getRange(2,1,rows.length,2).setValues(rows); const rule=SpreadsheetApp.newDataValidation().requireValueInRange(aSh.getRange(2,1,rows.length,1),true).build(); sh.getRange(HEADER_ROW_INDEX+1,cols.assistant,sh.getMaxRows()-HEADER_ROW_INDEX,1).setDataValidation(rule); SpreadsheetApp.getUi().alert('✅ Assistants updated.');} else SpreadsheetApp.getUi().alert('⚠️ No assistants.'); } catch(e){SpreadsheetApp.getUi().alert('Error: '+e.message);} }
function vapiRefreshPhoneNumberDropdown() { ensureSheetId_(); const ss = SpreadsheetApp.getActiveSpreadsheet(); const sh = ss.getActiveSheet(); const cols = getHeaderMap_(sh); if (!cols.vapi_number) return SpreadsheetApp.getUi().alert('❌ Missing "Vapi number" header'); let pSh = ss.getSheetByName(PHONE_NUMBERS_SHEET_NAME)||ss.insertSheet(PHONE_NUMBERS_SHEET_NAME); pSh.clear().getRange(1,1,1,3).setValues([['Display','E164','ID']]); const rows = VAPI_PHONE_NUMBERS.map(function(x){return[x.display,x.e164,x.id];}); pSh.getRange(2,1,rows.length,3).setValues(rows); const rule = SpreadsheetApp.newDataValidation().requireValueInRange(pSh.getRange(2,1,rows.length,1),true).build(); sh.getRange(HEADER_ROW_INDEX+1,cols.vapi_number,sh.getMaxRows()-HEADER_ROW_INDEX,1).setDataValidation(rule); SpreadsheetApp.getUi().alert('✅ Phone numbers updated.'); }

// ============================================================
// OUTREACH WIZARDS
// ============================================================
function openEmailWizard() { HtmlService.createHtmlOutputFromFile("EmailWizard").setWidth(520).setHeight(620); SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutputFromFile("EmailWizard").setWidth(520).setHeight(620), "Follow-up Email Wizard"); }
function getEmailWizardPreview() { return _buildOutreachPreview_("email"); }
function sendEmailsFromWizard(payload) { if(!payload||!Array.isArray(payload.candidates))throw new Error("Invalid payload."); const subject=(payload.subject||"").trim()||"Quick follow-up"; const bodyTemplate=(payload.body||"").trim()||"Hi {{name}},\n\nJust tried to reach you.\n\nBest,\n{{sender}}"; const sent=[],failed=[]; payload.candidates.forEach(function(c){try{const to=_s_(c.recipient);if(!to||to.indexOf("@")===-1)throw new Error("Invalid email");const name=_s_(c.prospectName)||"there";const sender=_s_(c.callerName)||(Session.getActiveUser().getEmail()||"Me");const body=bodyTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender);GmailApp.sendEmail(to,subject,body);sent.push({row:c.row,recipient:to});var batchId=_s_(c.batchId);if(batchId)logToProjectTagSheet_(to,batchId);}catch(e){failed.push({row:c.row,recipient:c.recipient,error:String(e.message||e)});}}); return{sentCount:sent.length,failedCount:failed.length,sent:sent,failed:failed}; }
function openSmsWizard() { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutputFromFile("SmsWizard").setWidth(520).setHeight(720), "Follow-up SMS Wizard"); }
function getSmsWizardPreview() { return _buildOutreachPreview_("sms"); }
function sendSmsFromWizard(payload) { if(!payload||!Array.isArray(payload.candidates))throw new Error("Invalid payload."); const props=PropertiesService.getScriptProperties(); const sid=props.getProperty("TWILIO_ACCOUNT_SID"); const token=props.getProperty("TWILIO_AUTH_TOKEN"); const fromNumber=props.getProperty("TWILIO_FROM_NUMBER"); if(!sid||!token||!fromNumber)throw new Error("Missing Twilio Script Properties"); const smsTemplate=(payload.body||"").trim()||"Hi {{name}} — it's {{sender}}. Tried to reach you."; const sent=[],failed=[]; payload.candidates.forEach(function(c){try{const to=_s_(c.recipient);if(!to||to.indexOf("+")!==0)throw new Error("Invalid phone");if(wasMessagedThisWeek_(to))throw new Error("Skipped: SMS sent within 7d");const name=_s_(c.prospectName)||"there";const sender=_s_(c.callerName)||"me";_twilioSendSms_(sid,token,fromNumber,to,smsTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender));sent.push({row:c.row,recipient:to});}catch(e){failed.push({row:c.row,recipient:c.recipient,error:String(e.message||e)});}}); return{sentCount:sent.length,failedCount:failed.length,sent:sent,failed:failed}; }
function _twilioSendSms_(sid, token, fromNumber, toNumber, body) { const url="https://api.twilio.com/2010-04-01/Accounts/"+encodeURIComponent(sid)+"/Messages.json"; const res=UrlFetchApp.fetch(url,{method:"post",muteHttpExceptions:true,payload:{From:fromNumber,To:toNumber,Body:body},headers:{Authorization:"Basic "+Utilities.base64Encode(sid+":"+token)}}); const code=res.getResponseCode(); if(code<200||code>=300)throw new Error("Twilio error "+code+": "+res.getContentText()); }
function openBothWizard() { SpreadsheetApp.getUi().showModalDialog(HtmlService.createHtmlOutputFromFile("BothWizard").setWidth(560).setHeight(760), "Follow-up Email + SMS Wizard"); }
function getBothWizardPreview() { return _buildOutreachPreview_("both"); }
function sendBothFromWizard(payload) { if(!payload||!Array.isArray(payload.candidates))throw new Error("Invalid payload."); const props=PropertiesService.getScriptProperties(); const sid=props.getProperty("TWILIO_ACCOUNT_SID"); const token=props.getProperty("TWILIO_AUTH_TOKEN"); const fromNumber=props.getProperty("TWILIO_FROM_NUMBER"); if(!sid||!token||!fromNumber)throw new Error("Missing Twilio Script Properties"); const emailSubject=(payload.emailSubject||"").trim()||"Quick follow-up"; const emailBodyTemplate=(payload.emailBody||"").trim()||"Hi {{name}},\n\nJust tried to reach you.\n\nBest,\n{{sender}}"; const smsTemplate=(payload.smsBody||"").trim()||"Hi {{name}} — it's {{sender}}. Tried to reach you."; const emailSent=[],emailFailed=[],smsSent=[],smsFailed=[]; payload.candidates.forEach(function(c){const name=_s_(c.prospectName)||"there";const sender=_s_(c.callerName)||(Session.getActiveUser().getEmail()||"Me"); try{const toEmail=_s_(c.email);if(!toEmail||toEmail.indexOf("@")===-1)throw new Error("Invalid email");GmailApp.sendEmail(toEmail,emailSubject,emailBodyTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender));emailSent.push({row:c.row,recipient:toEmail});}catch(e){emailFailed.push({row:c.row,recipient:c.email,error:String(e.message||e)});} try{const toPhone=_s_(c.phone);if(!toPhone||toPhone.indexOf("+")!==0)throw new Error("Invalid phone");if(wasMessagedThisWeek_(toPhone))throw new Error("Skipped: SMS sent within 7d");_twilioSendSms_(sid,token,fromNumber,toPhone,smsTemplate.split("{{name}}").join(name).split("{{sender}}").join(sender));smsSent.push({row:c.row,recipient:toPhone});var batchId=_s_(c.batchId);if(batchId)logToProjectTagSheet_(toPhone,batchId);}catch(e){smsFailed.push({row:c.row,recipient:c.phone,error:String(e.message||e)});}}); return{emailSentCount:emailSent.length,emailFailedCount:emailFailed.length,smsSentCount:smsSent.length,smsFailedCount:smsFailed.length,emailFailed:emailFailed,smsFailed:smsFailed}; }
function _buildOutreachPreview_(mode) { const sheet=SpreadsheetApp.getActiveSheet(); const range=sheet.getActiveRange(); if(!range)throw new Error("Select at least one row first."); const normMap=_buildNormHeaderMap_(sheet); const colName=_resolveCol_(normMap,HEADER_ALIASES.prospect_name); const colEmail=_resolveCol_(normMap,HEADER_ALIASES.prospect_email); const colScore=_resolveCol_(normMap,HEADER_ALIASES.email_verification); const colPhone=_resolveCol_(normMap,HEADER_ALIASES.phone); const colStatus=_resolveCol_(normMap,HEADER_ALIASES.status); const colCaller=_resolveCol_(normMap,HEADER_ALIASES.caller_name); const colBatchId=_resolveCol_(normMap,HEADER_ALIASES.batch_id); const lastCol=sheet.getLastColumn(); const rows=sheet.getRange(range.getRow(),1,range.getNumRows(),lastCol).getValues(); const candidates=[],skipped=[]; rows.forEach(function(r,i){const rowNum=range.getRow()+i;const name=colName?_s_(r[colName.index0]):"";const email=colEmail?_s_(r[colEmail.index0]):"";const score=colScore?_n_(r[colScore.index0]):NaN;const phone=colPhone?_s_(r[colPhone.index0]):"";const status=colStatus?_s_(r[colStatus.index0]):"";const caller=colCaller?_s_(r[colCaller.index0]):"";const reasons=[];if(!colScore)reasons.push("Missing email_verification header");if(!(score>SCORE_THRESHOLD))reasons.push("email_verification <= "+SCORE_THRESHOLD);if(!colStatus)reasons.push("Missing Status header");if(!ALLOWED_STATUSES.has(status))reasons.push("Status not allowed");if(mode==="email"||mode==="both"){if(!colEmail)reasons.push("Missing prospect_email header");if(!email||email.indexOf("@")===-1)reasons.push("Invalid prospect_email");}if(mode==="sms"||mode==="both"){if(!colPhone)reasons.push("Missing Phone header");if(!phone||phone.indexOf("+")!==0)reasons.push("Invalid Phone");}if(reasons.length){skipped.push({row:rowNum,reason:reasons.join("; ")});return;}if(mode==="email")candidates.push({row:rowNum,recipient:email,score:score,status:status,prospectName:name,callerName:caller,batchId:colBatchId?_s_(r[colBatchId.index0]):""}); else if(mode==="sms")candidates.push({row:rowNum,recipient:phone,score:score,status:status,prospectName:name,callerName:caller,batchId:colBatchId?_s_(r[colBatchId.index0]):""}); else candidates.push({row:rowNum,email:email,phone:phone,score:score,status:status,prospectName:name,callerName:caller,batchId:colBatchId?_s_(r[colBatchId.index0]):""}); }); return{sheetName:sheet.getName(),userEmail:Session.getActiveUser().getEmail()||"",candidates:candidates,skipped:skipped,hasProspectNameHeader:Boolean(colName),hasCallerNameHeader:Boolean(colCaller),hasEmailHeader:Boolean(colEmail),hasPhoneHeader:Boolean(colPhone),hasScoreHeader:Boolean(colScore),hasStatusHeader:Boolean(colStatus),resolvedHeaders:{prospect_name:colName?colName.raw:null,prospect_email:colEmail?colEmail.raw:null,email_verification:colScore?colScore.raw:null,Phone:colPhone?colPhone.raw:null,Status:colStatus?colStatus.raw:null,caller_name:colCaller?colCaller.raw:null}}; }

// ============================================================
// CAMPAIGN SETTINGS
// ============================================================
function getLastCampaignSettings_() { const sp=PropertiesService.getScriptProperties(); const saved=sp.getProperty('LAST_CAMPAIGN_SETTINGS'); if(saved){try{return JSON.parse(saved);}catch(e){return null;}} return null; }
function saveLastCampaignSettings_(config) { const sp=PropertiesService.getScriptProperties(); sp.setProperty('LAST_CAMPAIGN_SETTINGS',JSON.stringify({assistant:config.assistant||'',phoneNumber:config.phoneNumber||'',concurrency:config.concurrency||1,retryAssistant:config.retryAssistant||'',autoSort:config.autoSort!==false,rounds:config.rounds||[],followup:config.followup||null})); }
function debugShowSavedSettings() { const settings = getLastCampaignSettings_(); const ui = SpreadsheetApp.getUi(); if (settings) ui.alert('Saved Settings', 'Assistant: '+(settings.assistant||'none')+'\nPhone: '+(settings.phoneNumber||'none')+'\nConcurrency: '+(settings.concurrency||1), ui.ButtonSet.OK); else ui.alert('No saved settings.'); }

// ============================================================
// SCHEDULE / START / CAMPAIGN DIALOGS + ALL REMAINING FUNCTIONS
// These are unchanged from v4.0 — the fixes are in the functions above
// (doPost, processQueueForSheet_) and below (startSecondRoundAutomatically_,
// autoSortIfBatchComplete_).
//
// IMPORTANT FOR ANTONIO: The large HTML dialog functions
// (vapiScheduleHighlighted, vapiStartBatchWithAutoSecondRound,
// vapiShowBudget, etc.) must be pasted here from your current Code.gs.
//
// In your Apps Script editor:
// 1. Open your CURRENT Code.gs
// 2. Find: function vapiScheduleHighlighted() {
// 3. Select from there all the way down to (but NOT including):
//    function startSecondRoundAutomatically_(config) {
// 4. Copy that entire selection
// 5. Replace this comment block with what you copied
//
// That's it — one copy, one paste. Everything else is already here.
// ============================================================


// ============================================================
// CR-02 FIX: startSecondRoundAutomatically_ — now uses queue
// ============================================================
function startSecondRoundAutomatically_(config) {
  const ss = SpreadsheetApp.openById(config.sheetId); const sh = ss.getSheetByName(config.sheetName); if(!sh)return;
  const cols = getHeaderMap_(sh); if(!cols.batch_id||!cols.status)return;
  const lastRow = sh.getLastRow(); if(lastRow<=HEADER_ROW_INDEX)return;
  const lastCol = sh.getLastColumn(); const data = sh.getRange(HEADER_ROW_INDEX+1,1,lastRow-HEADER_ROW_INDEX,lastCol).getValues();
  const sp = PropertiesService.getScriptProperties();
  const fieldsToClear = ['call_id','started_at','ended_at','transcript','outcome_summary','recording_url','callback_flag','callback_when','scheduled_at','scheduled_in_min','auto_followup_status','auto_followup_preview'];
  const rowsToQueue = [];
  for(let i=0;i<data.length;i++){
    const row=data[i]; const rowNum=HEADER_ROW_INDEX+1+i; const rowBatchId=String(row[cols.batch_id-1]||'').trim(); const status=String(row[cols.status-1]||'').trim().toLowerCase();
    if(rowBatchId!==config.batchId)continue;
    if(DO_NOT_CALL_AGAIN_STATUSES.some(function(s){return status.includes(s);})){ row[cols.status-1]='⏭️ Skipped 2nd ('+String(row[cols.status-1]||'').trim()+')'; if(cols.second_round_status)row[cols.second_round_status-1]='⏭️ Skipped'; continue; }
    const shouldCall=config.statuses.some(function(s){return status.includes(s.toLowerCase());});
    const callbackFlag=cols.callback_flag?String(row[cols.callback_flag-1]||'').trim().toUpperCase():'';
    if(shouldCall||(callbackFlag==='TRUE'&&config.statuses.includes('callback'))){
      let assistantToUse=cols.assistant?String(row[cols.assistant-1]||'').trim():''; if(status.includes('voicemail')&&config.voicemailAssistant)assistantToUse=config.voicemailAssistant;
      row[cols.status-1]='Queued'; if(cols.assistant&&assistantToUse)row[cols.assistant-1]=assistantToUse;
      if(cols.call_attempt)row[cols.call_attempt-1]=Number(row[cols.call_attempt-1]||0)+1;
      fieldsToClear.forEach(function(f){if(cols[f])row[cols[f]-1]='';});
      row[cols.batch_id-1]=config.batchId+'_R2'; rowsToQueue.push(rowNum);
    }
  }
  if(rowsToQueue.length===0)return;
  sh.getRange(HEADER_ROW_INDEX+1,1,lastRow-HEADER_ROW_INDEX,lastCol).setValues(data); SpreadsheetApp.flush();
  const qKey=queueKey_(config.sheetId,config.sheetName); let queue=loadJson_(sp,qKey,[]);
  rowsToQueue.forEach(function(rn){if(queue.indexOf(rn)===-1)queue.push(rn);}); queue.sort(function(a,b){return a-b;}); sp.setProperty(qKey,JSON.stringify(queue));
  const concurrency=Number(sp.getProperty(concurrencyKey_(config.sheetId,config.sheetName))||1);
  const apiKey=sp.getProperty('VAPI_API_KEY');
  if(apiKey) processQueueForSheet_(ss,sh,apiKey,sp.getProperty('VAPI_PHONE_NUMBER_ID'),sp.getProperty('VAPI_ASSISTANT_ID'),concurrency);
  Logger.log('Queued '+rowsToQueue.length+' rows for 2nd round');
}

// ============================================================
// WR-05 FIX: autoSortIfBatchComplete_ — now locked
// ============================================================
function autoSortIfBatchComplete_(sheetId, sheetName) {
  const sortLock=LockService.getScriptLock(); if(!sortLock.tryLock(5000))return;
  try{
    const ss=SpreadsheetApp.openById(sheetId); const sh=ss.getSheetByName(sheetName); if(!sh)return;
    const cols=getHeaderMap_(sh); if(!cols.status)return; const lastRow=sh.getLastRow(); if(lastRow<=HEADER_ROW_INDEX)return;
    const lastCol=sh.getLastColumn(); const dataRange=sh.getRange(HEADER_ROW_INDEX+1,1,lastRow-HEADER_ROW_INDEX,lastCol); const data=dataRange.getValues();
    if(data.some(function(row){const s=String(row[cols.status-1]||'').trim().toLowerCase();return s==='queued'||s==='calling...'||s==='calling';}))return;
    const sp=PropertiesService.getScriptProperties(); let shouldSort=false; let batchIdsToClean=[];
    if(cols.batch_id){const batchIds=new Set();data.forEach(function(row){const b=String(row[cols.batch_id-1]||'').trim().replace(/_R\d+$/,'');if(b)batchIds.add(b);});
    batchIds.forEach(function(bid){if(sp.getProperty('BATCH_AUTOSORT_'+bid)==='true'){shouldSort=true;batchIdsToClean.push(bid);} const mr=sp.getProperty('MULTI_ROUND_'+bid);if(mr){try{if(JSON.parse(mr).autoSort!==false){shouldSort=true;batchIdsToClean.push(bid);}}catch(e){}} const sr=sp.getProperty('SECOND_ROUND_'+bid);if(sr){try{if(JSON.parse(sr).autoSort!==false){shouldSort=true;batchIdsToClean.push(bid);}}catch(e){}}});}else shouldSort=true;
    if(!shouldSort)return;
    const sortedData=data.map(function(row,idx){return{row:row,idx:idx};}).sort(function(a,b){const pa=getStatusPriority_(String(a.row[cols.status-1]||'').trim().toLowerCase());const pb=getStatusPriority_(String(b.row[cols.status-1]||'').trim().toLowerCase());return pa!==pb?pa-pb:a.idx-b.idx;}).map(function(item){return item.row;});
    dataRange.setValues(sortedData); SpreadsheetApp.flush();
    batchIdsToClean.forEach(function(bid){sp.deleteProperty('BATCH_AUTOSORT_'+bid);});
  }catch(e){Logger.log('autoSort error: '+e.message);}finally{sortLock.releaseLock();}
}

function getStatusPriority_(status) { const s=String(status||'').toLowerCase(); if(s.includes('spoke to human'))return 0;if(s.includes('interested'))return 1;if(s.includes('callback'))return 2;if(s.includes('voicemail'))return 3;if(s.includes('no answer'))return 4;if(s.includes('busy'))return 5;if(s.includes('gatekeeper'))return 6;if(s.includes('number failed'))return 7;if(s.includes('hung up'))return 8;if(s.includes('cancelled'))return 9;return 10; }
function shouldSkipStatus_(status) { const s=String(status||'').toLowerCase(); return DO_NOT_CALL_AGAIN_STATUSES.some(function(ss){return s.includes(ss);}); }
function getVapiKey_() { return PropertiesService.getScriptProperties().getProperty('VAPI_API_KEY'); }
function getRowDataForCall_(sh, rowNum, cols) { const lastCol=sh.getLastColumn(); const rowVals=sh.getRange(rowNum,1,1,lastCol).getValues()[0]; return{phone:normalizePhone_(rowVals[cols.phone-1]),prospectName:cols.prospect_name?String(rowVals[cols.prospect_name-1]||'').trim():'',prospectEmail:cols.prospect_email?String(rowVals[cols.prospect_email-1]||'').trim():'',eventName:cols.event_name?String(rowVals[cols.event_name-1]||'').trim():'',eventDate:cols.event_date?formatEventDate_(rowVals[cols.event_date-1]):'',eventCity:cols.event_city?String(rowVals[cols.event_city-1]||'').trim():'',eventTime:cols.event_time?formatEventTime_(rowVals[cols.event_time-1]):'',eventFormat:cols.event_format?String(rowVals[cols.event_format-1]||'').trim():'',eventContext:cols.event_context?String(rowVals[cols.event_context-1]||'').trim():'',eventArea:cols.event_area?String(rowVals[cols.event_area-1]||'').trim():String(rowVals[cols.event_city-1]||'').trim(),eventVenue:cols.event_venue?String(rowVals[cols.event_venue-1]||'').trim():'',targetAudience:cols.target_audience?String(rowVals[cols.target_audience-1]||'').trim():'',callerName:cols.caller_name?String(rowVals[cols.caller_name-1]||'Alex').trim():'Alex',hostName:cols.host_name?String(rowVals[cols.host_name-1]||'').trim():'',hostFirstName:cols.host_first_name?String(rowVals[cols.host_first_name-1]||'').trim():'',hostPronouns:cols.host_pronouns?String(rowVals[cols.host_pronouns-1]||'they/them').trim():'they/them',voicemailLeftCount:cols.voicemail_left_count?Number(rowVals[cols.voicemail_left_count-1]||0):0,assistantName:cols.assistant?String(rowVals[cols.assistant-1]||'').trim():'',vapiNumber:cols.vapi_number?String(rowVals[cols.vapi_number-1]||'').trim():''}; }
function triggerVapiCall_(apiKey, rowData, sh, rowNum, cols) { const ss=sh.getParent(); const sp=PropertiesService.getScriptProperties(); const assistantId=resolveAssistantIdFromName_(ss,rowData.assistantName,sp.getProperty('VAPI_ASSISTANT_ID')); if(!assistantId)throw new Error('No assistant ID'); const phoneNumberId=resolvePhoneNumberIdFromDisplay_(ss,rowData.vapiNumber,sp.getProperty('VAPI_PHONE_NUMBER_ID')); if(!phoneNumberId)throw new Error('No phone number ID'); const variableValues={prospect_name:rowData.prospectName,prospect_email:rowData.prospectEmail,event_name:rowData.eventName,event_date:rowData.eventDate,event_city:rowData.eventCity,event_area:rowData.eventArea,event_venue:rowData.eventVenue,caller_name:rowData.callerName,host_name:rowData.hostName,host_first_name:rowData.hostFirstName,host_pronouns:rowData.hostPronouns,event_time:rowData.eventTime,event_format:rowData.eventFormat,event_context:rowData.eventContext,target_audience:rowData.targetAudience,leave_voicemail:rowData.voicemailLeftCount>=1?'no':'yes',voicemail_action:rowData.voicemailLeftCount>=1?'hang_up_immediately':'leave_message',voicemail_left_count:String(rowData.voicemailLeftCount)}; const payload={assistantId:assistantId,phoneNumberId:phoneNumberId,customer:{number:rowData.phone,name:rowData.prospectName},metadata:{sheetName:sh.getName(),rowNum:rowNum},assistantOverrides:{variableValues:variableValues}}; const call=vapiCreateCall_(apiKey,payload); if(call&&call.id){sh.getRange(rowNum,cols.call_id).setValue(call.id);sh.getRange(rowNum,cols.status).setValue('Calling...');sh.getRange(rowNum,cols.started_at).setValue(new Date());applyRowHygiene_(sh,rowNum,cols);} return call; }
function generateBatchId_(sheetName) { const now=new Date(); const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return String(sheetName||'Batch')+'_'+months[now.getMonth()]+now.getDate()+'_'+(now.getHours()%12||12)+'-'+String(now.getMinutes()).padStart(2,'0')+(now.getHours()>=12?'PM':'AM'); }
function getCurrentUserEmail() { return Session.getActiveUser().getEmail()||'Unable to detect email'; }
function calculateSpecificTime_(timeStr, timezone, daysFromNow) { const parts=timeStr.split(':'); const hours=parseInt(parts[0])||0; const minutes=parseInt(parts[1])||0; const now=new Date(); const targetDate=new Date(now.getTime()+(daysFromNow||0)*24*60*60*1000); const dateStr=Utilities.formatDate(targetDate,timezone,'yyyy-MM-dd'); const timeString=dateStr+'T'+String(hours).padStart(2,'0')+':'+String(minutes).padStart(2,'0')+':00'; return new Date(Utilities.formatDate(Utilities.parseDate(timeString,timezone,"yyyy-MM-dd'T'HH:mm:ss"),'UTC',"yyyy-MM-dd'T'HH:mm:ss'Z'")); }

// ============================================================
// WATCHDOG — cleans up old webhook keys automatically
// ============================================================
function vapiWatchdog_() {
  const sp=PropertiesService.getScriptProperties(); const sheetId=sp.getProperty('SHEET_ID'); if(!sheetId)return;
  // Clean up old webhook idempotency keys (runs automatically with watchdog)
  cleanupOldWebhookKeys_();
  const ss=SpreadsheetApp.openById(sheetId);
  for(const sh of ss.getSheets()){
    const sheetName=sh.getName(); if(sheetName.startsWith('_'))continue;
    const qKey=queueKey_(sheetId,sheetName); const aKey=activeKey_(sheetId,sheetName);
    const queue=loadJson_(sp,qKey,[]); let active=loadJson_(sp,aKey,{});
    if(queue.length===0&&Object.keys(active).length===0)continue;
    const cols=getHeaderMap_(sh); const now=Date.now(); let cleaned=false;
    for(const[callId,rowNum]of Object.entries(active)){try{const r=Number(rowNum);if(!r||r<=HEADER_ROW_INDEX){delete active[callId];cleaned=true;continue;} const startedAt=cols.started_at?sh.getRange(r,cols.started_at).getValue():null; const status=cols.status?String(sh.getRange(r,cols.status).getValue()).trim():''; if(startedAt instanceof Date&&(now-startedAt.getTime())>350000&&status==='Calling...'){sh.getRange(r,cols.status).setValue('Auto-cleared (stale)');delete active[callId];cleaned=true;} if(status!=='Calling...'&&status!==''){delete active[callId];cleaned=true;}}catch(e){delete active[callId];cleaned=true;}}
    if(cleaned)sp.setProperty(aKey,JSON.stringify(active));
    const concurrency=Number(sp.getProperty(concurrencyKey_(sheetId,sheetName))||1);
    if(queue.length>0&&Object.keys(active).length<concurrency){const apiKey=sp.getProperty('VAPI_API_KEY');if(apiKey){updateStatus_({'Script Status':'🔄 Watchdog resuming...'},sheetName);processQueueForSheet_(ss,sh,apiKey,sp.getProperty('VAPI_PHONE_NUMBER_ID'),sp.getProperty('VAPI_ASSISTANT_ID'),concurrency);}}
    if(queue.length===0&&Object.keys(active).length===0){updateStatus_({'Script Status':'✅ Complete','Active Calls':0,'Queued Rows':0},sheetName);sp.deleteProperty(processingKey_(sheetId,sheetName));autoSortIfBatchComplete_(sheetId,sheetName);removeWatchdog_();}
  }
}
function startWatchdog_() { removeWatchdog_(); ScriptApp.newTrigger('vapiWatchdog_').timeBased().everyMinutes(1).create(); }
function removeWatchdog_() { ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='vapiWatchdog_')ScriptApp.deleteTrigger(t);}); }
function emergencyUnstick() { const sp=PropertiesService.getScriptProperties(); const sh=SpreadsheetApp.getActiveSheet(); const sheetName=sh.getName(); const sheetId=sp.getProperty('SHEET_ID'); sp.deleteProperty(queueKey_(sheetId,sheetName)); sp.deleteProperty(activeKey_(sheetId,sheetName)); sp.deleteProperty(processingKey_(sheetId,sheetName)); const cols=getHeaderMap_(sh); const lastRow=sh.getLastRow(); if(lastRow>1&&cols.status){const statuses=sh.getRange(2,cols.status,lastRow-1,1).getValues();for(let i=0;i<statuses.length;i++){if(String(statuses[i][0]).trim()==='Calling...')statuses[i][0]='Error - Stuck';}sh.getRange(2,cols.status,lastRow-1,1).setValues(statuses);} updateStatus_({'Script Status':'⚪ Idle','Active Calls':0,'Queued Rows':0},sheetName); SpreadsheetApp.getUi().alert('✅ Unstuck!'); }
function cleanupOldWebhookKeys_() { const sp=PropertiesService.getScriptProperties(); const allProps=sp.getProperties(); const oneHourAgo=Date.now()-(60*60*1000); for(const key in allProps){if(!key.startsWith('WEBHOOK_PROCESSED__'))continue;if(Number(allProps[key]||0)<oneHourAgo)sp.deleteProperty(key);} }

// ============================================================
// DAILY BUDGET
// ============================================================
const DAILY_BUDGET_USD = 100;
function getDailySpendKey_() { return 'DAILY_SPEND_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd'); }
function getDailySpend_() { return Number(PropertiesService.getScriptProperties().getProperty(getDailySpendKey_())||0); }
function addToDailySpend_(amount) { const sp=PropertiesService.getScriptProperties(); sp.setProperty(getDailySpendKey_(),String(Number(sp.getProperty(getDailySpendKey_())||0)+amount)); }
function isUnderBudget_() { const spent=getDailySpend_(); if(spent>=DAILY_BUDGET_USD)return false; const pct=(spent/DAILY_BUDGET_USD)*100; if(pct>=80&&pct<90){const sp=PropertiesService.getScriptProperties();const k='BUDGET_WARNING_80_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd');if(!sp.getProperty(k)){sp.setProperty(k,'true');showBudgetWarning_(80,spent,DAILY_BUDGET_USD);}} else if(pct>=90){const sp=PropertiesService.getScriptProperties();const k='BUDGET_WARNING_90_'+Utilities.formatDate(new Date(),Session.getScriptTimeZone(),'yyyy-MM-dd');if(!sp.getProperty(k)){sp.setProperty(k,'true');showBudgetWarning_(90,spent,DAILY_BUDGET_USD);}} return true; }
function showBudgetWarning_(threshold, spent, budget) { Logger.log((threshold>=90?'🚨':'⚠️')+' BUDGET: $'+spent.toFixed(2)+' / $'+budget); try{SpreadsheetApp.getUi().alert('Budget at '+threshold+'%','Spent: $'+spent.toFixed(2)+' / $'+budget,SpreadsheetApp.getUi().ButtonSet.OK);}catch(e){} }
function getCallCostFromVapi_(apiKey, callId) { try{const res=UrlFetchApp.fetch('https://api.vapi.ai/call/'+callId,{method:'get',headers:{Authorization:'Bearer '+apiKey},muteHttpExceptions:true});if(res.getResponseCode()>=300)return 0;const data=JSON.parse(res.getContentText());return Number(data.cost||(data.costBreakdown&&data.costBreakdown.total)||0);}catch(e){return 0;} }

// ============================================================
// SMS LOGGING
// ============================================================
function logToProjectTagSheet_(toNumber, projectTag) { const targetSS=SpreadsheetApp.openById("1YsRylkQKuOevTuzoh2F9EuFTjwc_nh674Vm6XATe5tU"); const logSheet=targetSS.getSheetByName("Key: Project Tag and Numbers"); if(!logSheet)return; const cleanNumber=String(toNumber).replace(/[^0-9]/g,''); const lastRow=logSheet.getLastRow()+1; logSheet.getRange(lastRow,2).setValue(cleanNumber); logSheet.getRange(lastRow,4).setValue(projectTag); logSheet.getRange(lastRow,5).setValue(new Date()); }
function wasMessagedThisWeek_(phoneNumber) { try{const cleanTarget=String(phoneNumber||'').replace(/[^0-9]/g,'');if(!cleanTarget)return false;const targetSS=SpreadsheetApp.openById("1YsRylkQKuOevTuzoh2F9EuFTjwc_nh674Vm6XATe5tU");const logSheet=targetSS.getSheetByName("Key: Project Tag and Numbers");if(!logSheet)return false;const lastRow=logSheet.getLastRow();if(lastRow<2)return false;const data=logSheet.getRange(2,2,lastRow-1,4).getValues();const sevenDaysAgo=Date.now()-(7*24*60*60*1000);for(let i=0;i<data.length;i++){const rowPhone=String(data[i][0]||'').replace(/[^0-9]/g,'');if(rowPhone!==cleanTarget)continue;const rowDate=data[i][3];if(rowDate instanceof Date&&rowDate.getTime()>=sevenDaysAgo)return true;}return false;}catch(e){return false;} }
