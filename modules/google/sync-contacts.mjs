/**
 * Orchestrates a bidirectional sync between a Thunderbird address book and
 * the authenticated user's Google Contacts.
 *
 * Inputs (from GoogleProvider.onSyncFolder):
 *   - providerAccountId  → for OAuth and storage lookups
 *   - accountId/folderId → tags for progress notifications to the host
 *   - targetAbId         → the Thunderbird address book to sync
 *   - notify             → provider instance exposing reportSyncState /
 *                          reportProgress; lets this module stay decoupled
 *                          from the wire protocol
 *
 * Phase order: PUSH → PULL. Pushing first lets the common "only local edits"
 * case reach Google without being clobbered by the pull; in the rare dual-
 * change case the push's etag check throws CONFLICT, the entry is dropped,
 * and the subsequent pull reconciles by overwriting local (server wins).
 *
 * Push pass (skipped when `readOnlyMode` is on):
 *   1. Load the account's changelog, dedup via `changelog.consolidate`.
 *   2. Dispatch each entry: ADD → create + stamp; MODIFY → update + stamp
 *      (CONFLICT → drop, NOT_FOUND → delete local); DELETE → deleteContact.
 *   3. Persist any unresolved entries for the next sync attempt.
 *
 * Pull pass:
 *   1. Fetch every Person (paginated) from People API.
 *   2. List TB contacts; build `resourceName → {id, etag}` map.
 *   3. For each Person: create if new, update if etag differs, skip if same.
 *   4. Delete local contacts whose resourceName isn't in the server set.
 *
 * All local writes are wrapped in `suppressDuringSelfWrite` so the watcher's
 * onCreated/onUpdated/onDeleted listeners don't echo our server→local writes
 * back into the changelog.
 *
 * Writes are serial — the TB contacts DB doesn't love concurrent writes and
 * serial keeps the progress stream monotonic. If very large books turn out
 * too slow we can batch later.
 */

import { ok, warning } from "../../vendor/tbsync/provider.mjs";
import * as peopleApi from "./people-api.mjs";
import { PUSH_ERR } from "./people-api.mjs";
import * as mapper from "./contact-mapper.mjs";
import * as addressBook from "../address-book.mjs";
import * as accounts from "../accounts.mjs";
import * as changelog from "../changelog.mjs";
import * as changelogWatcher from "../changelog-watcher.mjs";

