/**
 * Minimal Google People API client.
 *
 * M2c only needs one call — list all of an account's contact connections —
 * so that's all this module exposes. syncToken / incremental sync is M3.
 *
 * Transparent retry semantics:
 *   - On 401 (expired/invalid access token), call oauth.invalidateAccessToken
 *     and retry the request once with a freshly-issued token.
 *   - invalid_grant on refresh (refresh token revoked) bubbles up from
 *     oauth.getAccessToken as ERR.AUTH.
 *   - Any other non-2xx response throws ERR.NETWORK.
 */

import { ERR, withCode } from "../../shared/protocol.mjs";
import * as oauth from "./oauth.mjs";

const CONNECTIONS_ENDPOINT = "https://people.googleapis.com/v1/people/me/connections";

const PERSON_FIELDS = [
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
      personFields: PERSON_FIELDS,
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
 * GET `url` with an OAuth bearer token. On 401, invalidate the cached token
 * once, refresh, and retry. Any other error is classified as NETWORK / AUTH
 * and thrown with a shared error code.
 */
async function fetchWithAuthRetry(providerAccountId, url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const token = await oauth.getAccessToken(providerAccountId);
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.ok) {
      try {
        return await resp.json();
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
    const code = resp.status === 401 || resp.status === 403 ? ERR.AUTH : ERR.NETWORK;
    throw withCode(
      new Error(`People API ${resp.status}: ${body.slice(0, 200)}`),
      code
    );
  }
  // Unreachable — the loop either returns or throws.
  throw withCode(new Error("People API retry fell through"), ERR.NETWORK);
}
