/**
 * Bidirectional sync between a Thunderbird address book and the
 * authenticated user's Google Contacts. Flow:
 *   1. Push adds + modifies from our own change queue to Google.
 *   2. Push deletes.
 *   3. Pull all server contacts; reconcile local.
 *   4. Groups: mirror of the contact flow, via `groupMap`.
 *
 * Every push happens before the matching pull, and that ordering is load-
 * bearing rather than tidy. Our own change is then already part of what the
 * server reports, so anything the pull brings back is news; pull first and
 * the echo of a local edit is indistinguishable from a genuine server-side
 * one. Deletes suffer worst - a locally deleted item is simply absent, which
 * reads exactly like an item the book has never seen, so a pull-first delete
 * gets undone by the very pass that should have confirmed it.
 *
 * Ordering alone is not quite enough, because the People API is only
 * eventually consistent: it can still list an item it has just accepted a
 * delete for. So each pull also ignores whatever this same sync deleted -
 * see `deletedThisSync`.
 *
 * Contact groups and their memberships both sync bidirectionally.
 * Every local write is preceded by a `markServerWrite` pre-tag so
 * our own observer suppresses the resulting TB event. Writes are serial
 * for monotonic progress.
 */

import { ok, warning } from "../../vendor/tbsync/provider.mjs";
import * as peopleApi from "./people-api.mjs";
import * as mapper from "./contact-mapper.mjs";
import * as addressBook from "../../vendor/tbsync/address-book.mjs";
import {
  localQueue,
  rememberBindings,
} from "../../vendor/tbsync/change-queue.mjs";
import { SERVER_TAG_STATUSES } from "../../vendor/tbsync/changelog-core.mjs";
import { GroupMap } from "../group-map.mjs";
import { ContactMap } from "../contact-map.mjs";
import { stringifyError, PUSH_ERR } from "../errors.mjs";

const STATUS = {
  ADDED_BY_USER: "added_by_user",
  MODIFIED_BY_USER: "modified_by_user",
  DELETED_BY_USER: "deleted_by_user",
  ADDED_BY_SERVER: SERVER_TAG_STATUSES[0],
  MODIFIED_BY_SERVER: SERVER_TAG_STATUSES[1],
  DELETED_BY_SERVER: SERVER_TAG_STATUSES[2],
};
const SYSTEM_GROUP = "SYSTEM_CONTACT_GROUP";

// The kinds this sync can route to a pass. Folder-local vocabulary, a
// subset of the vendored CHANGELOG_KINDS: `event`/`task` are valid rows
// globally but have no pass in a contacts sync, and anything outside this
// list is skipped out loud in runFolderSync rather than misrouted.
// (`list-by-name` is absent on purpose - it exists only as a pre-tag, and
// pre-tags are not user entries.)
const ROUTED_KINDS = ["contact", "list", "membership"];

// ── Entry point ─────────────────────────────────────────────────────────

/** Push a debug-level entry into the host's session event log. The provider
 *  always emits; the host's capture gate (settings.logLevel) decides what
 *  to retain. */
function logDebug(ctx, message, details) {
  ctx.notify.reportEventLog({
    level: "debug",
    accountId: ctx.accountId,
    folderId: ctx.folderId,
    message,
    ...(details !== undefined ? { details } : {}),
  });
}

/** Stop if the host has cancelled this account's sync.
 *
 *  The abort signal already kills the People API call in flight; this covers
 *  the gaps between items, where carrying on means work nobody is waiting
 *  for any more. `ctx.notify` is the provider instance. */
function throwIfCancelled(ctx) {
  ctx.notify?.throwIfCancelled?.(ctx.accountId);
}

export async function syncFolderContacts({
  accountId,
  folderId,
  folder,
  account,
  notify,
}) {
  const targetID = folder?.targetID;
  // Effective read-only: account-level "Read-only mode" pref OR a per-folder
  // server-imposed `readOnly` (rare for Google) OR the user's per-folder
  // `downloadOnly` toggle from the manager UI's ACL icon. Any of the three
  // skips push and reverts pending local edits.
  const readOnly =
    !!account?.custom?.readOnlyMode ||
    !!folder?.readOnly ||
    !!folder?.downloadOnly;
  const includeSystemGroups = !!account?.custom?.includeSystemContactGroups;

  // Our own queue for this binding, plus the in-memory provider maps
  // (flushed at end). The queue is keyed by the session the host names, so a
  // folder that has been unbound and rebound never sees the old one's edits.
  const queue = localQueue({
    accountId,
    folderId,
    sessionId: folder?.sessionId,
    observed: true,
  });
  // Bank the binding while the row is in hand: an address-book event gives
  // the observer a book id and nothing else, and the host may be gone by
  // the time the user edits a card.
  if (folder?.sessionId && targetID) {
    await rememberBindings([
      {
        targetID,
        accountId,
        folderId,
        sessionId: folder.sessionId,
        targetType: folder.targetType,
      },
    ]).catch(() => {});
  }
  const changelog = await queue.entries();
  const gMap = new GroupMap(folder?.custom.groupMap);
  const cMap = new ContactMap(folder?.custom.contactMap);

  // Pre-tag helper: every messenger.contacts.* / messenger.mailingLists.*
  // call we make must be preceded by a *_by_server entry, so the observer
  // drops the resulting Thunderbird event as self-inflicted.
  const ctx = {
    accountId,
    folderId,
    targetID,
    notify,
    readOnly,
    includeSystemGroups,
    gMap,
    cMap,
    changelog,
    queue,
    // Resource names this sync has already deleted from the server. The
    // People API is read-after-write eventual: a `connections` or
    // `contactGroups` list issued seconds after an accepted delete can
    // still carry the thing that was deleted. The pull passes run inside
    // exactly that window, and to them a server item with no local
    // counterpart is indistinguishable from one the book has never seen -
    // so they re-create what the user just removed. Remembering what we
    // deleted is what tells those two apart.
    //
    // Per sync run, deliberately: the lag has always closed well before
    // the next sync. If one ever outlives a run, the pull re-creates and
    // the run after that removes it again - which is the behaviour this
    // replaces, so nothing gets worse.
    deletedThisSync: { contacts: new Set(), groups: new Set() },
    markServer: (parentId, itemId, status, kind) =>
      queue.markServerWrite({ parentId, itemId, status, kind }),
    removeEntry: (parentId, itemId, kind) =>
      queue.remove({ parentId, itemId, kind }),
  };

  try {
    const rv = await runFolderSync(ctx);
    await flushMaps(notify, accountId, folderId, gMap, cMap);
    return rv;
  } catch (err) {
    // Best-effort flush of in-progress groupMap/contactMap so a retry can
    // pick up where we left off. Log on failure so a broken flush doesn't
    // silently accumulate drift. The host writes folder.error / account.error
    // from the thrown code; we only need to rethrow.
    await flushMaps(notify, accountId, folderId, gMap, cMap).catch(
      (flushErr) => {
        console.warn(
          "[google-4-tbsync] flushMaps during error handling failed:",
          stringifyError(flushErr),
        );
      },
    );
    throw err;
  }
}

