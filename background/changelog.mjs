import { KEYS } from "../shared/storage-keys.mjs";

/**
 * Per-account changelog of pending local mutations to push to Google. Entry
 * shape mirrors the legacy TbSync changelog plus a `resourceName` snapshot
 * (captured at event time so `deleted_by_user` entries survive after the
 * local card is gone):
 *
 *   { parentId, itemId, timestamp, status, resourceName? }
 *
 * `status` values: see `STATUS` below. `_by_server` variants stay in the
 * enum for M3c's group-membership tracking but are not produced in M3b.
 */

export const STATUS = {
  ADDED_BY_USER: "added_by_user",
  MODIFIED_BY_USER: "modified_by_user",
  DELETED_BY_USER: "deleted_by_user",
  ADDED_BY_SERVER: "added_by_server",
  MODIFIED_BY_SERVER: "modified_by_server",
  DELETED_BY_SERVER: "deleted_by_server",
};

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
 * Collapse a changelog entry list to at most one entry per `itemId`, applying
 * the standard dedup rules:
 *   - add + delete (any order) → drop (item never reached the server)
 *   - any delete           → single delete (carry forward any known resourceName)
 *   - any add (no delete)  → single add (current card state will be pushed)
 *   - modify only          → single modify (latest timestamp wins)
 *
 * Pure function; does not touch storage.
 */
export function consolidate(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const byItem = new Map();
  for (const entry of entries) {
    if (!entry?.itemId) continue;
    if (!byItem.has(entry.itemId)) byItem.set(entry.itemId, []);
    byItem.get(entry.itemId).push(entry);
  }

  const out = [];
  for (const list of byItem.values()) {
    list.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const hasAdd = list.some(e => e.status === STATUS.ADDED_BY_USER);
    const hasDelete = list.some(e => e.status === STATUS.DELETED_BY_USER);

    if (hasAdd && hasDelete) continue;

    if (hasDelete) {
      // Keep the most recent delete; carry forward the earliest recorded
      // resourceName so deletions of items that were synced pre-install still
      // have something to DELETE against.
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
