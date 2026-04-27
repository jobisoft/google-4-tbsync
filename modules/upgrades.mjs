/**
 * Provider-local one-shot upgrades.
 *
 * Runs work that has to happen exactly once after the user updates the
 * provider across a "split version" - typically a one-time data-shape
 * migration that the host's legacy migration deliberately couldn't do
 * because it's provider-specific.
 *
 * The trigger is `runtime.onInstalled` (with `reason === "update"` and a
 * `previousVersion` set), wired up in [background.mjs](../background.mjs).
 * Fresh installs never fire any upgrade. The list of pending upgrade IDs
 * persists in `browser.storage.local` under UPGRADE_QUEUE_KEY so a
 * partial run (host crash, network outage) is retried on the next
 * host-connect via the boot-time stale drain.
 *
 * While a drain is in flight, the host treats every account belonging
 * to this provider as "upgrading" - refuses every user-initiated RPC
 * and skips autosync ticks. The lock is acquired before the first
 * upgrade body runs and released in a `finally` so a crashing upgrade
 * still releases it.
 */

import * as addressBook from "./address-book.mjs";
import * as mapper from "./google/contact-mapper.mjs";
import { stringifyError } from "./errors.mjs";
import * as oauth from "./google/oauth.mjs";

const UPGRADE_QUEUE_KEY = "google.upgradeQueue";
const STATUS_MODIFIED_BY_SERVER = "modified_by_server";

/** Ordered list of split versions. An upgrade is *applicable* to an
 *  `(previousVersion, currentVersion)` pair iff
 *  `previousVersion < splitVersion <= currentVersion`. Strict on the
 *  prev side so a user already on the split doesn't re-run; inclusive
 *  on the cur side so installing exactly at the split triggers it. */
export const UPGRADES = [
  {
    splitVersion: "0.9.5",
    id: "google.lift-legacy-stamps-and-backfill-email",
    run: async (provider) => {
      await liftLegacyStamps(provider);
      await liftLegacyGroupStamps(provider);
      await backfillAuthenticatedUserEmail(provider);
      await mirrorReadOnlyModeToFolders(provider);
    },
  },
];

/** Dotted-decimal version comparison. Sufficient for the version
 *  strings the providers ship (`"0.9.0"`, `"2.0.0"`); pre-release tags
 *  out of scope. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

let inFlight = null;

/** Drain `google.upgradeQueue` against the UPGRADES table. Idempotent
 *  (each upgrade body is itself idempotent) and self-coalescing - a
 *  second caller while the first is mid-flight just awaits the same
 *  Promise.
 *
 *  The host upgrade lock is acquired before any upgrade body runs and
 *  released in `finally`, so:
 *    - User-initiated RPCs against this provider's accounts are refused
 *      while the drain is running.
 *    - Autosync ticks skip those accounts.
 *    - A throw inside an upgrade still releases the lock; the failed
 *      upgrade ID stays in the queue and is retried next boot. */
