/**
 * Bidirectional sync between a Thunderbird address book and the
 * authenticated user's Google Contacts. Flow:
 *   1. Push adds + modifies from the host's changelog to Google.
 *   2. Pull all server contacts; reconcile local.
 *   3. Push-delete reconciliation: local cards that are gone but whose
 *      resourceName is still on the server → delete on the server.
 *   4. Groups: mirror of the contact flow, via `groupMap`.
 *
 * Contact groups sync bidirectionally; memberships are server→local only.
 * Every local write is preceded by `notify.changelogMarkServerWrite` so
 * the host's observer suppresses the resulting TB event. Writes are serial
 * for monotonic progress.
 */

import { ERR, ok, warning } from "../../vendor/tbsync/provider.mjs";
import * as peopleApi from "./people-api.mjs";
import * as mapper from "./contact-mapper.mjs";
import * as addressBook from "../address-book.mjs";
import { GroupMap } from "../group-map.mjs";
import { ContactMap } from "../contact-map.mjs";
import { DEBUG_STATUS_DELAY_MS } from "../debug.mjs";
import { stringifyError, PUSH_ERR } from "../errors.mjs";

const STATUS = {
  ADDED_BY_USER:      "added_by_user",
  MODIFIED_BY_USER:   "modified_by_user",
  DELETED_BY_USER:    "deleted_by_user",
  ADDED_BY_SERVER:    "added_by_server",
  MODIFIED_BY_SERVER: "modified_by_server",
  DELETED_BY_SERVER:  "deleted_by_server",
};
const SYSTEM_GROUP = "SYSTEM_CONTACT_GROUP";

// ── Entry point ─────────────────────────────────────────────────────────

/** Push a debug-level entry into the host's session event log. Verbosity is
 *  now driven by the host-level capture gate (settings.logLevel); the provider
 *  always emits, the host decides whether to retain. */
function logDebug(ctx, message, details) {
  ctx.notify.reportEventLog({
    level: "debug",
    accountId: ctx.accountId,
    folderId: ctx.folderId,
    message,
    ...(details !== undefined ? { details } : {}),
  });
}

export async function syncFolderContacts({ accountId, folderId, folder, account, notify }) {
  const targetID = folder?.targetID;
  const readOnly = !!account?.custom.readOnlyMode;
  const includeSystemGroups = !!account?.custom.includeSystemContactGroups;

  // Host-owned changelog and the in-memory provider maps (flushed at end).
  const changelog = Array.isArray(folder?.custom.changelog) ? folder.custom.changelog : [];
  const gMap = new GroupMap(folder?.custom.groupMap);
  const cMap = new ContactMap(folder?.custom.contactMap);

  // Pre-tag helper: every messenger.contacts.* / messenger.mailingLists.*
  // call we make must be preceded by a *_by_server entry so the host
  // observer drops the resulting TB event as self-inflicted.
  const ctx = {
    accountId, folderId, targetID,
    notify, readOnly, includeSystemGroups,
    gMap, cMap, changelog,
    markServer: (parentId, itemId, status) =>
      notify.changelogMarkServerWrite({ accountId, folderId, parentId, itemId, status }),
    removeEntry: (parentId, itemId) =>
      notify.changelogRemove({ accountId, folderId, parentId, itemId }),
  };

  // Clear any stale folder-level warning/error from a prior sync.
  await notify.updateFolder({
    accountId, folderId,
    patch: { warning: null, error: null },
  });

  try {
    const rv = await runFolderSync(ctx);
    await flushMaps(notify, accountId, folderId, gMap, cMap);
    return rv;
  } catch (err) {
    // Best-effort flush of in-progress groupMap/contactMap so a retry can
    // pick up where we left off. Log on failure so a broken flush doesn't
    // silently accumulate drift.
    await flushMaps(notify, accountId, folderId, gMap, cMap).catch(flushErr => {
      console.warn("[google-4-tbsync] flushMaps during error handling failed:", stringifyError(flushErr));
    });
    if (err?.code === ERR.AUTH) {
      await notify.updateAccount({
        accountId,
        patch: { error: ERR.AUTH },
      }).catch(() => { });
    } else {
      await notify.updateFolder({
        accountId, folderId,
        patch: { error: err?.code ?? err?.message ?? "Sync failed" },
      }).catch(() => { });
    }
    throw err;
  }
}

