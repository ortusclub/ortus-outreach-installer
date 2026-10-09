import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dataPath } from './paths.js';
import { channelType } from '../public/js/channel-types.mjs';
import { sameCompanyCampaign } from '../public/js/company-access.mjs';
const file = () => dataPath('channel-campaigns.json');
const read = () => existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : [];
const canAccess = (record, viewer) => record.owner === viewer.email || (viewer.admin && sameCompanyCampaign(record, viewer.email));
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function write(records) {
  writeFileSync(`${file()}.tmp`, JSON.stringify(records, null, 2), { mode: 0o600 });
  renameSync(`${file()}.tmp`, file());
}
export function listChannelCampaigns(viewer) { return read().filter(record => canAccess(record, viewer)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)); }
export function saveChannelCampaign(input, viewer) {
  if (!channelType(input?.type)) fail('Choose a supported campaign type.');
  if (!viewer.email) fail('Sign in to save a campaign.', 401);
  const text = (key, max) => { if (typeof input[key] !== 'string' || input[key].length > max) fail(`Invalid ${key}.`); return input[key].trim(); };
  const name = text('name', 150); if (!name) fail('Add a campaign name.');
  const recipients = text('recipients', 150000).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if (recipients.length > 10000 || recipients.some(phone => !/^\+[1-9]\d{6,14}$/.test(phone))) fail('Use one phone number per line, including + and the country code.');
  const sender = text('sender', 100);
  const records = read(); const current = input.id ? records.find(record => record.id === input.id) : null;
  if (input.id && (!current || !canAccess(current, viewer))) fail('Campaign not found.', 404);
  if (current && current.type !== input.type) fail('An existing campaign’s type cannot be changed.');
  const record = { id: current?.id || randomUUID(), type: input.type, name, sender, recipients: [...new Set(recipients)].join('\n'), content: text('content', 20000), templateName: text('templateName', 200), language: text('language', 50), owner: current?.owner || viewer.email, status: 'draft', createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  write([...records.filter(item => item.id !== record.id), record]); return record;
}
export function deleteChannelCampaign(id, viewer) {
 const records=read(); const current=records.find(record=>record.id===id);
 if (!current || !canAccess(current, viewer)) fail('Campaign not found.',404);
 write(records.filter(record=>record.id!==id));
}
export function installChannelCampaignRoutes(app, viewerOf) {
 app.get('/api/channel-campaigns', (req,res) => { try { res.set('Cache-Control','no-store').json({campaigns:listChannelCampaigns(viewerOf(req))}); } catch { res.status(500).json({error:'Could not load saved campaigns.'}); } });
 app.post('/api/channel-campaigns', (req,res) => { try { res.json({campaign:saveChannelCampaign(req.body,viewerOf(req))}); } catch(error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Could not save campaign.'}); } });
 app.delete('/api/channel-campaigns/:id', (req,res) => { try { deleteChannelCampaign(req.params.id,viewerOf(req));res.json({ok:true}); } catch(error) { res.status(error.status || 500).json({error:error.status ? error.message : 'Could not delete campaign.'}); } });
}
