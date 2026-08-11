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
 * one). Converting the account's settings is this module's job.
 *
 * What it deliberately does NOT convert is the account's data: the cards in
 * the bound address book, whose Google identity the legacy add-on kept in
 * the nsIAbCard property bag rather than in the vCard, and any edit it had
 * queued for them. An imported account does not sync at all until the user
 * reconnects it, which deletes the local book and rebuilds it from Google -
 * so converting first would be work done on a copy about to be replaced.
 *
 * Two triggers, one per kind of data, on the principle that the record of
 * a conversion belongs with the data it converted:
 *
 *   - Account `custom` lives in the host. Its trigger is the host's
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

import { stringifyError } from "./errors.mjs";
import * as oauth from "./google/oauth.mjs";

/* ── Provider-local storage schema ──────────────────────────────────── */

const SCHEMA_KEY = "schemaVersion";

/** Shape of this add-on's own `storage.local`. Independent of the add-on
 *  version - ship releases freely and bump this only when the stored shape
 *  actually changes. Also independent of any other provider's number: a
 *  `2` here and a `2` in EAS-4-TbSync describe different storages and must
 *  never be compared. */
const SCHEMA_VERSION = 4;

/** Steps that raise storage from the previous version to the keyed one,
 *  applied in ascending order. `name` appears in the event log so a
 *  support log shows the sequence rather than only its side effects. A
 *  rung with no `run` is legal and just bumps the number. */
const MIGRATIONS = {
  2: { name: "lift-legacy-prefs", run: liftLegacyPrefs },
  3: { name: "repair-unconverted-accounts", run: repairUnconvertedAccounts },
  // Rung 4 ran when this version still adopted the host's imported change
  // queues. It no longer does - an imported account does not sync until it
  // is reconnected, which replaces its resources - but the number stays
  // spent: installations that reached 4 must not be walked over it again.
  4: { name: "adopt-host-changelogs" },
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
