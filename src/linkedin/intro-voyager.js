/**
 * Voyager intro-send module — 3-way introduction DM via direct API.
 *
 * Spec: docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md
 * Endpoint: POST /voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage
 *
 * Used by auto-intro.js as the preferred path. If this rejects (4xx, network
 * error), the caller falls through to the existing DOM typeahead at
 * actions.js:sendIntroMessage.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { resolveProfileUrn, getSenderUrn } from './helpers.js';

const ENDPOINT = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';

/**
 * Build the JSON payload for the createMessage POST.
 *
 * Shape grounded in the 2026-05-18 DevTools recon captured at
 * docs/superpowers/specs/2026-05-18-voyager-intro-send-design.md.
 *
 * @param {object} args
 * @param {string} args.senderUrn        - urn:li:fsd_profile:ACoAA…
 * @param {string[]} args.recipientUrns  - [leadUrn, primaryUrn] in that order
 * @param {string} args.body             - the message body text
 * @param {string} [args.title]          - optional conversation title; omitted from payload if empty/whitespace
 * @returns {object} payload object (caller JSON.stringify's it for the POST)
 */
export function buildCreateMessagePayload({ senderUrn, recipientUrns, body, title } = {}) {
  if (!senderUrn || typeof senderUrn !== 'string') {
    throw new Error('buildCreateMessagePayload: senderUrn required');
  }
  if (!Array.isArray(recipientUrns) || recipientUrns.length === 0) {
    throw new Error('buildCreateMessagePayload: recipientUrns required (non-empty array)');
  }
  if (!body || typeof body !== 'string') {
    throw new Error('buildCreateMessagePayload: body required');
  }

  const payload = {
    message: {
      body: { attributes: [], text: body },
      originToken: randomUUID(),
      renderContentUnions: [],
    },
    mailboxUrn: senderUrn,
    hostRecipientUrns: recipientUrns.slice(),
    dedupeByClientGeneratedToken: false,
    // 16-char alphanumeric tracking id (LinkedIn's UI uses 16 random bytes;
    // hex encoding of 8 random bytes yields exactly 16 chars reliably and
    // survives JSON encoding cleanly).
    trackingId: randomBytes(8).toString('hex'),
  };
  const t = (title || '').trim();
  if (t) payload.conversationTitle = t;
  return payload;
}
