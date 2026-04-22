import { KEYS } from "../shared/storage-keys.mjs";

/**
 * Provider-side account store. Keyed by providerAccountId, which is the stable
 * identifier the provider assigns before TbSync knows about the account. Maps
 * of providerAccountId ↔ tbsyncAccountId live in a separate KEYS.ACCOUNT_ID_MAP
 * entry to avoid coupling the account-record shape to host numbering.
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

export async function setTbsyncAccountId(providerAccountId, tbsyncAccountId) {
  const rv = await browser.storage.local.get({ [KEYS.ACCOUNT_ID_MAP]: {} });
  rv[KEYS.ACCOUNT_ID_MAP][providerAccountId] = tbsyncAccountId;
  await browser.storage.local.set({ [KEYS.ACCOUNT_ID_MAP]: rv[KEYS.ACCOUNT_ID_MAP] });
}

export async function getTbsyncAccountId(providerAccountId) {
  const rv = await browser.storage.local.get({ [KEYS.ACCOUNT_ID_MAP]: {} });
  return rv[KEYS.ACCOUNT_ID_MAP][providerAccountId] ?? null;
}

export async function getProviderAccountIdByTbsyncAccountId(tbsyncAccountId) {
  const rv = await browser.storage.local.get({ [KEYS.ACCOUNT_ID_MAP]: {} });
  for (const [pid, tid] of Object.entries(rv[KEYS.ACCOUNT_ID_MAP])) {
    if (tid === tbsyncAccountId) return pid;
  }
  return null;
}

export async function clearMapping(providerAccountId) {
  const rv = await browser.storage.local.get({ [KEYS.ACCOUNT_ID_MAP]: {} });
  delete rv[KEYS.ACCOUNT_ID_MAP][providerAccountId];
  await browser.storage.local.set({ [KEYS.ACCOUNT_ID_MAP]: rv[KEYS.ACCOUNT_ID_MAP] });
}
