/**
 * Google provider. Overrides every on* hook with Google-specific logic.
 *
 * Host is the source of truth for account + folder rows. This provider
 * pulls its context from the host at the top of each on* hook via
 * `this.getAccount(accountId)`, reads user-config, OAuth credentials and
 * the refresh token from `account.custom.*`, and writes state back via
 * UPDATE_ACCOUNT / UPDATE_FOLDER RPCs. The provider has no persistent
 * storage of its own — even the changelog and the contact-group map
 * live on the host's folder rows.
 *
 * `authenticateAndCreateAccount` and `saveAccountFromConfig` are plain
 * methods triggered by runtime.onMessage from setup.html / config.html.
 */

import {
  ERR, withCode, error, ok,
  TbSyncProviderImplementation,
} from "../vendor/tbsync/provider.mjs";
import * as oauth from "./google/oauth.mjs";
import * as addressBook from "./address-book.mjs";
import { syncFolderContacts } from "./google/sync-contacts.mjs";
import { DEBUG_STATUS_DELAY_MS } from "./debug.mjs";

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

  /** Fired by the base class the first time the host opens the port (and on
   *  every subsequent reconnect). Safe to call more than once — priming is
   *  idempotent. */
  async onConnectedToHost() {
    await this.primeStartupState();
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  async onSyncAccount({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    // Prime OAuth auth so the people-api layer can refresh access tokens
    // without re-reading host state mid-sync.
    this.#primeAuth(ctx);
    // Google surfaces a single contacts container — no server-side folder
    // discovery. The host's sync-coordinator proceeds to call onSyncFolder
    // for each selected folder. Dwell 250 ms so the manager can render
    // the "Preparing…" transition.
    this.reportSyncState({ accountId, syncState: "prepare" });
    await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
    return ok();
  }

  async onSyncFolder({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);

    this.#primeAuth(ctx);

    // Defensive: the stored targetID may be stale if the user deleted the
    // address book manually from Thunderbird's UI. Recreate on the fly so
    // the sync can still proceed — push the new ID back to the host. The
    // host-side watcher picks up the new targetID via the folders-changed
    // broadcast that follows the updateFolder call.
    let targetID = folder.targetID;
    if (!targetID || !(await addressBook.bookExists(targetID))) {
      const bookName = computeBookName(ctx.account.accountName, ctx.authenticatedUserEmail);
      targetID = await addressBook.createBook(bookName);
      await this.updateFolder({
        accountId, folderId,
        patch: { targetID, targetName: bookName },
      });
    }

    return await syncFolderContacts({
      accountId,
      providerAccountId: ctx.providerAccountId,
      folderId,
      // Pass the refreshed folder row so `sync-contacts` has `folder.targetID`
      // and `folder.custom.groupMap` — the latter is loaded once at the top
      // of the sync and flushed back via one UPDATE_FOLDER at the end.
      folder: { ...folder, targetID },
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
    // the user may enable but not immediately sync. displayName mirrors
    // the first-setup convention (authenticatedUserEmail if available).
    if (ctx.folders.length > 0) return null;
    const folder = {
      folderId: `f-${crypto.randomUUID()}`,
      folderType: "contacts",
      displayName: ctx.authenticatedUserEmail?.trim() || ctx.account.accountName,
      // Mirror the account-level toggle so the ACL icon is correct from
      // the moment the folder is discovered, before the user enables it.
      readOnly: !!ctx.account.custom?.readOnlyMode,
      selected: false,
    };
    await this.pushFolderList({ accountId, folders: [folder] });
    return null;
  }

  async onAccountDisabled({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // Disable always releases Thunderbird resources so re-enable starts
    // from a clean slate. Clear each folder's groupMap, contactMap, and
    // pending changelog too — the TB ids they hold reference books we
    // just deleted.
    await this.#deleteAccountTargets(ctx.folders);
    for (const folder of ctx.folders) {
      await this.updateFolder({
        accountId, folderId: folder.folderId,
        patch: { custom: { groupMap: {}, contactMap: {}, changelog: [] } },
      }).catch(err => {
        // Re-enable will resurrect stale data if this fails; logging makes
        // the drift visible rather than silently accumulating.
        console.warn(`[google-4-tbsync] clear folder state on disable failed (folder=${folder.folderId}):`, err?.message ?? err);
      });
    }
    oauth.invalidateAccessToken(ctx.providerAccountId);
    oauth.forgetAuth(ctx.providerAccountId);
    return null;
  }

  async onAccountDeleted({ accountId, purgeTargets }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // `purgeTargets` travels over the protocol from the host. Default to
    // true: removing an account normally means the books go too. The host
    // row (including custom.{groupMap,contactMap,changelog} and OAuth
    // secrets) is wiped right after we return — no explicit patch needed.
    if (purgeTargets !== false) {
      await this.#deleteAccountTargets(ctx.folders);
    }
    oauth.invalidateAccessToken(ctx.providerAccountId);
    oauth.forgetAuth(ctx.providerAccountId);
    return null;
  }

  async onFolderEnabled({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    // Idempotent: if the book is already present, nothing to do — the
    // host's watcher is already registered for this targetID via the
    // folder-row registry.
    if (folder.targetID && await addressBook.bookExists(folder.targetID)) {
      return null;
    }
    const bookName = computeBookName(ctx.account.accountName, ctx.authenticatedUserEmail);
    const targetID = await addressBook.createBook(bookName);
    await this.updateFolder({
      accountId, folderId,
      patch: { targetID, targetName: bookName },
    });
    return null;
  }

  async onFolderDisabled({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find(f => f.folderId === folderId);
    if (!folder) throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    if (folder.targetID) {
      // Drop the targetID first so the host's watcher stops listening
      // before we delete the book (otherwise each cascading onDeleted
      // event from the book teardown would be logged as a user delete).
      await this.updateFolder({
        accountId, folderId,
        patch: { targetID: null, targetName: null },
      });
      await safeDeleteBook(folder.targetID);
    }
    // Dropping the book invalidates every pending changelog entry and
    // both provider-maintained maps — the TB ids they hold reference
    // the book we just deleted. Clear in one patch so re-enable starts
    // fresh.
    await this.updateFolder({
      accountId, folderId,
      patch: { custom: { groupMap: {}, contactMap: {}, changelog: [] } },
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
    return {
      displayName: ctx.account.accountName,
      iconUrl: browser.runtime.getURL("icons/icon-16.png"),
      connectionState: ctx.account.custom.refreshToken ? "connected" : "disconnected",
      lastSyncTime: ctx.account.lastSyncTime ?? 0,
      extraRows: [],
    };
  }

  async onGetSortedFolders({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return [];
    const readOnly = !!ctx.account.custom?.readOnlyMode;
    return ctx.folders
      .slice()
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
      .map(f => ({
        folderId: f.folderId,
        folderType: f.folderType ?? "contacts",
        displayName: f.displayName,
        // Mirror the account-level "read-only mode" toggle onto every
        // folder row so the manager's ACL column surfaces the cause of a
        // skipped push pass without any host-side knowledge of the flag.
        readOnly,
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
      const nextEmail = authenticatedUserEmail ?? ctx.authenticatedUserEmail ?? null;
      await this.updateAccount({
        accountId,
        patch: { custom: { refreshToken, authenticatedUserEmail: nextEmail } },
      });
      oauth.primeAuth(ctx.providerAccountId, { clientID, clientSecret, refreshToken });
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
   *    2. Return the payload the setup page forwards to the host: the
   *       providerAccountId, the user-chosen account name, the opaque
   *       `custom` blob (user-config + OAuth secrets + refresh token),
   *       and one unselected contacts folder descriptor.
   *  The host row is created by the base-class `onOpenSetupPopup` after
   *  the page posts `tbsync-setup-completed`. */
  async authenticateAndCreateAccount({ label, clientID, clientSecret }) {
    const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
      await oauth.startAuth({ clientID, clientSecret });

    const trimmedLabel = (label ?? "").trim();
    if (!trimmedLabel) {
      throw withCode(new Error("Account name is required"), ERR.UNKNOWN_ACCOUNT);
    }
    const providerAccountId = `g-${crypto.randomUUID()}`;

    oauth.primeAuth(providerAccountId, { clientID, clientSecret, refreshToken });
    if (accessToken) oauth.primeAccessToken(providerAccountId, accessToken, expiresIn);

    const initialFolders = [{
      folderId: `f-${crypto.randomUUID()}`,
      folderType: "contacts",
      displayName: authenticatedUserEmail?.trim() || trimmedLabel,
      // Mirrors `custom.readOnlyMode` default below so the ACL indicator
      // and push behavior agree from row zero.
      readOnly: true,
      selected: false,
    }];

    return {
      providerAccountId,
      accountName: trimmedLabel,
      initialFolders,
      custom: {
        clientID,
        clientSecret,
        refreshToken,
        authenticatedUserEmail: authenticatedUserEmail ?? null,
        readOnlyMode: true,
        includeSystemContactGroups: false,
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
    for (const key of ["readOnlyMode", "includeSystemContactGroups"]) {
      if (key in patch) customPatch[key] = !!patch[key];
    }

    const outgoing = { ...topLevelPatch };
    if (Object.keys(customPatch).length) outgoing.custom = customPatch;
    if (Object.keys(outgoing).length) {
      await this.updateAccount({ accountId, patch: outgoing });
    }

    // Mirror a read-only toggle onto every folder row immediately so the
    // manager's ACL column updates without waiting for the next sync's
    // onGetSortedFolders pass.
    if ("readOnlyMode" in patch) {
      const readOnly = !!patch.readOnlyMode;
      await Promise.all(ctx.folders.map(f =>
        this.updateFolder({ accountId, folderId: f.folderId, patch: { readOnly } })
      ));
    }
    return null;
  }

  /** Re-prime the in-memory OAuth auth cache for every account on startup
   *  from host-stored credentials. Fired by the base class from
   *  `onConnectedToHost` (first port-open + every reconnect). Safe to run
   *  multiple times. Book observation is host-owned now, so nothing to
   *  do for the watcher here. */
  async primeStartupState() {
    const accounts = await this.listAccounts();
    for (const acc of accounts) {
      const { providerAccountId, custom } = acc;
      if (!providerAccountId) continue;
      if (custom?.clientID && custom?.clientSecret && custom?.refreshToken) {
        oauth.primeAuth(providerAccountId, {
          clientID: custom.clientID,
          clientSecret: custom.clientSecret,
          refreshToken: custom.refreshToken,
        });
      }
    }
    // Book observation + identity caches are host-owned now; the host
    // watcher seeds its registry from the folders storage blob at boot.
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Prime OAuth for a context — clientID, clientSecret, and refresh token
   *  all live on the host row under `custom.*`. */
  #primeAuth(ctx) {
    const { clientID, clientSecret, refreshToken } = ctx.account.custom ?? {};
    if (!clientID || !clientSecret || !refreshToken) return;
    oauth.primeAuth(ctx.providerAccountId, { clientID, clientSecret, refreshToken });
  }

  /** Load `{account, folders, providerAccountId, authenticatedUserEmail}`
   *  for an on* hook. Returns null if the account doesn't exist or isn't
   *  owned by us. */
  async #loadContext(accountId) {
    const rv = await this.getAccount(accountId);
    if (!rv?.account) return null;
    return {
      account: rv.account,
      folders: rv.folders ?? [],
      providerAccountId: rv.account.providerAccountId,
      authenticatedUserEmail: rv.account.custom?.authenticatedUserEmail ?? null,
    };
  }

  /** Delete every Thunderbird address book bound to these folder rows,
   *  tolerating per-folder failures (log and continue). The host watcher
   *  unregisters each book on the next folders-changed broadcast (when
   *  targetID drops to null) — callers that care about avoiding orphan
   *  delete entries should null targetID *before* calling this helper. */
  async #deleteAccountTargets(folderList) {
    for (const folder of folderList) {
      if (folder.targetID) {
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
