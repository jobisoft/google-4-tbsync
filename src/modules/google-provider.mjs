/**
 * Google provider. Overrides every on* hook with Google-specific logic.
 *
 * Host is the source of truth for account + folder rows. This provider
 * pulls its context from the host at the top of each on* hook via
 * `this.getAccount(accountId)`, reads user-config, OAuth credentials and
 * the refresh token from `account.custom.*`, and writes state back via
 * UPDATE_ACCOUNT / UPDATE_FOLDER RPCs. The provider has no persistent
 * storage of its own - even the changelog and the contact-group map
 * live on the host's folder rows.
 *
 * `authenticateAndCreateAccount` and `saveAccountFromConfig` are plain
 * methods triggered by runtime.onMessage from setup.html / config.html.
 */

import {
  ERR,
  withCode,
  error,
  ok,
  TbSyncProviderImplementation,
} from "../vendor/tbsync/provider.mjs";
import * as oauth from "./google/oauth.mjs";
import * as addressBook from "./address-book.mjs";
import { syncFolderContacts } from "./google/sync-contacts.mjs";
import { runStartupMigrations } from "./upgrades.mjs";
import {
  localQueue,
  rememberBindings,
  sweep,
} from "../vendor/tbsync/change-queue.mjs";
import { installContactsObserver } from "../vendor/tbsync/contacts-observer.mjs";
import { setSyncSignalResolver } from "./google/people-api.mjs";

