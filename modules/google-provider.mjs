/**
 * Google provider. Overrides every on* hook with Google-specific logic.
 *
 * Host is the source of truth for account + folder rows. This provider
 * pulls its context from the host at the top of each on* hook via
 * `this.getAccount(accountId)`, reads user-config from `account.custom.*`
 * (clientID, clientSecret, readOnlyMode, includeSystemContactGroups,
 * verboseLogging), and writes state back via UPDATE_ACCOUNT / UPDATE_FOLDER
 * RPCs. Provider-side persistent storage is limited to OAuth refresh tokens
 * (oauth-tokens.mjs), the changelog, and the group map.
 *
 * `authenticateAndCreateAccount` and `saveAccountFromConfig` are plain
 * methods triggered by runtime.onMessage from setup.html / config.html.
 */

import {
  ERR, withCode, error, ok,
  TbSyncProviderImplementation,
} from "../vendor/tbsync/provider.mjs";
import * as oauthTokens from "./oauth-tokens.mjs";
import * as changelog from "./changelog.mjs";
import * as changelogWatcher from "./changelog-watcher.mjs";
import * as groupMap from "./group-map.mjs";
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
      maintainerEmail: "info@marcozanon.com",
      contributorsUrl: "https://github.com/jobisoft/google-4-tbsync",
      logPrefix: "[google-4-tbsync]",
    });
  }

  // ── Base-class hook: post-register ─────────────────────────────────────

  /** Nothing to persist locally after registration — providerAccountId lives
   *  on the host row and is looked up via getAccount() whenever needed. */
  async onRegisterSuccessful() { return null; }

  // ── Sync ───────────────────────────────────────────────────────────────

  async onSyncAccount({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    // Prime credentials so the people-api layer can refresh access tokens
    // without re-reading host state mid-sync.
    oauth.primeCredentials(ctx.providerAccountId, {
      clientID: ctx.account.custom.clientID,
      clientSecret: ctx.account.custom.clientSecret,
    });
    // Google surfaces a single contacts container — no server-side folder
    // discovery. The host's sync-coordinator proceeds to call onSyncFolder
    // for each selected folder.
    this.reportSyncState({ accountId, syncState: "prepare" });
    return ok();
  }

  async onSyncFolder({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);

    oauth.primeCredentials(ctx.providerAccountId, {
      clientID: ctx.account.custom.clientID,
      clientSecret: ctx.account.custom.clientSecret,
    });

    // Defensive: the stored targetID may be stale if the user deleted the
    // address book manually from Thunderbird's UI. Recreate on the fly so
    // the sync can still proceed — push the new ID back to the host.
    let targetID = folder.targetID;
    if (!targetID || !(await addressBook.bookExists(targetID))) {
      if (folder.targetID) changelogWatcher.unregisterTarget(folder.targetID);
      const bookName = computeBookName(ctx.account.accountName, ctx.authenticatedUserEmail);
      targetID = await addressBook.createBook(bookName);
      await this.updateFolder({
        accountId, folderId,
        patch: { targetID, targetName: bookName },
      });
      await changelogWatcher.registerTarget(targetID, ctx.providerAccountId);
    }

    return await syncFolderContacts({
      accountId,
      providerAccountId: ctx.providerAccountId,
      folderId,
      targetID,
      account: ctx.account,
      notify: this,
    });
  }

  async onCancelSync(_args) { return null; }

  // ── Account / folder lifecycle ─────────────────────────────────────────

  async onAccountEnabled({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // Re-enable after disable: push a fresh single-folder descriptor. The
    // book itself is created lazily (onFolderEnabled / onSyncFolder) since
    // the user may enable but not immediately sync.
    if (ctx.folders.length > 0) return null;
    const folder = {
      folderId: `f-${crypto.randomUUID()}`,
      folderType: "contacts",
      displayName: ctx.account.accountName,
      readOnly: false,
      selected: false,
    };
    await this.pushFolderList({ accountId, folders: [folder] });
    return null;
  }

  async onAccountDisabled({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // Disable always releases Thunderbird resources so re-enable starts
    // from a clean slate.
    await this.#deleteAccountTargets(ctx.folders);
    await changelog.clearAccount(ctx.providerAccountId);
    await groupMap.clearAccount(ctx.providerAccountId);
    oauth.invalidateAccessToken(ctx.providerAccountId);
    oauth.forgetCredentials(ctx.providerAccountId);
    return null;
  }

  async onAccountDeleted({ accountId, purgeTargets }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // `purgeTargets` travels over the protocol from the host. Default to
    // true: removing an account normally means the books go too.
    if (purgeTargets !== false) {
      await this.#deleteAccountTargets(ctx.folders);
    }
    await changelog.clearAccount(ctx.providerAccountId);
    await groupMap.clearAccount(ctx.providerAccountId);
    await oauthTokens.remove(ctx.providerAccountId);
    oauth.invalidateAccessToken(ctx.providerAccountId);
    oauth.forgetCredentials(ctx.providerAccountId);
    return null;
  }

  async onFolderEnabled({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    // Idempotent: if the book is already present, just re-register it.
    if (folder.targetID && await addressBook.bookExists(folder.targetID)) {
      await changelogWatcher.registerTarget(folder.targetID, ctx.providerAccountId);
      return null;
    }
    const bookName = computeBookName(ctx.account.accountName, ctx.authenticatedUserEmail);
    const targetID = await addressBook.createBook(bookName);
    await this.updateFolder({
      accountId, folderId,
      patch: { targetID, targetName: bookName },
    });
    await changelogWatcher.registerTarget(targetID, ctx.providerAccountId);
    return null;
  }

  async onFolderDisabled({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    if (folder.targetID) {
      // Unregister before deletion so cascading onDeleted events fired by
      // deleteBook don't log every card as a user-initiated delete.
      changelogWatcher.unregisterTarget(folder.targetID);
      await safeDeleteBook(folder.targetID);
    }
    // Dropping the book invalidates every pending changelog entry for this
    // account — the resourceNames they reference no longer correspond to
    // anything local. Clear so a re-enable starts from a clean slate.
    await changelog.clearAccount(ctx.providerAccountId);
    await groupMap.clearAccount(ctx.providerAccountId);
    await this.updateFolder({
      accountId, folderId,
      patch: { targetID: null, targetName: null },
    });
    return null;
  }

  // ── Display + folder-list queries ──────────────────────────────────────

  async onGetAccountDisplayInfo({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) {
      return {
        displayName: accountId,
        iconUrl: browser.runtime.getURL("icons/icon-16.png"),
        connectionState: "disconnected",
        lastSyncTime: 0,
        extraRows: [],
      };
    }
    const tokens = await oauthTokens.get(ctx.providerAccountId);
    return {
      displayName: ctx.account.accountName,
      iconUrl: browser.runtime.getURL("icons/icon-16.png"),
      connectionState: tokens?.refreshToken ? "connected" : "disconnected",
      lastSyncTime: ctx.account.lastSyncTime ?? 0,
      extraRows: [],
    };
  }

  async onGetSortedFolders({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return [];
    return ctx.folders
      .slice()
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
      .map(f => ({
        folderId: f.folderId,
        folderType: f.folderType ?? "contacts",
        displayName: f.displayName,
        readOnly: f.readOnly ?? false,
        selected: f.selected ?? false,
      }));
  }

  async onSetFolderSelected() {
    // The host owns `selected` — it stores the user's choice in its folder
    // row and calls onFolderEnabled / onFolderDisabled when the flip
    // triggers a side-effect. Nothing to do here.
    return null;
  }

  async onSetAccountEntry() {
    // Account entries are written by the config popup via UPDATE_ACCOUNT.
    // The host never dispatches SET_ACCOUNT_ENTRY against this provider.
    return null;
  }

  // ── Re-authentication ──────────────────────────────────────────────────

  /** Re-run OAuth against the authenticated email. Rejects with ERR.AUTH
   *  if the user signs in with a different Gmail address. */
  async onReauthenticate({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return error("Unknown account", ERR.UNKNOWN_ACCOUNT);
    const { clientID, clientSecret } = ctx.account.custom;
    if (!clientID || !clientSecret) {
      return error("Missing OAuth credentials", ERR.AUTH);
    }
    try {
      const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
        await oauth.startAuth({
          clientID,
          clientSecret,
          loginHint: ctx.authenticatedUserEmail,
        });
      if (ctx.authenticatedUserEmail && authenticatedUserEmail &&
          ctx.authenticatedUserEmail !== authenticatedUserEmail) {
        return error(
          `Signed-in user (${authenticatedUserEmail}) does not match the account's Google address (${ctx.authenticatedUserEmail}).`,
          ERR.AUTH
        );
      }
      await oauthTokens.set(ctx.providerAccountId, {
        refreshToken,
        authenticatedUserEmail: authenticatedUserEmail ?? ctx.authenticatedUserEmail ?? null,
      });
      oauth.primeCredentials(ctx.providerAccountId, { clientID, clientSecret });
      if (accessToken) oauth.primeAccessToken(ctx.providerAccountId, accessToken, expiresIn);
      return ok();
    } catch (err) {
      return error(err.message ?? "Re-authentication failed", err.code ?? ERR.AUTH);
    }
  }

  // ── Migration ──────────────────────────────────────────────────────────

  async onImportLegacyData(_args) {
    throw withCode(new Error("migration not implemented yet"), ERR.UNKNOWN_COMMAND);
  }

  // ── Internal-message entry points ──────────────────────────────────────

  /** Setup popup flow:
   *    1. Run OAuth → refresh token + authenticated email.
   *    2. Persist refresh token + email in oauth-tokens (provider-side secret).
   *    3. Return the payload the setup page forwards to the host: the
   *       providerAccountId, the user-chosen account name, the opaque
   *       `custom` blob with all user-config, and one unselected contacts
   *       folder descriptor.
   *  The host row is created by the base-class `onOpenSetupPopup` after the
   *  page posts `tbsync-setup-completed`. */
  async authenticateAndCreateAccount({ label, clientID, clientSecret }) {
    const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
      await oauth.startAuth({ clientID, clientSecret });

    const trimmedLabel = (label ?? "").trim();
    if (!trimmedLabel) {
      throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
    }
    const providerAccountId = `g-${crypto.randomUUID()}`;

    await oauthTokens.set(providerAccountId, {
      refreshToken,
      authenticatedUserEmail: authenticatedUserEmail ?? null,
    });
    oauth.primeCredentials(providerAccountId, { clientID, clientSecret });
    if (accessToken) oauth.primeAccessToken(providerAccountId, accessToken, expiresIn);

    const initialFolders = [{
      folderId: `f-${crypto.randomUUID()}`,
      folderType: "contacts",
      displayName: authenticatedUserEmail?.trim() || trimmedLabel,
      readOnly: false,
      selected: false,
    }];

    return {
      providerAccountId,
      accountName: trimmedLabel,
      initialFolders,
      custom: {
        clientID,
        clientSecret,
        readOnlyMode: true,
        includeSystemContactGroups: false,
        verboseLogging: false,
      },
    };
  }

  /** Most recent provider account, for prefilling clientID/clientSecret in
   *  the setup popup. Scans the host's account list. */
  async getLastCredentials() {
    const list = await this.listAccounts();
    const mine = list
      .filter(a => a.custom?.clientID && a.custom?.clientSecret)
      .sort((a, b) => (b.lastSyncTime ?? 0) - (a.lastSyncTime ?? 0));
    const last = mine[0];
    return last
      ? { clientID: last.custom.clientID, clientSecret: last.custom.clientSecret }
      : null;
  }

  /** Returns a sanitized view of the account record for the config popup.
   *  clientSecret never leaves the background context. */
  async getAccountForConfig(accountId) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);
    return {
      accountId,
      accountName: ctx.account.accountName,
      authenticatedUserEmail: ctx.authenticatedUserEmail ?? null,
      clientID: ctx.account.custom.clientID ?? "",
      readOnlyMode: !!ctx.account.custom.readOnlyMode,
      includeSystemContactGroups: !!ctx.account.custom.includeSystemContactGroups,
      verboseLogging: !!ctx.account.custom.verboseLogging,
    };
  }

  /** Write allow-listed fields from the config popup to the host via
   *  UPDATE_ACCOUNT. Account name goes to the top-level; toggles go into
   *  `custom` (shallow-merged on the host side). */
  async saveAccountFromConfig({ accountId, patch }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);

    const topLevelPatch = {};
    const customPatch = {};
    if ("accountName" in patch) {
      const trimmed = String(patch.accountName ?? "").trim();
      if (!trimmed) throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
      topLevelPatch.accountName = trimmed;
    }
    for (const key of ["readOnlyMode", "includeSystemContactGroups", "verboseLogging"]) {
      if (key in patch) customPatch[key] = !!patch[key];
    }

    const outgoing = { ...topLevelPatch };
    if (Object.keys(customPatch).length) outgoing.custom = customPatch;
    if (Object.keys(outgoing).length) {
      await this.updateAccount({ accountId, patch: outgoing });
    }
    return null;
  }

  /** Re-prime credentials and re-register books for every enabled account
   *  on startup. WebExtension event listeners don't replay across restarts,
   *  so we walk the host's accounts and wire the changelog watcher back in. */
  async primeStartupState() {
    const accounts = await this.listAccounts();
    for (const acc of accounts) {
      const { providerAccountId, custom } = acc;
      if (!providerAccountId) continue;
      if (custom?.clientID && custom?.clientSecret) {
        oauth.primeCredentials(providerAccountId, {
          clientID: custom.clientID,
          clientSecret: custom.clientSecret,
        });
      }
      const ctx = await this.getAccount(acc.accountId);
      if (!ctx) continue;
      for (const folder of ctx.folders) {
        if (folder.targetID) {
          await changelogWatcher.registerTarget(folder.targetID, providerAccountId);
        }
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Load `{account, folders, providerAccountId, authenticatedUserEmail}`
   *  for an on* hook. Returns null if the account doesn't exist or isn't
   *  owned by us. */
  async #loadContext(accountId) {
    const rv = await this.getAccount(accountId);
    if (!rv?.account) return null;
    const tokens = await oauthTokens.get(rv.account.providerAccountId);
    return {
      account: rv.account,
      folders: rv.folders ?? [],
      providerAccountId: rv.account.providerAccountId,
      authenticatedUserEmail: tokens?.authenticatedUserEmail ?? null,
    };
  }

  /** Delete every Thunderbird address book bound to these folder rows,
   *  tolerating per-folder failures (log and continue). Also unregisters
   *  each book from the changelog watcher so pending onDeleted events don't
   *  write orphan entries. */
  async #deleteAccountTargets(folderList) {
    for (const folder of folderList) {
      if (folder.targetID) {
        changelogWatcher.unregisterTarget(folder.targetID);
        await safeDeleteBook(folder.targetID);
      }
    }
  }
}

// ── Module-local helpers ─────────────────────────────────────────────────

/** Book name includes the email so users with multiple Google accounts
 *  under the same label can tell them apart in the Thunderbird sidebar. */
function computeBookName(accountName, authenticatedUserEmail) {
  const email = authenticatedUserEmail?.trim?.() || null;
  return email ? `${accountName} (${email})` : accountName;
}

/** `addressBook.deleteBook` with a warn-and-continue catch. */
async function safeDeleteBook(targetID) {
  try {
    await addressBook.deleteBook(targetID);
  } catch (err) {
    console.warn(
      `[google-4-tbsync] could not delete address book ${targetID}:`,
      err?.message ?? err
    );
  }
}
