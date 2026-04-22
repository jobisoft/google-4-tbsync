/**
 * Thin wrapper over `messenger.addressBooks.*` and `messenger.contacts.*`
 * for the Google provider.
 *
 * Book-level: create / delete / exists with the "not found" tolerance we
 * need when a user may have manually deleted the book from Thunderbird's UI.
 *
 * Contact-level: list / create / update / delete. All writes take a vCard
 * string (the canonical modern representation) via `{ vCard }`.
 *
 * Every method here is a single-purpose async wrapper — the sync orchestrator
 * in `google/sync-contacts.mjs` composes them.
 */

/**
 * Create a new Thunderbird address book with the given display name and
 * return its id. Throws on failure — callers should surface the error rather
 * than persisting half-configured accounts.
 */
export async function createBook(name) {
  if (!name || typeof name !== "string" || !name.trim()) {
    throw new Error("createBook requires a non-empty name");
  }
  // messenger.addressBooks.create returns the new book's id directly.
  const id = await messenger.addressBooks.create({ name: name.trim() });
  return id;
}

/**
 * Delete the address book with the given id. Tolerates "not found" errors
 * (the user may have removed the book manually from Thunderbird's UI).
 * Other failures are re-thrown so callers can log them.
 */
export async function deleteBook(id) {
  if (!id) return;
  try {
    await messenger.addressBooks.delete(id);
  } catch (err) {
    // messenger.addressBooks.delete throws a generic Error when the id is
    // unknown; the message typically contains "No such address book" or
    // similar. Swallow that shape; re-throw anything else.
    const msg = String(err?.message ?? err ?? "");
    if (/no such|not found|invalid id/i.test(msg)) return;
    throw err;
  }
}

/**
 * Returns true if an address book with the given id currently exists.
 */
export async function bookExists(id) {
  if (!id) return false;
  try {
    const node = await messenger.addressBooks.get(id);
    return !!node;
  } catch {
    return false;
  }
}

// ── Contact-level ──────────────────────────────────────────────────────────

/**
 * List all contacts in the given address book. Each ContactNode carries
 * `{ id, parentId, type, vCard, readOnly, ... }`; consumers typically only
 * care about `id` and `vCard`.
 */
export async function listContacts(bookId) {
  if (!bookId) return [];
  try {
    return await messenger.contacts.list(bookId);
  } catch (err) {
    const msg = String(err?.message ?? err ?? "");
    if (/no such|not found|invalid id/i.test(msg)) return [];
    throw err;
  }
}

/**
 * Create a new contact from a vCard string. Returns the new contact's id.
 */
export async function createContact(bookId, vCard) {
  if (!bookId) throw new Error("createContact requires a bookId");
  if (!vCard) throw new Error("createContact requires a vCard string");
  return await messenger.contacts.create(bookId, { vCard });
}

/**
 * Replace an existing contact's vCard. Caller must have already matched the
 * contact id via X-GOOGLE-RESOURCENAME on the existing vCard.
 */
export async function updateContact(contactId, vCard) {
  if (!contactId) throw new Error("updateContact requires a contactId");
  if (!vCard) throw new Error("updateContact requires a vCard string");
  await messenger.contacts.update(contactId, { vCard });
}

/**
 * Delete a contact by id. Tolerates "not found" — the card may have been
 * removed manually in Thunderbird between our list() and delete() calls.
 */
export async function deleteContact(contactId) {
  if (!contactId) return;
  try {
    await messenger.contacts.delete(contactId);
  } catch (err) {
    const msg = String(err?.message ?? err ?? "");
    if (/no such|not found|invalid id/i.test(msg)) return;
    throw err;
  }
}
