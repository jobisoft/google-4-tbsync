/**
 * Thin wrapper over `messenger.addressBooks.*` for the Google provider.
 *
 * Responsibilities:
 *   - create a new AB when an account is set up
 *   - delete an AB when an account is disabled or removed (tolerating a
 *     previous manual deletion from Thunderbird's UI)
 *   - check whether a stored targetAbId still points to a real book
 *
 * Contact CRUD (create/update/delete individual cards) lands in M2d and will
 * live in a sibling module; keep this file container-only.
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