async function flushMaps(notify, accountId, folderId, gMap, cMap) {
  const customPatch = {};
  if (gMap.dirty) customPatch.groupMap = gMap.toJSON();
  if (cMap.dirty) customPatch.contactMap = cMap.toJSON();
  if (!Object.keys(customPatch).length) return;
  await notify.updateFolder({
    accountId,
    folderId,
    patch: { custom: customPatch },
  });
  gMap.dirty = false;
  cMap.dirty = false;
}

// ── Main flow ────────────────────────────────────────────────────────────

async function runFolderSync(ctx) {
  const { notify, accountId, folderId, readOnly, changelog } = ctx;

  const isUserStatus = (e) =>
    e.status === STATUS.ADDED_BY_USER ||
    e.status === STATUS.MODIFIED_BY_USER ||
    e.status === STATUS.DELETED_BY_USER;
  // A changelog row's identity is (parentId, itemId, kind), and the host
  // refuses a kind-less removeEntry - so a row without a kind could be
  // pushed but never cleared, re-pushing forever (a contact add would
  // duplicate server-side on every sync). Such rows can only come from a
  // pre-release-v5 profile (the v4 migration stamps kind on every row);
  // park them untouched and say so, rather than half-processing them.
  const routable = changelog.filter(
    (e) => isUserStatus(e) && e.kind && ROUTED_KINDS.includes(e.kind),
  );
  const parked = changelog.filter((e) => isUserStatus(e) && !e.kind).length;
  if (parked) {
    notify.reportEventLog({
      level: "warning",
      accountId,
      folderId,
      message:
        `${parked} changelog entr${parked === 1 ? "y" : "ies"} without a ` +
        `kind - left untouched (pre-release-v5 leftovers; delete and ` +
        `re-make the edit, or resync the folder)`,
    });
  }
  // An entry whose kind this sync does not route - a typo, or a kind that
  // belongs to another resource. Deliberately folder-local, NOT a check
  // against the global kind list: `event` is a perfectly valid kind that
  // still has no pass here, and with the positive selection below it would
  // otherwise sit in the queue forever. Warned per row and removed, same
  // as EAS's mismatched-kind skip: dropped once, out loud.
  for (const e of changelog) {
    if (!isUserStatus(e) || !e.kind || ROUTED_KINDS.includes(e.kind)) continue;
    notify.reportEventLog({
      level: "warning",
      accountId,
      folderId,
      message:
        `skipping a queued edit of "${e.itemId}": its kind "${e.kind}" is ` +
        `not one this contacts sync routes (${ROUTED_KINDS.join(", ")})`,
    });
    await ctx.removeEntry(e.parentId, e.itemId, e.kind);
  }
  const userEntries = routable;
  logDebug(ctx, `changelog: ${userEntries.length} pending user entries`);

  // 1. Push adds + modifies.
  let pushCounts = { added: 0, updated: 0, deleted: 0, conflicts: 0 };
  if (readOnly) {
    // Drop pending user edits so they don't accumulate forever. The pull
    // pass below will resync server state for anything that was locally
    // modified or deleted; locally-added cards that were never pushed
    // will linger as unsynced local-only cards but won't keep retrying
    // every sync. Mirrors the spirit of EAS-4-TbSync's
    // `revertLocalChanges` pre-step on effective-RO folders.
    for (const entry of userEntries) {
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    }
    notify.reportEventLog({
      accountId,
      folderId,
      level: "info",
      message:
        userEntries.length > 0
          ? `Push skipped (read-only); dropped ${userEntries.length} pending local edit${userEntries.length === 1 ? "" : "s"}.`
          : "Push skipped (read-only).",
    });
  } else {
    pushCounts = await runPushAddModifyPass(ctx, userEntries);
  }

  // 2. Push deletes - before the pull, like the adds and modifies above.
  //    A delete pushed *after* the pull is a delete the pull has already
  //    undone: the card is gone locally but still on the server, which is
  //    indistinguishable from a contact the book has never seen, so the
  //    pull re-creates the very card the user just deleted. Sending it
  //    first means the pull reads a server that already agrees with us,
  //    and the ambiguity never arises.
  if (!readOnly) {
    const deleteStats = await runPushDeletePass(ctx, userEntries);
    pushCounts.deleted = deleteStats.deleted;
  }

  // 3. Pull contacts - server → local reconciliation.
  const pull = await runPullPass(ctx);

  // 4. Groups - mirror of the contact flow, and now in the same order:
  //    every push before the pull. Add-modify has always been first, so
  //    that a just-pushed group is in gMap before the pull walks the
  //    server's list and would otherwise create a duplicate local one.
  //    Delete joins it for a sharper reason: gMap holds a single entry per
  //    group, so a pull that re-creates a locally-deleted list overwrites
  //    its `mailingListId` with a fresh local id, and the delete pass then
  //    looks up the id the user actually deleted, finds nothing and drops
  //    the entry. Ordered this way the mapping is still intact when the
  //    delete is sent.
  let groupPushAddMod = { added: 0, updated: 0 };
  let groupDeleted = 0;
  let memberPush = { added: 0, removed: 0 };
  if (!ctx.readOnly) {
    groupPushAddMod = await runGroupPushAddModifyPass(ctx, userEntries);
    groupDeleted = (await runGroupPushDeletePass(ctx, userEntries)).deleted;
    // Last of the pushes: a membership needs both ends to exist on the
    // server, so it has to follow the contact and group adds, and it is
    // pointless for a group the delete pass just removed.
    //
    // `pull.memberMap` goes along to be kept honest. It was read during the
    // contact pull one step above and so predates everything pushed here,
    // and `applyMemberships` further down reconciles the book against it -
    // faithfully undoing, in this same sync, every membership we just sent.
    memberPush = await runMembershipPushPass(ctx, userEntries, pull.memberMap);
  }
  const groupCounts = await runGroupPullPass(
    ctx,
    pull.byResourceName,
    pull.memberMap,
  );
  groupCounts.added += groupPushAddMod.added;
  groupCounts.updated += groupPushAddMod.updated;
  groupCounts.deleted += groupDeleted;

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

  const pushSummary = readOnly
    ? "push skipped (read-only)"
    : `push: ${pushCounts.added}+${pushCounts.updated} ↑, ${pushCounts.deleted} ↓${pushCounts.conflicts ? `, ${pushCounts.conflicts} conflicts` : ""}`;
  const pullSummary = `pull: ${pull.added}+${pull.updated} ↓, ${pull.deleted} delete${pull.skipped ? `, ${pull.skipped} unchanged` : ""}`;
  const groupSummary = `groups: ${groupCounts.added}+${groupCounts.updated} ↓, ${groupCounts.deleted} delete; members: ${groupCounts.membersAdded}+${groupCounts.membersRemoved} ↓, ${memberPush.added}+${memberPush.removed} ↑`;
  const summary = `${pushSummary}; ${pullSummary}; ${groupSummary}`;

  if (
    pull.itemsTotal === 0 &&
    pull.localCount > 0 &&
    pull.added === 0 &&
    pull.updated === 0
  ) {
    return warning("Server returned 0 contacts", summary);
  }
  return ok(summary);
}