async function flushMaps(notify, accountId, folderId, gMap, cMap) {
  const customPatch = {};
  if (gMap.dirty) customPatch.groupMap = gMap.toJSON();
  if (cMap.dirty) customPatch.contactMap = cMap.toJSON();
  if (!Object.keys(customPatch).length) return;
  await notify.updateFolder({ accountId, folderId, patch: { custom: customPatch } });
  gMap.dirty = false;
  cMap.dirty = false;
}

// ── Main flow ────────────────────────────────────────────────────────────

async function runFolderSync(ctx) {
  const { notify, accountId, folderId, readOnly, changelog } = ctx;

  const userEntries = changelog.filter(e =>
    e.status === STATUS.ADDED_BY_USER ||
    e.status === STATUS.MODIFIED_BY_USER ||
    e.status === STATUS.DELETED_BY_USER
  );
  logDebug(ctx, `changelog: ${userEntries.length} pending user entries`);

  // 1. Push adds + modifies (deletes handled by reconciliation after pull).
  let pushCounts = { added: 0, updated: 0, deleted: 0, conflicts: 0 };
  if (readOnly) {
    notify.reportEventLog({
      accountId, folderId, level: "warning",
      message: "Push skipped (read-only mode)",
    });
  } else {
    pushCounts = await runPushAddModifyPass(ctx, userEntries);
  }

  // 2. Pull contacts - server → local reconciliation.
  const pull = await runPullPass(ctx);

  // 3. Push-delete reconciliation - user-deleted cards whose resourceName
  //    is still on the server.
  if (!readOnly) {
    const deleteStats = await runPushDeletePass(ctx, userEntries, pull.serverResourceNames);
    pushCounts.deleted = deleteStats.deleted;
  }

  // 4. Groups - mirror contact flow. Push-add-modify before pull so any
  //    new local group exists server-side (and is in gMap) before the
  //    pull pass walks the server's group list - otherwise the pull
  //    would see the just-pushed group as "new on server" and create a
  //    duplicate local list.
  let groupPushAddMod = { added: 0, updated: 0 };
  if (!ctx.readOnly) {
    groupPushAddMod = await runGroupPushAddModifyPass(ctx, userEntries);
  }
  const groupCounts = await runGroupPullPass(ctx, pull.byResourceName, pull.memberMap);
  groupCounts.added   += groupPushAddMod.added;
  groupCounts.updated += groupPushAddMod.updated;
  if (!ctx.readOnly) {
    const groupDelCounts = await runGroupPushDeletePass(ctx, userEntries);
    groupCounts.deleted += groupDelCounts.deleted;
  }

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));

  const pushSummary = readOnly
    ? "push skipped (read-only)"
    : `push: ${pushCounts.added}+${pushCounts.updated} ↑, ${pushCounts.deleted} ↓${pushCounts.conflicts ? `, ${pushCounts.conflicts} conflicts` : ""}`;
  const pullSummary = `pull: ${pull.added}+${pull.updated} ↓, ${pull.deleted} delete${pull.skipped ? `, ${pull.skipped} unchanged` : ""}`;
  const groupSummary = `groups: ${groupCounts.added}+${groupCounts.updated} ↓, ${groupCounts.deleted} delete; members: ${groupCounts.membersAdded}+${groupCounts.membersRemoved}`;
  const summary = `${pushSummary}; ${pullSummary}; ${groupSummary}`;

  const now = Date.now();
  if (pull.itemsTotal === 0 && pull.localCount > 0 && pull.added === 0 && pull.updated === 0) {
    await notify.updateFolder({
      accountId, folderId,
      patch: { warning: "Server returned 0 contacts", lastSyncTime: now },
    });
    return warning("Server returned 0 contacts", summary);
  }
  await notify.updateFolder({
    accountId, folderId,
    patch: { lastSyncTime: now },
  });
  return ok(summary);
}

// ── Push pass (adds + modifies) ──────────────────────────────────────────

async function runPushAddModifyPass(ctx, userEntries) {
  const { notify, accountId, folderId } = ctx;
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));

  // Contact entries only; groups handled in the groups pass.
  const entries = userEntries.filter(e => isContactEntry(e));
  const actionable = entries.filter(e =>
    e.status === STATUS.ADDED_BY_USER || e.status === STATUS.MODIFIED_BY_USER
  );

  let added = 0, updated = 0, conflicts = 0;
  const total = actionable.length;
  if (total > 0) {
    notify.reportProgress({ accountId, folderId, itemsDone: 0, itemsTotal: total });
    await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
  }
  let done = 0;

  for (const entry of actionable) {
    try {
      const outcome = entry.status === STATUS.ADDED_BY_USER
        ? await pushAdd(ctx, entry)
        : await pushModify(ctx, entry);
      if (outcome === "added")    added++;
      if (outcome === "updated")  updated++;
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
    notify.reportProgress({ accountId, folderId, itemsDone: done, itemsTotal: total });
    await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
  }
  return { added, updated, deleted: 0, conflicts };
}

