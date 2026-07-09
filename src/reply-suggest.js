/**
 * AI-suggested reply drafts for the Replies inbox — opt-in, OFF by default.
 *
 * Calls the Claude API directly over fetch (no SDK dependency) to draft a
 * response to a lead's inbound reply. The draft is returned as TEXT for the
 * operator to copy manually. This module deliberately has NO imports from any
 * LinkedIn automation code — there is no path from a suggestion to a send.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;

/** Build the prompt from the stored reply entry. Exported for unit tests. */
export function buildPrompt(reply) {
  const lines = [
    'You draft short LinkedIn replies for an operator at The Ortus Club, which hosts invite-only executive roundtable dinners (moderated peer discussions, not sales pitches).',
    '',
    `The lead ${reply.leadName || '(unknown name)'} replied to our outreach${reply.campaign ? ` for the campaign "${reply.campaign}"` : ''}${reply.profileName ? `, sent from the LinkedIn account "${reply.profileName}"` : ''}:`,
    '',
    `"""${String(reply.text || '').slice(0, 2000)}"""`,
    '',
    'Draft a warm, concise reply (2-4 sentences, no subject line, no signature, no markdown). Match their tone. If they asked a question you cannot answer from context, acknowledge it and offer to share details rather than inventing specifics (never invent dates, links, or names). Output ONLY the reply text.',
  ];
  return lines.join('\n');
}

/**
 * Request a draft from the Claude API. Returns the suggestion string.
 * Throws with a readable message on HTTP/parse failure.
 */
export async function suggestReply(reply, { apiKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing');
  const resp = await fetchImpl(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildPrompt(reply) }],
    }),
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch { /* */ }
    throw new Error(`Claude API error ${resp.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await resp.json();
  const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('Claude API returned an empty draft');
  return text;
}
