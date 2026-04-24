/**
 * Wire protocol between TbSync (host) and provider add-ons.
 *
 * This module is the single source of truth for message names, port name, and
 * version numbers.
 *
 * **THIS FILE IS MIRRORED INTO EVERY PROVIDER ADD-ON.** The copy in
 * `tbsync-new/tbsync/protocol.mjs` is authoritative; the copies shipped by
 * providers (e.g. `google-4-tbsync/vendor/tbsync/protocol.mjs`) MUST match
 * it byte-for-byte. When you change this file, re-copy it to every provider
 * and confirm with:
 *     diff -q tbsync-new/tbsync/protocol.mjs google-4-tbsync/vendor/tbsync/protocol.mjs
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

/** Provider → TbSync command names (RPC).
 *
 * ## Row shape contract (accounts and folders)
 *
 * Both row kinds carry **flat universal fields** plus one opaque
 * `custom: {}` object the host never interprets.
 *
 * Account universal fields:
 *   accountId, accountName, provider, providerAccountId, enabled,
 *   warning, error, lastSyncTime, autoSyncIntervalMinutes, custom
 *
 * Folder universal fields:
 *   folderId, accountId, folderType, displayName, selected, readOnly,
 *   warning, error, lastSyncTime, orderIndex, targetID, targetName, custom
 *
 * `targetID`/`targetName` identify the local Thunderbird artifact bound to
 * the remote resource. They are null until the provider's first sync
 * creates the local artifact and writes them via UPDATE_FOLDER.
 *
 * `custom` is opaque to the host and stores provider-specific per-row
 * configuration without host-schema changes.
 *
 * ## RPC semantics
 *
 * REGISTER_ACCOUNT { accountName, providerAccountId, custom?, initialFolders? }
 * UPDATE_ACCOUNT   { accountId, patch }  — top-level + shallow-merge `custom`
 * UPDATE_FOLDER    { accountId, folderId, patch } — top-level + shallow-merge `custom`
 * PUSH_FOLDER_LIST { accountId, folders: [descriptor…] } — preserves
 *   `selected`, `lastSyncTime`, `targetID`, `targetName`, `custom` from
 *   prior rows when descriptors omit them.
 */
export const PROVIDER_CMD = {
  REGISTER_ACCOUNT: "registerAccount",
  UPDATE_ACCOUNT: "updateAccount",
  UPDATE_FOLDER: "updateFolder",
  PUSH_FOLDER_LIST: "pushFolderList",
  LIST_ACCOUNTS: "listAccounts",
  GET_ACCOUNT: "getAccount",
  CHANGELOG_MARK_SERVER_WRITE: "changelogMarkServerWrite",
  CHANGELOG_REMOVE: "changelogRemove",
};

/** Provider → TbSync notification types (no response). */
export const PROVIDER_NOTIFY = {
  REPORT_SYNC_STATE: "reportSyncState",
  REPORT_PROGRESS: "reportProgress",
  REPORT_EVENT_LOG: "reportEventLog",
  REPORT_STATUS: "reportStatus",
  REQUEST_OPEN_MANAGER: "requestOpenManager",
};

