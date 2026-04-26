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

import { localizeDocument } from "../../vendor/i18n/i18n.mjs";
import { createDropdown } from "../shared/dropdown.mjs";

/** Look up a localized message, falling back to the inline default if the
 *  key is missing. Optional third arg forwards substitutions to
 *  `getMessage` for placeholder-bearing keys. */
const i18n = (key, fallback, substitutions) =>
  browser.i18n.getMessage(key, substitutions) || fallback;

const params = new URLSearchParams(location.search);
const accountId = params.get("accountId");
const readOnly = params.get("readOnly") === "1";

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
  if (!accountId) {
    showError(i18n("config.error.missingAccountId", "Missing account identifier."));
    return;
  }
  const reply = await browser.runtime.sendMessage({ type: "google.getAccount", accountId });
  if (!reply?.ok) {
    showError(reply?.error ?? i18n("config.error.loadFailed", "Failed to load account."));
    return;
  }
  const account = reply.result;

  document.getElementById("account-name").value = account.accountName ?? "";
  document.getElementById("email").textContent = account.authenticatedUserEmail ?? "—";
  document.getElementById("client-id").textContent = account.clientID ?? "—";
  document.getElementById("read-only-mode").checked = !!account.readOnlyMode;
  document.getElementById("include-system-groups").checked = !!account.includeSystemContactGroups;

  // Locked: set at setup and immutable here (changing the type would
  // invalidate the stored refresh token, which lives on disk).
  createDropdown(document.getElementById("client-type"), {
    options: [
      {
        value: "web",
        label: i18n("setup.clientType.web", "Web OAuth Client"),
        hint:  i18n("setup.clientType.web.hint", ""),
      },
      {
        value: "desktop",
        label: i18n("setup.clientType.desktop", "Desktop OAuth Client"),
        hint:  i18n("setup.clientType.desktop.hint", ""),
      },
    ],
    value: account.clientType === "web" ? "web" : "desktop",
    locked: true,
  });

  applyReadOnly();
}

function applyReadOnly() {
  const banner = document.getElementById("readonly-banner");
  if (readOnly) {
    banner.textContent = i18n("config.readOnlyBanner", "To prevent synchronization errors, settings cannot be edited while the account is enabled.");
    banner.classList.add("visible");
  } else {
    banner.classList.remove("visible");
  }
  for (const id of ["account-name", "read-only-mode", "include-system-groups"]) {
    document.getElementById(id).disabled = readOnly;
  }
  document.getElementById("btn-save").hidden = readOnly;
  // Cancel doubles as the only way out in read-only mode — label it "Close"
  // there so it reads as the primary/only action instead of a dismissal.
  const cancelBtn = document.getElementById("btn-cancel");
  cancelBtn.textContent = readOnly
    ? (i18n("config.close", "Close"))
    : (i18n("config.cancel", "Cancel"));
}

async function onSave() {
  if (readOnly) return;
  clearBanners();
  const patch = {
    accountName: document.getElementById("account-name").value.trim(),
    readOnlyMode: document.getElementById("read-only-mode").checked,
    includeSystemContactGroups: document.getElementById("include-system-groups").checked,
  };
  if (!patch.accountName) {
    showError(i18n("config.error.accountNameRequired", "Account name is required."));
    return;
  }
  document.getElementById("btn-save").disabled = true;
  try {
    const reply = await browser.runtime.sendMessage({ type: "google.saveAccount", accountId, patch });
    if (!reply?.ok) {
      throw new Error(reply?.error ?? i18n("config.error.saveFailed", "Save failed"));
    }
    window.close();
  } catch (err) {
    showError(err.message ?? String(err));
    document.getElementById("btn-save").disabled = false;
  }
}

localizeDocument();
load();
document.getElementById("btn-cancel").addEventListener("click", () => window.close());
document.getElementById("btn-save").addEventListener("click", onSave);
