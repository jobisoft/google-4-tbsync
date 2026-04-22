import { ERR, HOST_CMD, withCode } from "../shared/protocol.mjs";
import { error, ok } from "../shared/status.mjs";
import { folderId as genFolderId, setupToken as genSetupToken, uuid } from "../shared/ids.mjs";
import * as accounts from "./accounts.mjs";
import * as folders from "./folders.mjs";
import * as changelog from "./changelog.mjs";
import * as changelogWatcher from "./changelog-watcher.mjs";
import * as tbsync from "./tbsync-client.mjs";
import * as oauth from "./google/oauth.mjs";
import * as addressBook from "./thunderbird/address-book.mjs";
import { syncFolderContacts } from "./google/sync-contacts.mjs";

/**
 * Provider side of the protocol. Each exported handler corresponds 1:1 to a
 * HOST_CMD name and is registered with tbsync-client's dispatcher in init().
 * Real contacts sync flows through `google/sync-contacts.mjs`; address-book
 * lifecycle (create on enable, delete on disable/remove) flows through
 * `thunderbird/address-book.mjs`.
 */

const SETUP_WIDTH = 520;
const SETUP_HEIGHT = 640;
const CONFIG_WIDTH = 520;
const CONFIG_HEIGHT = 580;

const pendingSetups = new Map(); // setupToken -> { resolve, reject, windowId }

export function init() {
  tbsync.setHostCmdHandler(HOST_CMD.SYNC_ACCOUNT, handleSyncAccount);
  tbsync.setHostCmdHandler(HOST_CMD.SYNC_FOLDER, handleSyncFolder);
  tbsync.setHostCmdHandler(HOST_CMD.CANCEL_SYNC, handleCancelSync);
  tbsync.setHostCmdHandler(HOST_CMD.OPEN_SETUP_POPUP, handleOpenSetupPopup);
  tbsync.setHostCmdHandler(HOST_CMD.OPEN_CONFIG_POPUP, handleOpenConfigPopup);
  tbsync.setHostCmdHandler(HOST_CMD.REAUTHENTICATE, handleReauthenticate);
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

// ── Sync ──────────────────────────────────────────────────────────────────

async function handleSyncAccount(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  // Google surfaces a single contacts container — no server-side folder
  // discovery happens here. The host's sync-coordinator proceeds to call
  // syncFolder for each selected folder.
  tbsync.reportSyncState({ accountId: args.accountId, syncState: "send.account-list" });
  return ok();
}

async function handleSyncFolder(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);

  const folder = await folders.get(providerAccountId, args.folderId);
  if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);

  // Defensive: the stored targetAbId may be stale if the user deleted the
  // address book manually from Thunderbird's UI. Recreate on the fly so the
  // sync can still proceed.
  let targetAbId = folder.targetAbId;
  if (!targetAbId || !(await addressBook.bookExists(targetAbId))) {
    const acc = await accounts.get(providerAccountId);
    if (!acc) throw withCode(new Error("account record missing"), ERR.UNKNOWN_ACCOUNT);
    if (folder.targetAbId) changelogWatcher.unregisterTarget(folder.targetAbId);
    const bookName = computeBookName(acc.accountName, acc.authenticatedUserEmail);
    targetAbId = await addressBook.createBook(bookName);
    await folders.upsert(providerAccountId, {
      folderId: folder.folderId,
      targetAbId,
      targetAbName: bookName,
    });
    await changelogWatcher.registerTarget(targetAbId, providerAccountId);
  }

  return await syncFolderContacts({
    accountId: args.accountId,
    providerAccountId,
    folderId: args.folderId,
    targetAbId,
  });
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
  if (args.readOnly) url.searchParams.set("readOnly", "1");
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
 *  tolerating per-folder failures (log and continue). Also unregisters each
 *  book from the changelog watcher so pending onDeleted events don't write
 *  orphan entries for an account we're about to tear down. */
