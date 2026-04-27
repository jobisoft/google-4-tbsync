/**
 * Config popup controller - account settings only.
 *
 * Reads `accountId` + `readOnly` from the URL, fetches the sanitized account
 * via `google.getAccount`, and renders an editable or read-only form.
 *
 * Save path → `google.saveAccount` applies the allow-listed patch.
 *
 * `readOnly=true` means the account is currently connected in TbSync; we must
 * not allow edits while it's live. The banner explains why; inputs render
 * disabled; the secret field is hidden entirely; Save is hidden; Cancel
 * becomes Close.
 *
 * The OAuth client type is always rendered as a locked dropdown - switching
 * the type on an existing account would invalidate every cached token and
 * leave the account in an unrecoverable state. To change the type, remove
 * the account and add it again.
 *
 * Re-authentication is a separate flow driven by the manager's "Sign in again"
 * button - Google's consent runs directly without an intermediate provider UI.
 * This popup therefore has no Sign-in-again button by design.
 */

import { localizeDocument } from "../../vendor/i18n/i18n.mjs";
import { createDropdown } from "../shared/dropdown.mjs";
import { stringifyError } from "../../modules/errors.mjs";

const i18n = (key, fallback, substitutions) =>
  browser.i18n.getMessage(key, substitutions) || fallback;

const params = new URLSearchParams(location.search);
const accountId = params.get("accountId");
const readOnly = params.get("readOnly") === "1";

function $(id) { return document.getElementById(id); }

function showError(message) {
  const el = $("error");
  el.textContent = message;
  el.classList.add("visible");
  $("info").classList.remove("visible");
}

function clearBanners() {
  $("error").classList.remove("visible");
  $("info").classList.remove("visible");
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

  $("account-name").value = account.accountName ?? "";
  $("email").textContent = account.authenticatedUserEmail ?? "-";
  $("client-id").value = account.clientID ?? "";
  // Keep the secret field blank - the user takes an explicit action to
  // overwrite it. Empty on save means "leave the stored secret untouched".
  $("client-secret").value = "";
  $("read-only-mode").checked = !!account.readOnlyMode;
  $("include-system-groups").checked = !!account.includeSystemContactGroups;

  createDropdown($("client-type"), {
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
  const banner = $("readonly-banner");
  if (readOnly) {
    banner.textContent = i18n("config.readOnlyBanner", "To prevent synchronization errors, settings cannot be edited while the account is enabled.");
    banner.classList.add("visible");
  } else {
    banner.classList.remove("visible");
  }
  for (const id of ["account-name", "client-id", "client-secret", "read-only-mode", "include-system-groups"]) {
    $(id).disabled = readOnly;
  }
  // Hide the secret field entirely while locked - it's blank by design,
  // so showing a perpetually-empty disabled input is just visual noise.
  $("client-secret-field").hidden = readOnly;
  $("btn-save").hidden = readOnly;
  // Cancel doubles as the only way out in read-only mode - label it "Close"
  // there so it reads as the primary/only action instead of a dismissal.
  const cancelBtn = $("btn-cancel");
  cancelBtn.textContent = readOnly
    ? i18n("config.close", "Close")
    : i18n("config.cancel", "Cancel");
}

async function onSave() {
  if (readOnly) return;
  clearBanners();

  const accountName = $("account-name").value.trim();
  if (!accountName) {
    showError(i18n("config.error.accountNameRequired", "Account name is required."));
    return;
  }
  const clientID = $("client-id").value.trim();
  if (!clientID) {
    showError(i18n("config.error.clientIdRequired", "Client ID is required."));
    return;
  }

  const patch = {
    accountName,
    clientID,
    readOnlyMode: $("read-only-mode").checked,
    includeSystemContactGroups: $("include-system-groups").checked,
  };
  // Empty secret means "leave the stored secret untouched" - same
  // convention as basic-auth password fields in the EAS config popup.
  const clientSecret = $("client-secret").value;
  if (clientSecret) patch.clientSecret = clientSecret;

  $("btn-save").disabled = true;
  try {
    const reply = await browser.runtime.sendMessage({ type: "google.saveAccount", accountId, patch });
    if (!reply?.ok) {
      throw new Error(reply?.error ?? i18n("config.error.saveFailed", "Save failed"));
    }
    window.close();
  } catch (err) {
    showError(stringifyError(err));
    $("btn-save").disabled = false;
  }
}

localizeDocument();
load();
$("btn-cancel").addEventListener("click", () => window.close());
$("btn-save").addEventListener("click", onSave);

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