// ── Push pass (adds + modifies) ──────────────────────────────────────────

async function runPushAddModifyPass(ctx, userEntries) {
  const { notify, accountId, folderId } = ctx;
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

  // Contact entries only; groups handled in the groups pass.
  const entries = userEntries.filter((e) => isContactEntry(e));
  const actionable = entries.filter(
    (e) =>
      e.status === STATUS.ADDED_BY_USER || e.status === STATUS.MODIFIED_BY_USER,
  );

  let added = 0,
    updated = 0,
    conflicts = 0;
  const total = actionable.length;
  if (total > 0) {
    notify.reportProgress({
      accountId,
      folderId,
      itemsDone: 0,
      itemsTotal: total,
    });
  }
  let done = 0;

  for (const entry of actionable) {
    // Between items, never between a push and the changelog entry it
    // settles: unwinding there would drop a user edit that Google already
    // has. An entry left in the changelog is simply retried next sync.
    throwIfCancelled(ctx);
    try {
      const outcome =
        entry.status === STATUS.ADDED_BY_USER
          ? await pushAdd(ctx, entry)
          : await pushModify(ctx, entry);
      if (outcome === "added") added++;
      if (outcome === "updated") updated++;
      if (outcome === "conflict") conflicts++;
    } catch (err) {
      // Leave entry in the changelog - next sync retries.
      ctx.notify.reportEventLog({
        level: "warning",
        accountId: ctx.accountId,
        folderId: ctx.folderId,
        message: `Push failed (${entry.status} ${entry.itemId}): ${stringifyError(err)}`,
      });
    }
    done++;
    notify.reportProgress({
      accountId,
      folderId,
      itemsDone: done,
      itemsTotal: total,
    });
  }
  return { added, updated, deleted: 0, conflicts };
}

async function pushAdd(ctx, entry) {
  const { accountId, cMap } = ctx;
  const local = await addressBook.getContact(entry.itemId);
  if (!local) {
    // Card gone before we got to push it - add+del cancelled or something
    // external dropped it. Nothing to do.
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "dropped";
  }
  const person = mapper.vCardToPerson(local.vCard);
  logDebug(ctx, `push.add ${entry.itemId} - creating on Google`);
  const serverPerson = await peopleApi.createContact(accountId, person);
  logDebug(
    ctx,
    `push.add ${entry.itemId} - server resourceName=${serverPerson.resourceName}`,
  );
  await stampLocalCard(ctx, entry.itemId, local.vCard, serverPerson);
  cMap.set(entry.itemId, serverPerson.resourceName);
  await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
  return "added";
}

