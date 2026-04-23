/**
 * Base class for TbSync provider add-ons.
 *
 * Owns the boring plumbing that every provider needs:
 *   - Announce handshake (runtime.onMessageExternal + runtime.sendMessage)
 *   - Port lifecycle (runtime.onConnectExternal) + RPC envelope dispatch
 *   - Host-availability tracking + announce-with-retry on host enable
 *   - Setup popup windowing + setupToken round-trip + window-close cancel
 *   - Config popup windowing (fire-and-forget)
 *   - Outbound RPC wrappers (registerAccount / updateAccount / pushFolderList)
 *   - Outbound notifications (reportSyncState / reportProgress / …)
 *
 * Provider-specific logic lives in the subclass, which overrides the `on*`
 * virtual hook methods (one per HOST_CMD.*). Required overrides throw
 * `E:UNKNOWN_COMMAND` by default; safe-no-op hooks return `null`.
 *
 * Startup is a single line: `new MyProvider(options); provider.init();`.
 *
 * The wire protocol is unchanged from the hand-wired implementation that
 * preceded this class (see `./protocol.mjs`). This file is a structural
 * refactor only — every byte on the port looks identical.
 *
 * Modelled on webext-support's VfsProviderImplementation:
 * /home/john/Documents/GitHub/webext-support/modules/vfs-toolkit/vfs-provider/vfs-provider.mjs
 */

import {
  DISCOVERY, ERR, HOST_CMD, NO_TIMEOUT_CMDS,
  PORT_NAME, PROTOCOL_VERSION,
  PROVIDER_CMD, PROVIDER_NOTIFY, withCode,
} from "./protocol.mjs";

/**
 * Extension id of the TbSync host — the other end of the port. Exported so
 * provider-side code that needs to address the host directly (e.g. for
 * out-of-band runtime.sendMessage traffic during discovery) can import it
 * from the same place it gets the base class.
 */
export const TBSYNC_ID = "tbsync@jobisoft.de";