async function pushAdd(ctx, entry) {
  const { accountId, cMap } = ctx;
  const local = await addressBook.getContact(entry.itemId);
  if (!local) {
    // Card gone before we got to push it - add+del cancelled or something
    // external dropped it. Nothing to do.
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "dropped";
  }
  const person = mapper.vCardToPerson(local.vCard);
  logDebug(ctx, `push.add ${entry.itemId} - creating on Google`);
  const serverPerson = await peopleApi.createContact(accountId, person);
  logDebug(ctx, `push.add ${entry.itemId} - server resourceName=${serverPerson.resourceName}`);
  await stampLocalCard(ctx, entry.itemId, local.vCard, serverPerson);
  cMap.set(entry.itemId, serverPerson.resourceName);
  await ctx.removeEntry(entry.parentId, entry.itemId);
  return "added";
}

async function pushModify(ctx, entry) {
  const { accountId, cMap } = ctx;
  const local = await addressBook.getContact(entry.itemId);
  if (!local) {
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "dropped";
  }
  const identity = mapper.readIdentity(local.vCard);
  if (!identity?.resourceName) {
    // No server identity yet - treat as a late add.
    const person = mapper.vCardToPerson(local.vCard);
    logDebug(ctx, `push.modify ${entry.itemId} - no server identity, creating instead`);
    const serverPerson = await peopleApi.createContact(accountId, person);
    await stampLocalCard(ctx, entry.itemId, local.vCard, serverPerson);
    cMap.set(entry.itemId, serverPerson.resourceName);
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "added";
  }
  const person = mapper.vCardToPerson(local.vCard);
  logDebug(ctx, `push.modify ${identity.resourceName}`);
  try {
    const serverPerson = await peopleApi.updateContact(
      accountId, identity.resourceName, person, identity.etag
    );
    await stampLocalCard(ctx, entry.itemId, local.vCard, serverPerson);
    cMap.set(entry.itemId, serverPerson.resourceName);
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "updated";
  } catch (err) {
    if (err?.code === PUSH_ERR.CONFLICT) {
      logDebug(ctx, `push.modify ${identity.resourceName} - CONFLICT, dropping (pull will reconcile)`);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      return "conflict";
    }
    if (err?.code === PUSH_ERR.NOT_FOUND) {
      logDebug(ctx, `push.modify ${identity.resourceName} - server contact gone, deleting local`);
      await ctx.markServer(entry.parentId, entry.itemId, STATUS.DELETED_BY_SERVER);
      await addressBook.deleteContact(entry.itemId);
      cMap.remove(entry.itemId);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      return "deleted";
    }
    throw err;
  }
}

/** Stamp the local card with `{resourceName, etag}` from the server.
 *  Writes via the host's observer-aware pre-tag so the stamp-update
 *  doesn't echo back as a user edit. */
async function stampLocalCard(ctx, contactId, originalVCard, serverPerson) {
  const stamped = mapper.stampIdentity(originalVCard, {
    resourceName: serverPerson.resourceName,
    etag: serverPerson.etag,
  });
  await ctx.markServer(ctx.targetID, contactId, STATUS.MODIFIED_BY_SERVER);
  await addressBook.updateContact(contactId, stamped);
}

// ── Pull pass ────────────────────────────────────────────────────────────