async function pushModify(ctx, entry) {
  const { accountId, cMap } = ctx;
  const local = await addressBook.getContact(entry.itemId);
  if (!local) {
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "dropped";
  }
  const identity = mapper.readIdentity(local.vCard);
  if (!identity?.resourceName) {
    // No server identity yet - treat as a late add.
    const person = mapper.vCardToPerson(local.vCard);
    logDebug(
      ctx,
      `push.modify ${entry.itemId} - no server identity, creating instead`,
    );
    const serverPerson = await peopleApi.createContact(accountId, person);
    await stampLocalCard(ctx, entry.itemId, local.vCard, serverPerson);
    cMap.set(entry.itemId, serverPerson.resourceName);
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "added";
  }
  let vCard = local.vCard;
  let person = mapper.vCardToPerson(vCard);
  logDebug(ctx, `push.modify ${identity.resourceName}`);
  try {
    if (identity.syncRev < mapper.SYNC_REVISION) {
      // The card predates some field families; pushing it verbatim would
      // clear them on Google. Clean-pull the server Person first, merge
      // those families into the card - local changes win - save it, and
      // push the upgraded card instead. Happens once per old card.
      logDebug(
        ctx,
        `push.modify ${identity.resourceName} - card revision ` +
          `${identity.syncRev} < ${mapper.SYNC_REVISION}, merging server state`,
      );
      const serverNow = await peopleApi.getContact(
        accountId,
        identity.resourceName,
      );
      ({ vCard, person } = mapper.upgradeVCard(
        local.vCard,
        serverNow,
        identity.syncRev,
      ));
      await ctx.markServer(
        entry.parentId,
        entry.itemId,
        STATUS.MODIFIED_BY_SERVER,
        "contact",
      );
      await addressBook.updateContact(entry.itemId, vCard);
    }
    const serverPerson = await peopleApi.updateContact(
      accountId,
      identity.resourceName,
      person,
      // Deliberately the card's etag, not `serverNow`'s: conflict
      // detection for the fields the card did know stays unchanged.
      identity.etag,
    );
    await stampLocalCard(ctx, entry.itemId, vCard, serverPerson);
    cMap.set(entry.itemId, serverPerson.resourceName);
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "updated";
  } catch (err) {
    if (err?.code === PUSH_ERR.CONFLICT) {
      logDebug(
        ctx,
        `push.modify ${identity.resourceName} - CONFLICT, dropping (pull will reconcile)`,
      );
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      return "conflict";
    }
    if (err?.code === PUSH_ERR.NOT_FOUND) {
      logDebug(
        ctx,
        `push.modify ${identity.resourceName} - server contact gone, deleting local`,
      );
      await ctx.markServer(
        entry.parentId,
        entry.itemId,
        STATUS.DELETED_BY_SERVER,
        "contact",
      );
      await addressBook.deleteContact(entry.itemId);
      cMap.remove(entry.itemId);
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      return "deleted";
    }
    throw err;
  }
}

/** sha-1 of a base64 payload, hex - the photo change detector. */
async function sha1hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The server-side photo worth syncing, or null. `default: true` marks the
 *  generated monogram silhouette, which is not a photo anyone set. */
function pickServerPhoto(person) {
  return (person.photos ?? []).find((p) => p?.url && !p.default) ?? null;
}

/** Bring the server's photo in line with the local card, during the stamp
 *  step of a push. Photos travel through their own endpoint - they are not
 *  part of updateContact - and the endpoint answers with the updated
 *  person, whose fresh etag must win the stamp or the next pull re-reads
 *  the whole contact for nothing.
 *
 *  Returns `{ person, photoState }`: the person whose etag to stamp, and
 *  the bookkeeping to write ({url, hash} or nulls). Failures cost the
 *  photo, never the push - the entry has already been acknowledged.
 */
async function syncPhotoForPush(ctx, localVCard, serverPerson) {
  const local = mapper.readPhoto(localVCard);
  let person = serverPerson;
  let photoState = { url: local.url, hash: local.hash };

  try {
    if (local.base64) {
      const hash = await sha1hex(local.base64);
      if (hash !== local.hash) {
        logDebug(ctx, `push.photo ${serverPerson.resourceName} - uploading`);
        const updated = await peopleApi.updateContactPhoto(
          ctx.accountId,
          serverPerson.resourceName,
          local.base64,
        );
        if (updated) {
          person = updated;
          photoState = { url: pickServerPhoto(updated)?.url ?? null, hash };
        }
      }
    } else if (local.url) {
      // Had a synced photo, has none now - the user removed it.
      logDebug(ctx, `push.photo ${serverPerson.resourceName} - deleting`);
      const updated = await peopleApi.deleteContactPhoto(
        ctx.accountId,
        serverPerson.resourceName,
      );
      if (updated) person = updated;
      photoState = { url: null, hash: null };
    }
  } catch (err) {
    logDebug(
      ctx,
      `push.photo ${serverPerson.resourceName} failed: ${err?.message ?? err}`,
    );
  }
  return { person, photoState };
}

/** Stamp the local card with `{resourceName, etag}` from the server.
 *  Writes via the observer-aware pre-tag so the stamp-update
 *  doesn't echo back as a user edit. Also the moment the photo crosses:
 *  the card is being rewritten anyway, so the photo bookkeeping rides
 *  along in the same write. */
async function stampLocalCard(ctx, contactId, originalVCard, serverPerson) {
  const { person, photoState } = await syncPhotoForPush(
    ctx,
    originalVCard,
    serverPerson,
  );
  // The revision stamp rides along too, so push-created cards (add and
  // late-add) come out current and never trigger the old-card merge.
  const stamped = mapper.stampRevision(
    mapper.stampPhotoState(
      mapper.stampIdentity(originalVCard, {
        resourceName: person.resourceName ?? serverPerson.resourceName,
        etag: person.etag,
      }),
      photoState,
    ),
  );
  await ctx.markServer(
    ctx.targetID,
    contactId,
    STATUS.MODIFIED_BY_SERVER,
    "contact",
  );
  await addressBook.updateContact(contactId, stamped);
}

