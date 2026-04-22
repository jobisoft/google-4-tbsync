/**
 * Setup popup.
 *
 * Collects an optional account label, the Google OAuth client ID/secret, and
 * initiates the OAuth flow by asking the background to call
 * `google.authenticate`. On success, posts `tbsync-setup-completed` so the
 * host's `openSetupPopup` RPC resolves with the canonical accountId.
 */

const params = new URLSearchParams(location.search);
const setupToken = params.get("setupToken");

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const msg = browser.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.title = browser.i18n.getMessage("setup.title") ?? "Add a Google account";
}

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
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = prior; }, 1200);
  } catch (err) {
    showError(`Copy failed: ${err.message ?? err}`);
  }
}

async function onSignIn() {
  clearError();
  const label = document.getElementById("account-name").value.trim();
  const clientID = document.getElementById("client-id").value.trim();
  const clientSecret = document.getElementById("client-secret").value.trim();
  if (!label) {
    showError("Please enter an account name.");
    document.getElementById("account-name").focus();
    return;
  }
  if (!clientID || !clientSecret) {
    showError("Please enter both the Client ID and the Client secret.");
    return;
  }
  if (!setupToken) {
    showError("Missing setup token. Open this window through TbSync.");
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
      throw new Error(reply?.error ?? "Sign-in failed");
    }

    await browser.runtime.sendMessage({
      type: "tbsync-setup-completed",
      setupToken,
      providerAccountId: reply.result.providerAccountId,
      accountName: reply.result.accountName,
      initialFolders: reply.result.initialFolders,
    });
    window.close();
  } catch (err) {
    btn.disabled = false;
    showError(err.message ?? String(err));
  }
}

applyI18n();
prefillCredentials();
document.getElementById("btn-copy").addEventListener("click", onCopyRedirectURL);
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-sign-in").addEventListener("click", onSignIn);
