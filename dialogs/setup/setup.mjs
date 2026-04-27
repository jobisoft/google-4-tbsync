/**
 * Setup popup.
 *
 * Collects an optional account label, the Google OAuth client ID/secret, and
 * initiates the OAuth flow by asking the background to call
 * `google.authenticate`. On success, posts `tbsync-setup-completed` so the
 * host's `openSetupPopup` RPC resolves with the canonical accountId.
 */

import { localizeDocument } from "../../vendor/i18n/i18n.mjs";
import { createDropdown } from "../shared/dropdown.mjs";
import { stringifyError } from "../../modules/errors.mjs";
import { ERR } from "../../vendor/tbsync/provider.mjs";

/** Look up a localized message, falling back to the inline default if the
 *  key is missing. Optional third arg forwards substitutions to
 *  `getMessage` for placeholder-bearing keys. */
const i18n = (key, fallback, substitutions) =>
  browser.i18n.getMessage(key, substitutions) || fallback;

const params = new URLSearchParams(location.search);
const setupToken = params.get("setupToken");

const TYPE_DESKTOP = "desktop";
const TYPE_WEB     = "web";

let clientTypeDropdown;

/** Cached per-type credential prefills, keyed by client type. Populated
 *  once at boot from the host's account list; consulted on every
 *  client-type change so the form swaps to the most-recent credentials
 *  for the chosen type. */
let lastCredentials = { desktop: null, web: null };

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.classList.add("visible");
}

function clearError() {
  document.getElementById("error").classList.remove("visible");
}

async function loadLastCredentials() {
  try {
    const reply = await browser.runtime.sendMessage({ type: "google.getLastCredentials" });
    const creds = reply?.ok ? reply.result : null;
    if (creds && typeof creds === "object") {
      lastCredentials = {
        desktop: creds.desktop ?? null,
        web:     creds.web     ?? null,
      };
    }
  } catch { /* ignore - fields stay blank */ }
  applyCredentialsForType(clientTypeDropdown.getValue());
}

/** Replace the credential fields with the most-recent values for the
 *  given client type, or blank them out when there are none on file. */
function applyCredentialsForType(type) {
  const creds = lastCredentials[type];
  document.getElementById("client-id").value     = creds?.clientID     ?? "";
  document.getElementById("client-secret").value = creds?.clientSecret ?? "";
}

async function onCopyRedirectURL() {
  const btn = document.getElementById("btn-copy");
  try {
    const reply = await browser.runtime.sendMessage({ type: "google.getRedirectURL" });
    if (!reply?.ok) {
      throw new Error(reply?.error ?? i18n("setup.error.copyFailed", "Copy failed", "unknown error"));
    }
    await navigator.clipboard.writeText(reply.result.redirectURL);
    const prior = btn.textContent;
    btn.textContent = i18n("setup.copied", "Copied");
    setTimeout(() => { btn.textContent = prior; }, 1200);
  } catch (err) {
    const detail = stringifyError(err);
    showError(i18n("setup.error.copyFailed", `Copy failed: ${detail}`, detail));
  }
}

async function onSignIn() {
  clearError();
  const label = document.getElementById("account-name").value.trim();
  const clientID = document.getElementById("client-id").value.trim();
  const clientSecret = document.getElementById("client-secret").value.trim();
  const clientType = clientTypeDropdown.getValue();
  if (!label) {
    showError(i18n("setup.error.accountNameRequired", "Please enter an account name."));
    document.getElementById("account-name").focus();
    return;
  }
  if (!clientID || !clientSecret) {
    showError(i18n("setup.error.credentialsRequired", "Please enter both the Client ID and the Client secret."));
    return;
  }
  if (!setupToken) {
    showError(i18n("setup.error.missingToken", "Missing setup token. Open this window through TbSync."));
    return;
  }

  const btn = document.getElementById("btn-sign-in");
  btn.disabled = true;
  try {
    const reply = await browser.runtime.sendMessage({
      type: "google.authenticate",
      label, clientID, clientSecret, clientType,
    });
    if (!reply?.ok) {
      if (reply?.code === ERR.CANCELLED) { btn.disabled = false; return; }
      throw new Error(reply?.error ?? i18n("setup.error.signInFailed", "Sign-in failed"));
    }

    await browser.runtime.sendMessage({
      type: "tbsync-setup-completed",
      setupToken,
      accountName: reply.result.accountName,
      initialFolders: reply.result.initialFolders,
      // Seeds the host row's opaque `custom` blob atomically with creation.
      custom: reply.result.custom,
    });
    window.close();
  } catch (err) {
    btn.disabled = false;
    showError(stringifyError(err));
  }
}

function applyClientType(type) {
  document.getElementById("redirect-hint").hidden = type !== TYPE_WEB;
  applyCredentialsForType(type);
}

localizeDocument();
clientTypeDropdown = createDropdown(document.getElementById("client-type"), {
  options: [
    {
      value: TYPE_WEB,
      label: i18n("setup.clientType.web", "Web OAuth Client"),
      hint:  i18n("setup.clientType.web.hint", ""),
    },
    {
      value: TYPE_DESKTOP,
      label: i18n("setup.clientType.desktop", "Desktop OAuth Client"),
      hint:  i18n("setup.clientType.desktop.hint", ""),
    },
  ],
  value: TYPE_WEB,
  onChange: applyClientType,
});
applyClientType(clientTypeDropdown.getValue());

loadLastCredentials();
document.getElementById("btn-copy").addEventListener("click", onCopyRedirectURL);
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-sign-in").addEventListener("click", onSignIn);

document.body.addEventListener("click", e => {
  const a = e.target.closest("a[data-link-target='browser']");
  if (!a) return;
  e.preventDefault();
  messenger.windows.openDefaultBrowser(a.getAttribute("href"));
});

// ESC closes the dialog; Enter while focused in a text input fires the
// primary action (when enabled and visible). `defaultPrevented` lets the
// dropdown's own Escape handler swallow the key when its panel is open.
document.addEventListener("keydown", e => {
  if (e.defaultPrevented) return;
  if (e.key === "Escape") {
    window.close();
    return;
  }
  if (e.key === "Enter" && e.target?.tagName === "INPUT") {
    const btn = document.querySelector("button.primary:not([hidden])");
    if (btn && !btn.disabled) {
      e.preventDefault();
      btn.click();
    }
  }
});
