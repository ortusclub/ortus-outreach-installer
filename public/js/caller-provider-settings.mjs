export async function openCallerProviderSettings(){
 const modal=document.getElementById('caller-provider-modal');const input=document.getElementById('caller-vapi-token');const status=document.getElementById('caller-provider-status');
 input.value='';modal.classList.remove('hidden');status.textContent='Loading…';input.focus();
 try{const response=await fetch('/api/caller/provider');const data=await response.json();if(!response.ok)throw new Error(data.error);status.textContent=data.vapiConfigured?'Private key saved for your company on this computer.':'No private Vapi key saved.';}catch(error){status.textContent=error.message;}
}
export function closeCallerProviderSettings(){document.getElementById('caller-vapi-token').value='';document.getElementById('caller-provider-modal').classList.add('hidden');}
export async function saveCallerProviderSettings(remove=false){
 const input=document.getElementById('caller-vapi-token');const status=document.getElementById('caller-provider-status');
 if(!remove&&!input.value.trim()){status.textContent='Paste your private Vapi API key first.';return;}
 const buttons=[...document.querySelectorAll('#caller-provider-modal button')];buttons.forEach(b=>b.disabled=true);
 try{const response=await fetch('/api/caller/provider',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({vapiToken:remove?'':input.value.trim()})});const data=await response.json();if(!response.ok)throw new Error(data.error);input.value='';status.textContent=remove?'Vapi key removed.':'Vapi key saved. Open your caller campaign and select Load Vapi options.';}catch(error){status.textContent=error.message;}finally{buttons.forEach(b=>b.disabled=false);}
}
