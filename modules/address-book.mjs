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
    if (isNotFoundError(err)) return;
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
 * List all contacts in the given address book. Each returned node carries
 * `{ id, parentId, type, vCard, readOnly, ... }`.
 *
 * Every card we hand out is normalised so consumers can read `card.vCard`
 * directly — TB's `messenger.contacts.list` / `get` return ContactNode
 * instances with the vCard string nested at `properties.vCard`, and the
 * address-book lifecycle of older versions puts it at the top level. We
 * promote whichever one is present so downstream code doesn't care.
 */
export async function listContacts(bookId) {
  if (!bookId) return [];
  try {
    const list = await messenger.contacts.list(bookId);
    return list.map(normalizeCard);
  } catch (err) {
    if (isNotFoundError(err)) return [];
    throw err;
  }
}

/**
 * Fetch a single contact by id with the same `.vCard` normalisation as
 * `listContacts`. Returns null on "not found" so callers can distinguish
 * "card vanished between event and push" from real failures.
 */
export async function getContact(id) {
  if (!id) return null;
  try {
    const node = await messenger.contacts.get(id);
    return node ? normalizeCard(node) : null;
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

function normalizeCard(node) {
  if (!node) return node;
  const vCard = node.vCard ?? node.properties?.vCard ?? null;
  return { ...node, vCard };
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
    if (isNotFoundError(err)) return;
    throw err;
  }
}

/** True when the underlying Thunderbird API throws because the given id is
 *  unknown. The message wording varies ("No such address book", "not found",
 *  "Invalid id"), so we match generously on all three. */
function isNotFoundError(err) {
  const msg = String(err?.message ?? err ?? "");
  return /no such|not found|invalid id/i.test(msg);
}