export async function syncFolderContacts({ accountId, providerAccountId, folderId, targetAbId, notify }) {
  const acc = await accounts.get(providerAccountId);
  const verbose = !!acc?.verboseLogging;
  const log = verbose
    ? (msg, data) => console.log(`[google-4-tbsync] ${msg}`, data ?? "")
    : () => {};

  // ── Push pass ──────────────────────────────────────────────────────────
  let pushAdded = 0, pushUpdated = 0, pushDeleted = 0, pushConflicts = 0;
  const readOnly = !!acc?.readOnlyMode;
  if (readOnly) {
    notify.reportSyncState({ accountId, folderId, syncState: "push.skipped-read-only" });
    log("push pass skipped — readOnlyMode");
  } else {
    const result = await runPushPass({ accountId, folderId, providerAccountId, notify, log });
    pushAdded = result.added;
    pushUpdated = result.updated;
    pushDeleted = result.deleted;
    pushConflicts = result.conflicts;
  }

  // ── Pull pass ──────────────────────────────────────────────────────────
  notify.reportSyncState({ accountId, folderId, syncState: "send.people-list" });
  const people = await peopleApi.listAllConnections(providerAccountId);
  log(`pull: server returned ${people.length} contact(s)`);
  if (verbose && people.length > 0) log("pull: first server contact =", people[0]);

  notify.reportSyncState({ accountId, folderId, syncState: "eval.diff" });
  const local = await addressBook.listContacts(targetAbId);
  log(`pull: local book has ${local.length} card(s)`);
  const byResourceName = new Map();
  for (const card of local) {
    const identity = mapper.readIdentity(card.vCard);
    if (!identity?.resourceName) continue;
    byResourceName.set(identity.resourceName, { id: card.id, etag: identity.etag });
  }
  log(`pull: ${byResourceName.size} local card(s) carry a resourceName stamp`);

  const itemsTotal = people.length;
  let itemsDone = 0;
  let pullAdded = 0, pullUpdated = 0, pullSkipped = 0, pullDeleted = 0;

  notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });

  const seenResourceNames = new Set();
  await changelogWatcher.suppressDuringSelfWrite(async () => {
    for (const person of people) {
      const resourceName = person.resourceName;
      if (!resourceName) { itemsDone++; continue; }
      seenResourceNames.add(resourceName);

      const existing = byResourceName.get(resourceName);
      if (!existing) {
        const vCard = mapper.personToVCard(person);
        const newId = await addressBook.createContact(targetAbId, vCard);
        changelogWatcher.rememberIdentity(newId, resourceName);
        pullAdded++;
      } else if (existing.etag !== person.etag) {
        const vCard = mapper.personToVCard(person);
        await addressBook.updateContact(existing.id, vCard);
        pullUpdated++;
      } else {
        pullSkipped++;
      }

      itemsDone++;
      notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });
    }

    // Delete local contacts that no longer exist on the server.
    for (const [resourceName, entry] of byResourceName) {
      if (seenResourceNames.has(resourceName)) continue;
      await addressBook.deleteContact(entry.id);
      pullDeleted++;
    }
  });

  notify.reportSyncState({ accountId, folderId, syncState: "eval.done" });

  const pushSummary = readOnly
    ? "push skipped (read-only)"
    : `push: ${pushAdded}+${pushUpdated} ↑, ${pushDeleted} ↓${pushConflicts ? `, ${pushConflicts} conflicts` : ""}`;
  const pullSummary = `pull: ${pullAdded}+${pullUpdated} ↓, ${pullDeleted} delete${pullSkipped ? `, ${pullSkipped} unchanged` : ""}`;
  const summary = `${pushSummary}; ${pullSummary}`;

  if (itemsTotal === 0 && local.length > 0 && pullAdded === 0 && pullUpdated === 0) {
    return warning("Server returned 0 contacts", summary);
  }
  return ok(summary);
}

// ── Push pass ────────────────────────────────────────────────────────────

/**
 * Process the account's changelog against Google. Entries that succeed or are
 * dropped by policy (CONFLICT → reconciled by pull, create-then-delete →
 * never needed pushing, NOT_FOUND on delete → already gone) are removed.
 * Entries that fail for transient reasons are re-queued.
 */
async function runPushPass({ accountId, folderId, providerAccountId, notify, log = () => {} }) {
  notify.reportSyncState({ accountId, folderId, syncState: "push.updates" });

  const rawEntries = await changelog.listForAccount(providerAccountId);
  const entries = changelog.consolidate(rawEntries);
  const unresolved = [];
  let added = 0, updated = 0, deleted = 0, conflicts = 0;

  log(`push: ${rawEntries.length} raw changelog entries → ${entries.length} after consolidate`);

  const total = entries.length;
  let done = 0;
  if (total > 0) {
    notify.reportProgress({ accountId, folderId, itemsDone: 0, itemsTotal: total });
  }

  for (const entry of entries) {
    try {
      if (entry.status === changelog.STATUS.ADDED_BY_USER) {
        const outcome = await pushAddEntry(providerAccountId, entry, log);
        if (outcome === "added") added++;
      } else if (entry.status === changelog.STATUS.MODIFIED_BY_USER) {
        const outcome = await pushModifyEntry(providerAccountId, entry, log);
        if (outcome === "added") added++;
        else if (outcome === "updated") updated++;
        else if (outcome === "deleted") deleted++;
        else if (outcome === "conflict") conflicts++;
      } else if (entry.status === changelog.STATUS.DELETED_BY_USER) {
        const outcome = await pushDeleteEntry(providerAccountId, entry, log);
        if (outcome === "deleted") deleted++;
      }
    } catch (err) {
      // Transient failure — keep the entry for next attempt, log for the
      // event log. Never let one bad entry abort the whole push pass.
      console.warn(
        `[google-4-tbsync] push failed (${entry.status} ${entry.itemId}):`,
        err?.message ?? err
      );
      unresolved.push(entry);
    }
    done++;
    notify.reportProgress({ accountId, folderId, itemsDone: done, itemsTotal: total });
  }

  await changelog.setForAccount(providerAccountId, unresolved);
  return { added, updated, deleted, conflicts };
}

