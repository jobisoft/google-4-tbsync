/**
 * Bidirectional sync between a Thunderbird address book and the
 * authenticated user's Google Contacts. Push first (local edits reach the
 * server before pull clobbers them), then pull (server wins on conflict).
 * Contact groups sync bidirectionally; memberships are server→local only.
 * Local writes run inside `suppressDuringSelfWrite` so the watcher ignores
 * our own events. Writes are serial for monotonic progress.
 */

import { ok, warning } from "../../vendor/tbsync/provider.mjs";
import * as peopleApi from "./people-api.mjs";
import { PUSH_ERR } from "./people-api.mjs";
import * as mapper from "./contact-mapper.mjs";
import * as addressBook from "../address-book.mjs";
import * as accounts from "../accounts.mjs";
import * as changelog from "../changelog.mjs";
import * as changelogWatcher from "../changelog-watcher.mjs";
import * as groupMap from "../group-map.mjs";

const SYSTEM_GROUP = "SYSTEM_CONTACT_GROUP";

export async function syncFolderContacts({ accountId, providerAccountId, folderId, targetAbId, notify }) {
  const acc = await accounts.get(providerAccountId);
  const verbose = !!acc?.verboseLogging;
  const includeSystemGroups = !!acc?.includeSystemContactGroups;
  const log = verbose
    ? (msg, data) => console.log(`[google-4-tbsync] ${msg}`, data ?? "")
    : () => {};

  // Clear any stale warning/error from a prior sync. The host never touches
  // these fields — the provider owns their lifecycle.
  await notify.updateFolder({
    accountId, folderId,
    patch: { warning: null, error: null },
  });

  try {
    return await runFolderSync({ accountId, providerAccountId, folderId, targetAbId, notify, acc, verbose, log, includeSystemGroups });
  } catch (err) {
    if (err?.code === "E:AUTH") {
      // Auth failure is account-scoped. The folder list is about to be
      // wiped by the host's reauth flow, so stamping folder.error is
      // wasted work. Put the error on the account record instead — the
      // host's UI reads `error: "E:AUTH"` to render the Sign-in-again CTA.
      await notify.updateAccount({
        accountId,
        patch: { error: "E:AUTH" },
      }).catch(() => { /* best effort — original error still propagates */ });
    } else {
      // Non-auth errors are folder-scoped. Prefer the ERR code (localised
      // on the host) over the raw message.
      await notify.updateFolder({
        accountId, folderId,
        patch: { error: err?.code ?? err?.message ?? "Sync failed" },
      }).catch(() => { /* best effort */ });
    }
    throw err;
  }
}

