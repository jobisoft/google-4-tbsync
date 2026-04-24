import * as changelog from "./changelog.mjs";
import * as mapper from "./google/contact-mapper.mjs";
import * as addressBook from "./address-book.mjs";
import * as groupMap from "./group-map.mjs";

/**
 * Record user-initiated contact and mailing-list changes into the changelog.
 *
 * Only watches books the provider owns (tracked via register/unregister).
 * `suppressDuringSelfWrite` mutes the watcher during server→local writes
 * so our own events don't echo back; concurrent user edits during a sync
 * are also dropped (next pull reconciles).
 *
 * Identity for deleted items:
 *   - Contacts: delete events carry no vCard, so we keep an in-memory
 *     `contactId → resourceName` cache populated at register time and on
 *     every create/update.
 *   - Mailing lists: we look up `resourceName` via the group-map at event
 *     time. If the map entry is gone (e.g. list never synced), the delete
 *     changelog entry carries `resourceName: null` and the push pass drops it.
 *
 * Membership changes (onMemberAdded / onMemberRemoved) are intentionally
 * not tracked: memberships are server→local only.
 */

const registeredBooks = new Map();   // targetAbId → providerAccountId
const idToResourceName = new Map();  // contactId → resourceName
let selfWriteDepth = 0;

/** Watch a book and prime the identity cache from its contents. */
export async function registerTarget(targetAbId, providerAccountId) {
  if (!targetAbId || !providerAccountId) return;
  registeredBooks.set(targetAbId, providerAccountId);
  const contacts = await addressBook.listContacts(targetAbId);
  for (const c of contacts) {
    const resourceName = mapper.readIdentity(c.vCard)?.resourceName ?? null;
    if (resourceName) idToResourceName.set(c.id, resourceName);
  }
}

/** Stop watching a book. Identity-cache entries are left as-is; no future
 *  event will reference them. */
export function unregisterTarget(targetAbId) {
  if (!targetAbId) return;
  registeredBooks.delete(targetAbId);
}

/** Run `fn` with the watcher muted. The trailing `setTimeout(0)` lets any
 *  not-yet-delivered events drain before we re-enable. */
export async function suppressDuringSelfWrite(fn) {
  selfWriteDepth++;
  try {
    return await fn();
  } finally {
    await new Promise(r => setTimeout(r, 0));
    selfWriteDepth--;
  }
}

/** Update the identity cache after a self-write. */
export function rememberIdentity(contactId, resourceName) {
  if (contactId && resourceName) idToResourceName.set(contactId, resourceName);
}

export function init() {
  messenger.contacts.onCreated.addListener(node => onContactEvent("added", node));
  messenger.contacts.onUpdated.addListener(node => onContactEvent("modified", node));
  messenger.contacts.onDeleted.addListener((parentId, id) =>
    onContactEvent("deleted", { parentId, id, vCard: null })
  );
  messenger.mailingLists.onCreated.addListener(node => onMailingListEvent("added", node));
  messenger.mailingLists.onUpdated.addListener(node => onMailingListEvent("modified", node));
  messenger.mailingLists.onDeleted.addListener((parentId, id) =>
    onMailingListEvent("deleted", { parentId, id })
  );
}

function onContactEvent(op, node) {
  const providerAccountId = registeredBooks.get(node.parentId);
  if (!providerAccountId) return;
  if (selfWriteDepth > 0) return;

  // Thunderbird events may nest the vCard inside `properties` depending on version.
  const vCard = node.vCard ?? node.properties?.vCard ?? null;

  let resourceName = null;
  if (op === "deleted") {
    resourceName = idToResourceName.get(node.id) ?? null;
    idToResourceName.delete(node.id);
  } else if (vCard) {
    resourceName = mapper.readIdentity(vCard)?.resourceName ?? null;
    if (resourceName) idToResourceName.set(node.id, resourceName);
  }

  const status =
    op === "added" ? changelog.STATUS.ADDED_BY_USER :
    op === "modified" ? changelog.STATUS.MODIFIED_BY_USER :
    changelog.STATUS.DELETED_BY_USER;

  changelog.append(providerAccountId, {
    kind: changelog.KIND.CONTACT,
    parentId: node.parentId,
    itemId: node.id,
    status,
    resourceName,
  }).catch(err =>
    console.warn("[google-4-tbsync] changelog append failed:", err?.message ?? err)
  );
}

function onMailingListEvent(op, node) {
  const providerAccountId = registeredBooks.get(node.parentId);
  if (!providerAccountId) return;
  if (selfWriteDepth > 0) return;

  const status =
    op === "added" ? changelog.STATUS.ADDED_BY_USER :
    op === "modified" ? changelog.STATUS.MODIFIED_BY_USER :
    changelog.STATUS.DELETED_BY_USER;

  resolveGroupIdentity(providerAccountId, node.id, op).then(resourceName =>
    changelog.append(providerAccountId, {
      kind: changelog.KIND.GROUP,
      parentId: node.parentId,
      itemId: node.id,
      status,
      resourceName,
    })
  ).catch(err =>
    console.warn("[google-4-tbsync] changelog append failed:", err?.message ?? err)
  );
}

async function resolveGroupIdentity(providerAccountId, mailingListId, op) {
  const entry = await groupMap.getByListId(providerAccountId, mailingListId);
  if (op === "deleted" && entry) {
    await groupMap.remove(providerAccountId, entry.resourceName);
  }
  return entry?.resourceName ?? null;
}
