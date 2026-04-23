/**
 * Google provider — concrete TbSyncProviderImplementation.
 *
 * Every on* method below is provider-specific logic: account/folder storage
 * via `accounts.mjs` / `folders.mjs`, Thunderbird address-book lifecycle via
 * `address-book.mjs`, contacts sync via `google/sync-contacts.mjs`,
 * OAuth via `google/oauth.mjs`. The base class owns the wire protocol and
 * popup windowing — see [../vendor/tbsync/provider.mjs](../vendor/tbsync/provider.mjs).
 *
 * Authentication flows live here too as plain methods (not on* hooks),
 * because they're triggered by internal `runtime.onMessage` calls from
 * setup.html / config.html rather than host RPCs.
 */

import { ERR, withCode } from "../vendor/tbsync/protocol.mjs";
import { error, ok } from "../vendor/tbsync/status.mjs";
import { TbSyncProviderImplementation } from "../vendor/tbsync/provider.mjs";
import * as accounts from "./accounts.mjs";
import * as folders from "./folders.mjs";
import * as changelog from "./changelog.mjs";
import * as changelogWatcher from "./changelog-watcher.mjs";
import * as oauth from "./google/oauth.mjs";
import * as addressBook from "./address-book.mjs";
import { syncFolderContacts } from "./google/sync-contacts.mjs";

export class GoogleProvider extends TbSyncProviderImplementation {
  constructor() {
    super({
      name: "Google Contacts",
      shortName: "google4tbsync",
      setupPath: "dialogs/setup/setup.html",
      setupWidth: 520,
      setupHeight: 640,
      configPath: "dialogs/config/config.html",
      configWidth: 520,
      configHeight: 580,
      capabilities: {
        folderTypes: ["contacts"],
        supportsReadOnly: true,
        multipleAccounts: true,
        hasSetupPopup: true,
        hasConfigPopup: true,
      },
      defaultAccountEntries: {
        clientID: "",
        clientSecret: "",
        includeSystemContactGroups: false,
        useFakeEmailAddresses: false,
        readOnlyMode: true,
        verboseLogging: false,
      },
      defaultFolderEntries: {
        foldername: "",
        downloadonly: false,
        targetAbId: null,
      },
      maintainerEmail: "info@marcozanon.com",
      contributorsUrl: "https://github.com/jobisoft/google-4-tbsync",
      logPrefix: "[google-4-tbsync]",
    });
  }

  // ── Base-class hooks ───────────────────────────────────────────────────

  /** After the host has registered the account, persist the providerAccountId
   *  ↔ tbsyncAccountId mapping and return sanitized account entries. */
  async onRegisterSuccessful({ accountId, providerAccountId }) {
    await accounts.setTbsyncAccountId(providerAccountId, accountId);
    const acc = await accounts.get(providerAccountId);
    return acc ? stripSensitive(acc) : {};
  }

  async onResolveProviderAccountId(tbsyncAccountId) {
    return await accounts.getProviderAccountIdByTbsyncAccountId(tbsyncAccountId);
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  async onSyncAccount({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    // Google surfaces a single contacts container — no server-side folder
    // discovery happens here. The host's sync-coordinator proceeds to call
    // onSyncFolder for each selected folder.
    this.reportSyncState({ accountId, syncState: "send.account-list" });
    return ok();
  }

  async onSyncFolder({ accountId, folderId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);

    const folder = await folders.get(providerAccountId, folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);

    // Defensive: the stored targetAbId may be stale if the user deleted the
    // address book manually from Thunderbird's UI. Recreate on the fly so
    // the sync can still proceed.
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
      accountId,
      providerAccountId,
      folderId,
      targetAbId,
      notify: this,
    });
  }

  async onCancelSync(_args) { return null; }

  // ── Account / folder lifecycle ─────────────────────────────────────────

  async onAccountEnabled({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) return null;
    const existing = await folders.listForAccount(providerAccountId);
    if (existing.length > 0) return null;
    const acc = await accounts.get(providerAccountId);
    if (!acc) return null;
    // Re-enable after disable: disable cleared both the provider's folder
    // list and the Thunderbird book. Recreate a fresh contacts folder + push
    // the new list up to the host. The book itself is recreated when the
    // user ticks the resource (onFolderEnabled).
    const folder = await seedContactsFolder(providerAccountId, acc.accountName, acc.authenticatedUserEmail);
    await this.pushFolderList({
      accountId,
      folders: [folderToDescriptor(folder)],
    });
    return null;
  }

  async onAccountDisabled({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) return null;
    // Provider owns Thunderbird resources — disable always releases them so
    // re-enable starts from a clean slate (mirrors legacy TbSync behavior).
    await this.#deleteAccountTargets(providerAccountId);
    await folders.clearAccount(providerAccountId);
    await changelog.clearAccount(providerAccountId);
    return null;
  }

