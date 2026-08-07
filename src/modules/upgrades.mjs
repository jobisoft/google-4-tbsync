/**
 * Provider-side completion of the host's legacy import.
 *
 * TbSync's importer lifts the host-owned fields out of the legacy
 * `<profile>/TbSync/*.json` files but copies every provider field into
 * `account.custom` verbatim. The legacy add-on
 * (github.com/zanonmark/Google-4-TbSync) stored its accounts through
 * TbSync, so an imported account arrives with `clientID`, `clientSecret`,
 * `includeSystemContactGroups`, `readOnlyMode` and `refreshToken` in the
 * shape that add-on wrote, no `authenticatedUserEmail` (it never persisted
 * one), and cards whose Google identity lives in the nsIAbCard property
 * bag rather than in the vCard. Converting all of that is this module's
 * job.
 *
 * Two triggers, one per kind of data, on the principle that the record of
 * a conversion belongs with the data it converted:
 *
 *   - Account `custom` and the Thunderbird resources bound to it live in
 *     the host and in the address book. Their trigger is the host's
 *     `legacyMigrationPending` flag, which the host re-sets every time it
 *     re-imports - the only durable signal, since nothing about this
 *     add-on's own install history says anything about what the host did.
 *   - This add-on's own global settings live in `storage.local`. Their
 *     trigger is `schemaVersion` in that same storage, so marker and data
 *     are wiped together and can never disagree.
 *
 * The host blocks flagged accounts until we clear them, and an account
 * whose conversion throws keeps its flag and is tried again next boot - so
 * every step below has to be idempotent.
 */

import * as addressBook from "./address-book.mjs";
import * as mapper from "./google/contact-mapper.mjs";
import { stringifyError } from "./errors.mjs";
import * as oauth from "./google/oauth.mjs";

const STATUS_MODIFIED_BY_SERVER = "modified_by_server";

/* ── Provider-local storage schema ──────────────────────────────────── */

const SCHEMA_KEY = "schemaVersion";

/** Shape of this add-on's own `storage.local`. Independent of the add-on
 *  version - ship releases freely and bump this only when the stored shape
 *  actually changes. Also independent of any other provider's number: a
 *  `2` here and a `2` in EAS-4-TbSync describe different storages and must
 *  never be compared. */
const SCHEMA_VERSION = 3;

/** Steps that raise storage from the previous version to the keyed one,
 *  applied in ascending order. `name` appears in the event log so a
 *  support log shows the sequence rather than only its side effects. A
 *  rung with no `run` is legal and just bumps the number. */
const MIGRATIONS = {
  2: { name: "lift-legacy-prefs", run: liftLegacyPrefs },
  3: { name: "repair-unconverted-accounts", run: repairUnconvertedAccounts },
};

/** The legacy add-on's single global pref, and where it lands.
 *
 *  Units are unreliable and deliberately not corrected here. The legacy
 *  TbSync hook this fed - `getConnectionTimeout` - documented milliseconds,
 *  and legacy EAS returned `90000` from the same hook, but legacy Google
 *  registered a default of `50`. Anything read back therefore needs a
 *  sanity check before use; guessing at a x1000 correction would be
 *  inventing intent. Nothing in this add-on consumes it today - it is
 *  carried so the setting is not silently lost if a timeout knob returns.
 *
 *  Only prefs with a user-set value are lifted (`getUserPref` ignores
 *  registered defaults), so the nonsensical default never propagates. */
const PREF_MIGRATIONS = [
  {
    keys: {
      "extensions.google-4-tbsync.timeout": "timeout",
    },
    validate: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
    transform: (v) => v,
    logValue: (v) => ` (${v})`,
  },
];

let inFlight = null;

/** Bring this installation up to date, in one pass under one upgrade lock:
 *  the storage schema ladder, then the accounts the host flagged.
 *
 *  Self-coalescing - a second caller while the first is mid-flight awaits
 *  the same Promise - and re-runnable, so a host that restarts and
 *  re-imports is picked up on the next port open. */
