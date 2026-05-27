/** ======================================================================
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
  prospect_name: ['prospect_name', 'prospect name', 'name', 'prospectname', 'first name', 'firstname'],
  prospect_last_name: ['prospect_last_name', 'last name', 'lastname', 'surname'],
  prospect_email: ['prospect_email', 'prospect email', 'email', 'prospectemail'],
  email_verification: ['email_verification', 'email verification', 'verification score', 'email score'],
  phone: ['first phone'],
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
