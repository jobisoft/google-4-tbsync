import { KEYS } from "../shared/storage-keys.mjs";

/**
 * Provider-side folder store, keyed by providerAccountId. Carries the
 * sync-cursor bits (pageToken, syncToken) and the Thunderbird target AB id.
 */

async function read() {
  const rv = await browser.storage.local.get({ [KEYS.FOLDERS]: {} });
  return rv[KEYS.FOLDERS];
}

async function write(state) {
  await browser.storage.local.set({ [KEYS.FOLDERS]: state });
}

export async function listForAccount(providerAccountId) {
  const state = await read();
  return Object.values(state[providerAccountId] ?? {});
}

export async function get(providerAccountId, folderId) {
  const state = await read();
  return state[providerAccountId]?.[folderId] ?? null;
}

export async function upsert(providerAccountId, record) {
  const state = await read();
  if (!state[providerAccountId]) state[providerAccountId] = {};
  state[providerAccountId][record.folderId] = {
    ...(state[providerAccountId][record.folderId] ?? {}),
    ...record,
    providerAccountId,
  };
  await write(state);
  return state[providerAccountId][record.folderId];
}

export async function remove(providerAccountId, folderId) {
  const state = await read();
  if (!state[providerAccountId]?.[folderId]) return false;
  delete state[providerAccountId][folderId];
  await write(state);
  return true;
}

export async function clearAccount(providerAccountId) {
  const state = await read();
  if (!state[providerAccountId]) return false;
  delete state[providerAccountId];
  await write(state);
  return true;
}
