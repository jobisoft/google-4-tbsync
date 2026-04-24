/**
 * Base class for TbSync provider add-ons. Owns the handshake, port
 * lifecycle, RPC dispatch, and setup/config popup windowing. Subclasses
 * override `on*` virtual hooks — one per HOST_CMD. Required overrides
 * throw `E:UNKNOWN_COMMAND`; safe-no-op hooks return `null`.
 *
 * Startup: `new MyProvider(options); provider.init();`.
 */

import {
  DEFAULT_RPC_TIMEOUT_MS,
  DISCOVERY, ERR, HOST_CMD, NO_TIMEOUT_CMDS,
  PORT_NAME, PROTOCOL_VERSION,
  PROVIDER_CMD, PROVIDER_NOTIFY, withCode,
} from "./protocol.mjs";

// Subclass-facing surface. Subclass code imports only from this file;
// protocol.mjs and status.mjs stay as mirror-synced contract files.
export { ERR, withCode } from "./protocol.mjs";
export { ok, warning, error, accountRerun, folderRerun } from "./status.mjs";

/** Extension id of the TbSync host. */
export const TBSYNC_ID = "tbsync@jobisoft.de";


const DEFAULT_SETUP_WIDTH = 520;
const DEFAULT_SETUP_HEIGHT = 640;
const DEFAULT_CONFIG_WIDTH = 520;
const DEFAULT_CONFIG_HEIGHT = 580;

// Host-availability retry schedule — first announce 250 ms after host flips
// to enabled (it's still initialising its onMessageExternal listener), then
// every 500 ms up to 10 attempts.
const ANNOUNCE_INITIAL_DELAY_MS = 250;
const ANNOUNCE_RETRY_DELAY_MS = 500;
const ANNOUNCE_MAX_ATTEMPTS = 10;

const HOST_AVAILABLE_KEY = "host-available";

export class TbSyncProviderImplementation {
  #port = null;
  #pending = new Map();           // requestId → {resolve, reject, timer}
  #pendingSetups = new Map();     // setupToken → {resolve, reject, windowId}
  #announceInFlight = false;

  #name;
  #shortName;
  #icons;
  #capabilities;
  #defaultAccountEntries;
  #defaultFolderEntries;
  #maintainerEmail;
  #contributorsUrl;
  #setupPath;
  #setupWidth;
  #setupHeight;
  #configPath;
  #configWidth;
  #configHeight;
  #logPrefix;

  constructor(options = {}) {
    const manifest = browser.runtime.getManifest();
    this.#name = options.name ?? manifest.name;
    // Prefix for outbound RPC-correlation tokens; makes log lines from
    // different providers easy to tell apart.
    this.#shortName = options.shortName ?? browser.runtime.id;
    this.#icons = options.icons ?? manifest.icons ?? {};
    this.#capabilities = options.capabilities ?? {};
    this.#defaultAccountEntries = options.defaultAccountEntries ?? {};
    this.#defaultFolderEntries = options.defaultFolderEntries ?? {};
    this.#maintainerEmail = options.maintainerEmail ?? null;
    this.#contributorsUrl = options.contributorsUrl ?? null;
    this.#setupPath = options.setupPath ?? null;
    this.#setupWidth = options.setupWidth ?? DEFAULT_SETUP_WIDTH;
    this.#setupHeight = options.setupHeight ?? DEFAULT_SETUP_HEIGHT;
    this.#configPath = options.configPath ?? null;
    this.#configWidth = options.configWidth ?? DEFAULT_CONFIG_WIDTH;
    this.#configHeight = options.configHeight ?? DEFAULT_CONFIG_HEIGHT;
    this.#logPrefix = options.logPrefix ?? `[${browser.runtime.id}]`;
  }

