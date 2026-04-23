/**
 * Keys the Google provider uses in its own storage.local. Unlike tbsync-new,
 * the provider owns tokens and sync cursors — none of this data is visible to
 * TbSync beyond what we push explicitly over the port.
 */

export const KEYS = {
  SCHEMA_VERSION: "google.schemaVersion",
  ACCOUNTS: "google.accounts",
  FOLDERS: "google.folders",
  CHANGELOG: "google.changelog",
  ACCOUNT_ID_MAP: "google.accountIdMap",
  SETTINGS: "google.settings",
};

export const CURRENT_SCHEMA_VERSION = 1;

export const DEFAULT_SETTINGS = {
  timeoutMs: 60_000,
};
