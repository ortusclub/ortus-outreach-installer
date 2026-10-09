import { CHANNEL_TYPES, channelType } from './channel-types.mjs';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const channelCards = () => CHANNEL_TYPES.map(type => `<button type="button" class="mode-card channel-type-card" onclick="location.hash='#/channels/${type.id}'"><span class="mode-card-badge">Draft setup</span><div class="mode-card-title">${type.name}</div><p>${type.description}</p></button>`).join('');
async function request(url, options) { const response=await fetch(url,options);const body=await response.json();if(!response.ok)throw new Error(body.error || 'Request failed.');return body; }
let generation=0;
export async function showChannelCampaigns(mount) {
 const version=++generation;
 mount.innerHTML='<p role="status">Loading campaigns…</p>';
 try {
 const {campaigns}=await request('/api/channel-campaigns');
 if(version!==generation || !location.hash.startsWith('#/channels'))return;
 const selection=location.hash.split('/')[2] || '';
 const saved=campaigns.find(c=>c.id===selection);
 const type=channelType(saved?.type || selection);
 const record=saved || { name:'',sender:'',recipients:'',content:'',templateName:'',language:'en' };
 mount.innerHTML=`<div class="channel-heading"><h1>${type ? type.name : 'Calls & messages'}</h1><a class="btn btn-secondary" href="${type ? '#/channels' : '#/'}">${type ? 'All drafts' : 'Dashboard'}</a></div>
 <p class="channel-notice">Save your campaign setup here. Calling and messaging are not connected yet; these drafts do not send or run automatically.</p>
 ${type ? `<form id="channel-form" class="channel-editor">
 <label>Campaign name<input name="name" required maxlength="150" value="${esc(record.name)}"></label>
 <label>Sender number or sender ID<input name="sender" maxlength="100" value="${esc(record.sender)}" placeholder="Configure your sender when connecting a provider"></label>
 <label>Recipient phone numbers<textarea name="recipients" rows="6" placeholder="+441234567890">${esc(record.recipients)}</textarea><small>One number per line, including + and the country code.</small></label>
 ${type.id==='automated_whatsapp' ? `<label>WhatsApp template name<input name="templateName" maxlength="200" value="${esc(record.templateName)}"></label><label>Template language<input name="language" maxlength="50" value="${esc(record.language)}" placeholder="en"></label>` : '<input type="hidden" name="templateName" value=""><input type="hidden" name="language" value="">'}
 <label>${type.contentLabel}<textarea name="content" rows="8" maxlength="20000">${esc(record.content)}</textarea></label>
 <div class="channel-actions"><button class="btn" type="submit">Save draft</button><button class="btn btn-secondary" type="button" disabled>Provider connection required to launch</button></div>
 <p id="channel-feedback" role="status" aria-live="polite"></p></form>` : `<div class="mode-grid">${channelCards()}</div><h2>Saved drafts</h2><p>Saved on this computer.</p><div class="channel-drafts">${campaigns.length ? campaigns.map(c=>`<article><div><a href="#/channels/${esc(c.id)}">${esc(c.name)}</a><small>${esc(channelType(c.type)?.name)} · Draft · ${esc(c.owner)}</small></div><button class="btn btn-secondary" type="button" data-delete="${esc(c.id)}">Delete draft</button></article>`).join('') : '<p>No drafts yet. Choose a campaign type above to get started.</p>'}</div><p id="channel-feedback" role="status"></p>`}`;
 const form=mount.querySelector('form');
 form?.addEventListener('submit',async event=>{
   event.preventDefault();const button=form.querySelector('[type="submit"]');button.disabled=true;
   const feedback=mount.querySelector('#channel-feedback');feedback.textContent='Saving…';
   try {
    const payload={...Object.fromEntries(new FormData(form)),type:type.id,id:saved?.id};
    const result=await request('/api/channel-campaigns',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(version!==generation || !location.hash.startsWith('#/channels'))return;
    history.replaceState(null,'',`#/channels/${result.campaign.id}`);
    await showChannelCampaigns(mount);mount.querySelector('#channel-feedback').textContent='Draft saved. No calls or messages have been sent.';
   }catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}
 });
 mount.querySelectorAll('[data-delete]').forEach(button=>button.addEventListener('click',async()=>{
  if(!confirm('Delete this saved draft?'))return;
  button.disabled=true;
  try{await request(`/api/channel-campaigns/${encodeURIComponent(button.dataset.delete)}`,{method:'DELETE'});await showChannelCampaigns(mount);}catch(error){mount.querySelector('#channel-feedback').textContent=error.message;button.disabled=false;}
 }));
 }catch(error){if(version===generation)mount.textContent=error.message;}
}
