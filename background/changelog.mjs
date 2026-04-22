import { KEYS } from "../shared/storage-keys.mjs";

/**
 * Per-account changelog. Entry shape mirrors the legacy TbSync changelog to
 * keep migration trivial:
 *   { parentId, itemId, timestamp, status }
 */

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