const DEFAULT_SETUP_WIDTH = 520;
const DEFAULT_SETUP_HEIGHT = 640;
const DEFAULT_CONFIG_WIDTH = 520;
const DEFAULT_CONFIG_HEIGHT = 580;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

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
    // Short provider id, used as the prefix for outbound RPC-correlation
    // tokens so log lines from different providers are telleable apart.
    // Falls back to the extension id if the subclass doesn't set one.
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

  /**
   * Wire up every listener this provider needs. Idempotent-ish: calling
   * `init()` twice will double-register, so don't. Call once from the
   * background script after constructing the subclass.
   */
  init() {
    this.#attachPort();
    this.#attachProbeListener();
    this.#attachSetupCompletedListener();
    this.#attachSetupCancelListener();
    this.#watchHostAvailability();
    // Prime the host-availability flag from current state. Fire-and-forget;
    // announce will happen via the storage-onChanged listener if host is on.
    this.#primeHostAvailability().catch(err =>
      console.warn(`${this.#logPrefix} management.getAll() failed at startup:`, err)
    );
  }

  // ── Outbound: handshake ─────────────────────────────────────────────────

  /** Build and send an announce to TbSync. Returns the handshake reply, or
   *  null if the host didn't respond or rejected us. */
  async announce() {
    const manifest = browser.runtime.getManifest();
    const payload = {
      type: DISCOVERY.ANNOUNCE,
      protocolVersion: PROTOCOL_VERSION,
      providerId: browser.runtime.id,
      providerName: this.#name,
      providerVersion: manifest.version,
      icons: this.#icons,
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
      // Host not listening yet — caller's retry loop logs the outcome.
      return null;
    }
  }

  /** Best-effort unannounce before being disabled ourselves. */
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
  pushFolderList(args)  { return this.#sendCmd(PROVIDER_CMD.PUSH_FOLDER_LIST, args); }

  // ── Outbound: notifications ─────────────────────────────────────────────

  reportSyncState(payload)    { this.#notify(PROVIDER_NOTIFY.REPORT_SYNC_STATE, payload); }
  reportProgress(payload)     { this.#notify(PROVIDER_NOTIFY.REPORT_PROGRESS,   payload); }
  reportEventLog(payload)     { this.#notify(PROVIDER_NOTIFY.REPORT_EVENT_LOG,  payload); }
  reportStatus(payload)       { this.#notify(PROVIDER_NOTIFY.REPORT_STATUS,     payload); }
  requestOpenManager(payload) { this.#notify(PROVIDER_NOTIFY.REQUEST_OPEN_MANAGER, payload); }

  // ── Virtual hooks — subclass overrides ──────────────────────────────────

  /** Sync a whole account. Host calls this before walking selected folders. */
  async onSyncAccount(_args)           { throw this.#notImplemented("onSyncAccount"); }
  /** Sync one folder. Host calls this per selected folder after onSyncAccount. */
  async onSyncFolder(_args)            { throw this.#notImplemented("onSyncFolder"); }
  /** Cooperative cancellation for an in-flight sync. Safe default: no-op. */
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

  /**
   * Setup popup. Base implementation opens `setupPath` as a popup window,
   * waits for the in-extension `tbsync-setup-completed` message carrying the
   * freshly-minted account, forwards that via PROVIDER_CMD.REGISTER_ACCOUNT,
   * and returns `{accountId, accountName, accountEntries}` to the host.
   * Override only if the subclass needs to transform accountEntries or do
   * work beyond register; the common case is to leave it alone.
   */
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

    const { providerAccountId, accountName, initialFolders, accountEntries } =
      await new Promise((resolve, reject) => {
        this.#pendingSetups.set(setupToken, { resolve, reject, windowId: win.id });
      });

    const { accountId } = await this.registerAccount({
      setupToken,
      providerAccountId,
      accountName,
      initialFolders,
    });

    // Give the subclass a chance to link providerAccountId ↔ accountId and
    // surface sanitized account entries back to the host.
    const finalEntries = await this.onRegisterSuccessful({
      accountId,
      providerAccountId,
      accountName,
      accountEntries: accountEntries ?? {},
    });

    return {
      accountId,
      accountName,
      accountEntries: finalEntries ?? accountEntries ?? {},
    };
  }

  /** Called after registerAccount returns from the host. Subclass should
   *  persist the providerAccountId ↔ accountId mapping and may return a
   *  sanitized accountEntries object. Default: pass-through. */
  async onRegisterSuccessful({ accountEntries }) { return accountEntries ?? {}; }

  /**
   * Config popup. Base implementation opens `configPath` with `accountId`,
   * `providerAccountId` (if the subclass supplies it via `onResolveProviderAccountId`),
   * and optional `readOnly` / `mode` URL params, fire-and-forget. Override
   * for custom popups.
   */
  async onOpenConfigPopup(args) {
    if (!this.#configPath) throw this.#notImplemented("onOpenConfigPopup (no configPath)");
    const providerAccountId = await this.onResolveProviderAccountId(args.accountId);
    const url = new URL(browser.runtime.getURL(this.#configPath));
    url.searchParams.set("accountId", args.accountId);
    if (providerAccountId) url.searchParams.set("providerAccountId", providerAccountId);
    if (args.readOnly) url.searchParams.set("readOnly", "1");
    if (args.mode) url.searchParams.set("mode", args.mode);
    await browser.windows.create({
      url: url.toString(),
      type: "popup",
      width: this.#configWidth,
      height: this.#configHeight,
    });
    return null;
  }

  /** Subclass hook: map host's accountId to the subclass-owned
   *  providerAccountId. Default returns null (no mapping surfaced to the popup). */
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
    });
  }

  /** Respond to DISCOVERY.PROBE messages the host sends after its own
   *  restart to re-establish the port. We re-announce and return a short
   *  acknowledgement. */
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

    // Response to a provider→host RPC we initiated.
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

    // Incoming host→provider RPC we must dispatch.
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

  /** Big switch mapping the wire-protocol command name to the on* hook.
   *  Keeping every HOST_CMD value in one place here means adding a new
   *  command just requires adding a line here and an on* override. */
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
    // Opaque RPC-correlation token; the host just echoes it back on the
    // response. Prefixing with the provider's shortName keeps log lines
    // distinguishable when multiple providers are running.
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
        accountEntries: msg.accountEntries ?? {},
      });
    });
  }

  /** If the user closes the setup window without completing, reject the
   *  pending promise. The 500 ms grace period is there because "setup
   *  completed → window.close()" races: the completion message may still
   *  arrive after onRemoved fires. */
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

  /**
   * Model: a session-storage boolean `host-available` holds the current host
   * state. `management.*` events update it; a storage.onChanged observer
   * reacts to transitions to `true` by kicking announce-with-retry. That
   * single observer is the only place announce() is called so every code
   * path (startup / install / enable) funnels through one log site.
   */
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
