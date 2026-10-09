// Column names and defaults mirror the supplied Automated Calling Apps Script v4.6.15.
export const CALLER_FIELDS = {
 recordId:['Record ID','record_id'], name:['First Name','prospect_name','prospect name'], phone:['First Phone','phone number','firstphone'], email:['Email','prospect_email'],
 status:['VAPI Status','call status','call_status'], outcome:['Outcome','summary'], transcript:['Transcript'], recording:['Recording URL','recording link'],
 attempts:['call_attempt'], voicemailCount:['voicemail_left_count'], assistant:['Assistant'], callerNumber:['Vapi number','caller number'], callId:['Vapi Caller ID','call id'],
 callback:['callback_flag'], callbackWhen:['callback_when'], reply:['lead_reply'], followupStatus:['auto_followup_status'], followupPreview:['auto_followup_preview'],
 startedAt:['Started At'], endedAt:['Ended At'], scheduledAt:['scheduled_at'], batchId:['batch_id'], campaignStatus:['campaign_status'], nextRoundAt:['next_round_at'],
};
export const CALLER_EVENT_FIELDS = ['caller_name','event_name','event_date','event_city','host_name','host_first_name','host_pronouns','event_time','event_format','target_audience','event_area','event_venue','event_context','response_notif_email'];
const norm = value=>String(value||'').trim().toLowerCase().replace(/[ _-]+/g,'');
export function resolveCallerColumns(headers, overrides={}) {
 const fields={...CALLER_FIELDS,...Object.fromEntries(CALLER_EVENT_FIELDS.map(key=>[key,[key]]))};
 return Object.fromEntries(Object.entries(fields).map(([key,aliases])=>[key, headers.includes(overrides[key]) ? overrides[key] : headers.find(header=>aliases.some(alias=>norm(alias)===norm(header))) || '']));
}
export function callerSheetUrl(value, gid) {
 const u=new URL(value);if(u.protocol!=='https:' || u.hostname!=='docs.google.com' || !/^\/spreadsheets\/d\/[\w-]+(?:\/|$)/.test(u.pathname))throw new Error('Paste a Google Sheets spreadsheet link.');
 const tab=String(gid ?? (u.searchParams.get('gid') || new URLSearchParams(u.hash.slice(1)).get('gid') || ''));
 if(!/^\d+$/.test(tab))throw new Error('Choose a specific sheet tab (a link containing gid).');
 return `https://docs.google.com/spreadsheets/d/${u.pathname.split('/')[3]}/edit#gid=${tab}`;
}
export function normalizeCallerConfig(input={}) {
 const number=(key,fallback,min,max)=>{const n=Number(input[key]??fallback);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}.`);return n;};
 const text=(key,fallback='',max=10000)=>{const value=String(input[key]??fallback).trim();if(value.length>max)throw new Error(`${key} is too long.`);return value;};
 const timezone=text('timezone','Europe/Zurich',100);try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}catch{throw new Error('Choose a valid timezone.');}
 const sourceUrl=text('sourceUrl','',2000);
 const rowStart=number('rowStart',2,2,1000000),rowEnd=number('rowEnd',251,2,1000000);if(rowEnd<rowStart)throw new Error('Last row must be after the first row.');
 const mode=text('mode','ai',20);if(!['ai','voicemail_text'].includes(mode))throw new Error('Choose a supported calling mode.');
 const mapping={};for(const key of Object.keys(CALLER_FIELDS)){if(input.mapping?.[key]){mapping[key]=String(input.mapping[key]).trim();if(mapping[key].length>200)throw new Error('Invalid column mapping.');}}
 const eventDefaults={};for(const key of CALLER_EVENT_FIELDS){eventDefaults[key]=String(input.eventDefaults?.[key]||'').trim();if(eventDefaults[key].length>2000)throw new Error('Event detail is too long.');}
 return {sourceUrl:sourceUrl?callerSheetUrl(sourceUrl):'',tabName:text('tabName','',200),rowStart,rowEnd,mapping,eventDefaults,timezone,mode,
 assistant:text('assistant','',200),callerNumber:text('callerNumber','',100),concurrency:number('concurrency',1,1,50),maxCalls:number('maxCalls',250,1,250),dailyBudgetUsd:number('dailyBudgetUsd',100,1,100),
 rounds:number('rounds',1,1,10),roundDelayMinutes:number('roundDelayMinutes',60,1,10080),startAt:text('startAt','',100),
 smsEnabled:input.smsEnabled===true,smsDelayMinutes:number('smsDelayMinutes',5,0,1440),smsTemplate:text('smsTemplate'),voicemailScript:text('voicemailScript'),
 callingWindow:{days:[1,2,3,4,5],startHour:8,endHour:21},followupStatuses:['Voicemail','No Answer']};
}
export function callerPreview(rows, config) {
 const headers=[...new Set(rows.flatMap(item=>Object.keys(item.row)))];const columns=resolveCallerColumns(headers,config.mapping);
 const seen=new Set();const recordIds=new Set();
 const selected=rows.filter(item=>item.rowNumber>=config.rowStart&&item.rowNumber<=config.rowEnd).map(({rowNumber,row})=>{
  const values=Object.fromEntries(Object.entries(columns).map(([key,column])=>[key,String(row[column]??'').trim()]));
  const phone=values.phone.replace(/[\s().-]/g,'');const duplicate=seen.has(phone);if(phone)seen.add(phone);
  let reason=!/^\+[1-9]\d{6,14}$/.test(phone)?'Invalid phone number':duplicate?'Duplicate phone number':!values.recordId?'Missing Record ID':'';
  if(!reason&&recordIds.has(values.recordId))reason='Duplicate Record ID';
  if(values.recordId)recordIds.add(values.recordId);
  if(!reason&&(values.status||values.callId||values.reply||Number(values.attempts)>0||values.scheduledAt||values.callback))reason='Existing call history or reply — review before calling again';
  for(const key of CALLER_EVENT_FIELDS) values[key]=values[key]||config.eventDefaults[key]||'';
  return {rowNumber,...values,phone,reviewReason:reason};
 });
 const ready=selected.filter(row=>!row.reviewReason).length;
 return {headers,columns,missing:['recordId','name','phone'].filter(key=>!columns[key]),totalRows:rows.length,selectedRows:selected.length,ready,needsReview:selected.length-ready,overCap:selected.length>config.maxCalls,rows:selected.slice(0,250),truncated:selected.length>250};
}
