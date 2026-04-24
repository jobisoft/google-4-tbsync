/**
 * Setup popup.
 *
 * Collects an optional account label, the Google OAuth client ID/secret, and
 * initiates the OAuth flow by asking the background to call
 * `google.authenticate`. On success, posts `tbsync-setup-completed` so the
 * host's `openSetupPopup` RPC resolves with the canonical accountId.
 */

import { localizeDocument } from "../../vendor/i18n/i18n.mjs";

const params = new URLSearchParams(location.search);
const setupToken = params.get("setupToken");

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.classList.add("visible");
}

function clearError() {
  document.getElementById("error").classList.remove("visible");
}

async function prefillCredentials() {
  try {
    // Reads the host's accounts via `provider.listAccounts()` and picks the
    // most recent entry's custom.clientID / custom.clientSecret — no more
    // provider-local account storage to consult.
    const creds = await browser.runtime.sendMessage({ type: "google.getLastCredentials" });
    if (!creds) return;
    document.getElementById("client-id").value = creds.clientID ?? "";
    document.getElementById("client-secret").value = creds.clientSecret ?? "";
  } catch { /* ignore — fields stay blank */ }
}

async function onCopyRedirectURL() {
  const btn = document.getElementById("btn-copy");
  try {
    const { redirectURL } = await browser.runtime.sendMessage({ type: "google.getRedirectURL" });
    await navigator.clipboard.writeText(redirectURL);
    const prior = btn.textContent;
    btn.textContent = browser.i18n.getMessage("setup.copied") ?? "Copied";
    setTimeout(() => { btn.textContent = prior; }, 1200);
  } catch (err) {
    const detail = err.message ?? String(err);
    showError(
      browser.i18n.getMessage("setup.error.copyFailed", detail)
        ?? `Copy failed: ${detail}`
    );
  }
}

async function onSignIn() {
  clearError();
  const label = document.getElementById("account-name").value.trim();
  const clientID = document.getElementById("client-id").value.trim();
  const clientSecret = document.getElementById("client-secret").value.trim();
  if (!label) {
    showError(browser.i18n.getMessage("setup.error.accountNameRequired") ?? "Please enter an account name.");
    document.getElementById("account-name").focus();
    return;
  }
  if (!clientID || !clientSecret) {
    showError(browser.i18n.getMessage("setup.error.credentialsRequired") ?? "Please enter both the Client ID and the Client secret.");
    return;
  }
  if (!setupToken) {
    showError(browser.i18n.getMessage("setup.error.missingToken") ?? "Missing setup token. Open this window through TbSync.");
    return;
  }

  const btn = document.getElementById("btn-sign-in");
  btn.disabled = true;
  try {
    const reply = await browser.runtime.sendMessage({
      type: "google.authenticate",
      label, clientID, clientSecret,
    });
    if (!reply?.ok) {
      if (reply?.code === "E:CANCELLED") { btn.disabled = false; return; }
      throw new Error(reply?.error ?? browser.i18n.getMessage("setup.error.signInFailed") ?? "Sign-in failed");
    }

    await browser.runtime.sendMessage({
      type: "tbsync-setup-completed",
      setupToken,
      providerAccountId: reply.result.providerAccountId,
      accountName: reply.result.accountName,
      initialFolders: reply.result.initialFolders,
      // Seeds the host row's opaque `custom` blob atomically with creation.
      custom: reply.result.custom,
    });
    window.close();
  } catch (err) {
    btn.disabled = false;
    showError(err.message ?? String(err));
  }
}

localizeDocument();
prefillCredentials();
document.getElementById("btn-copy").addEventListener("click", onCopyRedirectURL);
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-sign-in").addEventListener("click", onSignIn);
