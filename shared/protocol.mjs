/**
 * Wire protocol between TbSync (host) and provider add-ons.
 *
 * This module is the single source of truth for message names, port name, and
 * version numbers.
 *
 * **THIS FILE IS MIRRORED INTO EVERY PROVIDER ADD-ON.** The copy in
 * `tbsync-new/shared/protocol.mjs` is authoritative; the copies shipped by
 * providers (e.g. `google-4-tbsync/shared/protocol.mjs`) MUST match it
 * byte-for-byte. When you change this file, re-copy it to every provider
 * and confirm with:
 *     diff -q tbsync-new/shared/protocol.mjs google-4-tbsync/shared/protocol.mjs
 */

export const PROTOCOL_VERSION = "1.0";

/** Name used for the persistent runtime.connect port. Includes major version so
 *  a breaking protocol bump leaves mismatched peers silently disconnected. */
export const PORT_NAME = "tbsync-v1";

/** Discovery message types (runtime.onMessageExternal, one-shot). */
export const DISCOVERY = {
  ANNOUNCE: "tbsync-provider-announce",
  PROBE: "tbsync-probe",
  UNANNOUNCE: "tbsync-provider-unannounce",
};

/** TbSync → Provider command names. */
export const HOST_CMD = {
  SYNC_ACCOUNT: "syncAccount",
  SYNC_FOLDER: "syncFolder",
  CANCEL_SYNC: "cancelSync",
  OPEN_SETUP_POPUP: "openSetupPopup",
  OPEN_CONFIG_POPUP: "openConfigPopup",
  REAUTHENTICATE: "reauthenticate",
  ACCOUNT_ENABLED: "accountEnabled",
  ACCOUNT_DISABLED: "accountDisabled",
  ACCOUNT_DELETED: "accountDeleted",
  FOLDER_ENABLED: "folderEnabled",
  FOLDER_DISABLED: "folderDisabled",
  GET_ACCOUNT_DISPLAY_INFO: "getAccountDisplayInfo",
  GET_SORTED_FOLDERS: "getSortedFolders",
  SET_FOLDER_SELECTED: "setFolderSelected",
  SET_ACCOUNT_ENTRY: "setAccountEntry",
  IMPORT_LEGACY_DATA: "importLegacyData",
};

/** Provider → TbSync command names (RPC). */
export const PROVIDER_CMD = {
  REGISTER_ACCOUNT: "registerAccount",
  UPDATE_ACCOUNT: "updateAccount",
  PUSH_FOLDER_LIST: "pushFolderList",
};

/** Provider → TbSync notification types (no response). */
export const PROVIDER_NOTIFY = {
  REPORT_SYNC_STATE: "reportSyncState",
  REPORT_PROGRESS: "reportProgress",
  REPORT_EVENT_LOG: "reportEventLog",
  REPORT_STATUS: "reportStatus",
  REQUEST_OPEN_MANAGER: "requestOpenManager",
};

/** Shared error codes. */
export const ERR = {
  PORT_CLOSED: "E:PORT_CLOSED",
  PROTOCOL_VERSION: "E:PROTOCOL_VERSION",
  AUTH: "E:AUTH",
  NETWORK: "E:NETWORK",
  CANCELLED: "E:CANCELLED",
  QUOTA: "E:QUOTA",
  PROVIDER_UNAVAILABLE: "E:PROVIDER_UNAVAILABLE",
  UNKNOWN_ACCOUNT: "E:UNKNOWN_ACCOUNT",
  UNKNOWN_FOLDER: "E:UNKNOWN_FOLDER",
  UNKNOWN_COMMAND: "E:UNKNOWN_COMMAND",
  TIMEOUT: "E:TIMEOUT",
};

/**
 * Attach an error code (and optional details) to an Error object without
 * clobbering any existing code. Returns the same Error for chaining.
 * Every host↔provider-speaking module uses this to stamp the code that gets
 * serialized onto the wire as `errorCode`.
 */
export function withCode(err, code, details = null) {
  if (!err.code) err.code = code;
  if (details != null && !err.details) err.details = details;
  return err;
}

/** Default timeout for host→provider RPCs in milliseconds. */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Long-running RPCs (sync) that should not be timed out. */
export const NO_TIMEOUT_CMDS = new Set([
  HOST_CMD.SYNC_ACCOUNT,
  HOST_CMD.SYNC_FOLDER,
  HOST_CMD.OPEN_SETUP_POPUP,
]);

/** Helper: is this a valid folder type? */
export function isKnownFolderType(type) {
  return type === "contacts" || type === "calendars" || type === "tasks";
}

/** Helper: build an RPC request envelope. */
export function buildRequest(requestId, cmd, args = {}) {
  return { requestId, cmd, args };
}

/** Helper: build a successful RPC response envelope. */
export function buildOk(requestId, result = null) {
  return { requestId, ok: true, result };
}

/** Helper: build an error RPC response envelope. */
export function buildErr(requestId, error, errorCode = ERR.UNKNOWN_COMMAND, details = null) {
  return { requestId, ok: false, error, errorCode, errorDetails: details };
}

/** Helper: build a notification envelope. */
export function buildNotification(type, payload = {}) {
  return { type, payload };
}