/** Create on server, then stamp the local card with the server's identity. */
async function pushAddEntry(providerAccountId, entry, log) {
  const local = await getContactSafe(entry.itemId);
  if (!local) return "dropped";  // user deleted before sync — nothing to push
  const person = mapper.vCardToPerson(local.vCard);
  log(`push.add ${entry.itemId} — sending to Google:`, person);
  const serverPerson = await peopleApi.createContact(providerAccountId, person);
  log(`push.add ${entry.itemId} — server returned:`, { resourceName: serverPerson.resourceName, etag: serverPerson.etag });
  await stampLocalCard(entry.itemId, local.vCard, serverPerson);
  return "added";
}

/** Update on server with optimistic-lock etag. CONFLICT → drop (pull will
 *  reconcile). NOT_FOUND → server-side delete happened, mirror locally. */
async function pushModifyEntry(providerAccountId, entry, log) {
  const local = await getContactSafe(entry.itemId);
  if (!local) return "dropped";
  const identity = mapper.readIdentity(local.vCard);
  if (!identity?.resourceName) {
    // Local card has no server identity — treat as a brand-new add. Rare
    // edge case: modified event fired before the prior add's stamp landed.
    const person = mapper.vCardToPerson(local.vCard);
    log(`push.modify ${entry.itemId} — no server identity, creating instead:`, person);
    const serverPerson = await peopleApi.createContact(providerAccountId, person);
    await stampLocalCard(entry.itemId, local.vCard, serverPerson);
    return "added";
  }
  const person = mapper.vCardToPerson(local.vCard);
  log(`push.modify ${identity.resourceName} — sending to Google:`, person);
  try {
    const serverPerson = await peopleApi.updateContact(
      providerAccountId, identity.resourceName, person, identity.etag
    );
    log(`push.modify ${identity.resourceName} — server returned etag ${serverPerson.etag}`);
    await stampLocalCard(entry.itemId, local.vCard, serverPerson);
    return "updated";
  } catch (err) {
    if (err?.code === PUSH_ERR.CONFLICT) {
      log(`push.modify ${identity.resourceName} — CONFLICT, dropping (pull will reconcile)`);
      return "conflict";
    }
    if (err?.code === PUSH_ERR.NOT_FOUND) {
      log(`push.modify ${identity.resourceName} — server contact gone, deleting local`);
      await changelogWatcher.suppressDuringSelfWrite(async () => {
        await addressBook.deleteContact(entry.itemId);
      });
      return "deleted";
    }
    throw err;
  }
}

/** Delete on server; missing resourceName means never-synced so just drop. */
async function pushDeleteEntry(providerAccountId, entry, log) {
  if (!entry.resourceName) return "dropped";
  log(`push.delete ${entry.resourceName} — sending to Google`);
  try {
    await peopleApi.deleteContact(providerAccountId, entry.resourceName);
    return "deleted";
  } catch (err) {
    if (err?.code === PUSH_ERR.NOT_FOUND) {
      log(`push.delete ${entry.resourceName} — already gone`);
      return "deleted";
    }
    throw err;
  }
}

/** Fetch a contact with vCard-field normalisation; null on "not found".
 *  Separates the "card vanished between event and push" case from real
 *  failures, and delegates the `properties.vCard` → `.vCard` promotion to
 *  the address-book wrapper so this module never sees TB's dual shape. */
async function getContactSafe(id) {
  return await addressBook.getContact(id);
}

/** Re-stamp the local card with `{resourceName, etag}` from the server. */
async function stampLocalCard(contactId, originalVCard, serverPerson) {
  const stamped = mapper.stampIdentity(originalVCard, {
    resourceName: serverPerson.resourceName,
    etag: serverPerson.etag,
  });
  await changelogWatcher.suppressDuringSelfWrite(async () => {
    await addressBook.updateContact(contactId, stamped);
  });
  changelogWatcher.rememberIdentity(contactId, serverPerson.resourceName);
}
