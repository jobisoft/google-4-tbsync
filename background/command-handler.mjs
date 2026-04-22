import { ERR, HOST_CMD } from "../shared/protocol.mjs";
import { ACCOUNT_STATUS, ok } from "../shared/status.mjs";
import { folderId as genFolderId, setupToken as genSetupToken, uuid } from "../shared/ids.mjs";
import * as accounts from "./accounts.mjs";
import * as folders from "./folders.mjs";
import * as changelog from "./changelog.mjs";
import * as tbsync from "./tbsync-client.mjs";

/**
 * Provider side of the protocol. Each exported handler corresponds 1:1 to a
 * HOST_CMD name and is registered with tbsync-client's dispatcher in init().
 *
 * M1 scope: enough stubs to prove the wire protocol end-to-end. syncAccount /
 * syncFolder return success without doing real work. Setup popup does a full
 * token round-trip but creates a dummy account record (no OAuth yet — M2).
 */

const SETUP_WIDTH = 520;
const SETUP_HEIGHT = 640;
const CONFIG_WIDTH = 520;
const CONFIG_HEIGHT = 480;

const pendingSetups = new Map(); // setupToken -> { resolve, reject, windowId }

export function init() {
  tbsync.setHostCmdHandler(HOST_CMD.SYNC_ACCOUNT, handleSyncAccount);
  tbsync.setHostCmdHandler(HOST_CMD.SYNC_FOLDER, handleSyncFolder);
  tbsync.setHostCmdHandler(HOST_CMD.CANCEL_SYNC, handleCancelSync);
  tbsync.setHostCmdHandler(HOST_CMD.OPEN_SETUP_POPUP, handleOpenSetupPopup);
  tbsync.setHostCmdHandler(HOST_CMD.OPEN_CONFIG_POPUP, handleOpenConfigPopup);
  tbsync.setHostCmdHandler(HOST_CMD.ACCOUNT_ENABLED, handleAccountEnabled);
  tbsync.setHostCmdHandler(HOST_CMD.ACCOUNT_DISABLED, handleAccountDisabled);
  tbsync.setHostCmdHandler(HOST_CMD.ACCOUNT_DELETED, handleAccountDeleted);
  tbsync.setHostCmdHandler(HOST_CMD.FOLDER_ENABLED, handleFolderEnabled);
  tbsync.setHostCmdHandler(HOST_CMD.FOLDER_DISABLED, handleFolderDisabled);
  tbsync.setHostCmdHandler(HOST_CMD.GET_ACCOUNT_DISPLAY_INFO, handleGetAccountDisplayInfo);
  tbsync.setHostCmdHandler(HOST_CMD.GET_SORTED_FOLDERS, handleGetSortedFolders);
  tbsync.setHostCmdHandler(HOST_CMD.SET_FOLDER_SELECTED, handleSetFolderSelected);
  tbsync.setHostCmdHandler(HOST_CMD.SET_ACCOUNT_ENTRY, handleSetAccountEntry);
  tbsync.setHostCmdHandler(HOST_CMD.IMPORT_LEGACY_DATA, handleImportLegacyData);

  // Resolve/cancel pending setups from setup.html or window close.
  browser.runtime.onMessage.addListener(msg => {
    if (msg?.type !== "tbsync-setup-completed") return;
    const entry = pendingSetups.get(msg.setupToken);
    if (!entry) return;
    pendingSetups.delete(msg.setupToken);
    entry.resolve({
      providerAccountId: msg.providerAccountId,
      accountName: msg.accountName,
      initialFolders: msg.initialFolders ?? [],
    });
  });
  browser.windows.onRemoved.addListener(winId => {
    for (const [token, entry] of pendingSetups) {
      if (entry.windowId !== winId) continue;
      setTimeout(() => {
        const still = pendingSetups.get(token);
        if (!still) return;
        pendingSetups.delete(token);
        still.reject(Object.assign(new Error("setup cancelled"), { code: ERR.CANCELLED }));
      }, 500);
    }
  });
}

// ── Sync stubs ────────────────────────────────────────────────────────────

async function handleSyncAccount(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  tbsync.reportSyncState({ accountId: args.accountId, syncState: "send.account-list" });
  // M1 stub: always succeed.
  return ok();
}

async function handleSyncFolder(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  tbsync.reportSyncState({
    accountId: args.accountId, folderId: args.folderId,
    syncState: "eval.done", message: "(M1 stub)",
  });
  return ok();
}

async function handleCancelSync(_args) {
  return null;
}

// ── Popups ────────────────────────────────────────────────────────────────

async function handleOpenSetupPopup(args) {
  const setupToken = args.setupToken ?? genSetupToken();
  const url = new URL(browser.runtime.getURL("setup/setup.html"));
  url.searchParams.set("setupToken", setupToken);
  if (args.locale) url.searchParams.set("locale", args.locale);

  const win = await browser.windows.create({
    url: url.toString(),
    type: "popup",
    width: SETUP_WIDTH,
    height: SETUP_HEIGHT,
  });

  const { providerAccountId, accountName, initialFolders } = await new Promise((resolve, reject) => {
    pendingSetups.set(setupToken, { resolve, reject, windowId: win.id });
  });

  // Register the newly-minted provider account with the host and get its
  // canonical accountId back.
  const { accountId } = await tbsync.registerAccount({
    setupToken,
    providerAccountId,
    accountName,
    initialFolders,
  });
  await accounts.setTbsyncAccountId(providerAccountId, accountId);

  const acc = await accounts.get(providerAccountId);
  return {
    accountId,
    accountName,
    accountEntries: acc ? stripSensitive(acc) : {},
  };
}

