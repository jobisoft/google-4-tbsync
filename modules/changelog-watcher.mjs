import * as changelog from "./changelog.mjs";
import * as mapper from "./google/contact-mapper.mjs";
import * as addressBook from "./address-book.mjs";

/**
 * Record user-initiated contact changes into the provider's changelog.
 *
 * Only watches books the provider owns (tracked via register/unregister).
 * `suppressDuringSelfWrite` mutes the watcher during server→local writes
 * so our own events don't echo back; concurrent user edits during a sync
 * are also dropped (next pull reconciles).
 *
 * Delete events don't carry a vCard, so we keep an in-memory
 * `contactId → resourceName` cache populated on create/update / at
 * registerTarget time, and stamp it onto `deleted_by_user` changelog
 * entries so the push pass knows which server record to remove.
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
  messenger.contacts.onCreated.addListener(node => {
    onContactEvent("added", node);
  });
  messenger.contacts.onUpdated.addListener(node => {
    onContactEvent("modified", node);
  });
  messenger.contacts.onDeleted.addListener((parentId, id) => {
    onContactEvent("deleted", { parentId, id, vCard: null });
  });
}

function onContactEvent(op, node) {
  const providerAccountId = registeredBooks.get(node.parentId);
  if (!providerAccountId) return;
  if (selfWriteDepth > 0) return;

  // TB events may nest the vCard inside `properties` depending on version.
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
    parentId: node.parentId,
    itemId: node.id,
    status,
    resourceName,
  }).catch(err =>
    console.warn("[google-4-tbsync] changelog append failed:", err?.message ?? err)
  );
}