export class GoogleProvider extends TbSyncProviderImplementation {
  constructor() {
    super({
      name: "Google Contacts",
      shortName: "google",
      setupPath: "dialogs/setup/setup.html",
      setupWidth: 520,
      setupHeight: 690,
      configPath: "dialogs/config/config.html",
      configWidth: 520,
      configHeight: 630,
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
    // Let the People API layer see the running sync's AbortSignal, so a
    // cancel drops the request in flight instead of waiting out a call that
    // may never answer.
    setSyncSignalResolver((accountId) => this.syncSignal(accountId));
  }

  // ── Base-class hook: post-register ─────────────────────────────────────

  /** Nothing to persist locally after registration - the host's accountId
   *  is the only identity we need and is looked up via getAccount(). */
  async onRegisterSuccessful() {
    return null;
  }

  /** Fired by the base class the first time the host opens the port (and on
   *  every subsequent reconnect). Safe to call more than once - priming is
   *  idempotent. */
  async onConnectedToHost() {
    // Bring storage and accounts up to date before priming reads account
    // state - a legacy-imported account still holds it in the shape the
    // legacy add-on wrote. Cheap when there is nothing to do, and it has to
    // run on every port open rather than once per boot: the host re-imports
    // whenever its own storage has been cleared, and that reaches this side
    // as a reconnect and nothing else.
    await runStartupMigrations(this);
    await this.primeStartupState();
    // Line our own storage up with the bindings the host names: learn where
    // each address book belongs, and drop the queues of bindings that have
    // ended. Then watch the books - after the reconcile, so the bindings the
    // observer resolves against are current before the first event lands.
    await this.#reconcileFolderSessions();
    installContactsObserver({
      provider: this,
      report: (args) => this.reportEventLog(args),
    });
  }

  /** Bank which folder each address book belongs to, and sweep the queues of
   *  bindings the host no longer names.
   *
   *  An address-book event carries a book id and nothing else, and the
   *  observer must resolve it without asking the host - the host may be gone
   *  by the time the user edits a card. Sweeping is the whole teardown path
   *  for what we store: the host ends a binding by minting a new session id
   *  and telling nobody, because Disconnect and Remove have to work while
   *  this add-on is broken or uninstalled.
   *
   *  Reads every account before deciding anything: a partial answer would
   *  sweep live queues away, so any failure abandons the pass. */
  async #reconcileFolderSessions() {
    const liveSessions = new Set();
    const liveTargets = new Set();
    const bindings = [];
    try {
      for (const { accountId } of await this.listAccounts()) {
        const { folders = [] } = (await this.getAccount(accountId)) ?? {};
        for (const f of folders) {
          if (!f?.sessionId) continue;
          liveSessions.add(f.sessionId);
          if (f.targetID) {
            liveTargets.add(f.targetID);
            bindings.push({
              targetID: f.targetID,
              accountId,
              folderId: f.folderId,
              sessionId: f.sessionId,
              targetType: f.targetType,
            });
          }
        }
      }
    } catch (err) {
      this.reportEventLog({
        level: "debug",
        message: `[queue] could not read folder sessions; reconcile skipped: ${err?.message ?? String(err)}`,
      });
      return;
    }
    try {
      await rememberBindings(bindings);
      const { queues, orphans } = await sweep({ liveSessions, liveTargets });
      for (const d of queues) {
        this.reportEventLog({
          level: d.entries > 0 ? "info" : "debug",
          accountId: d.accountId ?? undefined,
          folderId: d.folderId ?? undefined,
          message:
            `[queue] dropped the change queue of a binding that no longer ` +
            `exists (${d.entries} pending edit(s) went with it)`,
        });
      }
      // Whatever those bindings pointed at is no longer synced by anything.
      // The host marks the ones that still exist; the rest it skips.
      await this.reportOrphanedTargets(orphans);
    } catch (err) {
      this.reportEventLog({
        level: "warning",
        message: `[queue] reconcile failed: ${err?.message ?? String(err)}`,
      });
    }
  }

  /** The pending edits we hold for a folder. Read-only, and the only way
   *  anyone outside this add-on can see the queue - the folder row's own
   *  changelog stays empty. */
  async onGetChangelog({ accountId, folderId }) {
    const { folders = [] } = (await this.getAccount(accountId)) ?? {};
    const folder = folders.find((f) => f.folderId === folderId);
    if (!folder?.sessionId) return null;
    return localQueue({
      accountId,
      folderId,
      sessionId: folder.sessionId,
      observed: true,
    }).entries();
  }

  // ── Sync ───────────────────────────────────────────────────────────────

  async onSyncAccount({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    // Prime OAuth auth so the people-api layer can refresh access tokens
    // without re-reading host state mid-sync.
    this.#primeAuth(ctx);
    // Resource naming requires the authenticated user's email. Fetch and
    // persist it now; if userinfo can't be reached, abort the sync with an
    // account-level error rather than producing degraded names downstream.
    await this.#ensureUserEmail(ctx);
    // Google surfaces a single contacts container - no server-side folder
    // discovery. The host's sync-coordinator proceeds to call onSyncFolder
    // for each selected folder. Dwell 250 ms so the manager can render
    // the "Preparing…" transition.
    this.reportSyncState({ accountId, syncState: "prepare" });
    return ok();
  }

  async onSyncFolder({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find((f) => f.folderId === folderId);
    if (!folder)
      throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);

    this.#primeAuth(ctx);

    // The stored targetID may be stale (book deleted in TB's UI, or torn
    // down by `onAccountDisabled`). Recreate and persist the new id; the
    // host's watcher picks it up via the folders-changed broadcast.
    let targetID = folder.targetID;
    if (!targetID || !(await addressBook.bookExists(targetID))) {
      const bookName = bookNameForFolder(folder, ctx);
      targetID = await addressBook.createBook(bookName);
      await this.updateFolder({
        accountId,
        folderId,
        patch: { targetID, targetName: bookName },
      });
    }

    return await syncFolderContacts({
      accountId,
      folderId,
      // Pass the refreshed folder row so `sync-contacts` has `folder.targetID`
      // and `folder.custom.groupMap` - the latter is loaded once at the top
      // of the sync and flushed back via one UPDATE_FOLDER at the end.
      folder: { ...folder, targetID },
      account: ctx.account,
      notify: this,
    });
  }

  // ── Account / folder lifecycle ─────────────────────────────────────────

  async onAccountEnabled({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return null;
    // Prime OAuth for this account in case `primeStartupState` hasn't
    // had a chance to (e.g. the account was just created post-setup).
    this.#primeAuth(ctx);
    // Catch legacy/migrated accounts that arrived without the email on
    // file. Throws if userinfo can't be reached; the host surfaces that
    // as an account-level error.
    await this.#ensureUserEmail(ctx);
    // Re-enable after disable: push a fresh single-folder descriptor. The
    // book itself is created lazily (onFolderEnabled / onSyncFolder) since
    // the user may enable but not immediately sync.
    if (ctx.folders.length > 0) return null;
    const folder = {
      folderId: `f-${crypto.randomUUID()}`,
      targetType: "contacts",
      displayName: ctx.authenticatedUserEmail.trim(),
      // Mirror the account-level toggle so the ACL icon is correct from
      // the moment the folder is discovered, before the user enables it.
      readOnly: !!ctx.account.custom.readOnlyMode,
      selected: false,
    };
    await this.pushFolderList({ accountId, folders: [folder] });
    return null;
  }

  async onAccountDisabled({ accountId }) {
    // Provider state only - the host owns target deletion in every flow
    // and deletes the books right after this returns, whether or not this
    // provider is around to hear about it. That division is what makes
    // Disconnect a recovery path.
    oauth.forgetAuth(accountId);
    return null;
  }

  async onAccountDeleted({ accountId }) {
    // Same contract: stop, drop provider state, never touch resources.
    // Keeping or purging the books is the host's decision now; the host
    // row (including custom.{groupMap,contactMap,changelog} and OAuth
    // secrets) is wiped right after we return.
    oauth.forgetAuth(accountId);
    return null;
  }

  async onFolderEnabled() {
    // No-op: the host flips `selected` on its folder row. The address
    // book is created lazily by `onSyncFolder` on the next sync, so the
    // resource list reflects "enabled but not yet synced" until then.
    return null;
  }

  async onFolderDisabled({ accountId, folderId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("unknown account"), ERR.UNKNOWN_ACCOUNT);
    const folder = ctx.folders.find((f) => f.folderId === folderId);
    if (!folder)
      throw withCode(new Error("unknown folder"), ERR.UNKNOWN_FOLDER);
    if (folder.targetID) {
      // Drop the targetID so the host's watcher stops listening before the
      // book goes away (otherwise each cascading onDeleted event from the
      // teardown would be logged as a user delete). The deletion itself is
      // the host's, right after this returns.
      await this.updateFolder({
        accountId,
        folderId,
        patch: { targetID: null, targetName: null },
      });
    }
    // Clear the provider-owned maps: the TB ids they hold reference the
    // book we just deleted. The host wipes the changelog and the
    // universal sync-status fields itself in `setFolderSelected`.
    await this.updateFolder({
      accountId,
      folderId,
      patch: { custom: { groupMap: {}, contactMap: {} } },
    });
    return null;
  }

  // ── Display + folder-list queries ──────────────────────────────────────

  async onGetSortedFolders({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return [];
    const readOnly = !!ctx.account.custom.readOnlyMode;
    return ctx.folders
      .slice()
      .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
      .map((f) => ({
        folderId: f.folderId,
        targetType: f.targetType ?? "contacts",
        displayName: f.displayName,
        // Mirror the account-level "read-only mode" toggle onto every
        // folder row so the manager's ACL column surfaces the cause of a
        // skipped push pass without any host-side knowledge of the flag.
        readOnly,
        selected: f.selected ?? false,
      }));
  }

  // ── Re-authentication ──────────────────────────────────────────────────

  /** Re-run OAuth against the authenticated email. Rejects with ERR.AUTH
   *  if the user signs in with a different Gmail address. */
  async onReauthenticate({ accountId }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) return error("Unknown account", ERR.UNKNOWN_ACCOUNT);
    const { clientID, clientSecret, clientType } = ctx.account.custom;
    if (!clientID || !clientSecret) {
      return error("Missing OAuth credentials", ERR.AUTH);
    }
    try {
      const { refreshToken, authenticatedUserEmail, accessToken, expiresIn } =
        await oauth.startAuth({
          clientID,
          clientSecret,
          clientType,
          loginHint: ctx.authenticatedUserEmail,
        });
      if (
        ctx.authenticatedUserEmail &&
        authenticatedUserEmail &&
        ctx.authenticatedUserEmail !== authenticatedUserEmail
      ) {
        return error(
          `Signed-in user (${authenticatedUserEmail}) does not match the account's Google address (${ctx.authenticatedUserEmail}).`,
          ERR.AUTH,
        );
      }
      const nextEmail =
        authenticatedUserEmail ?? ctx.authenticatedUserEmail ?? null;
      await this.updateAccount({
        accountId,
        patch: { custom: { refreshToken, authenticatedUserEmail: nextEmail } },
      });
      oauth.primeAuth(ctx.account.accountId, {
        clientID,
        clientSecret,
        refreshToken,
      });
      if (accessToken)
        oauth.primeAccessToken(ctx.account.accountId, accessToken, expiresIn);
      return ok();
    } catch (err) {
      return error(
        err.message ?? "Re-authentication failed",
        err.code ?? ERR.AUTH,
      );
    }
  }

  // ── Internal-message entry points ──────────────────────────────────────

  /** Setup popup flow:
   *    1. Run OAuth → refresh token + authenticated email.
   *    2. Return the payload the setup page forwards to the host: the
   *       user-chosen account name, the opaque `custom` blob (user-config
   *       + OAuth secrets + refresh token), and one unselected contacts
   *       folder descriptor.
   *  The host row is created by the base-class `onOpenSetupPopup` after
   *  the page posts `tbsync-setup-completed`. The OAuth cache is primed
   *  by `primeStartupState` on the next port-open, keyed by the host's
   *  fresh accountId. */
  async authenticateAndCreateAccount({
    label,
    clientID,
    clientSecret,
    clientType,
  }) {
    const { refreshToken, authenticatedUserEmail } = await oauth.startAuth({
      clientID,
      clientSecret,
      clientType,
    });

    const trimmedLabel = (label ?? "").trim();
    if (!trimmedLabel) {
      throw withCode(
        new Error("Account name is required"),
        ERR.UNKNOWN_ACCOUNT,
      );
    }

    const initialFolders = [
      {
        folderId: `f-${crypto.randomUUID()}`,
        targetType: "contacts",
        displayName: authenticatedUserEmail.trim(),
        // Mirrors `custom.readOnlyMode` default below so the ACL indicator
        // and push behavior agree from row zero.
        readOnly: true,
        selected: false,
      },
    ];

    return {
      accountName: trimmedLabel,
      initialFolders,
      custom: {
        clientID,
        clientSecret,
        // Persist the chosen flow so re-auth and the config popup know
        // which redirect-URL / popup-vs-launchWebAuthFlow path to use.
        // `oauth.startAuth` treats anything other than "web" as desktop.
        clientType: clientType === "web" ? "web" : "desktop",
        refreshToken,
        authenticatedUserEmail,
        readOnlyMode: true,
        includeSystemContactGroups: false,
      },
    };
  }

  /** Most recent provider account credentials, grouped by OAuth client
   *  type. Setup popup uses this to prefill the form when the user picks
   *  a type from the dropdown. Migrated accounts have no `clientType`
   *  field - they're treated as `"desktop"` to match the OAuth layer. */
  async getLastCredentials() {
    const list = await this.listAccounts();
    const sorted = list
      .filter((a) => a.custom.clientID && a.custom.clientSecret)
      .sort((a, b) => (b.lastSyncTime ?? 0) - (a.lastSyncTime ?? 0));
    const out = { desktop: null, web: null };
    for (const acc of sorted) {
      const type = acc.custom.clientType === "web" ? "web" : "desktop";
      if (out[type]) continue;
      out[type] = {
        clientID: acc.custom.clientID,
        clientSecret: acc.custom.clientSecret,
      };
      if (out.desktop && out.web) break;
    }
    return out;
  }

  /** Sanitized account record view for the config popup. */
  async getAccountForConfig(accountId) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);
    return {
      accountId,
      accountName: ctx.account.accountName,
      authenticatedUserEmail: ctx.authenticatedUserEmail ?? null,
      clientID: ctx.account.custom.clientID ?? "",
      // If `clientType` is unset, we are dealing with a migrated google account
      // from the legacy era, which only supported "desktop".
      clientType: ctx.account.custom.clientType === "web" ? "web" : "desktop",
      readOnlyMode: !!ctx.account.custom.readOnlyMode,
      includeSystemContactGroups:
        !!ctx.account.custom.includeSystemContactGroups,
    };
  }

  /** Write allow-listed fields from the config popup to the host via
   *  UPDATE_ACCOUNT. Account name goes to the top-level; everything else
   *  goes into `custom` (shallow-merged on the host side).
   *
   *  OAuth credentials (`clientID` / `clientSecret`) are editable only
   *  when the account is disconnected - the popup enforces that via the
   *  `readOnly` URL param, and the host gates `readOnly` on
   *  `account.enabled`. When the user changes either, the stored
   *  `refreshToken` becomes meaningless (it was issued for the old
   *  client), so we drop it; the next sync will surface "Sign in again"
   *  via the standard auth-error path. The `clientType` is locked in
   *  the popup and never travels through here. */
  async saveAccountFromConfig({ accountId, patch }) {
    const ctx = await this.#loadContext(accountId);
    if (!ctx) throw withCode(new Error("Unknown account"), ERR.UNKNOWN_ACCOUNT);

    const topLevelPatch = {};
    const customPatch = {};
    if ("accountName" in patch) {
      const trimmed = String(patch.accountName ?? "").trim();
      if (!trimmed)
        throw withCode(
          new Error("Account name is required"),
          ERR.UNKNOWN_ACCOUNT,
        );
      topLevelPatch.accountName = trimmed;
    }
    if ("clientID" in patch) {
      const trimmed = String(patch.clientID ?? "").trim();
      if (!trimmed)
        throw withCode(new Error("Client ID is required"), ERR.AUTH);
      customPatch.clientID = trimmed;
    }
    if ("clientSecret" in patch) {
      // Empty values are filtered out at the popup; if a value reaches
      // here it's an explicit replacement.
      customPatch.clientSecret = String(patch.clientSecret);
    }
    for (const key of ["readOnlyMode", "includeSystemContactGroups"]) {
      if (key in patch) customPatch[key] = !!patch[key];
    }

    // Detect a credentials change: clientID or clientSecret differs from
    // what's on disk. Invalidate refresh token + cached email so the
    // user re-authenticates.
    const credsChanged =
      ("clientID" in customPatch &&
        customPatch.clientID !== ctx.account.custom.clientID) ||
      ("clientSecret" in customPatch &&
        customPatch.clientSecret !== ctx.account.custom.clientSecret);
    if (credsChanged) {
      customPatch.refreshToken = null;
      customPatch.authenticatedUserEmail = null;
      oauth.forgetAuth(accountId);
    }

    const outgoing = { ...topLevelPatch };
    if (Object.keys(customPatch).length) outgoing.custom = customPatch;
    if (Object.keys(outgoing).length) {
      await this.updateAccount({ accountId, patch: outgoing });
    }

    // Mirror onto each folder so the ACL column is updated.
    if ("readOnlyMode" in patch) {
      const readOnly = !!patch.readOnlyMode;
      await Promise.all(
        ctx.folders.map((f) =>
          this.updateFolder({
            accountId,
            folderId: f.folderId,
            patch: { readOnly },
          }),
        ),
      );
    }
    return null;
  }

  /** Re-prime the in-memory OAuth auth cache for every account on startup
   *  from host-stored credentials. Fired by the base class from
   *  `onConnectedToHost` (first port-open + every reconnect). Safe to run
   *  multiple times. Book observation is host-owned. */
  async primeStartupState() {
    const accounts = await this.listAccounts();
    for (const acc of accounts) {
      const { accountId, custom } = acc;
      if (!accountId) continue;
      if (custom.clientID && custom.clientSecret && custom.refreshToken) {
        oauth.primeAuth(accountId, {
          clientID: custom.clientID,
          clientSecret: custom.clientSecret,
          refreshToken: custom.refreshToken,
        });
      }
    }
  }

  // ── Private ────────────────────────────────────────────────────────────

  /** Prime OAuth for a context - clientID, clientSecret, and refresh token
   *  all live on the host row under `custom.*`. */
  #primeAuth(ctx) {
    const { clientID, clientSecret, refreshToken } = ctx.account.custom ?? {};
    if (!clientID || !clientSecret || !refreshToken) return;
    oauth.primeAuth(ctx.account.accountId, {
      clientID,
      clientSecret,
      refreshToken,
    });
  }