async function deleteAccountTargets(providerAccountId) {
  for (const folder of await folders.listForAccount(providerAccountId)) {
    if (folder.targetAbId) {
      changelogWatcher.unregisterTarget(folder.targetAbId);
      await safeDeleteBook(folder.targetAbId);
    }
  }
}

/** `deleteBook` with a warn-and-continue catch. Used where we want cleanup
 *  to proceed past a single book's failure rather than abort the whole op. */
async function safeDeleteBook(targetAbId) {
  try {
    await addressBook.deleteBook(targetAbId);
  } catch (err) {
    console.warn(
      `[google-4-tbsync] could not delete address book ${targetAbId}:`,
      err?.message ?? err
    );
  }
}

async function handleFolderEnabled(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  const folder = await folders.get(providerAccountId, args.folderId);
  if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
  // Idempotent: if the book is already present, re-register it (no-op if
  // already watched) and return.
  if (folder.targetAbId && await addressBook.bookExists(folder.targetAbId)) {
    await changelogWatcher.registerTarget(folder.targetAbId, providerAccountId);
    return null;
  }

  const acc = await accounts.get(providerAccountId);
  if (!acc) throw withCode(new Error("account record missing"), ERR.UNKNOWN_ACCOUNT);
  const bookName = computeBookName(acc.accountName, acc.authenticatedUserEmail);
  const targetAbId = await addressBook.createBook(bookName);
  await folders.upsert(providerAccountId, {
    folderId: folder.folderId,
    targetAbId,
    targetAbName: bookName,
  });
  await changelogWatcher.registerTarget(targetAbId, providerAccountId);
  return null;
}

async function handleFolderDisabled(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
  const folder = await folders.get(providerAccountId, args.folderId);
  if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
  if (folder.targetAbId) {
    // Unregister before deletion so the cascading onDeleted events fired by
    // `deleteBook` don't log every card as a user-initiated delete.
    changelogWatcher.unregisterTarget(folder.targetAbId);
    await safeDeleteBook(folder.targetAbId);
  }
  // Dropping the book invalidates every pending changelog entry for this
  // account — the resourceNames they reference no longer correspond to
  // anything local. Clear so a re-enable starts from a clean slate.
  await changelog.clearAccount(providerAccountId);
  await folders.upsert(providerAccountId, {
    folderId: folder.folderId,
    targetAbId: null,
    targetAbName: null,
  });
  return null;
}

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

// ── Internal messages from config.html ───────────────────────────────────

/** Returns a sanitized view of the account record for the config popup.
 *  clientSecret and refreshToken never leave the background context. */
export async function getAccountForConfig(tbsyncAccountId) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(tbsyncAccountId);
  if (!providerAccountId) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);
  const acc = await accounts.get(providerAccountId);
  if (!acc) throw withCode(new Error("Account record missing"), ERR.UNKNOWN_ACCOUNT);
  return {
    accountId: tbsyncAccountId,
    accountName: acc.accountName,
    authenticatedUserEmail: acc.authenticatedUserEmail ?? null,
    clientID: acc.clientID ?? "",
    readOnlyMode: !!acc.readOnlyMode,
    verboseLogging: !!acc.verboseLogging,
  };
}

/** Write allow-listed fields from the config popup to the account record.
 *  If `accountName` changed, propagate to the host via `updateAccount`. */
export async function saveAccountFromConfig({ accountId, patch }) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
  if (!providerAccountId) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);

  const allowed = ["accountName", "readOnlyMode", "verboseLogging"];
  const clean = {};
  for (const key of allowed) if (key in patch) clean[key] = patch[key];
  if (clean.accountName != null) {
    clean.accountName = String(clean.accountName).trim();
    if (!clean.accountName) throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
  }

  await accounts.upsert({ providerAccountId, ...clean });
  if ("accountName" in clean) {
    await tbsync.updateAccount({ accountId, patch: { accountName: clean.accountName } });
  }
  return null;
}

// ── Re-authentication ─────────────────────────────────────────────────────

