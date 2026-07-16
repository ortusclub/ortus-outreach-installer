// Thin publisher: POST the FG Auto-Pilot config to the central roster service.
// Any operator can call it — needs only the baked token, no gcloud.
import { FG_ROSTER_URL, FG_ROSTER_TOKEN } from './fg-roster-url.js';

export async function publishAutopilotConfig(config, {
  fetchImpl = fetch, rosterUrl = FG_ROSTER_URL, rosterToken = FG_ROSTER_TOKEN,
} = {}) {
  try {
    const r = await fetchImpl(`${rosterUrl}/admin/autopilot-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${rosterToken}` },
      body: JSON.stringify(config),
    });
    if (!r.ok) return { error: `publish failed: ${r.status}` };
    return { ok: true };
  } catch (e) { return { error: e.message }; }
}
