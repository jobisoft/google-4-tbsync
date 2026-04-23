/**
 * Minimal Google People API client.
 *
 * List + push entry points — enough for the bidirectional contacts sync in
 * M3b. Incremental sync via `syncToken` is a later milestone.
 *
 * Transparent retry semantics:
 *   - On 401 (expired/invalid access token), call oauth.invalidateAccessToken
 *     and retry the request once with a freshly-issued token.
 *   - invalid_grant on refresh (refresh token revoked) bubbles up from
 *     oauth.getAccessToken as ERR.AUTH.
 *   - Any other non-2xx response throws ERR.NETWORK, except:
 *     - 404 on updateContact / deleteContact → throws ERR.NOT_FOUND so
 *       callers can distinguish "server-side deleted" from network trouble.
 *     - 409/412 (or 400 with FAILED_PRECONDITION) on updateContact → throws
 *       ERR.CONFLICT for the push pass's etag-mismatch handling.
 */

import { ERR, withCode } from "../../vendor/tbsync/protocol.mjs";
import * as oauth from "./oauth.mjs";

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
].join(",");

// Push field mask: same as pull minus `memberships` (group-membership
// mutation is M3c; sending the mask here would wipe server-side group
// assignments). Matches legacy `CONTACT_UPDATE_PERSON_FIELDS` in intent,
// with `events` added because M2c's mapper round-trips anniversaries.
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
].join(",");

const PAGE_SIZE = 1000;

/**
 * Fetch every Person resource the authenticated user can see via
 * `people.connections.list`, following `nextPageToken` until exhaustion.
 * Returns a flat array.
 */
export async function listAllConnections(providerAccountId) {
  const all = [];
  let pageToken = null;

  while (true) {
    const params = new URLSearchParams({
      personFields: PULL_FIELDS,
      pageSize: String(PAGE_SIZE),
      sortOrder: "LAST_NAME_ASCENDING",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const data = await fetchWithAuthRetry(providerAccountId, `${CONNECTIONS_ENDPOINT}?${params}`);

    if (Array.isArray(data.connections)) {
      all.push(...data.connections);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return all;
}

/**
 * POST /v1/people:createContact — create a new contact. Returns the Person
 * the server stored, from which the caller reads `resourceName` and `etag`
 * to stamp on the local card.
 */
export async function createContact(providerAccountId, person) {
  const params = new URLSearchParams({ personFields: PULL_FIELDS });
  const url = `${BASE}/people:createContact?${params}`;
  return await fetchWithAuthRetry(providerAccountId, url, {
    method: "POST",
    body: JSON.stringify(person),
  });
}

/**
 * PATCH /v1/<resourceName>:updateContact — replace the listed field groups.
 * The body must carry the server's last-known `etag` for optimistic locking
 * — if the server has a newer version, the call throws ERR.CONFLICT and the
 * push pass drops the entry so the pull phase can reconcile.
 */
export async function updateContact(providerAccountId, resourceName, person, etag) {
  const params = new URLSearchParams({
    updatePersonFields: PUSH_FIELDS,
    personFields: PULL_FIELDS,
  });
  const url = `${BASE}/${resourceName}:updateContact?${params}`;
  return await fetchWithAuthRetry(providerAccountId, url, {
    method: "PATCH",
    body: JSON.stringify({ ...person, etag }),
  });
}

/**
 * DELETE /v1/<resourceName>:deleteContact. 404 is rethrown as ERR.NOT_FOUND
 * so the push pass can treat "already gone" as success.
 */
export async function deleteContact(providerAccountId, resourceName) {
  const url = `${BASE}/${resourceName}:deleteContact`;
  await fetchWithAuthRetry(providerAccountId, url, { method: "DELETE" });
}

/**
 * Internal error codes the push pass uses to branch on specific API outcomes.
 * Kept module-local because they never reach the host over the wire — the
 * push-pass catch translates them to control flow, not RPC responses.
 */
export const PUSH_ERR = {
  CONFLICT: "E:CONFLICT",    // etag mismatch on update — reconcile via next pull
  NOT_FOUND: "E:NOT_FOUND",  // server-side resource is gone
};

/**
 * Issue an authenticated request against the People API. On 401, invalidate
 * the cached token once, refresh, and retry. Any other non-2xx is classified
 * into a shared or push-pass error code and thrown.
 *
 * `opts.method` defaults to GET; `opts.body` (stringified JSON) is sent with
 * `Content-Type: application/json`. DELETE responses (204 No Content) return
 * `null`.
 */
async function fetchWithAuthRetry(providerAccountId, url, opts = {}) {
  const method = opts.method ?? "GET";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await oauth.getAccessToken(providerAccountId);
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.body) headers["Content-Type"] = "application/json";
    const resp = await fetch(url, { method, headers, body: opts.body });

    if (resp.ok) {
      if (resp.status === 204) return null;
      const text = await resp.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (err) {
        throw withCode(new Error(`Invalid People API response: ${err.message}`), ERR.NETWORK);
      }
    }

    if (resp.status === 401 && attempt === 1) {
      // Access token rejected — force a refresh and retry once.
      oauth.invalidateAccessToken(providerAccountId);
      continue;
    }

    const body = await resp.text().catch(() => "");
    // 400 with FAILED_PRECONDITION is how People API reports etag mismatches
    // on updateContact; 409/412 are the canonical HTTP forms. Treat all three
    // as conflict so the push pass can drop the entry consistently.
    if (
      (resp.status === 409 || resp.status === 412) ||
      (resp.status === 400 && /FAILED_PRECONDITION/.test(body))
    ) {
      throw withCode(
        new Error(`People API ${resp.status}: etag conflict`),
        PUSH_ERR.CONFLICT
      );
    }
    if (resp.status === 404) {
      throw withCode(
        new Error(`People API ${resp.status}: not found`),
        PUSH_ERR.NOT_FOUND
      );
    }
    const code = resp.status === 401 || resp.status === 403 ? ERR.AUTH : ERR.NETWORK;
    throw withCode(
      new Error(`People API ${resp.status}: ${body.slice(0, 200)}`),
      code
    );
  }
  // Unreachable — the loop either returns or throws.
  throw withCode(new Error("People API retry fell through"), ERR.NETWORK);
}