/** The photo argument for `personToVCard` on the pull side: reuse the
 *  local bytes when the server URL is unchanged, fetch when it moved,
 *  nothing when the server has none. */
async function resolvePullPhoto(ctx, person, existingVCard) {
  const serverPhoto = pickServerPhoto(person);
  if (!serverPhoto) return null;
  if (existingVCard) {
    const old = mapper.readPhoto(existingVCard);
    if (old.dataUri && old.url === serverPhoto.url) {
      return { dataUri: old.dataUri, url: old.url, hash: old.hash };
    }
  }
  const dataUri = await peopleApi.fetchPhotoAsDataUri(serverPhoto.url);
  if (!dataUri) return null;
  const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
  return { dataUri, url: serverPhoto.url, hash: await sha1hex(base64) };
}

// ── Pull pass ────────────────────────────────────────────────────────────

async function runPullPass(ctx) {
  const { notify, accountId, folderId, targetID, cMap } = ctx;

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  const people = await peopleApi.listAllConnections(accountId);
  logDebug(ctx, `pull: server returned ${people.length} contact(s)`);

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  const local = await addressBook.listContacts(targetID);
  logDebug(ctx, `pull: local book has ${local.length} card(s)`);

  // byResourceName: snapshot of pre-pull local state, keyed by stamped
  // resourceName. Used to decide create-vs-update and (after the pass)
  // to detect server contacts we never saw (push-delete candidates).
  const byResourceName = new Map();
  for (const card of local) {
    const identity = mapper.readIdentity(card.vCard);
    if (!identity?.resourceName) continue;
    byResourceName.set(identity.resourceName, {
      id: card.id,
      etag: identity.etag,
      vCard: card.vCard,
    });
    cMap.set(card.id, identity.resourceName);
  }

  const memberMap = new Map(); // groupRn → Set<contactRn>
  const itemsTotal = people.length;
  let itemsDone = 0;
  let added = 0,
    updated = 0,
    skipped = 0,
    deleted = 0;

  notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });

  const serverResourceNames = new Set();
  for (const person of people) {
    const resourceName = person.resourceName;
    if (!resourceName) {
      itemsDone++;
      continue;
    }
    if (ctx.deletedThisSync.contacts.has(resourceName)) {
      // A stale listing naming a contact this same sync deleted. Not added
      // to `serverResourceNames` either: that set says what the server
      // holds, and this is the one thing we know it no longer does.
      logDebug(
        ctx,
        `pull: ignoring ${resourceName}, deleted earlier this sync`,
      );
      itemsDone++;
      continue;
    }
    serverResourceNames.add(resourceName);
    indexMemberships(memberMap, resourceName, person.memberships);

    const existing = byResourceName.get(resourceName);
    if (!existing) {
      // Pull-create: book wasn't aware of this contact. Pre-generate the
      // UID so the changelog pre-tag can use a concrete itemId.
      const newId = crypto.randomUUID();
      const photo = await resolvePullPhoto(ctx, person, null);
      const vCard = mapper.personToVCard(person, newId, { photo });
      await ctx.markServer(targetID, newId, STATUS.ADDED_BY_SERVER, "contact");
      const createdId = await addressBook.createContact(targetID, vCard);
      if (createdId !== newId) {
        throw new Error(
          `createContact id mismatch: expected ${newId}, got ${createdId}`,
        );
      }
      byResourceName.set(resourceName, { id: newId, etag: person.etag });
      cMap.set(newId, resourceName);
      added++;
    } else if (existing.etag !== person.etag) {
      // Pull-update: server's version is newer.
      const photo = await resolvePullPhoto(ctx, person, existing.vCard);
      const vCard = mapper.personToVCard(person, null, { photo });
      await ctx.markServer(
        targetID,
        existing.id,
        STATUS.MODIFIED_BY_SERVER,
        "contact",
      );
      await addressBook.updateContact(existing.id, vCard);
      updated++;
    } else {
      skipped++;
    }
    itemsDone++;
    notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });
  }

  // Pull-delete: server dropped contacts we still have - mirror locally.
  for (const [resourceName, entry] of byResourceName) {
    if (serverResourceNames.has(resourceName)) continue;
    await ctx.markServer(
      targetID,
      entry.id,
      STATUS.DELETED_BY_SERVER,
      "contact",
    );
    await addressBook.deleteContact(entry.id);
    cMap.remove(entry.id);
    byResourceName.delete(resourceName);
    deleted++;
  }

  return {
    byResourceName,
    memberMap,
    itemsTotal,
    localCount: local.length,
    added,
    updated,
    skipped,
    deleted,
    serverResourceNames,
  };
}

function indexMemberships(memberMap, contactResourceName, memberships) {
  if (!Array.isArray(memberships)) return;
  for (const m of memberships) {
    const groupRn = m?.contactGroupMembership?.contactGroupResourceName;
    if (!groupRn) continue;
    let set = memberMap.get(groupRn);
    if (!set) {
      set = new Set();
      memberMap.set(groupRn, set);
    }
    set.add(contactResourceName);
  }
}

// ── Push-delete reconciliation ───────────────────────────────────────────

