/**
 * Account/folder status constants plus the StatusData result shape that
 * providers must use when responding to syncAccount/syncFolder RPCs.
 *
 * **MIRRORED INTO EVERY PROVIDER ADD-ON** — see the header of
 * `./protocol.mjs` for the sync rule.
 */

export const ACCOUNT_STATUS = {
  SUCCESS: "success",
  SYNCING: "syncing",
  BUSY: "busy",
  NOT_SYNCED: "notsyncronized",
  WARNING: "warning",
  ERROR: "error",
  DISABLED: "disabled",
  PROVIDER_UNAVAILABLE: "provider-unavailable",
  NEEDS_REAUTH: "needs-reauth",
};

export const FOLDER_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  BUSY: "busy",
  WARNING: "warning",
  ERROR: "error",
  SKIPPED: "skipped",
  DISABLED: "disabled",
};

export const STATUS_TYPES = {
  SUCCESS: "success",
  WARNING: "warning",
  ERROR: "error",
  ACCOUNT_RERUN: "account_rerun",
  FOLDER_RERUN: "folder_rerun",
};

/** Build a StatusData-compatible payload (the return shape for sync RPCs). */
export function ok(message = "", details = "") {
  return { type: STATUS_TYPES.SUCCESS, message, details, rerun: null };
}

export function warning(message, details = "") {
  return { type: STATUS_TYPES.WARNING, message, details, rerun: null };
}

export function error(message, details = "") {
  return { type: STATUS_TYPES.ERROR, message, details, rerun: null };
}

export function accountRerun(message = "", details = "") {
  return { type: STATUS_TYPES.ACCOUNT_RERUN, message, details, rerun: "account" };
}

export function folderRerun(message = "", details = "") {
  return { type: STATUS_TYPES.FOLDER_RERUN, message, details, rerun: "folder" };
}
