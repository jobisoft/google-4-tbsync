import { KEYS } from "./storage-keys.mjs";

/**
 * Per-account map between a Google contact-group `resourceName` and its
 * Thunderbird mailing-list id. Stores `etag` + `groupType` alongside so the
 * push pass can detect conflicts and skip system groups without a round-trip.
 *
 * Shape: `{ [providerAccountId]: { [resourceName]: {mailingListId, etag, groupType} } }`.
 */

async function read() {
  const rv = await browser.storage.local.get({ [KEYS.GROUP_MAP]: {} });
  return rv[KEYS.GROUP_MAP];
}

async function write(state) {
  await browser.storage.local.set({ [KEYS.GROUP_MAP]: state });
}

export async function get(providerAccountId, resourceName) {
  const state = await read();
  return state[providerAccountId]?.[resourceName] ?? null;
}

export async function getByListId(providerAccountId, mailingListId) {
  const entries = await listAll(providerAccountId);
  for (const [resourceName, entry] of entries) {
    if (entry.mailingListId === mailingListId) return { resourceName, ...entry };
  }
  return null;
}

export async function set(providerAccountId, resourceName, { mailingListId, etag, groupType }) {
  const state = await read();
  if (!state[providerAccountId]) state[providerAccountId] = {};
  state[providerAccountId][resourceName] = { mailingListId, etag, groupType };
  await write(state);
}

export async function remove(providerAccountId, resourceName) {
  const state = await read();
  if (!state[providerAccountId]?.[resourceName]) return false;
  delete state[providerAccountId][resourceName];
  await write(state);
  return true;
}

export async function listAll(providerAccountId) {
  const state = await read();
  return Object.entries(state[providerAccountId] ?? {});
}

export async function clearAccount(providerAccountId) {
  const state = await read();
  if (!state[providerAccountId]) return false;
  delete state[providerAccountId];
  await write(state);
  return true;
}
