/**
 * In-memory mapping between a Google contact-group `resourceName` and its
 * Thunderbird mailing-list id, scoped to a single sync pass. Stores `etag`
 * + `groupType` alongside so the push pass can detect conflicts and skip
 * system groups without a round-trip.
 *
 * Constructed from `folder.custom.groupMap` at the start of a sync and
 * flushed back via one UPDATE_FOLDER at the end if any mutations happened.
 * No provider-side persistent storage — the host's folder row is the
 * source of truth, which means uninstalling/reinstalling the provider
 * doesn't lose mapping state and never creates duplicate mailing lists.
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