async function runPushDeletePass(ctx, userEntries) {
  const { accountId, cMap } = ctx;
  const deletions = userEntries.filter(
    (e) => isContactEntry(e) && e.status === STATUS.DELETED_BY_USER,
  );
  if (!deletions.length) return { deleted: 0 };

  let deleted = 0;
  for (const entry of deletions) {
    // Every pass, not just the add/modify ones: once the signal is aborted
    // each remaining request fails instantly and the per-item catch below
    // turns that into one warning per item - a wall of noise for what was a
    // button press.
    throwIfCancelled(ctx);
    const resourceName = cMap.get(entry.itemId);
    if (!resourceName) {
      // Never-synced-or-already-gone → just drop the entry.
      logDebug(
        ctx,
        `push.delete ${entry.itemId} - no resourceName on file, dropping`,
      );
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      continue;
    }
    // No "is it still on the server?" pre-check: this pass now runs before
    // the pull, so there is no server listing to consult. A contact deleted
    // in the Google UI since our last sync answers with NOT_FOUND below,
    // which is the same outcome one round trip later.
    try {
      logDebug(ctx, `push.delete ${resourceName}`);
      await peopleApi.deleteContact(accountId, resourceName);
      ctx.deletedThisSync.contacts.add(resourceName);
      cMap.remove(entry.itemId);
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      deleted++;
    } catch (err) {
      if (err?.code === PUSH_ERR.NOT_FOUND) {
        // Gone already, and a listing taken before it went can still
        // name it - the same window as an accepted delete.
        ctx.deletedThisSync.contacts.add(resourceName);
        cMap.remove(entry.itemId);
        await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
        deleted++;
        continue;
      }
      // Leave the entry; next sync retries.
      ctx.notify.reportEventLog({
        level: "warning",
        accountId: ctx.accountId,
        folderId: ctx.folderId,
        message: `Push delete ${resourceName} failed: ${stringifyError(err)}`,
      });
    }
  }
  return { deleted };
}

// ── Groups: pull + apply memberships ─────────────────────────────────────

async function runGroupPullPass(ctx, byResourceName, memberMap) {
  const { notify, accountId, folderId, targetID, gMap, includeSystemGroups } =
    ctx;
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

  const serverGroups = await peopleApi.listAllContactGroups(accountId);
  const eligible = serverGroups.filter(
    (g) =>
      (includeSystemGroups || g.groupType !== SYSTEM_GROUP) &&
      // A stale listing naming a group this same sync deleted. Its gMap
      // mapping is already gone, so without this the loop below reads it
      // as a group the book has never seen and re-creates the list.
      !ctx.deletedThisSync.groups.has(g.resourceName),
  );
  const stale = serverGroups.filter((g) =>
    ctx.deletedThisSync.groups.has(g.resourceName),
  ).length;
  logDebug(
    ctx,
    `groups: server returned ${serverGroups.length} (${eligible.length} after ` +
      `filtering system groups${stale ? ` and ${stale} deleted earlier this sync` : ""})`,
  );

  const localLists = await addressBook.listMailingLists(targetID);
  const localByListId = new Map(localLists.map((l) => [l.id, l]));

  const listIdToResourceName = new Map();
  for (const [rn, entry] of gMap.listAll()) {
    if (entry.mailingListId) listIdToResourceName.set(entry.mailingListId, rn);
  }

  let added = 0,
    updated = 0,
    deleted = 0;
  const seen = new Set();

  for (const group of eligible) {
    const resourceName = group.resourceName;
    seen.add(resourceName);
    const mapping = gMap.get(resourceName);
    const existing = mapping?.mailingListId
      ? localByListId.get(mapping.mailingListId)
      : null;

    if (!existing) {
      // Wildcard because mailing lists are not created with a UID.
      // Pre-tag with the list's name as itemId. mailingLists.create takes
      // no UID, so we don't know the TB-assigned id yet; the watcher
      // matches by name on the next onCreated and rewrites the row to a
      // normal `kind: "list"` entry with the real id.
      await ctx.markServer(
        targetID,
        group.name,
        STATUS.ADDED_BY_SERVER,
        "list-by-name",
      );
      const listId = await addressBook.createMailingList(targetID, {
        name: group.name,
      });
      gMap.set(resourceName, {
        mailingListId: listId,
        etag: group.etag,
        groupType: group.groupType,
      });
      localByListId.set(listId, {
        id: listId,
        name: group.name,
        parentId: targetID,
      });
      added++;
    } else if (mapping.etag !== group.etag || existing.name !== group.name) {
      if (existing.name !== group.name) {
        await ctx.markServer(
          targetID,
          existing.id,
          STATUS.MODIFIED_BY_SERVER,
          "list",
        );
        await addressBook.updateMailingList(existing.id, { name: group.name });
        existing.name = group.name;
      }
      gMap.set(resourceName, {
        mailingListId: existing.id,
        etag: group.etag,
        groupType: group.groupType,
      });
      updated++;
    }
  }

  for (const [listId, rn] of listIdToResourceName) {
    if (seen.has(rn)) continue;
    const list = localByListId.get(listId);
    if (list) {
      await ctx.markServer(targetID, listId, STATUS.DELETED_BY_SERVER, "list");
      await addressBook.deleteMailingList(listId);
    }
    gMap.remove(rn);
    deleted++;
  }

  const memberDelta = await applyMemberships(ctx, byResourceName, memberMap);
  return { added, updated, deleted, ...memberDelta };
}

