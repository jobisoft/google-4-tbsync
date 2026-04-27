/**
 * In-memory mapping between a Thunderbird contact `itemId` and its Google
 * `resourceName`, scoped to a single sync pass. Lets `deleted_by_user`
 * entries resolve to a resourceName at push-delete time, when the local
 * card and its vCard stamp are gone.
 *
 * Loaded from `folder.custom.contactMap` at sync start, flushed back via
 * one UPDATE_FOLDER at sync end if dirty.
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