  /** Guarantee `ctx.authenticatedUserEmail` is populated. If the field is
   *  already on file, returns immediately. Otherwise hits Google's userinfo
   *  endpoint, persists the result, and mutates `ctx` so the rest of the
   *  hook sees it. Throws (ERR.NETWORK or ERR.AUTH) if the email cannot be
   *  fetched - sync should abort with an account-level error rather than
   *  produce resources named with a fallback. Caller must have run
   *  `#primeAuth(ctx)` first. */
  async #ensureUserEmail(ctx) {
    if (ctx.authenticatedUserEmail) return;
    const accountId = ctx.account.accountId;
    const accessToken = await oauth.getAccessToken(accountId);
    const email = await oauth.fetchUserEmail(accessToken);
    await this.updateAccount({
      accountId,
      patch: { custom: { authenticatedUserEmail: email } },
    });
    ctx.authenticatedUserEmail = email;
  }

  /** Load `{account, folders, authenticatedUserEmail}` for an on* hook.
   *  Returns null if the account doesn't exist or isn't owned by us. */
  async #loadContext(accountId) {
    const rv = await this.getAccount(accountId);
    if (!rv?.account) return null;
    return {
      account: rv.account,
      folders: rv.folders ?? [],
      authenticatedUserEmail: rv.account.custom.authenticatedUserEmail ?? null,
    };
  }

}

// ── Module-local helpers ─────────────────────────────────────────────────

/** Book name for a (re)created Thunderbird address book. Prefers the
 *  stored `targetName` (carries across disable/enable and any user
 *  rename mirrored from the TB UI). Otherwise builds the canonical
 *  initial form `${accountName} (${email})`. The email is guaranteed
 *  present by `#ensureUserEmail` running at the top of every sync. */
function bookNameForFolder(folder, ctx) {
  const stored = folder?.targetName?.trim?.();
  if (stored) return stored;
  return `${ctx.account.accountName} (${ctx.authenticatedUserEmail})`;
}