  async onAccountDeleted({ accountId, purgeTargets }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) return null;
    // `purgeTargets` travels over the protocol from the host. Default to
    // true: removing an account normally means the books go too. A future
    // "detach only" escape hatch can set it false from the config popup.
    if (purgeTargets !== false) {
      await this.#deleteAccountTargets(providerAccountId);
    }
    await folders.clearAccount(providerAccountId);
    await changelog.clearAccount(providerAccountId);
    await accounts.remove(providerAccountId);
    await accounts.clearMapping(providerAccountId);
    return null;
  }

  async onFolderEnabled({ accountId, folderId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = await folders.get(providerAccountId, folderId);
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

  async onFolderDisabled({ accountId, folderId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = await folders.get(providerAccountId, folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    if (folder.targetAbId) {
      // Unregister before deletion so the cascading onDeleted events fired
      // by deleteBook don't log every card as a user-initiated delete.
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

  // ── Display + folder-list queries ──────────────────────────────────────

  async onGetAccountDisplayInfo({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    const acc = providerAccountId ? await accounts.get(providerAccountId) : null;
    return {
      displayName: acc?.accountName ?? accountId,
      iconUrl: browser.runtime.getURL("icons/icon-16.png"),
      connectionState: acc?.refreshToken ? "connected" : "disconnected",
      lastSyncTime: acc?.lastSuccessfulSync ?? 0,
      extraRows: [],
    };
  }

  async onGetSortedFolders({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
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

  async onSetFolderSelected({ accountId, folderId, selected }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) return null;
    await folders.upsert(providerAccountId, {
      folderId,
      selected: !!selected,
    });
    return null;
  }

  async onSetAccountEntry({ accountId, key, value }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
    if (!providerAccountId) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    await accounts.upsert({ providerAccountId, [key]: value });
    return null;
  }

  // ── Re-authentication ──────────────────────────────────────────────────

  /**
   * Provider-authored re-auth. Host calls this via HOST_CMD.REAUTHENTICATE
   * when the account is in the authentication-failed state. For Google we
   * just re-run `oauth.startAuth` — launchWebAuthFlow opens Google's consent
   * screen directly, and `loginHint` pre-selects the expected account.
   *
   * Guards against the user picking a different Gmail address than the one
   * originally associated with this account — we refuse to overwrite the
   * refresh token in that case. `login_hint` is a suggestion, not a lock.
   */
  async onReauthenticate({ accountId }) {
    const providerAccountId = await accounts.getProviderAccountIdByTbsyncAccountId(accountId);
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
        // User signed in with a different Google account. Don't overwrite
        // the refresh token; the caller's account is still broken.
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

  // ── Migration (deferred to M4) ─────────────────────────────────────────

  async onImportLegacyData(_args) {
    throw withCode(new Error("migration not implemented yet"), ERR.UNKNOWN_COMMAND);
  }

  // ── Internal-message entry points (called from background.mjs) ─────────

  /**
   * Called from setup.html once the user has filled in client ID / secret
   * and clicked "Sign in with Google". Launches the OAuth flow, persists
   * the refresh token + authenticated email in the provider's account store,
   * and seeds a single contacts folder record.
   *
   * Per the account-lifecycle contract, the folder starts unselected with
   * no Thunderbird book — the user must tick it in the TbSync manager to
   * actually activate sync, which is where the book gets created (via
   * onFolderEnabled).
   */
  async authenticateAndCreateAccount({ label, clientID, clientSecret }) {
    const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
      await oauth.startAuth({ clientID, clientSecret });

    const trimmedLabel = (label ?? "").trim();
    if (!trimmedLabel) {
      throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
    }
    const providerAccountId = `g-${crypto.randomUUID()}`;
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

    // Seed the just-minted access token into the cache to save a refresh
    // on the very first sync.
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

  /** Returns a sanitized view of the account record for the config popup.
   *  clientSecret and refreshToken never leave the background context. */
  async getAccountForConfig(tbsyncAccountId) {
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
   *  If `accountName` changed, propagate to the host via updateAccount. */
  async saveAccountFromConfig({ accountId, patch }) {
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
      await this.updateAccount({ accountId, patch: { accountName: clean.accountName } });
    }
    return null;
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Delete every Thunderbird address book owned by this provider account,
   *  tolerating per-folder failures (log and continue). Also unregisters
   *  each book from the changelog watcher so pending onDeleted events don't
   *  write orphan entries for an account we're about to tear down. */
  async #deleteAccountTargets(providerAccountId) {
    for (const folder of await folders.listForAccount(providerAccountId)) {
      if (folder.targetAbId) {
        changelogWatcher.unregisterTarget(folder.targetAbId);
        await safeDeleteBook(folder.targetAbId);
      }
    }
  }
}

// ── Module-local helpers ─────────────────────────────────────────────────

/** Redact sensitive keys (clientSecret, refreshToken) before returning to host. */
function stripSensitive(record) {
  const { clientSecret, refreshToken, ...rest } = record;
  return rest;
}

/**
 * Create the resource record (no Thunderbird address book). Used at setup
 * time and on account re-enable.
 *
 * Per the account-lifecycle contract: enabling an account pulls the resource
 * list but does NOT activate any resource. The user must tick a resource
 * in the TbSync manager; that tick triggers FOLDER_ENABLED on the provider,
 * which is where the actual address book gets created.
 *
 * The folder's `displayName` in the TbSync resource list is the
 * authenticated Google email (or the account label as a fallback) — the
 * account label already appears above the resource card, so repeating it
 * per row is noise.
 */
async function seedContactsFolder(providerAccountId, accountName, authenticatedUserEmail) {
  const email = authenticatedUserEmail?.trim() || null;
  const folder = {
    folderId: `f-${crypto.randomUUID()}`,
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

/** `addressBook.deleteBook` with a warn-and-continue catch. */
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
