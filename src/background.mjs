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
 * The host owns the account and folder rows, including OAuth secrets,
 * groupMap and contactMap. The changelog is ours: pending edits live in
 * this add-on's own storage, and we watch our own address book for them -
 * so an edit is recorded whether or not the host is alive to hear it.
 */

const provider = new GoogleProvider();

// Internal messages from our own UI pages (setup.html, config.html).
//
// The listener is deliberately NOT async. Returning a promise from an
// onMessage listener claims the message and supplies its response, so an
// async listener would answer every message in this add-on - including
// `tbsync-setup-completed`, which belongs to the base class's own listener.
// Returning nothing for anything not in this table leaves those alone.
//
// Errors come back as structured { ok:false, error, code } rather than
// thrown, because runtime.sendMessage serialisation drops Error.code and the
// setup/config pages need the code to distinguish E:CANCELLED from real
// failures.
const MESSAGE_HANDLERS = {
  "google.authenticate": (msg) =>
    provider.authenticateAndCreateAccount({
      label: msg.label,
      clientID: msg.clientID,
      clientSecret: msg.clientSecret,
      clientType: msg.clientType,
    }),

  "google.getRedirectURL": () => ({ redirectURL: getRedirectURL() }),

  "google.getLastCredentials": () => provider.getLastCredentials(),

  "google.getAccount": (msg) => provider.getAccountForConfig(msg.accountId),

  "google.saveAccount": (msg) =>
    provider.saveAccountFromConfig({
      accountId: msg.accountId,
      patch: msg.patch ?? {},
    }),
};

/** Run a handler and shape the reply the dialogs expect. */
async function replyEnvelope(handler, msg) {
  try {
    return { ok: true, result: await handler(msg) };
  } catch (err) {
    return {
      ok: false,
      error: stringifyError(err),
      code: err?.code ?? null,
      details: err?.details ?? null,
    };
  }
}

browser.runtime.onMessage.addListener((msg) => {
  const handler = MESSAGE_HANDLERS[msg?.type];
  // Not ours - stay out of the way so the listener it belongs to can answer.
  if (!handler) return;
  return replyEnvelope(handler, msg);
});

provider.init();

// Startup priming runs inside `provider.onConnectedToHost` (fired by the
// base class when the host opens the port), not here - at this point the
// port isn't open yet, so listAccounts/getAccount would fail with
// "host not connected".

