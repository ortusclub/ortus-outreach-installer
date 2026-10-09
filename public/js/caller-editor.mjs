import { normalizeCallerConfig, CALLER_EVENT_FIELDS } from './caller-sheet-model.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function callerEditor(record) {
 const c=normalizeCallerConfig(record.caller||{});
 const field=(key,label,type='text',extra='')=>`<label>${label}<input data-caller="${key}" type="${type}" value="${esc(c[key])}" ${extra}></label>`;
 return `<fieldset><legend>1. Google Sheets lead list</legend>
 <p>Your spreadsheet stays the source of leads and call results. Preview is read-only.</p>
 ${field('sourceUrl','Spreadsheet link (including the tab)','url','placeholder="https://docs.google.com/spreadsheets/d/…/edit#gid=…"')}
 <div class="channel-actions"><button type="button" class="btn btn-secondary" id="caller-tabs">Load tabs</button><a id="caller-open-sheet" class="btn btn-secondary" href="#" target="_blank" rel="noopener">Open spreadsheet</a></div>
 <label>Sheet tab<select id="caller-tab"><option value="">Use the tab in the link</option></select></label>
 <div class="caller-grid">${field('rowStart','First lead row','number','min="2"')}${field('rowEnd','Last lead row','number','min="2"')}</div>
 <div class="channel-actions"><button type="button" class="btn btn-secondary" id="caller-preview">Preview selected rows</button></div>
 <p id="caller-preview-status" role="status"></p><div id="caller-mapping"></div><div id="caller-results" class="caller-results"></div></fieldset>
 <fieldset><legend>2. Calling setup</legend>
 <label>Calling mode<select data-caller="mode"><option value="ai" ${c.mode==='ai'?'selected':''}>Full AI conversation</option><option value="voicemail_text" ${c.mode==='voicemail_text'?'selected':''}>Voicemail / text follow-up</option></select></label>
 <button type="button" class="btn btn-secondary" id="caller-load-options">Load Vapi options</button><p id="caller-provider-feedback" role="status"></p>
 <div class="caller-grid">${field('assistant','Vapi assistant name or ID')}${field('callerNumber','Vapi caller number')}${field('timezone','Campaign timezone')}${field('concurrency','Simultaneous calls','number','min="1" max="50"')}${field('maxCalls','Campaign call cap','number','min="1" max="250"')}${field('dailyBudgetUsd','Daily spend limit (USD)','number','min="1" max="100"')}</div>
 <p>Calling window: Monday–Friday, 08:00–21:00 in the campaign timezone.</p>
 </fieldset><fieldset><legend>3. Planned timing and repeat rounds</legend>
 ${field('startAt','Proposed start','datetime-local')}
 <div class="caller-grid">${field('rounds','Total rounds','number','min="1" max="10"')}${field('roundDelayMinutes','Minutes between rounds','number','min="1" max="10080"')}</div>
 <p>Saving these settings does not schedule calls. Existing call history and replies are flagged for review.</p>
 </fieldset><fieldset><legend>4. Follow-up after voicemail or no answer</legend>
 <label class="caller-checkbox"><input data-caller="smsEnabled" type="checkbox" ${c.smsEnabled?'checked':''}>Prepare an SMS follow-up</label>
 ${field('smsDelayMinutes','SMS delay in minutes','number','min="0" max="1440"')}
 <label>SMS template<textarea data-caller="smsTemplate" rows="4">${esc(c.smsTemplate)}</textarea></label>
 <small>Variables: {{prospect_name}}, {{caller_name}}, {{event_name}}, {{event_date}}, {{event_city}}</small>
 <label>Voicemail script<textarea data-caller="voicemailScript" rows="4">${esc(c.voicemailScript)}</textarea></label>
 </fieldset><details><summary>Event details — defaults for empty sheet cells</summary><div class="caller-grid">${CALLER_EVENT_FIELDS.map(key=>`<label>${key.replaceAll('_',' ')}<input data-caller-event="${key}" value="${esc(c.eventDefaults[key])}"></label>`).join('')}</div></details>`;
}
export function readCallerEditor(form, existing={}) {
 const config={...existing,mapping:{...existing.mapping},eventDefaults:{}};
 form.querySelectorAll('[data-caller]').forEach(input=>{config[input.dataset.caller]=input.type==='checkbox'?input.checked:input.value;});
 form.querySelectorAll('[data-caller-event]').forEach(input=>{config.eventDefaults[input.dataset.callerEvent]=input.value;});
 form.querySelectorAll('[data-caller-column]').forEach(input=>{config.mapping[input.dataset.callerColumn]=input.value;});
 return config;
}
export function wireCallerEditor(form, existing={}) {
 const status=form.querySelector('#caller-preview-status');
 const source=form.querySelector('[data-caller="sourceUrl"]');
 const tabs=form.querySelector('#caller-tab');
 const link=form.querySelector('#caller-open-sheet');
 let requestVersion=0;
 function updateLink(){try{const c=normalizeCallerConfig(readCallerEditor(form,existing));link.href=c.sourceUrl||'#';}catch{link.href='#';}}
 source.addEventListener('input',()=>{requestVersion++;form.querySelector('#caller-results').textContent='';form.querySelector('#caller-mapping').textContent='';tabs.innerHTML='<option value="">Use the tab in the link</option>';updateLink();});updateLink();
 tabs.addEventListener('change',()=>{if(!tabs.value)return;const u=new URL(source.value);u.searchParams.delete('gid');u.hash='gid='+tabs.value;source.value=u.href;existing.tabName=tabs.selectedOptions[0].textContent;requestVersion++;updateLink();});
 async function json(url,options){const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not read sheet.');return data;}
 form.querySelector('#caller-load-options').addEventListener('click',async()=>{
  const feedback=form.querySelector('#caller-provider-feedback');feedback.textContent='Loading assistants and phone numbers…';
  try{const data=await json('/api/caller/provider/options');if(!form.isConnected)return;
   for(const [key,items] of [['assistant',data.assistants],['callerNumber',data.numbers]]){
    const old=form.querySelector(`[data-caller="${key}"]`);const selected=old.value;const select=document.createElement('select');select.dataset.caller=key;
    select.innerHTML='<option value="">Choose an option</option>'+items.map(item=>`<option value="${esc(item.id)}" ${selected===item.id||selected===item.name?'selected':''}>${esc(item.name)}</option>`).join('');old.replaceWith(select);
   }
   feedback.textContent='Vapi options loaded. These selections are saved with your draft.';
  }catch(error){feedback.textContent=error.message;}
 });
 form.querySelector('#caller-tabs').addEventListener('click',async()=>{
  const version=++requestVersion;status.textContent='Loading tabs…';
  try{const {tabs:items}=await json('/api/sheet/tabs?sheetUrl='+encodeURIComponent(source.value));if(version!==requestVersion)return;
   tabs.innerHTML='<option value="">Choose a tab</option>'+items.filter(t=>!t.hidden).map(t=>`<option value="${esc(t.gid ?? t.sheetId ?? t.id)}">${esc(t.name ?? t.title)}</option>`).join('');status.textContent='Choose the lead tab, then preview your rows.';
  }catch(error){status.textContent=error.message;}
 });
 form.querySelector('#caller-preview').addEventListener('click',async()=>{
  const version=++requestVersion;status.textContent='Reading selected rows…';
  try{const config=normalizeCallerConfig(readCallerEditor(form,existing));const data=await json('/api/caller/sheet-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});if(version!==requestVersion||!form.isConnected)return;
   status.textContent=`${data.selectedRows} selected · ${data.ready} without recorded call history · ${data.needsReview} to review.${data.overCap?' Selection exceeds the campaign call cap.':''}${data.missing.length?' Missing columns: '+data.missing.join(', '):''}`;
   form.querySelector('#caller-mapping').innerHTML='<div class="caller-grid">'+['recordId','name','phone','email'].map(key=>`<label>${key} column<select data-caller-column="${key}"><option value="">Choose a column</option>${data.headers.map(header=>`<option ${data.columns[key]===header?'selected':''} value="${esc(header)}">${esc(header)}</option>`).join('')}</select></label>`).join('')+'</div>';
   form.querySelector('#caller-results').innerHTML=`<table><thead><tr><th>Row</th><th>Name / phone</th><th>Call status</th><th>History and results</th></tr></thead><tbody>${data.rows.map(row=>`<tr><td>${row.rowNumber}</td><td>${esc(row.name)}<br>${esc(row.phone)}</td><td>${esc(row.status||'Not called')}<br>${esc(row.reviewReason)}</td><td><details><summary>View results</summary><p>Attempts: ${esc(row.attempts||'0')} · Voicemails: ${esc(row.voicemailCount||'0')}</p><p>${esc(row.outcome)}</p><p>Callback: ${esc(row.callbackWhen||row.callback||'—')}</p><p>Reply: ${esc(row.reply||'—')}</p><p>Follow-up: ${esc(row.followupStatus||'—')}</p><pre>${esc(row.transcript||'No transcript recorded.')}</pre>${/^https:\/\//.test(row.recording)?`<a href="${esc(row.recording)}" target="_blank" rel="noopener">Recording</a>`:''}</details></td></tr>`).join('')}</tbody></table>${data.truncated?'<p>Showing the first 250 selected rows. Narrow the row range to inspect more.</p>':''}`;
  }catch(error){status.textContent=error.message;}
 });
}