async function runPullPass(ctx) {
  const { notify, accountId, folderId, targetID, cMap } = ctx;

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
  const people = await peopleApi.listAllConnections(accountId);
  logDebug(ctx, `pull: server returned ${people.length} contact(s)`);

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
  const local = await addressBook.listContacts(targetID);
  logDebug(ctx, `pull: local book has ${local.length} card(s)`);

  // byResourceName: snapshot of pre-pull local state, keyed by stamped
  // resourceName. Used to decide create-vs-update and (after the pass)
  // to detect server contacts we never saw (push-delete candidates).
  const byResourceName = new Map();
  for (const card of local) {
    const identity = mapper.readIdentity(card.vCard);
    if (!identity?.resourceName) continue;
    byResourceName.set(identity.resourceName, { id: card.id, etag: identity.etag });
    cMap.set(card.id, identity.resourceName);
  }

  const memberMap = new Map();   // groupRn → Set<contactRn>
  const itemsTotal = people.length;
  let itemsDone = 0;
  let added = 0, updated = 0, skipped = 0, deleted = 0;

  notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));

  const serverResourceNames = new Set();
  for (const person of people) {
    const resourceName = person.resourceName;
    if (!resourceName) { itemsDone++; continue; }
    serverResourceNames.add(resourceName);
    indexMemberships(memberMap, resourceName, person.memberships);

    const existing = byResourceName.get(resourceName);
    if (!existing) {
      // Pull-create: book wasn't aware of this contact.
      const vCard = mapper.personToVCard(person);
      // Wildcard pre-tag: we don't know the new itemId yet. Watcher
      // upgrades this to a concrete tag when onCreated fires.
      await ctx.markServer(targetID, null, STATUS.ADDED_BY_SERVER);
      const newId = await addressBook.createContact(targetID, vCard);
      byResourceName.set(resourceName, { id: newId, etag: person.etag });
      cMap.set(newId, resourceName);
      added++;
    } else if (existing.etag !== person.etag) {
      // Pull-update: server's version is newer.
      const vCard = mapper.personToVCard(person);
      await ctx.markServer(targetID, existing.id, STATUS.MODIFIED_BY_SERVER);
      await addressBook.updateContact(existing.id, vCard);
      updated++;
    } else {
      skipped++;
    }
    itemsDone++;
    notify.reportProgress({ accountId, folderId, itemsDone, itemsTotal });
    await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));
  }

  // Pull-delete: server dropped contacts we still have - mirror locally.
  for (const [resourceName, entry] of byResourceName) {
    if (serverResourceNames.has(resourceName)) continue;
    await ctx.markServer(targetID, entry.id, STATUS.DELETED_BY_SERVER);
    await addressBook.deleteContact(entry.id);
    cMap.remove(entry.id);
    byResourceName.delete(resourceName);
    deleted++;
  }

  return { byResourceName, memberMap, itemsTotal, localCount: local.length, added, updated, skipped, deleted, serverResourceNames };
}

function indexMemberships(memberMap, contactResourceName, memberships) {
  if (!Array.isArray(memberships)) return;
  for (const m of memberships) {
    const groupRn = m?.contactGroupMembership?.contactGroupResourceName;
    if (!groupRn) continue;
    let set = memberMap.get(groupRn);
    if (!set) { set = new Set(); memberMap.set(groupRn, set); }
    set.add(contactResourceName);
  }
}

// ── Push-delete reconciliation ───────────────────────────────────────────

