import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dataPath } from './paths.js';

export const HUBSPOT_REQUIRED = 'Add your HubSpot private app access token in Settings → HubSpot access, then try again.';
const file = () => dataPath('hubspot-credentials.json');
export function applyHubSpotCredential() {
  if (!existsSync(file())) return;
  try {
    const { token } = JSON.parse(readFileSync(file(), 'utf8'));
    if (typeof token === 'string' && token.trim()) process.env.HUBSPOT_TOKEN = token.trim();
    else delete process.env.HUBSPOT_TOKEN;
  } catch {
    delete process.env.HUBSPOT_TOKEN;
    console.warn('[hubspot] Saved credential could not be read. Add it again in Settings.');
  }
}
export function hubspotCredentialStatus() {
  return { configured: !!process.env.HUBSPOT_TOKEN?.trim() };
}
export function saveHubSpotCredential(token) {
  if (typeof token !== 'string' || token.length > 4096 || /\s/.test(token.trim())) throw new Error('Enter a valid HubSpot access token without spaces.');
  token = token.trim();
  writeFileSync(`${file()}.tmp`, JSON.stringify({ token }), { mode: 0o600 });
  renameSync(`${file()}.tmp`, file());
  applyHubSpotCredential();
  return hubspotCredentialStatus();
}
export function requireHubSpotCredential(_req, res, next) {
  if (!hubspotCredentialStatus().configured) return res.status(409).json({ code: 'HUBSPOT_CREDENTIAL_REQUIRED', error: HUBSPOT_REQUIRED });
  next();
}