async function applyMemberships(ctx, byResourceName, memberMap) {
  const { gMap } = ctx;
  let membersAdded = 0,
    membersRemoved = 0;
  const mappings = gMap.listAll();

  for (const [resourceName, entry] of mappings) {
    const listId = entry.mailingListId;
    if (!listId) continue;

    const expectedIds = new Set();
    for (const contactRn of memberMap.get(resourceName) ?? new Set()) {
      const contactEntry = byResourceName.get(contactRn);
      if (contactEntry) expectedIds.add(contactEntry.id);
    }

    const current = await addressBook.listMailingListMembers(listId);
    const currentIds = new Set(current.map((c) => c.id));

    // Each write is pre-tagged, like every other local write here: the host
    // now watches onMemberAdded/onMemberRemoved, so an untagged write of the
    // server's own state comes straight back as a pending user edit and gets
    // pushed again on the next sync, forever.
    for (const id of expectedIds) {
      if (!currentIds.has(id)) {
        try {
          await ctx.markServer(
            listId,
            id,
            STATUS.ADDED_BY_SERVER,
            "membership",
          );
          await addressBook.addMailingListMember(listId, id);
          membersAdded++;
        } catch (err) {
          if (err?.code === PUSH_ERR.NOT_FOUND) {
            ctx.notify.reportEventLog({
              level: "warning",
              accountId: ctx.accountId,
              folderId: ctx.folderId,
              message: `Mailing list membership add skipped - list ${listId} or contact ${id} no longer exists`,
            });
            continue;
          }
          throw err;
        }
      }
    }
    for (const id of currentIds) {
      if (!expectedIds.has(id)) {
        try {
          await ctx.markServer(
            listId,
            id,
            STATUS.DELETED_BY_SERVER,
            "membership",
          );
          await addressBook.removeMailingListMember(listId, id);
          membersRemoved++;
        } catch (err) {
          if (err?.code === PUSH_ERR.NOT_FOUND) {
            ctx.notify.reportEventLog({
              level: "warning",
              accountId: ctx.accountId,
              folderId: ctx.folderId,
              message: `Mailing list membership remove skipped - list ${listId} or contact ${id} no longer exists`,
            });
            continue;
          }
          throw err;
        }
      }
    }
  }
  logDebug(ctx, `memberships: +${membersAdded} -${membersRemoved}`);
  return { membersAdded, membersRemoved };
}

// ── Group push: add + modify ─────────────────────────────────────────────
//
// Walks `_by_user` group entries from the changelog and pushes each to
// Google.

async function runGroupPushAddModifyPass(ctx, userEntries) {
  const groupEntries = userEntries.filter(
    (e) =>
      isGroupEntry(e) &&
      (e.status === STATUS.ADDED_BY_USER ||
        e.status === STATUS.MODIFIED_BY_USER),
  );
  if (!groupEntries.length) return { added: 0, updated: 0 };

  let added = 0,
    updated = 0;
  for (const entry of groupEntries) {
    throwIfCancelled(ctx);
    try {
      const outcome =
        entry.status === STATUS.ADDED_BY_USER
          ? await pushGroupAdd(ctx, entry)
          : await pushGroupModify(ctx, entry);
      if (outcome === "added") added++;
      if (outcome === "updated") updated++;
    } catch (err) {
      ctx.notify.reportEventLog({
        level: "warning",
        accountId: ctx.accountId,
        folderId: ctx.folderId,
        message: `Push group failed (${entry.status} ${entry.itemId}): ${stringifyError(err)}`,
      });
    }
  }
  return { added, updated };
}

async function pushGroupAdd(ctx, entry) {
  const { accountId, gMap } = ctx;
  // entry.itemId is the local mailing-list UID.
  const list = await addressBook.getMailingList(entry.itemId);
  if (!list) {
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "dropped";
  }
  logDebug(ctx, `push.group.add ${list.name}`);
  const created = await peopleApi.createContactGroup(accountId, {
    name: list.name,
  });
  gMap.set(created.resourceName, {
    mailingListId: list.id,
    etag: created.etag,
    groupType: created.groupType,
  });
  await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
  return "added";
}

async function pushGroupModify(ctx, entry) {
  const { accountId, gMap } = ctx;
  // entry.itemId is either a local mailing-list UID or a Google
  // resourceName starting with "contactGroups/" (the latter from
  // migrated profiles).
  let mapping;
  let resourceName;
  let listId;
  if (
    typeof entry.itemId === "string" &&
    entry.itemId.startsWith("contactGroups/")
  ) {
    resourceName = entry.itemId;
    mapping = gMap.get(resourceName);
    if (!mapping) {
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      return "dropped";
    }
    listId = mapping.mailingListId;
  } else {
    listId = entry.itemId;
    mapping = gMap.getByListId(listId);
    if (!mapping) {
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      return "dropped";
    }
    resourceName = mapping.resourceName;
  }
  if (mapping.groupType === SYSTEM_GROUP) {
    // System groups can't be renamed via the People API; just clear
    // the changelog entry so the account doesn't sit in needs-sync.
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "skipped";
  }
  const list = await addressBook.getMailingList(listId);
  if (!list) {
    await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
    return "dropped";
  }
  logDebug(ctx, `push.group.modify ${resourceName}`);
  const updatedGroup = await peopleApi.updateContactGroup(
    accountId,
    resourceName,
    {
      name: list.name,
      etag: mapping.etag,
    },
  );
  gMap.set(updatedGroup.resourceName, {
    mailingListId: listId,
    etag: updatedGroup.etag,
    groupType: updatedGroup.groupType ?? mapping.groupType,
  });
  await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
  return "updated";
}

// ── Group push-deletes ───────────────────────────────────────────────────

