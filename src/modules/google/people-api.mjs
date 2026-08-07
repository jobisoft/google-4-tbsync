/**
 * Google People API client. List + create/update/delete contacts.
 *
 * Error mapping:
 *   - 401 retries once with a refreshed access token; persistent 401 → ERR.AUTH.
 *   - 404 on update/delete → PUSH_ERR.NOT_FOUND.
 *   - 409/412 (or 400 FAILED_PRECONDITION) on update → PUSH_ERR.CONFLICT.
 *   - Anything else non-2xx → ERR.NETWORK.
 *   - invalid_grant on token refresh bubbles up from oauth as ERR.AUTH.
 */

import { ERR, withCode } from "../../vendor/tbsync/provider.mjs";
import * as oauth from "./oauth.mjs";
import { PUSH_ERR } from "../errors.mjs";

const BASE = "https://people.googleapis.com/v1";
const CONNECTIONS_ENDPOINT = `${BASE}/people/me/connections`;

const PULL_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "urls",
  "birthdays",
  "events",
  "imClients",
  "biographies",
  "memberships",
  "userDefined",
  "genders",
  "occupations",
  "relations",
  "calendarUrls",
  "photos",
].join(",");

// Push mask excludes `memberships` - memberships are server→local only.
// Every other pulled field is pushed: a field in the pull mask but not the
// update mask is silently reverted by the next updateContact, which reads
// as "Google keeps undoing my edit".
const PUSH_FIELDS = [
  "names",
  "nicknames",
  "emailAddresses",
  "phoneNumbers",
  "addresses",
  "organizations",
  "urls",
  "birthdays",
  "events",
  "imClients",
  "biographies",
  "userDefined",
  "genders",
  "occupations",
  "relations",
  "calendarUrls",
].join(",");

// Group members are NOT derived from here - they come from each Person's
// `memberships` field on the connections list. `memberResourceNames` isn't
// a valid groupFields value anyway (only batchGet returns it).
const GROUP_PULL_FIELDS = "name,groupType";
const GROUP_PUSH_FIELDS = "name";

const PAGE_SIZE = 1000;