async function runFolderSync({ accountId, providerAccountId, folderId, targetAbId, notify, acc, verbose, log, includeSystemGroups }) {
  // ── Push pass ──────────────────────────────────────────────────────────
  let pushCounts = { added: 0, updated: 0, deleted: 0, conflicts: 0 };
  const readOnly = !!acc?.readOnlyMode;
  if (readOnly) {
    notify.reportEventLog({
      accountId, folderId,
      severity: "info",
      message: "Push skipped (read-only mode)",
    });
    log("push pass skipped — readOnlyMode");
  } else {
    pushCounts = await runPushPass({ accountId, folderId, providerAccountId, targetAbId, notify, log });
  }

  // ── Pull contacts ──────────────────────────────────────────────────────
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  const people = await peopleApi.listAllConnections(providerAccountId);
  log(`pull: server returned ${people.length} contact(s)`);
  if (verbose && people.length > 0) log("pull: first server contact =", people[0]);

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });
  const local = await addressBook.listContacts(targetAbId);
  log(`pull: local book has ${local.length} card(s)`);
  const byResourceName = new Map();
  for (const card of local) {
    const identity = mapper.readIdentity(card.vCard);
    if (!identity?.resourceName) continue;
    byResourceName.set(identity.resourceName, { id: card.id, etag: identity.etag });
  }
  log(`pull: ${byResourceName.size} local card(s) carry a resourceName stamp`);

  // Map each group's resourceName to the set of contact resourceNames that
  // are members of it. Built from `person.memberships` during the contact
  // pull and consumed by the membership-apply pass after groups are synced.
  const memberMap = new Map();

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
      indexMemberships(memberMap, resourceName, person.memberships);

      const existing = byResourceName.get(resourceName);
      if (!existing) {
        const vCard = mapper.personToVCard(person);
        const newId = await addressBook.createContact(targetAbId, vCard);
        byResourceName.set(resourceName, { id: newId, etag: person.etag });
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
      byResourceName.delete(resourceName);
      pullDeleted++;
    }
  });

  // ── Pull groups + apply memberships ───────────────────────────────────
  const groupCounts = await runGroupPullPass({
    accountId, folderId, providerAccountId, targetAbId,
    includeSystemGroups, byResourceName, memberMap, notify, log,
  });

  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

  const pushSummary = readOnly
    ? "push skipped (read-only)"
    : `push: ${pushCounts.added}+${pushCounts.updated} ↑, ${pushCounts.deleted} ↓${pushCounts.conflicts ? `, ${pushCounts.conflicts} conflicts` : ""}`;
  const pullSummary = `pull: ${pullAdded}+${pullUpdated} ↓, ${pullDeleted} delete${pullSkipped ? `, ${pullSkipped} unchanged` : ""}`;
  const groupSummary = `groups: ${groupCounts.added}+${groupCounts.updated} ↓, ${groupCounts.deleted} delete; members: ${groupCounts.membersAdded}+${groupCounts.membersRemoved}`;
  const summary = `${pushSummary}; ${pullSummary}; ${groupSummary}`;

  // Stamp the folder's lastSyncTime. warning/error were cleared at entry,
  // so a clean sync leaves them null.
  const now = Date.now();
  if (itemsTotal === 0 && local.length > 0 && pullAdded === 0 && pullUpdated === 0) {
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

/** Record each group's membership from a Person's `memberships` list. */
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

// ── Push pass ────────────────────────────────────────────────────────────

/** Push the account's changelog. Dispatches on `kind` (contact | group).
 *  Successful / policy-dropped entries are removed; transient failures are
 *  re-queued. */
async function runPushPass({ accountId, folderId, providerAccountId, targetAbId, notify, log = () => {} }) {
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

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
      const outcome = entry.kind === changelog.KIND.GROUP
        ? await pushGroupEntry(providerAccountId, targetAbId, entry, log)
        : await pushContactEntry(providerAccountId, entry, log);
      if (outcome === "added") added++;
      else if (outcome === "updated") updated++;
      else if (outcome === "deleted") deleted++;
      else if (outcome === "conflict") conflicts++;
    } catch (err) {
      console.warn(
        `[google-4-tbsync] push failed (${entry.kind ?? "contact"} ${entry.status} ${entry.itemId}):`,
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

/** Dispatch a contact changelog entry. */
async function pushContactEntry(providerAccountId, entry, log) {
  if (entry.status === changelog.STATUS.ADDED_BY_USER)    return pushAddEntry(providerAccountId, entry, log);
  if (entry.status === changelog.STATUS.MODIFIED_BY_USER) return pushModifyEntry(providerAccountId, entry, log);
  if (entry.status === changelog.STATUS.DELETED_BY_USER)  return pushDeleteEntry(providerAccountId, entry, log);
  return "dropped";
}

/** Create on server, then stamp the local card with the server's identity. */
async function pushAddEntry(providerAccountId, entry, log) {
  const local = await getContactSafe(entry.itemId);
  if (!local) return "dropped";
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
    // No server identity yet — treat as a new add.
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

/** Fetch a contact; null on "not found". */
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

// ── Groups: push ─────────────────────────────────────────────────────────

/** Dispatch a group changelog entry. */
async function pushGroupEntry(providerAccountId, targetAbId, entry, log) {
  if (entry.status === changelog.STATUS.ADDED_BY_USER) {
    return pushGroupAdd(providerAccountId, targetAbId, entry, log);
  }
  if (entry.status === changelog.STATUS.MODIFIED_BY_USER) {
    return pushGroupModify(providerAccountId, entry, log);
  }
  if (entry.status === changelog.STATUS.DELETED_BY_USER) {
    return pushGroupDelete(providerAccountId, entry, log);
  }
  return "dropped";
}

/** Create a user contact group on Google from a locally-added mailing list. */
async function pushGroupAdd(providerAccountId, _targetAbId, entry, log) {
  const list = await addressBook.getMailingList(entry.itemId);
  if (!list) return "dropped";
  log(`push.group.add ${entry.itemId} — sending to Google: ${list.name}`);
  const group = await peopleApi.createContactGroup(providerAccountId, { name: list.name });
  log(`push.group.add ${entry.itemId} — server returned:`, { resourceName: group.resourceName, etag: group.etag });
  await groupMap.set(providerAccountId, group.resourceName, {
    mailingListId: entry.itemId,
    etag: group.etag,
    groupType: group.groupType ?? "USER_CONTACT_GROUP",
  });
  return "added";
}

/** Rename a user contact group on Google when the local mailing list was
 *  renamed. System groups are skipped (Google rejects the edit). */
async function pushGroupModify(providerAccountId, entry, log) {
  const list = await addressBook.getMailingList(entry.itemId);
  if (!list) return "dropped";
  const mapping = await groupMap.getByListId(providerAccountId, entry.itemId);
  if (!mapping) {
    // No server identity — treat as a new add.
    log(`push.group.modify ${entry.itemId} — no mapping, creating instead`);
    return pushGroupAdd(providerAccountId, null, entry, log);
  }
  if (mapping.groupType === SYSTEM_GROUP) {
    log(`push.group.modify ${mapping.resourceName} — system group, skipping`);
    return "dropped";
  }
  log(`push.group.modify ${mapping.resourceName} — renaming to: ${list.name}`);
  try {
    const group = await peopleApi.updateContactGroup(providerAccountId, mapping.resourceName, {
      name: list.name,
      etag: mapping.etag,
    });
    await groupMap.set(providerAccountId, mapping.resourceName, {
      mailingListId: entry.itemId,
      etag: group.etag,
      groupType: group.groupType ?? mapping.groupType,
    });
    return "updated";
  } catch (err) {
    if (err?.code === PUSH_ERR.CONFLICT) {
      log(`push.group.modify ${mapping.resourceName} — CONFLICT, dropping (pull will reconcile)`);
      return "conflict";
    }
    if (err?.code === PUSH_ERR.NOT_FOUND) {
      log(`push.group.modify ${mapping.resourceName} — server group gone, deleting local`);
      await groupMap.remove(providerAccountId, mapping.resourceName);
      await changelogWatcher.suppressDuringSelfWrite(() =>
        addressBook.deleteMailingList(entry.itemId)
      );
      return "deleted";
    }
    throw err;
  }
}

/** Delete a user contact group on Google. */
async function pushGroupDelete(providerAccountId, entry, log) {
  if (!entry.resourceName) return "dropped";
  log(`push.group.delete ${entry.resourceName} — sending to Google`);
  try {
    await peopleApi.deleteContactGroup(providerAccountId, entry.resourceName);
  } catch (err) {
    if (err?.code !== PUSH_ERR.NOT_FOUND) throw err;
    log(`push.group.delete ${entry.resourceName} — already gone`);
  }
  await groupMap.remove(providerAccountId, entry.resourceName);
  return "deleted";
}

// ── Groups: pull + memberships ──────────────────────────────────────────

/**
 * Pull all server groups, reconcile local mailing lists against them, then
 * apply the member-map computed during contact pull. All writes wrapped in
 * `suppressDuringSelfWrite`.
 */
async function runGroupPullPass({
  accountId, folderId, providerAccountId, targetAbId,
  includeSystemGroups, byResourceName, memberMap, notify, log,
}) {
  notify.reportSyncState({ accountId, folderId, syncState: "sync" });

  const serverGroups = await peopleApi.listAllContactGroups(providerAccountId);
  const eligible = serverGroups.filter(g =>
    includeSystemGroups || g.groupType !== SYSTEM_GROUP
  );
  log(`groups: server returned ${serverGroups.length} (${eligible.length} after system-group filter)`);

  const localLists = await addressBook.listMailingLists(targetAbId);
  const localByListId = new Map(localLists.map(l => [l.id, l]));

  // listId → expected resourceName from the map; inverse of what we'll build.
  const listIdToResourceName = new Map();
  for (const [rn, entry] of await groupMap.listAll(providerAccountId)) {
    if (entry.mailingListId) listIdToResourceName.set(entry.mailingListId, rn);
  }

  let added = 0, updated = 0, deleted = 0;
  const seenResourceNames = new Set();

  await changelogWatcher.suppressDuringSelfWrite(async () => {
    for (const group of eligible) {
      const resourceName = group.resourceName;
      seenResourceNames.add(resourceName);
      const mapping = await groupMap.get(providerAccountId, resourceName);
      const existing = mapping?.mailingListId
        ? localByListId.get(mapping.mailingListId)
        : null;

      if (!existing) {
        const listId = await addressBook.createMailingList(targetAbId, { name: group.name });
        await groupMap.set(providerAccountId, resourceName, {
          mailingListId: listId,
          etag: group.etag,
          groupType: group.groupType,
        });
        localByListId.set(listId, { id: listId, name: group.name, parentId: targetAbId });
        added++;
      } else if (mapping.etag !== group.etag || existing.name !== group.name) {
        if (existing.name !== group.name) {
          await addressBook.updateMailingList(existing.id, { name: group.name });
          existing.name = group.name;
        }
        await groupMap.set(providerAccountId, resourceName, {
          mailingListId: existing.id,
          etag: group.etag,
          groupType: group.groupType,
        });
        updated++;
      }
    }

    // Delete local mailing lists whose resourceName isn't in the server set
    // (or was filtered out by the system-group toggle).
    for (const [listId, rn] of listIdToResourceName) {
      if (seenResourceNames.has(rn)) continue;
      const list = localByListId.get(listId);
      if (list) await addressBook.deleteMailingList(listId);
      await groupMap.remove(providerAccountId, rn);
      deleted++;
    }
  });

  // Memberships: apply server's member-map to each synced group.
  const memberDelta = await applyMemberships({
    providerAccountId, byResourceName, memberMap, notify, log,
  });

  return { added, updated, deleted, ...memberDelta };
}

async function applyMemberships({ providerAccountId, byResourceName, memberMap, notify, log }) {
  let membersAdded = 0, membersRemoved = 0;
  const mappings = await groupMap.listAll(providerAccountId);

  await changelogWatcher.suppressDuringSelfWrite(async () => {
    for (const [resourceName, entry] of mappings) {
      const listId = entry.mailingListId;
      if (!listId) continue;

      const expectedContactIds = new Set();
      const expectedMembers = memberMap.get(resourceName) ?? new Set();
      for (const contactRn of expectedMembers) {
        const contactEntry = byResourceName.get(contactRn);
        if (contactEntry) expectedContactIds.add(contactEntry.id);
      }

      const current = await addressBook.listMailingListMembers(listId);
      const currentIds = new Set(current.map(c => c.id));

      for (const id of expectedContactIds) {
        if (!currentIds.has(id)) {
          await addressBook.addMailingListMember(listId, id);
          membersAdded++;
        }
      }
      for (const id of currentIds) {
        if (!expectedContactIds.has(id)) {
          await addressBook.removeMailingListMember(listId, id);
          membersRemoved++;
        }
      }
    }
  });

  log(`memberships: +${membersAdded} -${membersRemoved}`);
  return { membersAdded, membersRemoved };
}
