import { CURRENT_SCHEMA_VERSION, KEYS, TBSYNC_ID } from "../shared/storage-keys.mjs";
import * as tbsync from "./tbsync-client.mjs";
import * as commands from "./command-handler.mjs";

/**
 * Provider entry point.
 *
 * Boot order:
 *   1. Ensure schema version / default settings in storage.local.
 *   2. Install tbsync-client listeners (onConnectExternal, onMessageExternal)
 *      BEFORE we announce, so an incoming port from the host on our heels
 *      lands on the listener.
 *   3. Wire the command handlers.
 *   4. Subscribe to management events so we announce/unannounce as the host
 *      add-on goes in and out of existence at runtime.
 *   5. If TbSync is already installed+enabled, announce right away.
 */

async function ensureSchema() {
  const rv = await browser.storage.local.get({ [KEYS.SCHEMA_VERSION]: 0 });
  if (rv[KEYS.SCHEMA_VERSION] !== CURRENT_SCHEMA_VERSION) {
    await browser.storage.local.set({ [KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION });
  }
}

async function isHostAvailable() {
  try {
    const info = await browser.management.get(TBSYNC_ID);
    return info?.enabled === true;
  } catch {
    return false;
  }
}

function watchHostAvailability() {
  browser.management.onInstalled.addListener(info => {
    if (info.id === TBSYNC_ID && info.enabled) tbsync.announce().catch(() => { });
  });
  browser.management.onEnabled.addListener(info => {
    if (info.id === TBSYNC_ID) tbsync.announce().catch(() => { });
  });
  // Disabled/uninstalled: the host will drop the port on its side and our
  // onDisconnect handler clears local state. Nothing to do here.
}

// Expose the M1 stub-account helper to setup.html via runtime.sendMessage.
// (The setup page is in our own extension, so internal messages suffice.)
browser.runtime.onMessage.addListener(async msg => {
  if (msg?.type !== "google.createStubAccount") return undefined;
  return commands.createStubAccount({ accountName: msg.accountName });
});

await ensureSchema();
tbsync.init();
commands.init();
watchHostAvailability();
if (await isHostAvailable()) {
  tbsync.announce().catch(err => console.warn("[google-4-tbsync] announce failed:", err));
}
