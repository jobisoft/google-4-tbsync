import { CURRENT_SCHEMA_VERSION, KEYS, TBSYNC_ID } from "../shared/storage-keys.mjs";
import * as tbsync from "./tbsync-client.mjs";
import * as commands from "./command-handler.mjs";

/**
 * Provider entry point.
 *
 * Host-availability model (mirrors the quicktext community-scripts pattern):
 *
 *   1. A session-storage flag `host-available` holds the current host state.
 *   2. All four `management.*` events update that flag via setHostAvailable().
 *   3. A single `storage.onChanged` observer reacts when the flag transitions
 *      to true and calls tbsync.announce(). That's the only place announce()
 *      is called — so management events and the initial getAll() both funnel
 *      through one code path with one log line on failure.
 *   4. On startup we call `management.getAll()` to prime the flag; subsequent
 *      enable/disable events keep it in sync.
 */

const HOST_AVAILABLE_KEY = "host-available";

async function ensureSchema() {
  const rv = await browser.storage.local.get({ [KEYS.SCHEMA_VERSION]: 0 });
  if (rv[KEYS.SCHEMA_VERSION] !== CURRENT_SCHEMA_VERSION) {
    await browser.storage.local.set({ [KEYS.SCHEMA_VERSION]: CURRENT_SCHEMA_VERSION });
  }
}

async function setHostAvailable(available) {
  await browser.storage.session.set({ [HOST_AVAILABLE_KEY]: !!available });
}

let announceInFlight = false;

function watchHostAvailability() {
  // storage.session.set on an unchanged value is a no-op, so we only announce
  // on a genuine transition to available.
  browser.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== "session" || !changes[HOST_AVAILABLE_KEY]) return;
    if (changes[HOST_AVAILABLE_KEY].newValue !== true) return;
    if (announceInFlight) return;
    announceInFlight = true;
    try {
      await announceWithRetry();
    } finally {
      announceInFlight = false;
    }
  });

  const onHostEvent = (info, available) => {
    if (info.id !== TBSYNC_ID) return;
    console.log(`[google-4-tbsync] management event for host, available=${available}`);
    setHostAvailable(available).catch(err =>
      console.warn("[google-4-tbsync] setHostAvailable failed:", err));
  };
  browser.management.onInstalled.addListener(info => onHostEvent(info, info.enabled));
  browser.management.onEnabled.addListener(info => onHostEvent(info, true));
  browser.management.onDisabled.addListener(info => onHostEvent(info, false));
  browser.management.onUninstalled.addListener(info => onHostEvent(info, false));
}

/**
 * Announce to the host with retries. When the host transitions to available
 * via a `management.onInstalled`/`onEnabled` event, its background script is
 * usually still initializing and `runtime.onMessageExternal` may not be
 * attached yet, so the first sendMessage races with the host's own init.
 * 250 ms initial wait, then retry every 500 ms up to 10 times total.
 */
async function announceWithRetry() {
  const MAX_ATTEMPTS = 10;
  const INITIAL_DELAY_MS = 250;
  const RETRY_DELAY_MS = 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await new Promise(r => setTimeout(r, attempt === 1 ? INITIAL_DELAY_MS : RETRY_DELAY_MS));

    // Abort if the host flipped away while we were waiting.
    const rv = await browser.storage.session.get({ [HOST_AVAILABLE_KEY]: false });
    if (!rv[HOST_AVAILABLE_KEY]) {
      console.log("[google-4-tbsync] host went away during retry — stopping");
      return;
    }

    console.log(`[google-4-tbsync] announcing (attempt ${attempt}/${MAX_ATTEMPTS})`);
    const reply = await tbsync.announce();
    if (reply) {
      console.log("[google-4-tbsync] announce accepted by host", reply);
      return;
    }
  }
  console.warn("[google-4-tbsync] announce failed after all retries");
}

// Internal messages from our own UI pages (setup.html, config.html).
// Errors are returned as structured { ok:false, error, code } instead of being
// thrown, because runtime.sendMessage serialization drops Error.code and the
// setup page needs the code to distinguish E:CANCELLED from real failures.
browser.runtime.onMessage.addListener(async msg => {
  if (msg?.type === "google.authenticate") {
    try {
      const result = await commands.authenticateAndCreateAccount({
        label: msg.label,
        clientID: msg.clientID,
        clientSecret: msg.clientSecret,
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message ?? String(err), code: err.code ?? null };
    }
  }
  if (msg?.type === "google.getRedirectURL") {
    // Must match google/oauth.mjs#getRedirectURL — loopback form.
    const managed = new URL(browser.identity.getRedirectURL());
    const subdomain = managed.hostname.split(".")[0];
    return { redirectURL: `http://127.0.0.1/mozoauth2/${subdomain}` };
  }
  if (msg?.type === "google.getLastCredentials") {
    // Pre-populate the setup popup from the most-recently-created account.
    // No new storage — we just read the existing account records.
    const rv = await browser.storage.local.get({ [KEYS.ACCOUNTS]: {} });
    const last = Object.values(rv[KEYS.ACCOUNTS])
      .filter(a => a.clientID && a.clientSecret)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
    return last
      ? { clientID: last.clientID, clientSecret: last.clientSecret }
      : null;
  }
  return undefined;
});

await ensureSchema();
tbsync.init();
commands.init();
watchHostAvailability();

// Prime the host-available flag from current state. Inlined (instead of a
// named helper) to avoid a TS-analyzer false-positive "declared but never
// read" hint on module-level async helpers that are only called once.
try {
  const all = await browser.management.getAll();
  const host = all.find(a => a.id === TBSYNC_ID);
  const available = !!host?.enabled;
  console.log(`[google-4-tbsync] initial host state: ${available ? "available" : "absent"}`);
  await setHostAvailable(available);
} catch (err) {
  console.warn("[google-4-tbsync] management.getAll() failed at startup:", err);
}
