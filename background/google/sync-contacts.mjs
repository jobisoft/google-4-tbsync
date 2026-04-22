/**
 * Orchestrates a one-way, server-to-local sync of Google Contacts into a
 * single Thunderbird address book.
 *
 * Inputs come from the caller (handleSyncFolder in command-handler.mjs):
 *   - providerAccountId  → used for OAuth
 *   - accountId/folderId → used as tags on progress notifications
 *   - targetAbId         → the Thunderbird address book to write into
 *
 * Flow:
 *   1. Fetch every Person (paginated) from People API.
 *   2. List TB contacts; build `resourceName → {id, etag}` map via the
 *      X-GOOGLE-RESOURCENAME / X-GOOGLE-ETAG properties on each vCard.
 *   3. For each Person: create if new, update if etag differs, skip if same.
 *   4. Delete local contacts whose resourceName isn't in the server set.
 *   5. Return StatusData summarising adds/updates/deletes.
 *
 * Writes are serial — the TB contacts DB doesn't love concurrent writes and
 * serial keeps the progress stream monotonic. If this turns out too slow for
 * very large books we can batch in M3.
 */

import { ok, warning } from "../../shared/status.mjs";
import * as tbsync from "../tbsync-client.mjs";
import * as peopleApi from "./people-api.mjs";
import * as mapper from "./contact-mapper.mjs";
import * as addressBook from "../thunderbird/address-book.mjs";

export async function syncFolderContacts({ accountId, providerAccountId, folderId, targetAbId }) {
  // 1. Pull the full connections list — fast JSON fetch(es), no TB writes yet.
  tbsync.reportSyncState({ accountId, folderId, syncState: "send.people-list" });
  const people = await peopleApi.listAllConnections(providerAccountId);

  // 2. Index local contacts by Google resourceName.
  tbsync.reportSyncState({ accountId, folderId, syncState: "eval.diff" });
  const local = await addressBook.listContacts(targetAbId);
  const byResourceName = new Map();
  for (const card of local) {
    const identity = mapper.readIdentity(card.vCard);
    if (!identity?.resourceName) continue;
    byResourceName.set(identity.resourceName, { id: card.id, etag: identity.etag });
  }

  const itemsTotal = people.length;
  let itemsDone = 0;
  let added = 0, updated = 0, skipped = 0;

  tbsync.reportProgress({ accountId, folderId, itemsDone, itemsTotal });

  // 3. Upsert.
  const seenResourceNames = new Set();
  for (const person of people) {
    const resourceName = person.resourceName;
    if (!resourceName) { itemsDone++; continue; }
    seenResourceNames.add(resourceName);

    const existing = byResourceName.get(resourceName);
    if (!existing) {
      const vCard = mapper.personToVCard(person);
      await addressBook.createContact(targetAbId, vCard);
      added++;
    } else if (existing.etag !== person.etag) {
      const vCard = mapper.personToVCard(person);
      await addressBook.updateContact(existing.id, vCard);
      updated++;
    } else {
      skipped++;
    }

    itemsDone++;
    tbsync.reportProgress({ accountId, folderId, itemsDone, itemsTotal });
  }

  // 4. Delete local contacts that no longer exist on the server.
  let deleted = 0;
  for (const [resourceName, entry] of byResourceName) {
    if (seenResourceNames.has(resourceName)) continue;
    await addressBook.deleteContact(entry.id);
    deleted++;
  }

  tbsync.reportSyncState({ accountId, folderId, syncState: "eval.done" });

  const summary = `${added} added, ${updated} updated, ${deleted} deleted${skipped ? ` (${skipped} unchanged)` : ""}`;
  // If the server returned zero contacts on a known-used account, surface as
  // a warning rather than silent success — usually a permissions issue.
  if (itemsTotal === 0 && local.length > 0) {
    return warning("Server returned 0 contacts", summary);
  }
  return ok(summary);
}