async function runPushDeletePass(ctx, userEntries, serverResourceNames) {
  const { accountId, cMap } = ctx;
  const deletions = userEntries.filter(
    e => isContactEntry(e) && e.status === STATUS.DELETED_BY_USER
  );
  if (!deletions.length) return { deleted: 0 };

  let deleted = 0;
  for (const entry of deletions) {
    const resourceName = cMap.get(entry.itemId);
    if (!resourceName) {
      // Never-synced-or-already-gone → just drop the entry.
      logDebug(ctx, `push.delete ${entry.itemId} - no resourceName on file, dropping`);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      continue;
    }
    if (!serverResourceNames.has(resourceName)) {
      // Server already dropped it; nothing to push.
      logDebug(ctx, `push.delete ${resourceName} - already gone on server`);
      cMap.remove(entry.itemId);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      continue;
    }
    try {
      logDebug(ctx, `push.delete ${resourceName}`);
      await peopleApi.deleteContact(accountId, resourceName);
      cMap.remove(entry.itemId);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      deleted++;
    } catch (err) {
      if (err?.code === PUSH_ERR.NOT_FOUND) {
        cMap.remove(entry.itemId);
        await ctx.removeEntry(entry.parentId, entry.itemId);
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
  const { notify, accountId, folderId, targetID, gMap, includeSystemGroups } = ctx;
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  await new Promise(r => setTimeout(r, DEBUG_STATUS_DELAY_MS));

  const serverGroups = await peopleApi.listAllContactGroups(accountId);
  const eligible = serverGroups.filter(g =>
    includeSystemGroups || g.groupType !== SYSTEM_GROUP
  );
  logDebug(ctx, `groups: server returned ${serverGroups.length} (${eligible.length} after system-group filter)`);

  const localLists = await addressBook.listMailingLists(targetID);
  const localByListId = new Map(localLists.map(l => [l.id, l]));

  const listIdToResourceName = new Map();
  for (const [rn, entry] of gMap.listAll()) {
    if (entry.mailingListId) listIdToResourceName.set(entry.mailingListId, rn);
  }

  let added = 0, updated = 0, deleted = 0;
  const seen = new Set();

  for (const group of eligible) {
    const resourceName = group.resourceName;
    seen.add(resourceName);
    const mapping = gMap.get(resourceName);
    const existing = mapping?.mailingListId ? localByListId.get(mapping.mailingListId) : null;

    if (!existing) {
      await ctx.markServer(targetID, null, STATUS.ADDED_BY_SERVER);
      const listId = await addressBook.createMailingList(targetID, { name: group.name });
      gMap.set(resourceName, {
        mailingListId: listId, etag: group.etag, groupType: group.groupType,
      });
      localByListId.set(listId, { id: listId, name: group.name, parentId: targetID });
      added++;
    } else if (mapping.etag !== group.etag || existing.name !== group.name) {
      if (existing.name !== group.name) {
        await ctx.markServer(targetID, existing.id, STATUS.MODIFIED_BY_SERVER);
        await addressBook.updateMailingList(existing.id, { name: group.name });
        existing.name = group.name;
      }
      gMap.set(resourceName, {
        mailingListId: existing.id, etag: group.etag, groupType: group.groupType,
      });
      updated++;
    }
  }

  for (const [listId, rn] of listIdToResourceName) {
    if (seen.has(rn)) continue;
    const list = localByListId.get(listId);
    if (list) {
      await ctx.markServer(targetID, listId, STATUS.DELETED_BY_SERVER);
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
  let membersAdded = 0, membersRemoved = 0;
  const mappings = gMap.listAll();

  for (const [resourceName, entry] of mappings) {
    const listId = entry.mailingListId;
    if (!listId) continue;

    const expectedIds = new Set();
    for (const contactRn of (memberMap.get(resourceName) ?? new Set())) {
      const contactEntry = byResourceName.get(contactRn);
      if (contactEntry) expectedIds.add(contactEntry.id);
    }

    const current = await addressBook.listMailingListMembers(listId);
    const currentIds = new Set(current.map(c => c.id));

    for (const id of expectedIds) {
      if (!currentIds.has(id)) {
        // Note: mailingLists.addMember doesn't emit a contact-level event
        // we need to suppress - mailing-list member changes fire their
        // own event type (onMemberAdded/onMemberRemoved) that we don't
        // track. Still, pre-tag defensively in case TB changes behaviour.
        await ctx.markServer(listId, id, STATUS.MODIFIED_BY_SERVER);
        try {
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
        await ctx.markServer(listId, id, STATUS.MODIFIED_BY_SERVER);
        try {
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
// Mirrors the legacy provider's `synchronizeContactGroups` add/modify
// loops. Walks `_by_user` group entries from the changelog and pushes
// each to Google. The watcher annotates new entries with `kind: "list"`;
// migrated legacy entries lack `kind` but use `contactGroups/…` as the
// itemId, which `isContactEntry` recognises and routes here.

async function runGroupPushAddModifyPass(ctx, userEntries) {
  const groupEntries = userEntries.filter(e =>
    !isContactEntry(e) && (
      e.status === STATUS.ADDED_BY_USER ||
      e.status === STATUS.MODIFIED_BY_USER
    )
  );
  if (!groupEntries.length) return { added: 0, updated: 0 };

  let added = 0, updated = 0;
  for (const entry of groupEntries) {
    try {
      const outcome = entry.status === STATUS.ADDED_BY_USER
        ? await pushGroupAdd(ctx, entry)
        : await pushGroupModify(ctx, entry);
      if (outcome === "added")   added++;
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
  // Post-watcher: itemId is the local mailing-list UID. Legacy never
  // left ADDED_BY_USER group entries un-pushed across an upgrade
  // (the legacy sync flushed them before the user updated the add-on).
  const list = await addressBook.getMailingList(entry.itemId);
  if (!list) {
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "dropped";
  }
  logDebug(ctx, `push.group.add ${list.name}`);
  const created = await peopleApi.createContactGroup(accountId, { name: list.name });
  gMap.set(created.resourceName, {
    mailingListId: list.id,
    etag: created.etag,
    groupType: created.groupType,
  });
  await ctx.removeEntry(entry.parentId, entry.itemId);
  return "added";
}

async function pushGroupModify(ctx, entry) {
  const { accountId, gMap } = ctx;
  // entry.itemId can be either:
  //   - a local mailing-list UID (post-watcher entries)
  //   - a Google resourceName "contactGroups/…" (migrated legacy
  //     entries - TbSync's wrapper routed legacy mailing-list property
  //     writes through the changelog DB keyed by the primary-key field,
  //     which the Google provider set to X-GOOGLE-RESOURCENAME).
  let mapping;
  let resourceName;
  let listId;
  if (typeof entry.itemId === "string" && entry.itemId.startsWith("contactGroups/")) {
    resourceName = entry.itemId;
    mapping = gMap.get(resourceName);
    if (!mapping) {
      await ctx.removeEntry(entry.parentId, entry.itemId);
      return "dropped";
    }
    listId = mapping.mailingListId;
  } else {
    listId = entry.itemId;
    mapping = gMap.getByListId(listId);
    if (!mapping) {
      await ctx.removeEntry(entry.parentId, entry.itemId);
      return "dropped";
    }
    resourceName = mapping.resourceName;
  }
  if (mapping.groupType === SYSTEM_GROUP) {
    // System groups can't be renamed via the People API; just clear
    // the changelog entry so the account doesn't sit in needs-sync.
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "skipped";
  }
  const list = await addressBook.getMailingList(listId);
  if (!list) {
    await ctx.removeEntry(entry.parentId, entry.itemId);
    return "dropped";
  }
  logDebug(ctx, `push.group.modify ${resourceName}`);
  const updatedGroup = await peopleApi.updateContactGroup(accountId, resourceName, {
    name: list.name,
    etag: mapping.etag,
  });
  gMap.set(updatedGroup.resourceName, {
    mailingListId: listId,
    etag: updatedGroup.etag,
    groupType: updatedGroup.groupType ?? mapping.groupType,
  });
  await ctx.removeEntry(entry.parentId, entry.itemId);
  return "updated";
}

// ── Group push-deletes ───────────────────────────────────────────────────

async function runGroupPushDeletePass(ctx, userEntries) {
  const { accountId, gMap } = ctx;
  const deletions = userEntries.filter(
    e => !isContactEntry(e) && e.status === STATUS.DELETED_BY_USER
  );
  if (!deletions.length) return { deleted: 0 };

  let deleted = 0;
  for (const entry of deletions) {
    const mapping = gMap.getByListId(entry.itemId);
    if (!mapping) {
      await ctx.removeEntry(entry.parentId, entry.itemId);
      continue;
    }
    if (mapping.groupType === SYSTEM_GROUP) {
      // Can't delete system groups via API; just forget the mapping.
      gMap.remove(mapping.resourceName);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      continue;
    }
    try {
      logDebug(ctx, `push.group.delete ${mapping.resourceName}`);
      await peopleApi.deleteContactGroup(accountId, mapping.resourceName);
      gMap.remove(mapping.resourceName);
      await ctx.removeEntry(entry.parentId, entry.itemId);
      deleted++;
    } catch (err) {
      if (err?.code === PUSH_ERR.NOT_FOUND) {
        gMap.remove(mapping.resourceName);
        await ctx.removeEntry(entry.parentId, entry.itemId);
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

/**
 * Contact vs. group discrimination from the host's agnostic entry shape.
 * The changelog entry only knows `parentId` (bookId for contacts, bookId
 * for lists too) and `itemId`. We distinguish by asking the address book:
 * mailing lists have their own `messenger.mailingLists.*` namespace.
 *
 * In practice the watcher dispatches both kinds into the same folder's
 * queue; we check if the itemId resolves to a mailing list to route.
 *
 * Performance: the observer could mark `kind` on the entry, but keeping
 * it provider-interpreted avoids host-side coupling. We cache the lookup
 * per entry.
 */
function isContactEntry(entry) {
  // The watcher annotates contemporary entries with `kind`; migrated
  // legacy entries lack it. For those we fall back to the itemId
  // shape: Google's contact-group resource names start with
  // `contactGroups/` - anything else is taken as a contact entry.
  if (entry.kind === "list")    return false;
  if (entry.kind === "contact") return true;
  if (typeof entry.itemId === "string" && entry.itemId.startsWith("contactGroups/")) {
    return false;
  }
  return true;
}
