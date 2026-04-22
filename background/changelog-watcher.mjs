import * as changelog from "./changelog.mjs";
import * as mapper from "./google/contact-mapper.mjs";
import * as addressBook from "./thunderbird/address-book.mjs";

/**
 * Watches `messenger.contacts.onCreated/onUpdated/onDeleted` and records
 * user-initiated changes into the provider's changelog. The push pass in
 * `google/sync-contacts.mjs` consumes those entries on the next sync.
 *
 * ── Target tracking ──
 * We only care about events in books this provider owns. `registerTarget` is
 * called from `handleFolderEnabled` (and at startup for every pre-existing
 * folder with a `targetAbId`); `unregisterTarget` from `handleFolderDisabled`
 * / `handleAccountDeleted`.
 *
 * ── Self-write suppression ──
 * Server→local writes (create/update/delete performed by sync-contacts.mjs)
 * trigger the same TB events as user writes, so the watcher must skip them
 * to avoid echoing our own writes into the changelog. `suppressDuringSelfWrite`
 * bumps a depth counter; while > 0, all events in registered books are
 * ignored. Tradeoff: user edits that happen concurrently with a sync also
 * get dropped (the next sync's server pull reconciles anyway).
 *
 * ── Identity cache for deletes ──
 * `messenger.contacts.onDeleted` fires with `(parentId, id)` only — no vCard,
 * so we can't read `X-GOOGLE-RESOURCENAME` from the card itself. We keep an
 * in-memory `contactId → resourceName` map, primed from each book's current
 * contents at `registerTarget` time and updated on every create/update
 * event, so the delete handler can stamp the resourceName onto the changelog
 * entry. Without it, the push pass would have no way to tell Google which
 * server-side contact to remove.
 */

const registeredBooks = new Map();   // targetAbId → providerAccountId
const idToResourceName = new Map();  // contactId → resourceName
let selfWriteDepth = 0;

/**
 * Add a Thunderbird book to the watch set and prime the identity cache from
 * its current contents. Safe to call on empty books (cheap no-op).
 */
export async function registerTarget(targetAbId, providerAccountId) {
  if (!targetAbId || !providerAccountId) return;
  registeredBooks.set(targetAbId, providerAccountId);
  const contacts = await addressBook.listContacts(targetAbId);
  for (const c of contacts) {
    const resourceName = mapper.readIdentity(c.vCard)?.resourceName ?? null;
    if (resourceName) idToResourceName.set(c.id, resourceName);
  }
}

/**
 * Remove a book from the watch set. Identity-cache entries for contacts that
 * lived in it are not purged (the book may be about to be deleted; leaving
 * them is harmless because no future event will reference those ids).
 */
export function unregisterTarget(targetAbId) {
  if (!targetAbId) return;
  registeredBooks.delete(targetAbId);
}

/**
 * Run `fn` with the watcher muted so that server→local writes inside it
 * don't echo back into the changelog. The trailing `setTimeout(0)` lets any
 * events dispatched by the API but not yet delivered to our listener drain
 * before we re-enable.
 */
export async function suppressDuringSelfWrite(fn) {
  selfWriteDepth++;
  try {
    return await fn();
  } finally {
    await new Promise(r => setTimeout(r, 0));
    selfWriteDepth--;
  }
}

/** Update the identity cache after a self-write we performed ourselves.
 *  Called by sync-contacts after stamping a freshly-created card. */
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

  // Events deliver a raw ContactNode from TB; vCard may be nested inside
  // `properties` rather than exposed at the top level, matching what
  // messenger.contacts.list/get return.
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
