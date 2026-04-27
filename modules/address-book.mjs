/**
 * Thin wrapper over `messenger.addressBooks.*` and `messenger.contacts.*`.
 * Book operations tolerate "not found" (the user may have removed the book
 * manually). Contact writes all take a vCard string via `{ vCard }`.
 */

import { stringifyError, PUSH_ERR } from "./errors.mjs";

/** Create a book and return its id. */
export async function createBook(name) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("createBook requires a non-empty name");
  }
  return await messenger.addressBooks.create({ name: name.trim() });
}

/** Delete a book, tolerating "not found". */
export async function deleteBook(id) {
  if (!id) return;
  try {
    await messenger.addressBooks.delete(id);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

export async function bookExists(id) {
  if (!id) return false;
  try {
    const node = await messenger.addressBooks.get(id);
    return !!node;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

// ── Contact-level ──────────────────────────────────────────────────────────

/** List all contacts in a book, with vCard normalised to the top level. */
export async function listContacts(bookId) {
  if (!bookId) return [];
  try {
    const list = await messenger.contacts.list(bookId);
    return list.map(normalizeCard);
  } catch (err) {
    if (isNotFoundError(err)) {
      console.debug(`[google-4-tbsync] listContacts: book ${bookId} not found`);
      return [];
    }
    throw err;
  }
}

/** Fetch a contact by id with vCard normalised. Null on "not found". */
export async function getContact(id) {
  if (!id) return null;
  try {
    const node = await messenger.contacts.get(id);
    return node ? normalizeCard(node) : null;
  } catch (err) {
    if (isNotFoundError(err)) {
      console.debug(`[google-4-tbsync] getContact: ${id} not found`);
      return null;
    }
    throw err;
  }
}

/** Re-emit the contact node with `vCard` guaranteed present (`null` if
 *  the API returned no vCard). */
function normalizeCard(node) {
  if (!node) return node;
  return { ...node, vCard: node.vCard ?? null };
}

/** Create a contact from a vCard. Returns the new id. */
export async function createContact(bookId, vCard) {
  if (!bookId) throw new Error("createContact requires a bookId");
  if (!vCard) throw new Error("createContact requires a vCard string");
  return await messenger.contacts.create(bookId, { vCard });
}

/** Replace an existing contact's vCard. */
export async function updateContact(contactId, vCard) {
  if (!contactId) throw new Error("updateContact requires a contactId");
  if (!vCard) throw new Error("updateContact requires a vCard string");
  await messenger.contacts.update(contactId, { vCard });
}

/** Delete a contact by id, tolerating "not found". */
export async function deleteContact(contactId) {
  if (!contactId) return;
  try {
    await messenger.contacts.delete(contactId);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

// ── Mailing-list-level ────────────────────────────────────────────────────

/** List all mailing lists in a book. */
export async function listMailingLists(bookId) {
  if (!bookId) return [];
  try {
    return await messenger.mailingLists.list(bookId);
  } catch (err) {
    if (isNotFoundError(err)) {
      console.debug(`[google-4-tbsync] listMailingLists: book ${bookId} not found`);
      return [];
    }
    throw err;
  }
}

/** Fetch a mailing list by id; null on "not found". */
export async function getMailingList(id) {
  if (!id) return null;
  try {
    return await messenger.mailingLists.get(id);
  } catch (err) {
    if (isNotFoundError(err)) {
      console.debug(`[google-4-tbsync] getMailingList: ${id} not found`);
      return null;
    }
    throw err;
  }
}

/** Create a mailing list. Returns the new id. */
export async function createMailingList(bookId, { name }) {
  if (!bookId) throw new Error("createMailingList requires a bookId");
  if (!name) throw new Error("createMailingList requires a name");
  return await messenger.mailingLists.create(bookId, { name });
}

/** Rename / update a mailing list. */
export async function updateMailingList(id, { name }) {
  if (!id) throw new Error("updateMailingList requires an id");
  await messenger.mailingLists.update(id, { name });
}

/** Delete a mailing list, tolerating "not found". */
export async function deleteMailingList(id) {
  if (!id) return;
  try {
    await messenger.mailingLists.delete(id);
  } catch (err) {
    if (isNotFoundError(err)) return;
    throw err;
  }
}

/** List the contacts in a mailing list, tolerating "not found". */
export async function listMailingListMembers(listId) {
  if (!listId) return [];
  try {
    return await messenger.mailingLists.listMembers(listId);
  } catch (err) {
    if (isNotFoundError(err)) {
      console.debug(`[google-4-tbsync] listMailingListMembers: list ${listId} not found`);
      return [];
    }
    throw err;
  }
}

/** Add a contact to a mailing list. Throws with `code: PUSH_ERR.NOT_FOUND`
 *  when either side has been removed - the caller must catch and surface
 *  the drift; a silent return there would leave the membership delta
 *  reporting a false positive. */
export async function addMailingListMember(listId, contactId) {
  if (!listId || !contactId) return;
  try {
    await messenger.mailingLists.addMember(listId, contactId);
  } catch (err) {
    if (isNotFoundError(err)) {
      const wrapped = new Error(`addMailingListMember: list ${listId} or contact ${contactId} not found`);
      wrapped.code = PUSH_ERR.NOT_FOUND;
      throw wrapped;
    }
    throw err;
  }
}

/** Remove a contact from a mailing list. Same semantics as
 *  `addMailingListMember` - throws with `code: PUSH_ERR.NOT_FOUND` when
 *  the list or contact is gone so the caller can report drift. */
export async function removeMailingListMember(listId, contactId) {
  if (!listId || !contactId) return;
  try {
    await messenger.mailingLists.removeMember(listId, contactId);
  } catch (err) {
    if (isNotFoundError(err)) {
      const wrapped = new Error(`removeMailingListMember: list ${listId} or contact ${contactId} not found`);
      wrapped.code = PUSH_ERR.NOT_FOUND;
      throw wrapped;
    }
    throw err;
  }
}

/** Match Thunderbird's "unknown id" errors - wording varies across versions. */
function isNotFoundError(err) {
  return /no such|not found|invalid id/i.test(stringifyError(err));
}
