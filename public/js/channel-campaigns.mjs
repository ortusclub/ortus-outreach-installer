import { CHANNEL_TYPES, channelType } from './channel-types.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const channelCards = () => CHANNEL_TYPES.map(type => `<button type="button" class="mode-card channel-type-card" onclick="location.hash='#/outreach/${type.id}'"><span class="mode-card-badge">Draft setup</span><div class="mode-card-title">${type.name}</div><p>${type.description}</p></button>`).join('');
async function request(url, options) { const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.error || 'Request failed.');return body; }
let generation=0;
export async function showChannelCampaigns(mount) {
 const version=++generation;
 mount.innerHTML='<p role="status">Loading campaigns…</p>';
 try {
 const {campaigns}=await request('/api/channel-campaigns');
 if(version!==generation || !location.hash.startsWith('#/outreach/'))return;
 const selection=location.hash.split('/')[2] || '';
 const saved=campaigns.find(c=>c.id===selection);
 const type=channelType(saved?.type || selection);
 if (!type) { location.hash='#/new'; return; }
 const record=saved || { name:'',sender:'',recipients:'',content:'',templateName:'',language:'en' };
 mount.innerHTML=`<div class="channel-heading"><h1>${type.name}</h1><button type="button" class="btn btn-secondary" onclick="goCampaignsTab()">Outreach campaigns</button></div>
 <p class="channel-notice">Save your campaign setup here. Calling and messaging are not connected yet; these drafts do not send or run automatically.</p>
 ${type ? `<form id="channel-form" class="channel-editor">
 <label>Campaign name<input name="name" required maxlength="150" value="${esc(record.name)}"></label>
 <label>Sender number or sender ID<input name="sender" maxlength="100" value="${esc(record.sender)}" placeholder="Configure your sender when connecting a provider"></label>
 <label>Recipient phone numbers<textarea name="recipients" rows="6" placeholder="+441234567890">${esc(record.recipients)}</textarea><small>One number per line, including + and the country code.</small></label>
 ${type.id==='automated_whatsapp' ? `<label>WhatsApp template name<input name="templateName" maxlength="200" value="${esc(record.templateName)}"></label><label>Template language<input name="language" maxlength="50" value="${esc(record.language)}" placeholder="en"></label>` : '<input type="hidden" name="templateName" value=""><input type="hidden" name="language" value="">'}
 <label>${type.contentLabel}<textarea name="content" rows="8" maxlength="20000">${esc(record.content)}</textarea></label>
 <div class="channel-actions"><button class="btn" type="submit">Save draft</button><button class="btn btn-secondary" type="button" disabled>Provider connection required to launch</button></div>
 ${saved ? `<button class="btn btn-secondary" type="button" data-delete="${esc(saved.id)}">Delete draft</button>` : ''}
 <p id="channel-feedback" role="status" aria-live="polite"></p></form>` : ''}`;
 const form=mount.querySelector('form');
 form?.addEventListener('submit',async event=>{
   event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
   const feedback=mount.querySelector('#channel-feedback');feedback.textContent='Saving…';
   try {
    const payload={...Object.fromEntries(new FormData(form)),type:type.id,id:saved?.id};
    const result=await request('/api/channel-campaigns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(version!==generation || !location.hash.startsWith('#/outreach/'))return;
    history.replaceState(null,'',`#/outreach/${result.campaign.id}`);
    await showChannelCampaigns(mount);mount.querySelector('#channel-feedback').textContent='Draft saved. No calls or messages have been sent.';
   }catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
 });
 mount.querySelectorAll('[data-delete]').forEach(button=>button.addEventListener('click',async()=>{
  if(!confirm('Delete this saved draft?'))return;
  button.disabled=true;
  try{await request(`/api/channel-campaigns/${encodeURIComponent(button.dataset.delete)}`,{method:'DELETE'});window.goCampaignsTab();}catch(error){mount.querySelector('#channel-feedback').textContent=error.message;button.disabled=false;}
 }));
 }catch(error){if(version===generation)mount.textContent=error.message;}
}

export function channelDraftStrip(c) {
 return `<div class="sn-strip done sn-collapsed draft"><div class="sn-compact"><div class="sn-top"><span class="sn-type">${esc(channelType(c.type)?.name)}</span><span class="sn-status">Draft</span></div><div class="sn-name">${esc(c.name)}</div><div class="sn-flow">${esc(c.owner)} · Not launched</div><div class="sn-foot"><div class="right"><a class="mini solid" href="#/outreach/${esc(c.id)}">Open</a></div></div></div></div>`;
}
