import { getRedirectURL } from "./modules/google/oauth.mjs";
import { GoogleProvider } from "./modules/google-provider.mjs";
import { runUpgrades, enqueueUpgradesForUpdate } from "./modules/upgrades.mjs";

/**
 * Provider entry point. All port / handshake plumbing lives inside the
 * TbSyncProviderImplementation base class — this file constructs the
 * concrete GoogleProvider, calls its init(), and routes internal
 * runtime.onMessage traffic (from setup.html / config.html) to the
 * appropriate provider method.
 *
 * The provider carries no persistent storage. The host owns the account
 * and folder rows (including OAuth secrets, groupMap, contactMap, and
 * the changelog). The host also runs the address-book observer; the
 * provider is a pure consumer of the host's changelog queue.
 */

const provider = new GoogleProvider();

/** Resolves once the provider has finished its boot sequence (instance
 *  constructed, `init()` returned, host port open). Any code that needs
 *  to do RPC work against the host without coupling to other init
 *  paths (the fixup runner, in particular) awaits this. */
export const providerReady = (async () => {
  // provider.init() is fire-and-forget below; it returns void
  // synchronously. The actual readiness signal we care about is the
  // first port-open, surfaced via onceConnectedToHost.
  await new Promise(resolve => provider.onceConnectedToHost(resolve));
})();

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
        clientType: msg.clientType,
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
    try {
      return await provider.getLastCredentials();
    } catch {
      return null;
    }
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

provider.init();

// Startup priming runs inside `provider.onConnectedToHost` (fired by the
// base class when the host opens the port), not here — at this point the
// port isn't open yet, so listAccounts/getAccount would fail with
// "host not connected".

// ── One-shot fixup runner ──────────────────────────────────────────────────
//
// `runtime.onInstalled` enqueues the IDs of every fixup whose split version
// falls in `(previousVersion, currentVersion]`, then drains them once the
// provider is connected to the host. Fresh installs short-circuit at the
// reason check so no fixup ever runs on a clean profile.
browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "update" || !details.previousVersion) return;
  const cur = browser.runtime.getManifest().version;
  const enqueued = await enqueueUpgradesForUpdate(details.previousVersion, cur);
  if (!enqueued) return;
  await providerReady;
  await runUpgrades(provider);
});

// Boot-time stale-queue drain. `runtime.onInstalled` only fires on the
// boot where the install/update *actually* happened — if a previous run
// failed mid-flight, the queue persists in storage and we need a second,
// independent trigger to retry. `runUpgrades` is idempotent + self-
// coalescing, so a same-boot collision with the listener above is safe.
providerReady.then(() => runUpgrades(provider));