/**
 * Sync-state protocol — the status cell's wire format.
 *
 * A provider emits REPORT_SYNC_STATE { accountId, folderId, syncState, label? }
 * during any sync phase it wants visible in the manager.
 *
 * ## Base syncstates (localised on the host)
 * The host ships `syncstate.*` translations for these four bases only:
 *   - syncstate.sync          — generic active sync
 *   - syncstate.prepare       — preparation phase (may be extended)
 *   - syncstate.send          — awaiting network response (may be extended)
 *   - syncstate.eval          — processing response (may be extended)
 *
 * ## Extended syncstates (provider-granular)
 * A provider may extend `send`, `eval`, or `prepare` with a dot-suffix, e.g.
 * `"send.request.folders"`. The suffix is provider-internal; the host does
 * NOT interpret it.
 *
 * ## Display resolution (in order)
 *   1. If `label` is present, show it.
 *   2. Else if `syncState` is an exact base key, show its host translation.
 *   3. Else if `syncState`'s first segment is a base key, show
 *      "{localised-base} ({suffix})" — the suffix appears verbatim in
 *      parentheses as a diagnostic hint.
 *   4. Else show the raw `syncState`.
 *
 * ## Decorations (independent of display; driven by `syncState` structure)
 *   - `syncState` starts with "send." or equals "send" AND the provider's
 *     capabilities.connectionTimeoutMs is set → countdown "(Xs)" appears
 *     2 s into the state and refreshes every second.
 *   - Any state when REPORT_PROGRESS is live for the folder → counter
 *     "(done/total)" is appended.
 *
 * ## When should a provider send `label`?
 * If the provider has richer internal localisation (like EAS's 39 translated
 * states), it should pre-resolve via its own browser.i18n.getMessage and send
 * the result as `label`. The user sees high-quality phase-level text without
 * the host having to grow a vocabulary.
 *
 * ## When should a provider stick to bare base states?
 * If one of the four base states communicates enough (like Google's simple
 * contacts sync), emit the bare base state and omit `label`. The host
 * translates.
 */
export const SYNCSTATE_BASE_KEYS = new Set([
  "sync", "prepare", "send", "eval",
]);

/**
 * Warning / error messages on accounts + folders — the provider's channel
 * for surfacing persistent, visible state (distinct from transient syncstate
 * or one-shot event-log entries).
 *
 * ## Wire shape
 * A message is just `string | null` on the respective `warning` or `error`
 * field of an account record, a folder record, or any of the descriptors
 * pushed via PUSH_FOLDER_LIST / UPDATE_ACCOUNT / UPDATE_FOLDER.
 *
 * `null` means "no message". A non-null string is resolved for display in
 * this order:
 *   1. `browser.i18n.getMessage("error." + s)` — host-shipped predefined
 *      error code.
 *   2. `browser.i18n.getMessage("warning." + s)` — predefined warning code.
 *   3. Raw `s` — verbatim free-text fallback.
 *
 * The provider picks one or the other per message: a predefined code for
 * the common localised cases, or a free-text string when context is more
 * valuable than localisation.
 *
 * ## Host-predefined codes
 * These are the codes the host currently ships translations for. Send any
 * of them as-is in a `warning` / `error` field and the UI will render the
 * localised label.
 *
 *   error.E:AUTH              — "Authentication failed" (refresh token
 *                                revoked or credentials wrong). In addition
 *                                to showing the localised message, the host
 *                                treats `error: "E:AUTH"` on an *account*
 *                                record as the trigger for the Sign-in-again
 *                                button affordance in the manager — so
 *                                providers should write this exact code on
 *                                the account, not on a folder, when auth is
 *                                the root cause.
 *
 * No warning codes are predefined yet. Providers may send any free-text
 * warning; the UI renders it verbatim until the host adds a key.
 *
 * As providers emerge with shared failure modes, we add more entries here
 * (e.g. `error.E:NETWORK`, `error.E:QUOTA`) — additive, no wire change.
 *
 * ## Clearing
 * The host never mutates these fields. The provider is expected to pass
 * `{warning: null, error: null}` at the start of a sync to clear stale
 * messages, and explicitly set them on failure before returning/throwing.
 *
 * ## Aggregation
 * The account's visible status is derived from the aggregate: any selected
 * folder with a non-null `error` (or the account's own `error`) → the
 * account pill is red. Likewise warning → yellow. `error: "E:AUTH"` on an
 * account record is special-cased by the manager: the pill reads
 * "Authentication failed" and the card switches to Sign-in-again + Remove
 * buttons.
 */
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

export const PREDEFINED_ERROR_CODES = new Set([ERR.AUTH]);
export const PREDEFINED_WARNING_CODES = new Set();

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

/** Long-running RPCs (sync, popups) that should not be timed out. */
export const NO_TIMEOUT_CMDS = new Set([
  HOST_CMD.SYNC_ACCOUNT,
  HOST_CMD.SYNC_FOLDER,
  HOST_CMD.OPEN_SETUP_POPUP,
  HOST_CMD.OPEN_CONFIG_POPUP,
  HOST_CMD.REAUTHENTICATE,
]);
