import { coldStageRequirements } from '../public/js/mature-pool-capacity.mjs';
import { normalizeProfileUrl } from './preflight-lint.js';

// Sample once at launch and persist that exact list to the account's plan tab.
// Never repeat a recipient within one profile's list or pad a short pool.
export function selectMatureColdLeads({ plan, rows, excludedUrls = [], urlOf = row => row['LinkedIn URL'], random = Math.random }) {
  const stages = coldStageRequirements(plan);
  const required = stages.reduce((sum, stage) => sum + stage.count, 0);
  if (!Number.isSafeInteger(required)) throw new Error('The cold plan total is too large. Reduce the stage limits.');
  const seen = new Set(excludedUrls.filter(Boolean).map(normalizeProfileUrl));
  const candidates = [];
  for (const row of rows) {
    const linkedinUrl = urlOf(row);
    if (!linkedinUrl || !/^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^/?#]+/i.test(linkedinUrl)) continue;
    const key = normalizeProfileUrl(linkedinUrl);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = String(row['Full Name'] || row.Name || `${row['First Name'] || row['first name'] || ''} ${row['Last Name'] || row['last name'] || ''}`).trim();
    candidates.push({ name, linkedinUrl });
  }
  if (candidates.length < required) throw new Error(`The cold plan needs ${required} unique profiles, but the source has only ${candidates.length} eligible profiles. Reduce the stage limits or add more people to the source sheet.`);
  if (plan.coldPoolOrder !== 'descending') {
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
  }
  return { leads: candidates.slice(0, required), available: candidates.length, required, stages };
}