export function runUpgrades(provider) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const rv = await browser.storage.local.get({ [UPGRADE_QUEUE_KEY]: [] });
    const queue = rv[UPGRADE_QUEUE_KEY];
    if (!queue.length) return;

    let lockAcquired = false;
    try {
      await provider.setProviderUpgradeLock(true);
      lockAcquired = true;
      provider.reportEventLog({
        level: "debug",
        message: `[upgrade] entering upgrade mode - sync and account/resource modifications are paused (${queue.length} upgrade(s) pending)`,
      });

      const remaining = [];
      for (const id of queue) {
        const upgrade = UPGRADES.find(u => u.id === id);
        if (!upgrade) continue;  // unknown id - silently drop
        try {
          provider.reportEventLog({ level: "debug", message: `[upgrade] ${id} starting` });
          await upgrade.run(provider);
          provider.reportEventLog({ level: "debug", message: `[upgrade] ${id} done` });
        } catch (err) {
          provider.reportEventLog({
            level: "error",
            message: `[upgrade] ${id} failed: ${stringifyError(err)}`,
          });
          remaining.push(id);
        }
      }

      await browser.storage.local.set({ [UPGRADE_QUEUE_KEY]: remaining });
    } finally {
      if (lockAcquired) {
        await provider.setProviderUpgradeLock(false).catch(err =>
          console.warn("[google-4-tbsync] failed to release upgrade lock:", stringifyError(err))
        );
        provider.reportEventLog({
          level: "debug",
          message: `[upgrade] exiting upgrade mode - sync and account/resource modifications re-enabled`,
        });
      }
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Compute the set of upgrades triggered by an update transition and
 *  merge their IDs into the persistent queue. No-op when nothing
 *  applies. Returns the new queue length. */
export async function enqueueUpgradesForUpdate(previousVersion, currentVersion) {
  const triggered = UPGRADES
    .filter(u =>
      compareVersions(previousVersion, u.splitVersion) < 0
      && compareVersions(u.splitVersion, currentVersion) <= 0
    )
    .map(u => u.id);
  if (!triggered.length) return 0;
  const rv = await browser.storage.local.get({ [UPGRADE_QUEUE_KEY]: [] });
  const next = Array.from(new Set([...rv[UPGRADE_QUEUE_KEY], ...triggered]));
  await browser.storage.local.set({ [UPGRADE_QUEUE_KEY]: next });
  return next.length;
}

// ── Upgrade bodies ───────────────────────────────────────────────────────

/** Lift legacy `X-GOOGLE-RESOURCENAME` / `X-GOOGLE-ETAG` from each
 *  card's nsIAbCard userProperty bag onto the vCard. Idempotent (skips
 *  cards already showing the right identity in their vCard). Each
 *  update is pre-tagged with `markServerWrite("modified_by_server")` so
 *  the host's changelog watcher classifies the upcoming AB onModified
 *  event as self-inflicted and drops it - no `_by_user` entry, no
 *  spurious "needs sync" state. */
async function liftLegacyStamps(provider) {
  const accounts = await provider.listAccounts();
  for (const acc of accounts) {
    const rv = await provider.getAccount(acc.accountId);
    const folders = rv?.folders ?? [];
    for (const folder of folders) {
      if (!folder.targetID) continue;
      let stamps;
      try {
        stamps = await browser.LegacyAbProperties.readGoogleStamps(folder.targetID);
      } catch (err) {
        provider.reportEventLog({
          level: "warning",
          accountId: acc.accountId, folderId: folder.folderId,
          message: `[upgrade] readGoogleStamps failed: ${stringifyError(err)}`,
        });
        continue;
      }
      if (!stamps.length) continue;

      let lifted = 0;
      for (const { contactId, resourceName, etag } of stamps) {
        const card = await addressBook.getContact(contactId);
        if (!card?.vCard) continue;
        if (mapper.readIdentity(card.vCard)?.resourceName === resourceName) continue;
        await provider.changelogMarkServerWrite({
          accountId: acc.accountId,
          folderId: folder.folderId,
          parentId: folder.targetID,
          itemId: contactId,
          status: STATUS_MODIFIED_BY_SERVER,
        });
        const stampedVCard = mapper.stampIdentity(card.vCard, { resourceName, etag });
        await addressBook.updateContact(contactId, stampedVCard);
        lifted++;
      }
      provider.reportEventLog({
        level: "debug",
        accountId: acc.accountId, folderId: folder.folderId,
        message: `[upgrade] lifted ${lifted}/${stamps.length} legacy X-GOOGLE-RESOURCENAME stamp(s) onto vCards`,
      });
    }
  }
}

/** Mailing-list parallel of `liftLegacyStamps`. Legacy stamped each
 *  mailing list with `X-GOOGLE-RESOURCENAME` / `X-GOOGLE-ETAG` via the
 *  same `setProperty()` API it used for contacts, but the new sync
 *  layer keeps the server-resourceName → local-listId mapping in
 *  `folder.custom.groupMap` rather than reading it back off the
 *  mailing-list cards. Without this lift, the first sync after a
 *  migration creates a fresh duplicate of every group.
 *
 *  `groupType` is intentionally left undefined on lifted entries -
 *  the next pull pass overlays the correct value from the server. */
async function liftLegacyGroupStamps(provider) {
  const accounts = await provider.listAccounts();
  for (const acc of accounts) {
    const rv = await provider.getAccount(acc.accountId);
    const folders = rv?.folders ?? [];
    for (const folder of folders) {
      if (!folder.targetID) continue;
      const incoming = Array.isArray(folder.changelog) ? folder.changelog : [];

      // Legacy stored mailing-list X-GOOGLE-* in TbSync's changelog DB
      // (mailing lists can't carry properties of their own). The
      // migration carried those rows into folder.changelog because
      // parentId starts with folder.targetID. Each row has:
      //   parentId: <bookUID>#<listUID>
      //   itemId:   "X-GOOGLE-RESOURCENAME" | "X-GOOGLE-ETAG"
      //   status:   the actual value
      // Group by parentId (two halves per list), build groupMap entries,
      // and drop the consumed rows from the changelog.
      const RESOURCENAME = "X-GOOGLE-RESOURCENAME";
      const ETAG = "X-GOOGLE-ETAG";
      const byParent = new Map();
      const consumed = [];
      for (const e of incoming) {
        if (e?.itemId !== RESOURCENAME && e?.itemId !== ETAG) continue;
        if (typeof e.parentId !== "string" || !e.parentId.includes("#")) continue;
        let bag = byParent.get(e.parentId);
        if (!bag) { bag = {}; byParent.set(e.parentId, bag); }
        if (e.itemId === RESOURCENAME) bag.resourceName = e.status;
        else                            bag.etag         = e.status;
        consumed.push({ parentId: e.parentId, itemId: e.itemId });
      }
      if (!byParent.size) continue;

      const existing = folder.custom.groupMap ?? {};
      const groupMap = { ...existing };
      let lifted = 0;
      for (const [parentId, { resourceName, etag }] of byParent) {
        if (!resourceName) continue;
        const mailingListId = parentId.split("#", 2)[1];
        if (!mailingListId) continue;
        if (groupMap[resourceName]?.mailingListId === mailingListId) continue;
        groupMap[resourceName] = { mailingListId, etag: etag ?? null };
        lifted++;
      }

      if (lifted) {
        await provider.updateFolder({
          accountId: acc.accountId,
          folderId: folder.folderId,
          patch: { custom: { groupMap } },
        });
      }

      // Drop the consumed legacy entries from the host-owned changelog
      // regardless of whether each pair produced a groupMap entry -
      // they're never useful to the new sync code.
      for (const { parentId, itemId } of consumed) {
        await provider.changelogRemove({
          accountId: acc.accountId,
          folderId: folder.folderId,
          parentId,
          itemId,
        });
      }

      provider.reportEventLog({
        level: "debug",
        accountId: acc.accountId, folderId: folder.folderId,
        message: `[upgrade] lifted ${lifted}/${byParent.size} legacy mailing-list stamp(s) into folder.custom.groupMap (${consumed.length} legacy entries removed from folder.changelog)`,
      });
    }
  }
}

/** Push `account.custom.readOnlyMode` down onto every folder's
 *  `readOnly` flag. The Google provider treats `readOnlyMode` as the
 *  account-level source of truth and mirrors it onto each folder
 *  whenever the user toggles the checkbox in the config popup
 *  (`saveAccountFromConfig`). Migrated accounts arrive carrying
 *  `readOnlyMode` in `account.custom` but with folder-level `readOnly`
 *  set only from the legacy per-folder `downloadonly` field - so the
 *  manager's resource list shows pencils when it should show locks.
 *  Idempotent: only writes when the folder's value differs from the
 *  desired one. */
async function mirrorReadOnlyModeToFolders(provider) {
  const accounts = await provider.listAccounts();
  for (const acc of accounts) {
    const desired = !!acc.custom.readOnlyMode;
    const rv = await provider.getAccount(acc.accountId);
    const folders = rv?.folders ?? [];
    for (const folder of folders) {
      if (!!folder.readOnly === desired) continue;
      await provider.updateFolder({
        accountId: acc.accountId,
        folderId: folder.folderId,
        patch: { readOnly: desired },
      });
    }
  }
}

/** Backfill `account.custom.authenticatedUserEmail` for every account
 *  that has working OAuth credentials but no email on file (legacy
 *  never persisted it). Idempotent - early-returns on each account
 *  that already has the field set. */
async function backfillAuthenticatedUserEmail(provider) {
  const accounts = await provider.listAccounts();
  for (const acc of accounts) {
    if (acc.custom.authenticatedUserEmail) continue;
    if (!acc.custom.clientID || !acc.custom.clientSecret || !acc.custom.refreshToken) continue;
    oauth.primeAuth(acc.accountId, {
      clientID: acc.custom.clientID,
      clientSecret: acc.custom.clientSecret,
      refreshToken: acc.custom.refreshToken,
    });
    try {
      const accessToken = await oauth.getAccessToken(acc.accountId);
      const email = await oauth.fetchUserEmail(accessToken);
      if (email) {
        await provider.updateAccount({
          accountId: acc.accountId,
          patch: { custom: { authenticatedUserEmail: email } },
        });
      }
    } catch (err) {
      provider.reportEventLog({
        level: "warning",
        accountId: acc.accountId,
        message: `[upgrade] backfill authenticatedUserEmail failed: ${stringifyError(err)}`,
      });
    }
  }
}
