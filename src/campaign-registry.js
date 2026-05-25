// Map-backed registry of campaign entries. Replaces the singleton
// `campaign` object in src/campaign.js as the source of truth for "which
// campaigns exist and what state are they in." This module is intentionally
// thin — runtime concerns (the loop, watchdog, parking lot) layer on top
// in src/campaign.js. Persistence layers on top in Phase 2.
//
// Entry shape is loose (any object with an `id` string). Callers attach
// their own fields (status, name, participatingProfileIds, etc.) — the
// registry just stores and indexes.

const ACTIVE_STATUSES = new Set(['running', 'paused', 'monitoring']);

export class CampaignRegistry {
  constructor() {
    this._byId = new Map();
  }

  register(entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error('CampaignRegistry.register: entry must have a non-empty string id');
    }
    if (this._byId.has(entry.id)) {
      throw new Error(`CampaignRegistry.register: entry with id "${entry.id}" already exists — use update()`);
    }
    this._byId.set(entry.id, entry);
    return entry;
  }

  get(id) {
    return this._byId.get(id);
  }

  update(id, patch) {
    const existing = this._byId.get(id);
    if (!existing) {
      throw new Error(`CampaignRegistry.update: entry with id "${id}" not found`);
    }
    Object.assign(existing, patch);
    return existing;
  }

  remove(id) {
    return this._byId.delete(id);
  }

  list({ status } = {}) {
    const all = Array.from(this._byId.values());
    return status ? all.filter((e) => e.status === status) : all;
  }

  runningIds() {
    const ids = new Set();
    for (const e of this._byId.values()) {
      if (e.status === 'running') ids.add(e.id);
    }
    return ids;
  }

  // Profile ids in use by any campaign that's actively holding browser
  // sessions or could resume to do so (running, paused, monitoring). The
  // account-lock helper (Phase 5) filters monitoring back out per spec
  // §4.5 (monitoring doesn't lock) — we keep monitoring in this union so
  // other callers (UI badges, debugging) get the full picture.
  activeProfileIds() {
    const ids = new Set();
    for (const e of this._byId.values()) {
      if (!ACTIVE_STATUSES.has(e.status)) continue;
      const pids = Array.isArray(e.participatingProfileIds) ? e.participatingProfileIds : [];
      for (const p of pids) ids.add(p);
    }
    return ids;
  }
}
