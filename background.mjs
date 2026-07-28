import { getRedirectURL } from "./modules/google/oauth.mjs";
import { GoogleProvider } from "./modules/google-provider.mjs";
import { stringifyError } from "./modules/errors.mjs";

/**
 * Provider entry point. All port / handshake plumbing lives inside the
 * TbSyncProviderImplementation base class - this file constructs the
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

// Internal messages from our own UI pages (setup.html, config.html).
// Errors are returned as structured { ok:false, error, code } rather than
// thrown, because runtime.sendMessage serialisation drops Error.code and
// the setup/config pages need the code to distinguish E:CANCELLED from
// real failures.
browser.runtime.onMessage.addListener(async (msg) => {
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
      return { ok: false, error: stringifyError(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.getRedirectURL") {
    try {
      return { ok: true, result: { redirectURL: getRedirectURL() } };
    } catch (err) {
      return { ok: false, error: stringifyError(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.getLastCredentials") {
    try {
      const result = await provider.getLastCredentials();
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: stringifyError(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.getAccount") {
    try {
      const result = await provider.getAccountForConfig(msg.accountId);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: stringifyError(err), code: err.code ?? null };
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
      return { ok: false, error: stringifyError(err), code: err.code ?? null };
    }
  }
  return undefined;
});

provider.init();

// Startup priming runs inside `provider.onConnectedToHost` (fired by the
// base class when the host opens the port), not here - at this point the
// port isn't open yet, so listAccounts/getAccount would fail with
// "host not connected".

