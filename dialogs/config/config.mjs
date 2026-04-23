/**
 * Config popup controller — account settings only.
 *
 * Reads `accountId` + `readOnly` from the URL, fetches the sanitized account
 * via `google.getAccount`, and renders an editable or read-only form.
 *
 * Save path → `google.saveAccount` applies the allow-listed patch.
 *
 * `readOnly=true` means the account is currently connected in TbSync; we must
 * not allow edits while it's live. The banner explains why; inputs render
 * disabled; Save is hidden; Cancel becomes Close.
 *
 * Re-authentication is a separate flow driven by the manager's "Sign in again"
 * button; it runs Google's consent directly via launchWebAuthFlow with no
 * intermediate provider UI. This popup therefore has no Sign-in-again button
 * by design.
 */

const params = new URLSearchParams(location.search);
const accountId = params.get("accountId");
const readOnly = params.get("readOnly") === "1";

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const msg = browser.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.title = browser.i18n.getMessage("config.title") ?? "Google account settings";
  const titleEl = document.getElementById("title");
  if (titleEl) titleEl.textContent = browser.i18n.getMessage("config.title") ?? "Google account settings";
}

function showError(message) {
  const el = document.getElementById("error");
  el.textContent = message;
  el.classList.add("visible");
  document.getElementById("info").classList.remove("visible");
}

function clearBanners() {
  document.getElementById("error").classList.remove("visible");
  document.getElementById("info").classList.remove("visible");
}

async function load() {
  if (!accountId) { showError("Missing accountId."); return; }
  const reply = await browser.runtime.sendMessage({ type: "google.getAccount", accountId });
  if (!reply?.ok) { showError(reply?.error ?? "Failed to load account."); return; }
  const account = reply.result;

  document.getElementById("account-name").value = account.accountName ?? "";
  document.getElementById("email").textContent = account.authenticatedUserEmail ?? "—";
  document.getElementById("client-id").textContent = account.clientID ?? "—";
  document.getElementById("read-only-mode").checked = !!account.readOnlyMode;
  document.getElementById("include-system-groups").checked = !!account.includeSystemContactGroups;
  document.getElementById("verbose-logging").checked = !!account.verboseLogging;

  applyReadOnly();
}

function applyReadOnly() {
  const banner = document.getElementById("readonly-banner");
  if (readOnly) {
    banner.textContent = browser.i18n.getMessage("config.readOnlyBanner")
      ?? "To prevent synchronization errors, settings cannot be edited while the account is enabled.";
    banner.classList.add("visible");
  } else {
    banner.classList.remove("visible");
  }
  for (const id of ["account-name", "read-only-mode", "include-system-groups", "verbose-logging"]) {
    document.getElementById(id).disabled = readOnly;
  }
  document.getElementById("btn-save").hidden = readOnly;
  // Cancel doubles as the only way out in read-only mode — label it "Close"
  // there so it reads as the primary/only action instead of a dismissal.
  const cancelBtn = document.getElementById("btn-cancel");
  cancelBtn.textContent = readOnly
    ? (browser.i18n.getMessage("config.close") ?? "Close")
    : (browser.i18n.getMessage("config.cancel") ?? "Cancel");
}

async function onSave() {
  if (readOnly) return;
  clearBanners();
  const patch = {
    accountName: document.getElementById("account-name").value.trim(),
    readOnlyMode: document.getElementById("read-only-mode").checked,
    includeSystemContactGroups: document.getElementById("include-system-groups").checked,
    verboseLogging: document.getElementById("verbose-logging").checked,
  };
  if (!patch.accountName) {
    showError(browser.i18n.getMessage("setup.accountName")
      ? `${browser.i18n.getMessage("setup.accountName")} is required.`
      : "Account name is required.");
    return;
  }
  document.getElementById("btn-save").disabled = true;
  try {
    const reply = await browser.runtime.sendMessage({ type: "google.saveAccount", accountId, patch });
    if (!reply?.ok) throw new Error(reply?.error ?? "Save failed");
    window.close();
  } catch (err) {
    showError(err.message ?? String(err));
    document.getElementById("btn-save").disabled = false;
  }
}

applyI18n();
load();
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-save").addEventListener("click", onSave);
