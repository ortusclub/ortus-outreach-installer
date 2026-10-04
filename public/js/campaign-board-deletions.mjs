const key=value=>String(value||'').trim().toLowerCase();
export function isDeletedCampaign(item,entries){
 return entries.some(entry=>key(entry.owner)===key(item.mine?'mine':item.owner) && (
   (entry.campaignId && item.campaignId===entry.campaignId)
   || (entry.runIds||[]).includes(item.id)
   || (!item.campaignId && entry.legacyName && key(item.name)===entry.legacyName)));
}