async function handleOpenConfigPopup(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  const url = new URL(browser.runtime.getURL("config/config.html"));
  url.searchParams.set("accountId", args.accountId);
  url.searchParams.set("providerAccountId", providerAccountId);
  await browser.windows.create({
    url: url.toString(),
    type: "popup",
    width: CONFIG_WIDTH,
    height: CONFIG_HEIGHT,
  });
  return null;
}

// ── Account / folder lifecycle ────────────────────────────────────────────

async function handleAccountEnabled(_args) { return null; }

async function handleAccountDisabled(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  // In the new ownership model the provider owns Thunderbird resources, so
  // disabling an account must release them. We clear the provider-side folder
  // state now; target deletion against messenger.addressBooks.* lands in M2
  // once real books exist.
  // TODO(M2): for each folder with a targetAbId, call messenger.addressBooks.delete(targetAbId).
  await simulateBusyWork();
  await folders.clearAccount(providerAccountId);
  await changelog.clearAccount(providerAccountId);
  return null;
}

async function handleAccountDeleted(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  await simulateBusyWork();
  await folders.clearAccount(providerAccountId);
  await changelog.clearAccount(providerAccountId);
  await accounts.remove(providerAccountId);
  await accounts.clearMapping(providerAccountId);
  return null;
}

async function handleFolderEnabled(_args)  { return null; }
async function handleFolderDisabled(_args) { return null; }

async function handleGetAccountDisplayInfo(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  const acc = providerAccountId ? await accounts.get(providerAccountId) : null;
  return {
    displayName: acc?.accountName ?? args.accountId,
    iconUrl: browser.runtime.getURL("icons/icon-16.png"),
    connectionState: acc?.refreshToken ? "connected" : "disconnected",
    lastSyncTime: acc?.lastSuccessfulSync ?? 0,
    extraRows: [],
  };
}

async function handleGetSortedFolders(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return [];
  const list = await folders.listForAccount(providerAccountId);
  return list
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
    .map(f => ({
      folderId: f.folderId,
      folderType: f.folderType ?? "contacts",
      displayName: f.displayName,
      readOnly: f.readOnly ?? false,
      selected: f.selected ?? false,
      cached: f.cached ?? false,
      extraProps: { UID: f.UID ?? null },
    }));
}

async function handleSetFolderSelected(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  await folders.upsert(providerAccountId, {
    folderId: args.folderId,
    selected: !!args.selected,
  });
  return null;
}

async function handleSetAccountEntry(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  await accounts.upsert({ providerAccountId, [args.key]: args.value });
  return null;
}

// ── Migration (M4, stubbed for M1) ────────────────────────────────────────

async function handleImportLegacyData(_args) {
  throw withCode(new Error("migration not implemented yet"), ERR.UNKNOWN_COMMAND);
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** M1 testing aid: simulate a 2 s provider-side cleanup so the host's BUSY
 *  transition is visible. Remove when real cleanup lands in M2. */
function simulateBusyWork() {
  return new Promise(resolve => setTimeout(resolve, 2000));
}


/** Redact sensitive keys (clientSecret, refreshToken) before returning to host. */
function stripSensitive(record) {
  const { clientSecret, refreshToken, ...rest } = record;
  return rest;
}

function withCode(err, code, details = null) {
  err.code = code;
  if (details != null) err.details = details;
  return err;
}

/**
 * Used by setup.html during M1 to create a stub account record when the
 * "Create test account" button is clicked. Real OAuth lands in M2.
 */
export async function createStubAccount({ accountName }) {
  const providerAccountId = `g-${uuid()}`;
  await accounts.upsert({
    providerAccountId,
    accountName,
    clientID: "",
    clientSecret: "",
    refreshToken: "",
    authenticatedUserEmail: accountName,
    readOnlyMode: true,
    verboseLogging: false,
    createdAt: Date.now(),
  });
  // M1 stub: create one fake folder of each supported type so the manager's
  // folder list renders all three icons for UI testing. Real folders land in M2.
  const specs = [
    { type: "contacts",  name: "Contacts" },
    { type: "calendars", name: "Calendar" },
    { type: "tasks",     name: "Tasks" },
  ];
  const initialFolders = [];
  for (const [i, spec] of specs.entries()) {
    const folder = {
      folderId: genFolderId(),
      folderType: spec.type,
      displayName: `${accountName} - ${spec.name}`,
      UID: String(i + 1),
      targetAbId: null,
      readOnly: false,
      selected: true,
      orderIndex: i,
    };
    await folders.upsert(providerAccountId, folder);
    initialFolders.push({
      folderId: folder.folderId,
      folderType: folder.folderType,
      displayName: folder.displayName,
      readOnly: folder.readOnly,
      selected: folder.selected,
      cached: false,
      extraProps: { UID: folder.UID },
    });
  }
  return { providerAccountId, initialFolders };
}
