import { ERR, HOST_CMD, withCode } from "../shared/protocol.mjs";
import { ACCOUNT_STATUS, ok } from "../shared/status.mjs";
import { folderId as genFolderId, setupToken as genSetupToken, uuid } from "../shared/ids.mjs";
import * as accounts from "./accounts.mjs";
import * as folders from "./folders.mjs";
import * as changelog from "./changelog.mjs";
import * as tbsync from "./tbsync-client.mjs";
import * as oauth from "./google/oauth.mjs";
import * as addressBook from "./thunderbird/address-book.mjs";

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

async function handleAccountEnabled(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  // If folders already exist (e.g. fresh install, not a re-enable), nothing
  // to do; host already knows about them.
  const existing = await folders.listForAccount(providerAccountId);
  if (existing.length > 0) return null;
  const acc = await accounts.get(providerAccountId);
  if (!acc) return null;
  // Re-enable after disable: disable cleared both the provider's folder list
  // and the Thunderbird book. Recreate a fresh contacts folder + book and
  // push the new list up to the host.
  const folder = await seedContactsFolder(providerAccountId, acc.accountName, acc.authenticatedUserEmail);
  await tbsync.pushFolderList({
    accountId: args.accountId,
    folders: [folderToDescriptor(folder)],
  });
  return null;
}

async function handleAccountDisabled(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  // Provider owns Thunderbird resources — disable always releases them so
  // re-enable starts from a clean slate (mirrors legacy TbSync behavior).
  await deleteAccountTargets(providerAccountId);
  await folders.clearAccount(providerAccountId);
  await changelog.clearAccount(providerAccountId);
  return null;
}

async function handleAccountDeleted(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) return null;
  // `purgeTargets` travels over the protocol from the host. Default to true:
  // removing an account normally means the books go too. A future "detach
  // only" escape hatch can set it false from the config popup.
  if (args.purgeTargets !== false) {
    await deleteAccountTargets(providerAccountId);
  }
  await folders.clearAccount(providerAccountId);
  await changelog.clearAccount(providerAccountId);
  await accounts.remove(providerAccountId);
  await accounts.clearMapping(providerAccountId);
  return null;
}

/** Delete every Thunderbird address book owned by this provider account,
 *  tolerating per-folder failures (log and continue). */
async function deleteAccountTargets(providerAccountId) {
  for (const folder of await folders.listForAccount(providerAccountId)) {
    if (!folder.targetAbId) continue;
    try {
      await addressBook.deleteBook(folder.targetAbId);
    } catch (err) {
      console.warn(
        `[google-4-tbsync] could not delete address book ${folder.targetAbId}:`,
        err?.message ?? err
      );
    }
  }
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


/** Redact sensitive keys (clientSecret, refreshToken) before returning to host. */
function stripSensitive(record) {
  const { clientSecret, refreshToken, ...rest } = record;
  return rest;
}


/**
 * Called from setup.html once the user has filled in client ID / secret and
 * clicked "Sign in with Google". Launches the OAuth flow, creates a
 * Thunderbird address book, persists the refresh token + authenticated email
 * in the provider's account store, and seeds a single contacts folder
 * pointing at the new book.
 *
 * Order matters: we create the TB book BEFORE we persist any provider state
 * so a book-create failure leaves no half-configured account behind.
 */
export async function authenticateAndCreateAccount({ label, clientID, clientSecret }) {
  const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
    await oauth.startAuth({ clientID, clientSecret });

  const trimmedLabel = (label ?? "").trim();
  if (!trimmedLabel) {
    throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
  }
  const providerAccountId = `g-${uuid()}`;
  const accountName = trimmedLabel;

  // Book + folder first: a createBook failure here leaves nothing persisted,
  // so the user can simply try again. Once this succeeds, we commit the rest.
  const folder = await seedContactsFolder(providerAccountId, accountName, authenticatedUserEmail);

  await accounts.upsert({
    providerAccountId,
    accountName,
    clientID,
    clientSecret,
    refreshToken,
    authenticatedUserEmail,
    readOnlyMode: true,
    verboseLogging: false,
    createdAt: Date.now(),
  });

  // Seed the just-minted access token into the cache to save a refresh on
  // the very first sync.
  if (accessToken) {
    oauth.primeAccessToken(providerAccountId, accessToken, expiresIn);
  }

  return {
    providerAccountId,
    accountName,
    initialFolders: [folderToDescriptor(folder)],
  };
}

/**
 * Create a Thunderbird address book and the matching folder record. Used at
 * setup time and on re-enable (when disable cleared the book + folder).
 *
 * Book name carries both the user's account label AND the authenticated
 * Google email so multiple Google accounts with the same label (or a single
 * label repurposed across Gmail addresses) are disambiguated in
 * Thunderbird's address-book list. The folder's display name in the TbSync
 * resource list is just the Google identifier — the account label already
 * appears above the resource card, so repeating it per row is noise.
 */
async function seedContactsFolder(providerAccountId, accountName, authenticatedUserEmail) {
  const email = authenticatedUserEmail?.trim() || null;
  const bookName = email ? `${accountName} (${email})` : accountName;
  const targetAbId = await addressBook.createBook(bookName);
  const folder = {
    folderId: genFolderId(),
    folderType: "contacts",
    displayName: email ?? accountName,
    UID: "1",
    targetAbId,
    targetAbName: bookName,
    readOnly: false,
    selected: true,
    orderIndex: 0,
  };
  await folders.upsert(providerAccountId, folder);
  return folder;
}

/** Translate an internal folder record into the descriptor shape the host
 *  expects for registerAccount / pushFolderList. */
function folderToDescriptor(folder) {
  return {
    folderId: folder.folderId,
    folderType: folder.folderType,
    displayName: folder.displayName,
    readOnly: folder.readOnly,
    selected: folder.selected,
    cached: false,
    extraProps: { UID: folder.UID },
  };
}
