/**
 * In-memory mapping between a Google contact-group `resourceName` and its
 * Thunderbird mailing-list id, scoped to a single sync pass. Stores `etag`
 * + `groupType` alongside so the push pass can detect conflicts and skip
 * system groups without a round-trip.
 *
 * Loaded from `folder.custom.groupMap` at sync start, flushed back via
 * one UPDATE_FOLDER at sync end if dirty.
 */

export class GroupMap {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial ?? {}));
    this.dirty = false;
  }

  get(resourceName) {
    return this.map.get(resourceName) ?? null;
  }

  getByListId(mailingListId) {
    for (const [resourceName, entry] of this.map) {
      if (entry?.mailingListId === mailingListId) {
        return { resourceName, ...entry };
      }
    }
    return null;
  }

  set(resourceName, { mailingListId, etag, groupType }) {
    this.map.set(resourceName, { mailingListId, etag, groupType });
    this.dirty = true;
  }

  remove(resourceName) {
    if (this.map.delete(resourceName)) this.dirty = true;
  }

  listAll() {
    return [...this.map.entries()];
  }

  toJSON() {
    return Object.fromEntries(this.map);
  }
}
