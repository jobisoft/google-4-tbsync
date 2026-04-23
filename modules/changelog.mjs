import { KEYS } from "./storage-keys.mjs";

/**
 * Per-account changelog of pending local mutations. Entry shape:
 *   { kind, parentId, itemId, timestamp, status, resourceName? }
 * `kind` is "contact" or "group"; entries without it default to "contact"
 * so pre-M3c changelogs upgrade transparently. `resourceName` is captured
 * at event time so `deleted_by_user` entries survive after the local
 * object is gone.
 */

export const KIND = {
  CONTACT: "contact",
  GROUP: "group",
};

export const STATUS = {
  ADDED_BY_USER: "added_by_user",
  MODIFIED_BY_USER: "modified_by_user",
  DELETED_BY_USER: "deleted_by_user",
  ADDED_BY_SERVER: "added_by_server",
  MODIFIED_BY_SERVER: "modified_by_server",
  DELETED_BY_SERVER: "deleted_by_server",
};

function kindOf(entry) {
  return entry?.kind ?? KIND.CONTACT;
}

async function read() {
  const rv = await browser.storage.local.get({ [KEYS.CHANGELOG]: {} });
  return rv[KEYS.CHANGELOG];
}

async function write(state) {
  await browser.storage.local.set({ [KEYS.CHANGELOG]: state });
}

export async function listForAccount(providerAccountId) {
  const state = await read();
  return state[providerAccountId] ?? [];
}

export async function setForAccount(providerAccountId, entries) {
  const state = await read();
  state[providerAccountId] = Array.isArray(entries) ? entries : [];
  await write(state);
}

export async function append(providerAccountId, entry) {
  const state = await read();
  if (!state[providerAccountId]) state[providerAccountId] = [];
  state[providerAccountId].push({ timestamp: Date.now(), ...entry });
  await write(state);
}

export async function clearAccount(providerAccountId) {
  const state = await read();
  if (!state[providerAccountId]) return false;
  delete state[providerAccountId];
  await write(state);
  return true;
}

/**
 * Collapse entries to at most one per `(kind, itemId)`:
 *   - add + delete (any order) → drop
 *   - any delete  → single delete (carry the earliest resourceName forward)
 *   - any add     → single add (latest state is pushed)
 *   - modify only → single modify (latest timestamp wins)
 */
export function consolidate(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const byKey = new Map();
  for (const entry of entries) {
    if (!entry?.itemId) continue;
    const key = `${kindOf(entry)}:${entry.itemId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  }

  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const hasAdd = list.some(e => e.status === STATUS.ADDED_BY_USER);
    const hasDelete = list.some(e => e.status === STATUS.DELETED_BY_USER);

    if (hasAdd && hasDelete) continue;

    if (hasDelete) {
      const latestDelete = [...list].reverse().find(e => e.status === STATUS.DELETED_BY_USER);
      const resourceName = list.find(e => e.resourceName)?.resourceName ?? latestDelete.resourceName ?? null;
      out.push({ ...latestDelete, resourceName });
      continue;
    }

    if (hasAdd) {
      const firstAdd = list.find(e => e.status === STATUS.ADDED_BY_USER);
      out.push({ ...firstAdd });
      continue;
    }

    out.push({ ...list[list.length - 1] });
  }
  return out;
}
