/**
 * In-memory mapping between a Thunderbird contact `itemId` and the Google
 * `resourceName` it was synced under, scoped to a single sync pass. Sole
 * purpose: resolve `deleted_by_user` changelog entries to a resourceName
 * at push-delete time, when the local card is gone and its vCard stamp
 * with it.
 *
 * Constructed from `folder.custom.contactMap` at sync start, mutated
 * in-memory (add on push-add / pull-create, drop on push-delete /
 * pull-delete), flushed back via one UPDATE_FOLDER at sync end if dirty.
 * No provider-side persistent storage — host's folder row is the source
 * of truth.
 */

export class ContactMap {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial ?? {}));
    this.dirty = false;
  }

  get(itemId)   { return this.map.get(itemId) ?? null; }
  set(itemId, resourceName) {
    if (!itemId || !resourceName) return;
    if (this.map.get(itemId) === resourceName) return;
    this.map.set(itemId, resourceName);
    this.dirty = true;
  }
  remove(itemId) {
    if (this.map.delete(itemId)) this.dirty = true;
  }
  toJSON() { return Object.fromEntries(this.map); }
}
