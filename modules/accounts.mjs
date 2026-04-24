import { KEYS } from "./storage-keys.mjs";

/**
 * Account store, keyed by providerAccountId (the stable id the provider
 * assigns at setup time). The providerAccountId ↔ tbsyncAccountId mapping
 * lives separately under KEYS.ACCOUNT_ID_MAP.
 */

async function read() {
  const rv = await browser.storage.local.get({ [KEYS.ACCOUNTS]: {} });
  return rv[KEYS.ACCOUNTS];
}

async function write(state) {
  await browser.storage.local.set({ [KEYS.ACCOUNTS]: state });
}

export async function list() {
  return Object.values(await read());
}

export async function get(providerAccountId) {
  const state = await read();
  return state[providerAccountId] ?? null;
}

export async function upsert(record) {
  if (!record?.providerAccountId) throw new Error("providerAccountId is required");
  const state = await read();
  state[record.providerAccountId] = { ...(state[record.providerAccountId] ?? {}), ...record };
  await write(state);
  return state[record.providerAccountId];
}

export async function remove(providerAccountId) {
  const state = await read();
  if (!state[providerAccountId]) return false;
  delete state[providerAccountId];
  await write(state);
  return true;
}

// ── providerAccountId ↔ tbsyncAccountId mapping ───────────────────────────

async function mapRead() {
  return (await browser.storage.local.get({ [KEYS.ACCOUNT_ID_MAP]: {} }))[KEYS.ACCOUNT_ID_MAP];
}

async function mapWrite(map) {
  await browser.storage.local.set({ [KEYS.ACCOUNT_ID_MAP]: map });
}

export async function setTbsyncAccountId(providerAccountId, tbsyncAccountId) {
  const map = await mapRead();
  map[providerAccountId] = tbsyncAccountId;
  await mapWrite(map);
}

export async function getTbsyncAccountId(providerAccountId) {
  const map = await mapRead();
  return map[providerAccountId] ?? null;
}

export async function getProviderAccountIdByTbsyncAccountId(tbsyncAccountId) {
  const map = await mapRead();
  for (const [pid, tid] of Object.entries(map)) {
    if (tid === tbsyncAccountId) return pid;
  }
  return null;
}

export async function clearMapping(providerAccountId) {
  const map = await mapRead();
  delete map[providerAccountId];
  await mapWrite(map);
}
