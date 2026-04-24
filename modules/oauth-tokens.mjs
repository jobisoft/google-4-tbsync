import { KEYS } from "./storage-keys.mjs";

/**
 * OAuth secrets per providerAccountId. Refresh tokens and the authenticated
 * email live here rather than on the host account record so the host's
 * storage never holds an OAuth secret. Losing this store (add-on uninstall
 * or wipe) costs one Sign-in-again click — the host's account row still
 * carries clientID/clientSecret via `custom` and kicks off reauth.
 *
 * Shape: { [providerAccountId]: { refreshToken, authenticatedUserEmail? } }
 */

async function read() {
  const rv = await browser.storage.local.get({ [KEYS.OAUTH_TOKENS]: {} });
  return rv[KEYS.OAUTH_TOKENS];
}

async function write(state) {
  await browser.storage.local.set({ [KEYS.OAUTH_TOKENS]: state });
}

export async function get(providerAccountId) {
  const state = await read();
  return state[providerAccountId] ?? null;
}

export async function set(providerAccountId, patch) {
  const state = await read();
  state[providerAccountId] = { ...(state[providerAccountId] ?? {}), ...patch };
  await write(state);
  return state[providerAccountId];
}

export async function remove(providerAccountId) {
  const state = await read();
  if (!state[providerAccountId]) return false;
  delete state[providerAccountId];
  await write(state);
  return true;
}