  /** True while a TbSync port is open. */
  get isConnected() { return this.#port !== null; }

  // ── Entry point ─────────────────────────────────────────────────────────

  /** Attach every listener. Call once, after constructing the subclass.
   *  Calling twice double-registers. */
  init() {
    this.#attachPort();
    this.#attachProbeListener();
    this.#attachSetupCompletedListener();
    this.#attachSetupCancelListener();
    this.#watchHostAvailability();
    this.#primeHostAvailability().catch(err =>
      console.warn(`${this.#logPrefix} management.getAll() failed at startup:`, err)
    );
  }

  // ── Outbound: handshake ─────────────────────────────────────────────────

  /** Send an announce. Returns the host's reply, or null on rejection / no response. */
  async announce() {
    const manifest = browser.runtime.getManifest();
    // Resolve relative icon paths to absolute moz-extension:// URLs so the
    // host can render them cross-extension via <img src>. The provider must
    // list these paths in its manifest's web_accessible_resources.
    const absoluteIcons = Object.fromEntries(
      Object.entries(this.#icons).map(([size, path]) => [
        size,
        /^(moz-extension|https?):/.test(path) ? path : browser.runtime.getURL(path),
      ])
    );
    const payload = {
      type: DISCOVERY.ANNOUNCE,
      protocolVersion: PROTOCOL_VERSION,
      providerId: browser.runtime.id,
      providerName: this.#name,
      providerVersion: manifest.version,
      icons: absoluteIcons,
      capabilities: this.#capabilities,
      defaultAccountEntries: this.#defaultAccountEntries,
      defaultFolderEntries: this.#defaultFolderEntries,
    };
    if (this.#maintainerEmail) payload.maintainerEmail = this.#maintainerEmail;
    if (this.#contributorsUrl) payload.contributorsUrl = this.#contributorsUrl;

    try {
      const reply = await browser.runtime.sendMessage(TBSYNC_ID, payload);
      if (!reply?.ok) {
        console.warn(`${this.#logPrefix} announce rejected:`, reply);
        return null;
      }
      return reply;
    } catch {
      return null;
    }
  }

  /** Best-effort unannounce. */
  async unannounce() {
    try {
      await browser.runtime.sendMessage(TBSYNC_ID, {
        type: DISCOVERY.UNANNOUNCE,
        providerId: browser.runtime.id,
      });
    } catch { /* host already gone */ }
  }

  // ── Outbound: RPC provider → host ───────────────────────────────────────

  registerAccount(args) { return this.#sendCmd(PROVIDER_CMD.REGISTER_ACCOUNT, args); }
  updateAccount(args)   { return this.#sendCmd(PROVIDER_CMD.UPDATE_ACCOUNT,   args); }
  updateFolder(args)    { return this.#sendCmd(PROVIDER_CMD.UPDATE_FOLDER,    args); }
  pushFolderList(args)  { return this.#sendCmd(PROVIDER_CMD.PUSH_FOLDER_LIST, args); }
  /** Accounts owned by this provider, scoped on the host side. */
  listAccounts()                 { return this.#sendCmd(PROVIDER_CMD.LIST_ACCOUNTS); }
  /** `{account, folders}` for one account, or `null` if it doesn't exist
   *  or isn't owned by this provider. */
  getAccount(accountId)          { return this.#sendCmd(PROVIDER_CMD.GET_ACCOUNT, { accountId }); }
  /** Stamp a `*_by_server` pre-tag on `folder.custom.changelog` so the
   *  host's observer drops the next Thunderbird event for this item as
   *  self-inflicted (1500 ms freeze). Pass `itemId: null` for creates
   *  where the TB-assigned id isn't known pre-call. Must be awaited
   *  BEFORE the actual `messenger.contacts.*` / `messenger.mailingLists.*`
   *  call so the tag is durable before the event fires. */
  changelogMarkServerWrite(args) { return this.#sendCmd(PROVIDER_CMD.CHANGELOG_MARK_SERVER_WRITE, args); }
  /** Remove the changelog entry for `(parentId, itemId)` regardless of
   *  status. Called after successfully pushing a `*_by_user` entry. */
  changelogRemove(args)          { return this.#sendCmd(PROVIDER_CMD.CHANGELOG_REMOVE, args); }

  // ── Outbound: notifications ─────────────────────────────────────────────

  reportSyncState(payload)    { this.#notify(PROVIDER_NOTIFY.REPORT_SYNC_STATE, payload); }
  reportProgress(payload)     { this.#notify(PROVIDER_NOTIFY.REPORT_PROGRESS,   payload); }
  /** Append a line to the host's event log. `payload.level` is REQUIRED and
   *  MUST be one of "error" | "warning" | "debug"; a plain Error is thrown
   *  at the call site if it's missing or bogus (fail-fast, not a wire error). */
  reportEventLog(payload) {
    const level = payload?.level;
    if (level !== "error" && level !== "warning" && level !== "debug") {
      throw new Error(`reportEventLog: level must be "error" | "warning" | "debug" (got ${JSON.stringify(level)})`);
    }
    this.#notify(PROVIDER_NOTIFY.REPORT_EVENT_LOG, payload);
  }
  reportStatus(payload)       { this.#notify(PROVIDER_NOTIFY.REPORT_STATUS, payload); }
  requestOpenManager(payload) { this.#notify(PROVIDER_NOTIFY.REQUEST_OPEN_MANAGER, payload); }

  // ── Virtual hooks — subclass overrides ──────────────────────────────────

  /** Sync a whole account. Host calls this before walking selected folders. */
  async onSyncAccount(_args)           { throw this.#notImplemented("onSyncAccount"); }
  /** Sync one folder. Host calls this per selected folder after onSyncAccount. */
  async onSyncFolder(_args)            { throw this.#notImplemented("onSyncFolder"); }
  /** Cooperative cancel for an in-flight sync. */
  async onCancelSync(_args)            { return null; }

  async onAccountEnabled(_args)        { return null; }
  async onAccountDisabled(_args)       { return null; }
  async onAccountDeleted(_args)        { return null; }
  async onFolderEnabled(_args)         { return null; }
  async onFolderDisabled(_args)        { return null; }

  async onGetAccountDisplayInfo(_args) { throw this.#notImplemented("onGetAccountDisplayInfo"); }
  async onGetSortedFolders(_args)      { throw this.#notImplemented("onGetSortedFolders"); }
  async onSetFolderSelected(_args)     { return null; }
  async onSetAccountEntry(_args)       { return null; }

  async onReauthenticate(_args)        { throw this.#notImplemented("onReauthenticate"); }
  async onImportLegacyData(_args)      { throw this.#notImplemented("onImportLegacyData"); }

  /** Called each time the host opens a port to us (initial boot + every
   *  reconnect after a host restart). Safe place for startup work that
   *  needs to read host state — listAccounts, getAccount, etc. — since the
   *  port is live from this point. Must be idempotent. */
  async onConnectedToHost()            { return null; }

  /** Open the setup popup, wait for `tbsync-setup-completed`, register the
   *  account with the host, and return `{accountId, accountName, accountEntries}`. */
  async onOpenSetupPopup(args) {
    if (!this.#setupPath) throw this.#notImplemented("onOpenSetupPopup (no setupPath)");
    const { setupToken } = args;
    if (!setupToken) {
      throw withCode(new Error("openSetupPopup: args.setupToken is required"), ERR.UNKNOWN_COMMAND);
    }
    const url = new URL(browser.runtime.getURL(this.#setupPath));
    url.searchParams.set("setupToken", setupToken);
    if (args.locale) url.searchParams.set("locale", args.locale);

    const win = await browser.windows.create({
      url: url.toString(),
      type: "popup",
      width: this.#setupWidth,
      height: this.#setupHeight,
    });

    const { providerAccountId, accountName, initialFolders, custom } =
      await new Promise((resolve, reject) => {
        this.#pendingSetups.set(setupToken, { resolve, reject, windowId: win.id });
      });

    // `custom` — if present — seeds the new account's opaque provider blob
    // atomically with the host row creation. See protocol.mjs PROVIDER_CMD.
    const { accountId } = await this.registerAccount({
      setupToken,
      providerAccountId,
      accountName,
      initialFolders,
      custom,
    });

    // Give the subclass a chance to link providerAccountId ↔ accountId.
    await this.onRegisterSuccessful({
      accountId,
      providerAccountId,
      accountName,
    });

    return { accountId, accountName };
  }

  /** Called after registerAccount returns so a subclass can persist the
   *  providerAccountId ↔ accountId mapping or do any other post-register
   *  bookkeeping. Return value is discarded. */
  async onRegisterSuccessful(_args) { return null; }

  /** Open the config popup with `accountId`, optional `providerAccountId`,
   *  `readOnly`, and `mode` URL params. Resolves when the popup closes. */
  async onOpenConfigPopup(args) {
    if (!this.#configPath) throw this.#notImplemented("onOpenConfigPopup (no configPath)");
    const providerAccountId = await this.onResolveProviderAccountId(args.accountId);
    const url = new URL(browser.runtime.getURL(this.#configPath));
    url.searchParams.set("accountId", args.accountId);
    if (providerAccountId) url.searchParams.set("providerAccountId", providerAccountId);
    if (args.readOnly) url.searchParams.set("readOnly", "1");
    if (args.mode) url.searchParams.set("mode", args.mode);
    const win = await browser.windows.create({
      url: url.toString(),
      type: "popup",
      width: this.#configWidth,
      height: this.#configHeight,
    });
    await waitForWindowClose(win.id);
    return null;
  }

  /** Map host's accountId to the subclass's providerAccountId, or null. */
  async onResolveProviderAccountId(_tbsyncAccountId) { return null; }

  // ── Private: port + dispatch ────────────────────────────────────────────

  #attachPort() {
    browser.runtime.onConnectExternal.addListener(incoming => {
      if (incoming.sender?.id !== TBSYNC_ID) return;
      if (incoming.name !== PORT_NAME) return;
      if (this.#port) {
        try { this.#port.disconnect(); } catch { /* ignore */ }
      }
      this.#port = incoming;
      incoming.onMessage.addListener(msg => this.#onPortMessage(msg));
      incoming.onDisconnect.addListener(() => {
        if (this.#port === incoming) this.#port = null;
        this.#rejectAllPending(ERR.PORT_CLOSED, "host disconnected");
      });
      // Fire the subclass hook so startup work that needs the port
      // (provider→host reads via listAccounts/getAccount) runs at the
      // right moment. Warn-not-throw keeps a buggy subclass from poisoning
      // the fresh port.
      this.onConnectedToHost().catch(err =>
        console.warn(`${this.#logPrefix} onConnectedToHost failed:`, err)
      );
    });
  }

  /** Re-announce when the host probes us (after its own restart). */
  #attachProbeListener() {
    browser.runtime.onMessageExternal.addListener((msg, sender) => {
      if (sender?.id !== TBSYNC_ID) return;
      if (msg?.type !== DISCOVERY.PROBE) return;
      this.announce().catch(() => { });
      return Promise.resolve({ ok: true, providerId: browser.runtime.id });
    });
  }

  #onPortMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    // Response to a provider→host RPC.
    if (msg.requestId && (msg.ok === true || msg.ok === false) && !msg.cmd) {
      const entry = this.#pending.get(msg.requestId);
      if (!entry) return;
      this.#pending.delete(msg.requestId);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(msg.result);
      else entry.reject(withCode(
        new Error(msg.error ?? "host error"),
        msg.errorCode ?? ERR.UNKNOWN_COMMAND,
        msg.errorDetails ?? null
      ));
      return;
    }

    // Incoming host→provider RPC.
    if (msg.requestId && msg.cmd) {
      this.#dispatchHostCmd(msg);
    }
  }

  async #dispatchHostCmd(msg) {
    const activePort = this.#port;
    if (!activePort) return;
    try {
      const result = await this.#callHostCmdHandler(msg.cmd, msg.args ?? {});
      if (this.#port === activePort) {
        activePort.postMessage({ requestId: msg.requestId, ok: true, result: result ?? null });
      }
    } catch (err) {
      if (this.#port === activePort) {
        activePort.postMessage({
          requestId: msg.requestId,
          ok: false,
          error: err.message ?? "unknown error",
          errorCode: err.code ?? ERR.UNKNOWN_COMMAND,
          errorDetails: err.details ?? null,
        });
      }
    }
  }

  /** Map HOST_CMD to the on* hook. Adding a new command = one case here
   *  plus one override in the subclass. */
  #callHostCmdHandler(cmd, args) {
    switch (cmd) {
      case HOST_CMD.SYNC_ACCOUNT:             return this.onSyncAccount(args);
      case HOST_CMD.SYNC_FOLDER:              return this.onSyncFolder(args);
      case HOST_CMD.CANCEL_SYNC:              return this.onCancelSync(args);
      case HOST_CMD.OPEN_SETUP_POPUP:         return this.onOpenSetupPopup(args);
      case HOST_CMD.OPEN_CONFIG_POPUP:        return this.onOpenConfigPopup(args);
      case HOST_CMD.REAUTHENTICATE:           return this.onReauthenticate(args);
      case HOST_CMD.ACCOUNT_ENABLED:          return this.onAccountEnabled(args);
      case HOST_CMD.ACCOUNT_DISABLED:         return this.onAccountDisabled(args);
      case HOST_CMD.ACCOUNT_DELETED:          return this.onAccountDeleted(args);
      case HOST_CMD.FOLDER_ENABLED:           return this.onFolderEnabled(args);
      case HOST_CMD.FOLDER_DISABLED:          return this.onFolderDisabled(args);
      case HOST_CMD.GET_ACCOUNT_DISPLAY_INFO: return this.onGetAccountDisplayInfo(args);
      case HOST_CMD.GET_SORTED_FOLDERS:       return this.onGetSortedFolders(args);
      case HOST_CMD.SET_FOLDER_SELECTED:      return this.onSetFolderSelected(args);
      case HOST_CMD.SET_ACCOUNT_ENTRY:        return this.onSetAccountEntry(args);
      case HOST_CMD.IMPORT_LEGACY_DATA:       return this.onImportLegacyData(args);
      default:
        throw withCode(new Error(`Unknown command: ${cmd}`), ERR.UNKNOWN_COMMAND);
    }
  }

  #sendCmd(cmd, args = {}) {
    if (!this.#port) {
      return Promise.reject(withCode(new Error("host not connected"), ERR.PORT_CLOSED));
    }
    const requestId = `${this.#shortName}-request-${crypto.randomUUID()}`;
    const activePort = this.#port;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      if (!NO_TIMEOUT_CMDS.has(cmd)) {
        entry.timer = setTimeout(() => {
          this.#pending.delete(requestId);
          reject(withCode(new Error(`Timeout waiting for ${cmd}`), ERR.TIMEOUT));
        }, DEFAULT_RPC_TIMEOUT_MS);
      }
      this.#pending.set(requestId, entry);
      try {
        activePort.postMessage({ requestId, cmd, args });
      } catch (err) {
        this.#pending.delete(requestId);
        if (entry.timer) clearTimeout(entry.timer);
        reject(withCode(err, ERR.PORT_CLOSED));
      }
    });
  }

  #notify(type, payload = {}) {
    if (!this.#port) return;
    try {
      this.#port.postMessage({ type, payload });
    } catch { /* port races with disconnect; drop silently */ }
  }

  #rejectAllPending(code, message) {
    for (const [, entry] of this.#pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(withCode(new Error(message), code));
    }
    this.#pending.clear();
  }

  // ── Private: setup-popup completion & cancellation ──────────────────────

  #attachSetupCompletedListener() {
    browser.runtime.onMessage.addListener(msg => {
      if (msg?.type !== "tbsync-setup-completed") return;
      const entry = this.#pendingSetups.get(msg.setupToken);
      if (!entry) return;
      this.#pendingSetups.delete(msg.setupToken);
      entry.resolve({
        providerAccountId: msg.providerAccountId,
        accountName: msg.accountName,
        initialFolders: msg.initialFolders ?? [],
        custom: msg.custom ?? {},
      });
    });
  }

  /** Reject the pending setup promise when the window is closed. 500 ms
   *  grace period because the completion message races window.close(). */
  #attachSetupCancelListener() {
    browser.windows.onRemoved.addListener(winId => {
      for (const [token, entry] of this.#pendingSetups) {
        if (entry.windowId !== winId) continue;
        setTimeout(() => {
          const still = this.#pendingSetups.get(token);
          if (!still) return;
          this.#pendingSetups.delete(token);
          still.reject(Object.assign(new Error("setup cancelled"), { code: ERR.CANCELLED }));
        }, 500);
      }
    });
  }

  // ── Private: host-availability tracking ─────────────────────────────────

  /** Track host state in session storage. `management.*` events update it;
   *  a storage.onChanged observer kicks announce-with-retry on transition
   *  to true so every path funnels through one log site. */
  #watchHostAvailability() {
    browser.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== "session" || !changes[HOST_AVAILABLE_KEY]) return;
      if (changes[HOST_AVAILABLE_KEY].newValue !== true) return;
      if (this.#announceInFlight) return;
      this.#announceInFlight = true;
      try {
        await this.#announceWithRetry();
      } finally {
        this.#announceInFlight = false;
      }
    });

    const onHostEvent = (info, available) => {
      if (info.id !== TBSYNC_ID) return;
      console.log(`${this.#logPrefix} management event for host, available=${available}`);
      this.#setHostAvailable(available).catch(err =>
        console.warn(`${this.#logPrefix} setHostAvailable failed:`, err)
      );
    };
    browser.management.onInstalled.addListener(info => onHostEvent(info, info.enabled));
    browser.management.onEnabled.addListener(info => onHostEvent(info, true));
    browser.management.onDisabled.addListener(info => onHostEvent(info, false));
    browser.management.onUninstalled.addListener(info => onHostEvent(info, false));
  }

  async #primeHostAvailability() {
    const all = await browser.management.getAll();
    const host = all.find(a => a.id === TBSYNC_ID);
    const available = !!host?.enabled;
    console.log(`${this.#logPrefix} initial host state: ${available ? "available" : "absent"}`);
    await this.#setHostAvailable(available);
  }

  async #setHostAvailable(available) {
    await browser.storage.session.set({ [HOST_AVAILABLE_KEY]: !!available });
  }

  async #announceWithRetry() {
    for (let attempt = 1; attempt <= ANNOUNCE_MAX_ATTEMPTS; attempt++) {
      await new Promise(r =>
        setTimeout(r, attempt === 1 ? ANNOUNCE_INITIAL_DELAY_MS : ANNOUNCE_RETRY_DELAY_MS)
      );
      // Abort if the host flipped back off while we were waiting.
      const rv = await browser.storage.session.get({ [HOST_AVAILABLE_KEY]: false });
      if (!rv[HOST_AVAILABLE_KEY]) {
        console.log(`${this.#logPrefix} host went away during retry — stopping`);
        return;
      }
      console.log(`${this.#logPrefix} announcing (attempt ${attempt}/${ANNOUNCE_MAX_ATTEMPTS})`);
      const reply = await this.announce();
      if (reply) {
        console.log(`${this.#logPrefix} announce accepted by host`, reply);
        return;
      }
    }
    console.warn(`${this.#logPrefix} announce failed after all retries`);
  }

  // ── Private: helpers ────────────────────────────────────────────────────

  #notImplemented(which) {
    return withCode(
      new Error(`${which} not implemented by provider`),
      ERR.UNKNOWN_COMMAND
    );
  }
}

/** Resolve when `windows.onRemoved` fires for `windowId`. */
function waitForWindowClose(windowId) {
  return new Promise(resolve => {
    const listener = closedId => {
      if (closedId !== windowId) return;
      browser.windows.onRemoved.removeListener(listener);
      resolve();
    };
    browser.windows.onRemoved.addListener(listener);
  });
}