/** Fetch all of the user's contacts, following pagination. */
export async function listAllConnections(accountId) {
  const all = [];
  let pageToken = null;

  while (true) {
    const params = new URLSearchParams({
      personFields: PULL_FIELDS,
      pageSize: String(PAGE_SIZE),
      sortOrder: "LAST_NAME_ASCENDING",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await fetchWithAuthRetry(
      accountId,
      `${CONNECTIONS_ENDPOINT}?${params}`,
    );

    if (Array.isArray(data.connections)) {
      all.push(...data.connections);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return all;
}

/** Create a contact. Returns the stored Person with `resourceName` and `etag`. */
export async function createContact(accountId, person) {
  const params = new URLSearchParams({ personFields: PULL_FIELDS });
  const url = `${BASE}/people:createContact?${params}`;
  return await fetchWithAuthRetry(accountId, url, {
    method: "POST",
    body: JSON.stringify(person),
  });
}

/** Update a contact with optimistic locking on `etag`. Mismatch → PUSH_ERR.CONFLICT. */
export async function updateContact(accountId, resourceName, person, etag) {
  const params = new URLSearchParams({
    updatePersonFields: PUSH_FIELDS,
    personFields: PULL_FIELDS,
  });
  const url = `${BASE}/${resourceName}:updateContact?${params}`;
  return await fetchWithAuthRetry(accountId, url, {
    method: "PATCH",
    body: JSON.stringify({ ...person, etag }),
  });
}

/** DELETE /v1/<resourceName>:deleteContact. 404 → PUSH_ERR.NOT_FOUND
 *  via `fetchWithAuthRetry`'s shared 404 mapping below - the push pass
 *  treats "already gone" as success. */
export async function deleteContact(accountId, resourceName) {
  const url = `${BASE}/${resourceName}:deleteContact`;
  await fetchWithAuthRetry(accountId, url, { method: "DELETE" });
}

// ── Contact photos ────────────────────────────────────────────────────────
//
// Photos are not part of updateContact - listing them in updatePersonFields
// is a 400 - they travel through their own endpoints, and downloads go
// straight to the photo URL each person carries.

/** Fetch a photo URL into a data URI, or null when it cannot be fetched.
 *  No Authorization header: the URLs Google hands out are self-authorizing,
 *  and a failure here must cost one photo, never the sync. */
export async function fetchPhotoAsDataUri(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const mime = resp.headers.get("content-type") ?? "image/jpeg";
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    return `data:${mime};base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}

/** Upload a contact photo. Returns the updated person (fresh etag and
 *  photo URL), so the caller can restamp instead of refetching. */
export async function updateContactPhoto(accountId, resourceName, base64) {
  const url = `${BASE}/${resourceName}:updateContactPhoto`;
  const data = await fetchWithAuthRetry(accountId, url, {
    method: "PATCH",
    body: JSON.stringify({ photoBytes: base64, personFields: PULL_FIELDS }),
  });
  return data?.person ?? null;
}

/** Remove a contact photo. Returns the updated person. */
export async function deleteContactPhoto(accountId, resourceName) {
  const params = new URLSearchParams({ personFields: PULL_FIELDS });
  const url = `${BASE}/${resourceName}:deleteContactPhoto?${params}`;
  const data = await fetchWithAuthRetry(accountId, url, { method: "DELETE" });
  return data?.person ?? null;
}

// ── Contact groups ────────────────────────────────────────────────────────

/** Fetch all contact groups, following pagination. */
export async function listAllContactGroups(accountId) {
  const all = [];
  let pageToken = null;
  while (true) {
    const params = new URLSearchParams({
      groupFields: GROUP_PULL_FIELDS,
      pageSize: String(PAGE_SIZE),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await fetchWithAuthRetry(
      accountId,
      `${BASE}/contactGroups?${params}`,
    );
    if (Array.isArray(data.contactGroups)) all.push(...data.contactGroups);
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return all;
}

/** Create a user contact group. Returns the stored group with `resourceName` + `etag`. */
export async function createContactGroup(accountId, { name }) {
  const params = new URLSearchParams({ readGroupFields: GROUP_PULL_FIELDS });
  const url = `${BASE}/contactGroups?${params}`;
  return await fetchWithAuthRetry(accountId, url, {
    method: "POST",
    body: JSON.stringify({ contactGroup: { name } }),
  });
}

/** Rename a user contact group. Etag required for optimistic locking. */
export async function updateContactGroup(
  accountId,
  resourceName,
  { name, etag },
) {
  const url = `${BASE}/${resourceName}`;
  return await fetchWithAuthRetry(accountId, url, {
    method: "PUT",
    body: JSON.stringify({
      contactGroup: { etag, name },
      updateGroupFields: GROUP_PUSH_FIELDS,
      readGroupFields: GROUP_PULL_FIELDS,
    }),
  });
}

/** Add and/or remove members of a user contact group, in one call.
 *
 *  `contactGroups.members.modify` rather than `memberships` on each person:
 *  this is the shape Thunderbird's data model already has - a list and the
 *  contacts in it - whereas `people.updateContact` replaces a contact's
 *  *entire* membership set, so pushing one added member would first mean
 *  reading back every other group that contact belongs to and resending them
 *  all. (`memberships` is a legal `updatePersonFields` value; the reason to
 *  prefer this endpoint is the shape, not permission.)
 *
 *  Google caps the two arrays at 1000 names combined. Callers here push one
 *  user action at a time, so the cap is documentation rather than a limit we
 *  come near.
 *
 *  Among system groups only `myContacts` and `starred` accept additions;
 *  everything we push is a user group, where both directions are allowed. */
export async function modifyContactGroupMembers(
  accountId,
  resourceName,
  { add = [], remove = [] } = {},
) {
  if (!add.length && !remove.length) return null;
  const url = `${BASE}/${resourceName}/members:modify`;
  return await fetchWithAuthRetry(accountId, url, {
    method: "POST",
    body: JSON.stringify({
      resourceNamesToAdd: add,
      resourceNamesToRemove: remove,
    }),
  });
}

/** Delete a user contact group. 404 → PUSH_ERR.NOT_FOUND. */
export async function deleteContactGroup(accountId, resourceName) {
  const url = `${BASE}/${resourceName}`;
  await fetchWithAuthRetry(accountId, url, { method: "DELETE" });
}

/** How this module reaches the running sync's AbortSignal. Wired once by the
 *  provider, so every People API call is cancellable without threading a
 *  signal through each of them. */
let syncSignalFor = () => null;
export function setSyncSignalResolver(fn) {
  syncSignalFor = typeof fn === "function" ? fn : () => null;
}

/** Authenticated People API fetch. Retries once on 401 with a fresh token.
 *  DELETE and empty bodies return null. */
async function fetchWithAuthRetry(accountId, url, opts = {}) {
  const method = opts.method ?? "GET";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const signal = syncSignalFor(accountId);
    const token = await oauth.getAccessToken(accountId);
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.body) headers["Content-Type"] = "application/json";
    // A cancel aborts the request in flight; the AbortError travels out
    // untouched so the port reports E:CANCELLED rather than a fault.
    const resp = await fetch(url, {
      method,
      headers,
      body: opts.body,
      ...(signal ? { signal } : {}),
    });

    if (resp.ok) {
      if (resp.status === 204) return null;
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw withCode(
          new Error(`Invalid People API response: ${err.message}`),
          ERR.NETWORK,
        );
      }
    }

    if (resp.status === 401 && attempt === 1) {
      oauth.invalidateAccessToken(accountId);
      continue;
    }

    const body = await resp.text().catch(() => "");
    // People API reports etag mismatches as 400 FAILED_PRECONDITION or
    // 409/412.
    if (
      resp.status === 409 ||
      resp.status === 412 ||
      (resp.status === 400 && /FAILED_PRECONDITION/.test(body))
    ) {
      throw withCode(
        new Error(`People API ${resp.status}: etag conflict`),
        PUSH_ERR.CONFLICT,
      );
    }
    if (resp.status === 404) {
      throw withCode(
        new Error(`People API ${resp.status}: not found`),
        PUSH_ERR.NOT_FOUND,
      );
    }
    const code =
      resp.status === 401 || resp.status === 403 ? ERR.AUTH : ERR.NETWORK;
    throw withCode(
      new Error(`People API ${resp.status}: ${body.slice(0, 200)}`),
      code,
    );
  }
}
