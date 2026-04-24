import * as changelogWatcher from "./modules/changelog-watcher.mjs";
import { getRedirectURL } from "./modules/google/oauth.mjs";
import { GoogleProvider } from "./modules/google-provider.mjs";

/**
 * Provider entry point. All port / handshake plumbing lives inside the
 * TbSyncProviderImplementation base class — this file constructs the
 * concrete GoogleProvider, calls its init(), and routes internal
 * runtime.onMessage traffic (from setup.html / config.html) to the
 * appropriate provider method.
 *
 * Provider-local storage is limited to OAuth refresh tokens, the pending
 * changelog, and the group map — all transient or secret. The host owns
 * the authoritative account + folder rows.
 */

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
changelogWatcher.init();

// Re-attach the changelog watcher to every book owned by this provider on
// startup. WebExtension event listeners don't replay across restarts, so we
// walk the host's account + folder rows and re-register each bound book.
// Runs best-effort; the host may still be booting when we hit this line.
provider.primeStartupState().catch(err => {
  console.warn("[google-4-tbsync] startup priming failed:", err);
});
