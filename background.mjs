import { CURRENT_SCHEMA_VERSION, KEYS } from "./modules/storage-keys.mjs";
import * as accounts from "./modules/accounts.mjs";
import * as folders from "./modules/folders.mjs";
import * as changelogWatcher from "./modules/changelog-watcher.mjs";
import { getRedirectURL } from "./modules/google/oauth.mjs";
import { GoogleProvider } from "./modules/google-provider.mjs";

/**
 * Provider entry point. All the port/handshake plumbing lives inside the
 * TbSyncProviderImplementation base class — this file just constructs the
 * concrete GoogleProvider, calls its init(), and routes internal
 * runtime.onMessage traffic (from setup.html / config.html) to the
 * appropriate provider method.
 */

async function ensureSchema() {
  const rv = await browser.storage.local.get({ [KEYS.SCHEMA_VERSION]: 0 });
  if (rv[KEYS.SCHEMA_VERSION] !== CURRENT_SCHEMA_VERSION) {
    await browser.storage.local.set({ [KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION });
  }
}

const provider = new GoogleProvider();

// Internal messages from our own UI pages (setup.html, config.html).
// Errors are returned as structured { ok:false, error, code } rather than
// thrown, because runtime.sendMessage serialisation drops Error.code and
// the setup/config pages need the code to distinguish E:CANCELLED from
// real failures.
browser.runtime.onMessage.addListener(async msg => {
  if (msg?.type === "google.authenticate") {
    try {
      const result = await provider.authenticateAndCreateAccount({
        label: msg.label,
        clientID: msg.clientID,
        clientSecret: msg.clientSecret,
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message ?? String(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.getRedirectURL") {
    return { redirectURL: getRedirectURL() };
  }
  if (msg?.type === "google.getLastCredentials") {
    // Pre-populate the setup popup from the most-recently-created account.
    // No new storage — just read the existing account records.
    const rv = await browser.storage.local.get({ [KEYS.ACCOUNTS]: {} });
    const last = Object.values(rv[KEYS.ACCOUNTS])
      .filter(a => a.clientID && a.clientSecret)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    return last
      ? { clientID: last.clientID, clientSecret: last.clientSecret }
      : null;
  }
  if (msg?.type === "google.getAccount") {
    try {
      const result = await provider.getAccountForConfig(msg.accountId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message ?? String(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.saveAccount") {
    try {
      const result = await provider.saveAccountFromConfig({
        accountId: msg.accountId,
        patch: msg.patch ?? {},
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message ?? String(err), code: err.code ?? null };
    }
  }
  return undefined;
});

await ensureSchema();
provider.init();
changelogWatcher.init();

// Re-attach the changelog watcher to every book owned by this provider.
// WebExtension event listeners don't replay events across restarts, so we
// walk every stored account's folders and register each existing book so
// subsequent user edits are captured from this point forward.
try {
  for (const account of await accounts.list()) {
    for (const folder of await folders.listForAccount(account.providerAccountId)) {
      if (folder.targetAbId) {
        await changelogWatcher.registerTarget(folder.targetAbId, account.providerAccountId);
      }
    }
  }
} catch (err) {
  console.warn("[google-4-tbsync] changelog-watcher startup priming failed:", err);
}
