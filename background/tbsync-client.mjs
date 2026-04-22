import {
  DISCOVERY, ERR, NO_TIMEOUT_CMDS,
  PORT_NAME, PROTOCOL_VERSION,
  PROVIDER_CMD, PROVIDER_NOTIFY,
} from "../shared/protocol.mjs";
import { requestId as genRequestId } from "../shared/ids.mjs";
import { TBSYNC_ID } from "../shared/storage-keys.mjs";

/**
 * The provider's single connection to TbSync.
 *
 * Model: TbSync always *initiates* the port connection after receiving our
 * announce. We accept incoming ports named PORT_NAME from TBSYNC_ID only.
 * Outbound RPCs and notifications go through the currently-held port; if none
 * exists they fail fast with E:PORT_CLOSED and the caller can decide whether
 * to retry.
 */

let port = null;
const pending = new Map();      // requestId -> { resolve, reject, timer }
const hostRpcHandlers = new Map();

/** Register a handler for incoming host→provider RPCs. */
export function setHostCmdHandler(cmd, fn) {
  hostRpcHandlers.set(cmd, fn);
}

/** True while a TbSync port is open. */
export function isConnected() {
  return port !== null;
}

/** Announce this provider to TbSync. Call on startup and when TbSync is
 *  installed/enabled at runtime. Returns the handshake reply, or null if
 *  TbSync did not respond or accept us. */
export async function announce() {
  const manifest = browser.runtime.getManifest();
  const payload = {
    type: DISCOVERY.ANNOUNCE,
    protocolVersion: PROTOCOL_VERSION,
    providerId: browser.runtime.id,
    providerName: manifest.name,
    providerVersion: manifest.version,
    icons: manifest.icons ?? {},
    capabilities: {
      folderTypes: ["contacts"],
      supportsReadOnly: true,
      multipleAccounts: true,
      hasSetupPopup: true,
      hasConfigPopup: true,
    },
    maintainerEmail: "info@marcozanon.com",
    contributorsUrl: "https://github.com/jobisoft/google-4-tbsync",
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
  };

  try {
    const reply = await browser.runtime.sendMessage(TBSYNC_ID, payload);
    if (!reply?.ok) {
      console.warn("[google-4-tbsync] announce rejected:", reply);
      return null;
    }
    return reply;
  } catch (err) {
    // tbsync-new not installed, not enabled, or not listening yet.
    console.debug("[google-4-tbsync] announce failed:", err.message);
    return null;
  }
}

/** Unannounce (best-effort) before the provider is disabled. */
export async function unannounce() {
  try {
    await browser.runtime.sendMessage(TBSYNC_ID, {
      type: DISCOVERY.UNANNOUNCE,
      providerId: browser.runtime.id,
    });
  } catch { /* host already gone */ }
}

/** Attach runtime listeners. Call once from background.mjs. */
export function init() {
  browser.runtime.onConnectExternal.addListener(incoming => {
    if (incoming.sender?.id !== TBSYNC_ID) return;
    if (incoming.name !== PORT_NAME) return;
    // If a previous port is still lingering, drop it.
    if (port) {
      try { port.disconnect(); } catch { /* ignore */ }
    }
    port = incoming;
    incoming.onMessage.addListener(msg => handleIncoming(msg));
    incoming.onDisconnect.addListener(() => {
      if (port === incoming) port = null;
      rejectAllPending(ERR.PORT_CLOSED, "host disconnected");
    });
  });

  // Probes the host sends after restart — mirror the announce.
  browser.runtime.onMessageExternal.addListener((msg, sender) => {
    if (sender?.id !== TBSYNC_ID) return;
    if (msg?.type !== DISCOVERY.PROBE) return;
    // The host expects an announce-ish reply; re-send via a fresh announce.
    announce().catch(() => { });
    return Promise.resolve({ ok: true, providerId: browser.runtime.id });
  });
}

// ── Outbound: RPC provider → host ─────────────────────────────────────────

export function sendCmd(cmd, args = {}) {
  if (!port) {
    return Promise.reject(withCode(new Error("host not connected"), ERR.PORT_CLOSED));
  }
  const requestId = genRequestId();
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null };
    if (!NO_TIMEOUT_CMDS.has(cmd)) {
      entry.timer = setTimeout(() => {
        pending.delete(requestId);
        reject(withCode(new Error(`Timeout waiting for ${cmd}`), ERR.TIMEOUT));
      }, 30_000);
    }
    pending.set(requestId, entry);
    try {
      port.postMessage({ requestId, cmd, args });
    } catch (err) {
      pending.delete(requestId);
      if (entry.timer) clearTimeout(entry.timer);
      reject(withCode(err, ERR.PORT_CLOSED));
    }
  });
}

/** Outbound: notification provider → host (no response). */
export function notify(type, payload = {}) {
  if (!port) return;
  try {
    port.postMessage({ type, payload });
  } catch { /* port races with disconnect; drop silently */ }
}

// Convenience wrappers.
export const registerAccount = args => sendCmd(PROVIDER_CMD.REGISTER_ACCOUNT, args);
export const updateAccount   = args => sendCmd(PROVIDER_CMD.UPDATE_ACCOUNT,   args);
export const pushFolderList  = args => sendCmd(PROVIDER_CMD.PUSH_FOLDER_LIST, args);

export const reportSyncState = payload => notify(PROVIDER_NOTIFY.REPORT_SYNC_STATE, payload);
export const reportProgress  = payload => notify(PROVIDER_NOTIFY.REPORT_PROGRESS,   payload);
export const reportEventLog  = payload => notify(PROVIDER_NOTIFY.REPORT_EVENT_LOG,  payload);
export const reportStatus    = payload => notify(PROVIDER_NOTIFY.REPORT_STATUS,     payload);

// ── Incoming handling ─────────────────────────────────────────────────────

function handleIncoming(msg) {
  if (!msg || typeof msg !== "object") return;

  // Response to a provider→host RPC.
  if (msg.requestId && (msg.ok === true || msg.ok === false) && !msg.cmd) {
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    if (entry.timer) clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(withCode(new Error(msg.error ?? "host error"), msg.errorCode ?? ERR.UNKNOWN_COMMAND, msg.errorDetails ?? null));
    return;
  }

  // Incoming host→provider RPC.
  if (msg.requestId && msg.cmd) {
    handleHostRpc(msg);
    return;
  }
}

async function handleHostRpc(msg) {
  const activePort = port;
  if (!activePort) return;
  const fn = hostRpcHandlers.get(msg.cmd);
  try {
    if (!fn) throw withCode(new Error(`Unknown command: ${msg.cmd}`), ERR.UNKNOWN_COMMAND);
    const result = await fn(msg.args ?? {});
    if (port === activePort) {
      activePort.postMessage({ requestId: msg.requestId, ok: true, result: result ?? null });
    }
  } catch (err) {
    if (port === activePort) {
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

function rejectAllPending(code, message) {
  for (const [rid, entry] of pending) {
    pending.delete(rid);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(withCode(new Error(message), code));
  }
}

function withCode(err, code, details = null) {
  if (!err.code) err.code = code;
  if (details != null && !err.details) err.details = details;
  return err;
}
