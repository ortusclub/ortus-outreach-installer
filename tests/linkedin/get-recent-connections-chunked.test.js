// getRecentConnections now walks the connections list in chunks (each its own
// page.evaluate()) so a large network can't blow past the 180s CDP protocolTimeout
// — Operation Magellan previously capped a 13k-connection account at ~page 66.
//
// page.evaluate is mocked to return synthetic chunk results based on the args the
// chunker passes (basePage / want / endpointIdx), so we can assert the Node-side
// behaviour without a real browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecentConnections } from '../../src/linkedin/helpers.js';

const PAGE_SIZE = 40;

// A page whose evaluate() emits `total` synthetic connections, honouring the
// chunk window the chunker asks for. Records every call's args.
function mockPage(total) {
  const calls = [];
  return {
    calls,
    url: () => 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    goto: async () => {},
    evaluate: async (_fn, args) => {
      calls.push(args);
      const { basePage, want, endpointIdx } = args;
      const out = [];
      let reachedEnd = false;
      for (let i = 0; i < want; i++) {
        const pageStart = (basePage + i) * PAGE_SIZE;
        if (pageStart >= total) { reachedEnd = true; break; }
        const n = Math.min(PAGE_SIZE, total - pageStart);
        for (let k = 0; k < n; k++) {
          const id = pageStart + k;
          out.push({ urn: `u${id}`, publicId: `p${id}`, firstName: 'F', lastName: 'L', memberNumber: `${id}`, connectedAt: 0 });
        }
        if (n < PAGE_SIZE) { reachedEnd = true; break; }
      }
      return {
        connections: out, done: reachedEnd, stoppedEarly: false, partial: null,
        total, firstPageKeys: 'elements', endpointIndex: endpointIdx < 0 ? 0 : endpointIdx,
      };
    },
  };
}

test('a large list is walked across multiple chunks and fully accumulated, in order', async () => {
  const page = mockPage(3700); // > one chunk (CHUNK_PAGES*PAGE_SIZE = 1600)
  const conns = await getRecentConnections(page, 0, { maxPages: 500 });
  assert.equal(conns.error, undefined, 'no error');
  assert.equal(conns.length, 3700, 'every connection across all chunks is collected');
  assert.ok(page.calls.length >= 3, `walked in multiple chunks (got ${page.calls.length})`);
  assert.equal(conns[0].urn, 'u0');
  assert.equal(conns[3699].urn, 'u3699');
  // no duplicates / no gaps
  assert.ok(conns.every((c, i) => c.urn === `u${i}`), 'order preserved, no dupes or gaps across chunk seams');
});

test('the endpoint is probed once and reused on later chunks (no re-fetch of page 0)', async () => {
  const page = mockPage(3700);
  await getRecentConnections(page, 0, { maxPages: 500 });
  assert.equal(page.calls[0].endpointIdx, -1, 'first chunk probes for a working endpoint');
  assert.ok(page.calls.slice(1).every((c) => c.endpointIdx === 0), 'later chunks reuse the chosen endpoint');
});

test('an empty network finishes in a single chunk', async () => {
  const page = mockPage(0);
  const conns = await getRecentConnections(page, 0, { maxPages: 500 });
  assert.equal(conns.length, 0);
  assert.equal(page.calls.length, 1, 'does not keep probing to maxPages on an empty list');
});

test('a chunk error after the first chunk keeps what earlier chunks collected (partial)', async () => {
  let n = 0;
  const page = {
    url: () => 'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    goto: async () => {},
    evaluate: async (_fn, { endpointIdx }) => {
      n += 1;
      if (n === 1) {
        // full first chunk → not done, so the chunker asks for more
        const out = Array.from({ length: 40 * 40 }, (_, k) => ({ urn: `u${k}`, publicId: `p${k}`, firstName: 'F', lastName: 'L', memberNumber: `${k}`, connectedAt: 0 }));
        return { connections: out, done: false, stoppedEarly: false, partial: null, total: 9999, firstPageKeys: 'elements', endpointIndex: endpointIdx < 0 ? 0 : endpointIdx };
      }
      return { connections: [], done: false, stoppedEarly: false, partial: 'Failed to fetch (page 41, 1600 collected, tab was on the connections page)', total: 9999, firstPageKeys: 'elements', endpointIndex: 0 };
    },
  };
  const conns = await getRecentConnections(page, 0, { maxPages: 500 });
  assert.equal(conns.error, undefined, 'a mid-walk failure is not a hard error — we keep what we have');
  assert.equal(conns.length, 1600, 'the first chunk is retained');
  assert.match(conns.partial || '', /Failed to fetch/, 'the partial reason is surfaced');
});