/**
 * Provider-authored re-auth. Host calls this via `HOST_CMD.REAUTHENTICATE`
 * when the account is in the authentication-failed state. For Google we just
 * re-run `oauth.startAuth` — `launchWebAuthFlow` opens Google's consent
 * screen directly, and the `loginHint` pre-selects the expected account.
 *
 * Guards against the user picking a different Gmail address than the one
 * originally associated with this account — we refuse to overwrite the
 * refresh token in that case. `login_hint` is a suggestion, not a lock.
 */
async function handleReauthenticate(args) {
  const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(args.accountId);
  if (!providerAccountId) {
    return error("Unknown account", ERR.UNKNOWN_ACCOUNT);
  }
  const acc = await accounts.get(providerAccountId);
  if (!acc) {
    return error("Account record missing", ERR.UNKNOWN_ACCOUNT);
  }
  if (!acc.clientID || !acc.clientSecret) {
    return error("Missing OAuth credentials", ERR.AUTH);
  }
  try {
    const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
      await oauth.startAuth({
        clientID: acc.clientID,
        clientSecret: acc.clientSecret,
        loginHint: acc.authenticatedUserEmail,
      });
    if (acc.authenticatedUserEmail && authenticatedUserEmail &&
        acc.authenticatedUserEmail !== authenticatedUserEmail) {
      // User signed in with a different Google account. Don't overwrite the
      // refresh token; the caller's account is still broken.
      return error(
        `Signed-in user (${authenticatedUserEmail}) does not match the account's Google address (${acc.authenticatedUserEmail}).`,
        ERR.AUTH
      );
    }
    await accounts.upsert({ providerAccountId, refreshToken });
    if (accessToken) oauth.primeAccessToken(providerAccountId, accessToken, expiresIn);
    return ok();
  } catch (err) {
    return error(err.message ?? "Re-authentication failed", err.code ?? ERR.AUTH);
  }
}

// ── Migration (deferred to M4) ────────────────────────────────────────────

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
 * clicked "Sign in with Google". Launches the OAuth flow, persists the
 * refresh token + authenticated email in the provider's account store, and
 * seeds a single contacts folder record.
 *
 * Per the account-lifecycle contract, the folder starts unselected with no
 * Thunderbird book — the user must tick it in the TbSync manager to
 * actually activate sync, which is where the book gets created (via
 * handleFolderEnabled).
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

  const folder = await seedContactsFolder(providerAccountId, accountName, authenticatedUserEmail);
  return {
    providerAccountId,
    accountName,
    initialFolders: [folderToDescriptor(folder)],
  };
}

/**
 * Create the resource record (no Thunderbird address book). Used at setup
 * time and on account re-enable.
 *
 * Per the account-lifecycle contract: enabling an account pulls the resource
 * list but does NOT activate any resource. The user must tick a resource in
 * the TbSync manager; that ticks triggers FOLDER_ENABLED on the provider,
 * which is where the actual address book gets created.
 *
 * The folder's `displayName` in the TbSync resource list is the authenticated
 * Google email (or the account label as a fallback) — the account label
 * already appears above the resource card, so repeating it per row is noise.
 */
async function seedContactsFolder(providerAccountId, accountName, authenticatedUserEmail) {
  const email = authenticatedUserEmail?.trim() || null;
  const folder = {
    folderId: genFolderId(),
    folderType: "contacts",
    displayName: email ?? accountName,
    UID: "1",
    targetAbId: null,
    targetAbName: null,
    readOnly: false,
    selected: false,
    orderIndex: 0,
  };
  await folders.upsert(providerAccountId, folder);
  return folder;
}

/**
 * Build the Thunderbird address-book name for a Google account. The email
 * disambiguates books in the TB sidebar when the user has multiple Google
 * accounts with the same label.
 */
function computeBookName(accountName, authenticatedUserEmail) {
  const email = authenticatedUserEmail?.trim?.() || null;
  return email ? `${accountName} (${email})` : accountName;
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