export function runStartupMigrations(provider) {
  if (inFlight) return inFlight;
  // Clear the latch when the run settles, however it settles - including
  // the common case where there was nothing to do. "Nothing to convert" is
  // only ever true of the moment it was asked: the host re-imports long
  // after we first connect, and a latch left holding a resolved Promise
  // would turn every later port open into a silent no-op.
  inFlight = runAll(provider).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runAll(provider) {
  // The lock goes up before anything is read, so the provider is never
  // serviceable with either phase outstanding. A run with nothing to do
  // costs one lock round-trip; port opens are rare.
  let lockAcquired = false;
  try {
    await provider.setProviderUpgradeLock(true);
    lockAcquired = true;

    await runStorageSchemaMigrations(provider);
    await convertFlaggedAccounts(provider);
  } finally {
    if (lockAcquired) {
      await provider
        .setProviderUpgradeLock(false)
        .catch((err) =>
          console.warn(
            "[google-4-tbsync] failed to release upgrade lock:",
            stringifyError(err),
          ),
        );
    }
  }
}

/** Walk the storage ladder from whatever version is recorded up to
 *  `SCHEMA_VERSION`.
 *
 *  Absent (or non-integer) means 1: storage exists but nothing has been
 *  migrated. Writing that before running anything gives a crash mid-rung a
 *  recorded state to resume from, and makes "have we ever run here?"
 *  answerable from storage rather than inferred from a side effect.
 *
 *  Each rung is stamped on success, so a failure at 3 keeps 2 banked; a
 *  rung that throws leaves the version alone and is retried on the next
 *  startup, which is why every `run` has to be idempotent. */
async function runStorageSchemaMigrations(provider) {
  const rv = await browser.storage.local.get({ [SCHEMA_KEY]: null });
  let version = rv[SCHEMA_KEY];
  if (!Number.isInteger(version) || version < 1) {
    version = 1;
    await browser.storage.local.set({ [SCHEMA_KEY]: version });
  }

  for (let next = version + 1; next <= SCHEMA_VERSION; next++) {
    const step = MIGRATIONS[next];
    const label = step ? ` (${step.name})` : "";
    try {
      if (step?.run) await step.run(provider);
      await browser.storage.local.set({ [SCHEMA_KEY]: next });
      provider.reportEventLog({
        level: "debug",
        message: `[upgrade] storage schema ${next - 1} -> ${next}${label}`,
      });
    } catch (err) {
      provider.reportEventLog({
        level: "warning",
        message: `[upgrade] storage schema ${next - 1} -> ${next}${label} failed, retrying on next start: ${stringifyError(err)}`,
      });
      return;
    }
  }
}

/** Rung 2. Carry the settings a legacy user explicitly customised out of
 *  the legacy pref branch and into this add-on's storage.
 *
 *  Guarded by the ladder rather than by per-key checks, because an absent
 *  key cannot be read as "never set" - that is also what a deliberate
 *  reset to the default looks like. Marker and settings share
 *  `storage.local`, so a reinstall wipes both together and re-adopting the
 *  legacy values has nothing to overwrite. */
async function liftLegacyPrefs(provider) {
  for (const migration of PREF_MIGRATIONS) {
    await liftPref(provider, migration);
  }
}

/** Rung 3. Convert accounts the host left in legacy shape before
 *  `legacyMigrationPending` existed: the importer re-ran under a build that
 *  had no flag to set, so nothing has ever asked for their conversion and
 *  nothing ever would.
 *
 *  No detection heuristic - every step of the conversion is individually
 *  guarded, so running it over an already-converted account is a sequence
 *  of early returns. Accounts that *are* flagged belong to the flag path
 *  and are skipped here to avoid converting them twice in one run. */
async function repairUnconvertedAccounts(provider) {
  const accounts = await provider.listAccounts();
  const stale = accounts.filter((acc) => !acc.legacyMigrationPending);
  if (!stale.length) return;

  // Every account is attempted before the rung reports failure. Letting
  // the first throw escape would leave the accounts behind it untouched,
  // and a permanently failing one would then block the repair of all the
  // others for good, since the rung is never stamped and always restarts
  // from the same place.
  let failed = 0;
  for (const acc of stale) {
    try {
      await convertAccountData(provider, acc);
    } catch (err) {
      failed++;
      provider.reportEventLog({
        level: "warning",
        accountId: acc.accountId,
        message: `[upgrade] repair failed: ${stringifyError(err)}`,
      });
    }
  }
  if (failed) {
    throw new Error(
      `${failed} of ${stale.length} account(s) could not be repaired`,
    );
  }
}

/* ── Host-flag driven account conversion ────────────────────────────── */

/** Convert every account the host flagged, clearing each flag as it
 *  succeeds. One account failing must not affect the others, so failures
 *  are contained per account rather than aborting the phase. */
async function convertFlaggedAccounts(provider) {
  const pending = (await provider.listAccounts()).filter(
    (acc) => acc.legacyMigrationPending,
  );
  if (!pending.length) return;

  provider.reportEventLog({
    level: "debug",
    message: `[upgrade] converting ${pending.length} legacy-imported account(s)`,
  });
  for (const acc of pending) {
    await convertAccount(provider, acc);
  }
}

/** Convert one flagged account and tell the host it is finished. A throw
 *  anywhere leaves the flag set, so the account stays blocked and is
 *  retried next boot rather than syncing against half-converted data. */
async function convertAccount(provider, acc) {
  try {
    await convertAccountData(provider, acc);
    // Last, so the flag only clears once every step above has landed.
    await provider.legacyMigrationDone({ accountId: acc.accountId });
  } catch (err) {
    provider.reportEventLog({
      level: "warning",
      accountId: acc.accountId,
      message: `[upgrade] legacy conversion failed - account stays blocked and is retried on the next boot: ${stringifyError(err)}`,
    });
    return;
  }
  provider.reportEventLog({
    level: "info",
    accountId: acc.accountId,
    message: `[upgrade] legacy conversion complete`,
  });
}

/** The conversion itself, with no flag handling, so it can serve both the
 *  flag path and the rung-3 repair. Throws on the first step that fails -
 *  the caller decides what that means.
 *
 *  Order is the one the previous release used: the stamp lifts populate
 *  the identities the later steps and the sync path rely on. */
async function convertAccountData(provider, acc) {
  await liftLegacyStamps(provider, acc);
  await liftLegacyGroupStamps(provider, acc);
  await backfillAuthenticatedUserEmail(provider, acc);
  await mirrorReadOnlyModeToFolders(provider, acc);
}

// ── Upgrade bodies ───────────────────────────────────────────────────────

/** Copy one legacy pref branch into `storage.local`. `getUserPref` returns
 *  a value only where the user set one, so the defaults the legacy add-on
 *  registered are never carried over - an untouched profile lifts nothing.
 *  Kept identical to the EAS-4-TbSync helper of the same name. */
async function liftPref(provider, { keys, validate, transform, logValue }) {
  for (const [legacyKey, storageKey] of Object.entries(keys)) {
    const value = await browser.LegacyPrefs.getUserPref(legacyKey);
    if (!validate(value)) continue;

    const newValue = transform(value);
    await browser.storage.local.set({ [storageKey]: newValue });

    provider.reportEventLog({
      level: "debug",
      message: `[upgrade] lifted legacy '${legacyKey}' pref${logValue(newValue)} into storage.local['${storageKey}']`,
    });
  }
}

/** Lift legacy `X-GOOGLE-RESOURCENAME` / `X-GOOGLE-ETAG` from each
 *  card's nsIAbCard userProperty bag onto the vCard. Idempotent (skips
 *  cards already showing the right identity in their vCard). Each
 *  update is pre-tagged with `markServerWrite("modified_by_server")` so
 *  the host's changelog watcher classifies the upcoming AB onModified
 *  event as self-inflicted and drops it - no `_by_user` entry, no
 *  spurious "needs sync" state. */
async function liftLegacyStamps(provider, acc) {
  const rv = await provider.getAccount(acc.accountId);
  const folders = rv?.folders ?? [];
  for (const folder of folders) {
    if (!folder.targetID) continue;
    let stamps;
    try {
      stamps = await browser.LegacyAbProperties.readGoogleStamps(
        folder.targetID,
      );
    } catch (err) {
      // Not knowing whether this folder holds legacy cards is not the same
      // as knowing it doesn't. Rethrow so the account stays blocked: the
      // sync path never reads the property bag, so proceeding would sync
      // cards whose identity we failed to look at and duplicate every one.
      // This is also how the eventual removal of the Experiment surfaces -
      // as a blocked account with a reason, not silent duplication.
      throw new Error(
        `readGoogleStamps failed for folder ${folder.folderId}: ${stringifyError(err)}`,
      );
    }
    if (!stamps.length) continue;

    let lifted = 0;
    for (const { contactId, resourceName, etag } of stamps) {
      const card = await addressBook.getContact(contactId);
      if (!card?.vCard) continue;
      if (mapper.readIdentity(card.vCard)?.resourceName === resourceName)
        continue;
      await provider.changelogMarkServerWrite({
        accountId: acc.accountId,
        folderId: folder.folderId,
        parentId: folder.targetID,
        itemId: contactId,
        status: STATUS_MODIFIED_BY_SERVER,
        kind: "contact",
      });
      const stampedVCard = mapper.stampIdentity(card.vCard, {
        resourceName,
        etag,
      });
      await addressBook.updateContact(contactId, stampedVCard);
      lifted++;
    }
    provider.reportEventLog({
      level: "debug",
      accountId: acc.accountId,
      folderId: folder.folderId,
      message: `[upgrade] lifted ${lifted}/${stamps.length} legacy X-GOOGLE-RESOURCENAME stamp(s) onto vCards`,
    });
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
async function liftLegacyGroupStamps(provider, acc) {
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
      if (typeof e.parentId !== "string" || !e.parentId.includes("#"))
        continue;
      let bag = byParent.get(e.parentId);
      if (!bag) {
        bag = {};
        byParent.set(e.parentId, bag);
      }
      if (e.itemId === RESOURCENAME) bag.resourceName = e.status;
      else bag.etag = e.status;
      consumed.push({ parentId: e.parentId, itemId: e.itemId, kind: e.kind });
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
    for (const { parentId, itemId, kind } of consumed) {
      // Legacy rows imported before entries carried a kind cannot satisfy
      // the host's kind-required remove - and they are inert anyway (their
      // status is a raw value, never `*_by_user`, so nothing pushes them).
      // Skip those instead of failing the migration.
      if (!kind) continue;
      await provider.changelogRemove({
        accountId: acc.accountId,
        folderId: folder.folderId,
        parentId,
        itemId,
        kind,
      });
    }

    provider.reportEventLog({
      level: "debug",
      accountId: acc.accountId,
      folderId: folder.folderId,
      message: `[upgrade] lifted ${lifted}/${byParent.size} legacy mailing-list stamp(s) into folder.custom.groupMap (${consumed.length} legacy entries removed from folder.changelog)`,
    });
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
async function mirrorReadOnlyModeToFolders(provider, acc) {
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

/** Backfill `account.custom.authenticatedUserEmail` when the account has
 *  working OAuth credentials but no email on file (legacy never persisted
 *  one). Idempotent - returns early once the field is set.
 *
 *  A failure here is logged rather than thrown: the address book is
 *  already converted by this point, and the email can be fetched again on
 *  any later sync, so an unreachable network must not keep the account
 *  blocked. */
async function backfillAuthenticatedUserEmail(provider, acc) {
  if (acc.custom.authenticatedUserEmail) return;
  if (
    !acc.custom.clientID ||
    !acc.custom.clientSecret ||
    !acc.custom.refreshToken
  )
    return;
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