async function runGroupPushDeletePass(ctx, userEntries) {
  const { accountId, gMap } = ctx;
  const deletions = userEntries.filter(
    (e) => isGroupEntry(e) && e.status === STATUS.DELETED_BY_USER,
  );
  if (!deletions.length) return { deleted: 0 };

  let deleted = 0;
  for (const entry of deletions) {
    throwIfCancelled(ctx);
    const mapping = gMap.getByListId(entry.itemId);
    if (!mapping) {
      // Never reached the server, or the mapping was lost. Say so: dropping
      // a delete in silence is how a list that keeps coming back looks like
      // a clean sync.
      logDebug(
        ctx,
        `push.group.delete ${entry.itemId} - no group mapping on file, dropping`,
      );
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      continue;
    }
    if (mapping.groupType === SYSTEM_GROUP) {
      // Can't delete system groups via API; just forget the mapping.
      gMap.remove(mapping.resourceName);
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      continue;
    }
    try {
      logDebug(ctx, `push.group.delete ${mapping.resourceName}`);
      await peopleApi.deleteContactGroup(accountId, mapping.resourceName);
      ctx.deletedThisSync.groups.add(mapping.resourceName);
      gMap.remove(mapping.resourceName);
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      deleted++;
    } catch (err) {
      if (err?.code === PUSH_ERR.NOT_FOUND) {
        // Gone already, and a listing taken before it went can still
        // name it - the same window as an accepted delete.
        ctx.deletedThisSync.groups.add(mapping.resourceName);
        gMap.remove(mapping.resourceName);
        await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
        deleted++;
        continue;
      }
      ctx.notify.reportEventLog({
        level: "warning",
        accountId: ctx.accountId,
        folderId: ctx.folderId,
        message: `Push group delete ${mapping.resourceName} failed: ${stringifyError(err)}`,
      });
    }
  }
  return { deleted };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Kind classifiers - one per ROUTED_KINDS, and every pass selects with
 *  its own, positively. Selecting a pass's entries by *excluding* the
 *  other classifiers looked equivalent and was not: an entry with an
 *  unroutable kind matched every exclusion, landed in the group passes,
 *  and `pushGroupModify` dropped it without a log line. runFolderSync now
 *  removes such entries out loud before the passes run, and each pass
 *  takes only what is provably its own. (Migrated rows may still carry a
 *  `contactGroups/…` resource name as their itemId VALUE -
 *  `pushGroupModify` handles that shape - but their kind is always
 *  present.) */
function isMembershipEntry(entry) {
  return entry.kind === "membership";
}

function isGroupEntry(entry) {
  return entry.kind === "list";
}

// ── Membership push ──────────────────────────────────────────────────────
//
// A membership entry names the exact pair the user changed - `parentId` is
// the mailing list, `itemId` the contact - so what goes to Google is that
// one add or removal, not the group's whole membership re-asserted. That
// matters for more than bandwidth: re-asserting would silently undo a member
// added from another device between our syncs, whereas a delta touches only
// what the user actually touched and leaves the rest to the pull.

async function runMembershipPushPass(ctx, userEntries, memberMap) {
  const { accountId, gMap, cMap } = ctx;
  const entries = userEntries.filter(isMembershipEntry);
  if (!entries.length) return { added: 0, removed: 0 };

  // Group by list so one call carries every change to the same group.
  const byGroup = new Map();
  for (const entry of entries) {
    const mapping = gMap.getByListId(entry.parentId);
    const contactRn = cMap.get(entry.itemId);
    if (!mapping || !contactRn) {
      // The list or the contact never reached the server - it was deleted
      // before this ran, or was never pushed. Either way the membership
      // cannot be expressed; drop it rather than retry forever.
      logDebug(
        ctx,
        `push.member ${entry.parentId}/${entry.itemId} - ` +
          `${!mapping ? "list" : "contact"} not on the server, dropping`,
      );
      await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      continue;
    }
    let bucket = byGroup.get(mapping.resourceName);
    if (!bucket) {
      bucket = { add: [], remove: [], entries: [] };
      byGroup.set(mapping.resourceName, bucket);
    }
    if (entry.status === STATUS.DELETED_BY_USER) bucket.remove.push(contactRn);
    else bucket.add.push(contactRn);
    bucket.entries.push(entry);
  }

  let added = 0,
    removed = 0;
  for (const [groupRn, bucket] of byGroup) {
    throwIfCancelled(ctx);
    try {
      logDebug(
        ctx,
        `push.member ${groupRn} +${bucket.add.length} -${bucket.remove.length}`,
      );
      await peopleApi.modifyContactGroupMembers(accountId, groupRn, {
        add: bucket.add,
        remove: bucket.remove,
      });
      added += bucket.add.length;
      removed += bucket.remove.length;
      // Fold the change into the pull's snapshot so the reconciliation
      // below sees the server as it now is, not as it was a step ago.
      if (memberMap) {
        let set = memberMap.get(groupRn);
        if (!set) {
          set = new Set();
          memberMap.set(groupRn, set);
        }
        for (const rn of bucket.add) set.add(rn);
        for (const rn of bucket.remove) set.delete(rn);
      }
      for (const entry of bucket.entries) {
        await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
      }
    } catch (err) {
      if (err?.code === PUSH_ERR.NOT_FOUND) {
        for (const entry of bucket.entries) {
          await ctx.removeEntry(entry.parentId, entry.itemId, entry.kind);
        }
        continue;
      }
      // Leave the entries; the next sync retries.
      ctx.notify.reportEventLog({
        level: "warning",
        accountId: ctx.accountId,
        folderId: ctx.folderId,
        message: `Push membership ${groupRn} failed: ${stringifyError(err)}`,
      });
    }
  }
  return { added, removed };
}

function isContactEntry(entry) {
  // Every entry reaching this carries a kind - runFolderSync parks
  // kind-less rows up front, and the host stamps kind on all v4-migrated
  // rows - so the old resource-name-shape fallback is gone with the
  // profiles that needed it.
  return entry.kind === "contact";
}
