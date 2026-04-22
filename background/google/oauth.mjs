/**
 * Google OAuth 2.0 for the provider.
 *
 *   startAuth(clientID, clientSecret)
 *     Launch identity.launchWebAuthFlow against Google's consent screen.
 *     Returns { refreshToken, authenticatedUserEmail } on success.
 *
 *   getAccessToken(providerAccountId)
 *     Returns a cached access token, refreshing via the stored refresh token
 *     when needed. Throws with ERR.AUTH on invalid_grant (user must re-consent).
 *
 *   invalidateAccessToken(providerAccountId)
 *     Drops the in-memory cache entry; next getAccessToken will force a refresh.
 *
 * Access tokens live in a module-level Map, keyed by providerAccountId. They
 * are NEVER persisted (they expire quickly; persisting them gains nothing and
 * widens the attack surface). Refresh tokens are persisted in the provider's
 * account record by command-handler / accounts.mjs.
 */

import { ERR, withCode } from "../../shared/protocol.mjs";
import * as accounts from "../accounts.mjs";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** accessTokenCache: providerAccountId -> { token, expiresAt } */
const accessTokenCache = new Map();

/** Access-token safety margin: refresh 30 s before expiry. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Redirect URI used by `identity.launchWebAuthFlow`. Stable per-install. The
 * user has to paste this into the Authorized redirect URIs field of their
 * Google Cloud OAuth client (of type "Web application" — Desktop-app clients
 * aren't compatible with the identity API).
 *
 * We use the loopback form (`http://127.0.0.1/mozoauth2/<subdomain>`, supported
 * by launchWebAuthFlow since Firefox 86) rather than the managed URL that
 * `identity.getRedirectURL()` returns directly (`https://<subdomain>.extensions.allizom.org/`).
 * Both require registration on a Web-application client, but the loopback is
 * less alarming to users who might worry about "allizom.org" appearing in their
 * GCP authorized-redirect list. The local loopback URL uses the name of the client
 * picked by the user in the google cloud console.
 */
export function getRedirectURL() {
  const managed = new URL(browser.identity.getRedirectURL());
  const subdomain = managed.hostname.split(".")[0];
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}

/**
 * Open the Google consent screen, exchange the resulting code for tokens,
 * and fetch the authenticated user's email.
 *
 * Pass `loginHint` to pre-select a specific Google account on the consent
 * screen — useful for re-auth flows where we already know which address
 * must be signed in. Google treats this as a hint, not a lock: if the user
 * isn't currently signed in to that address they can still pick another,
 * so the caller must still verify the returned email matches expectations.
 */
export async function startAuth({ clientID, clientSecret, loginHint }) {
  if (!clientID || !clientSecret) {
    throw withCode(new Error("Missing client ID or client secret"), ERR.AUTH);
  }
  const redirectUri = getRedirectURL();

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", clientID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  if (loginHint) authUrl.searchParams.set("login_hint", loginHint);

  let responseUrl;
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl.toString(),
      interactive: true,
    });
  } catch (err) {
    const msg = String(err?.message ?? err ?? "");
    if (/cancel|close/i.test(msg)) {
      throw withCode(new Error("Sign-in cancelled"), ERR.CANCELLED);
    }
    throw withCode(new Error(`Sign-in failed: ${msg}`), ERR.AUTH);
  }

  const parsed = new URL(responseUrl);
  const code = parsed.searchParams.get("code");
  const error = parsed.searchParams.get("error");
  if (error) throw withCode(new Error(`Google returned: ${error}`), ERR.AUTH);
  if (!code) throw withCode(new Error("No authorization code in response"), ERR.AUTH);

  const tokens = await exchangeCode({ clientID, clientSecret, code, redirectUri });
  if (!tokens.refresh_token) {
    throw withCode(
      new Error("Google did not return a refresh_token. Revoke access at https://myaccount.google.com/permissions and try again."),
      ERR.AUTH
    );
  }
  const email = await fetchUserEmail(tokens.access_token).catch(() => null);

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    authenticatedUserEmail: email,
  };
}

async function exchangeCode({ clientID, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientID,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    throw withCode(new Error(`Token exchange failed (${resp.status}): ${text}`), ERR.AUTH);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw withCode(new Error("Invalid token-exchange response"), ERR.AUTH);
  }
}

/** Exchange a refresh_token for a fresh access_token. Throws ERR.AUTH when
 *  Google returns invalid_grant (revoked / expired refresh token). */
export async function refreshAccessToken({ clientID, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientID,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    const isInvalidGrant = resp.status === 400 && /invalid_grant/.test(text);
    throw withCode(
      new Error(`Token refresh failed (${resp.status}): ${text}`),
      isInvalidGrant ? ERR.AUTH : ERR.NETWORK
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw withCode(new Error("Invalid token-refresh response"), ERR.NETWORK);
  }
}

/** Returns a valid access token for the given provider account, refreshing
 *  transparently when needed. */
export async function getAccessToken(providerAccountId) {
  const cached = accessTokenCache.get(providerAccountId);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return cached.token;
  }
  const acc = await accounts.get(providerAccountId);
  if (!acc?.refreshToken) {
    throw withCode(new Error("No refresh token on file"), ERR.AUTH);
  }
  const fresh = await refreshAccessToken({
    clientID: acc.clientID,
    clientSecret: acc.clientSecret,
    refreshToken: acc.refreshToken,
  });
  accessTokenCache.set(providerAccountId, {
    token: fresh.access_token,
    expiresAt: Date.now() + (fresh.expires_in ?? 3600) * 1000,
  });
  return fresh.access_token;
}

export function invalidateAccessToken(providerAccountId) {
  accessTokenCache.delete(providerAccountId);
}

/** Seed the in-memory cache after a fresh exchange (saves a refresh on the
 *  first sync immediately following account creation). */
export function primeAccessToken(providerAccountId, token, expiresIn) {
  accessTokenCache.set(providerAccountId, {
    token,
    expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
  });
}

async function fetchUserEmail(accessToken) {
  const resp = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.email ?? null;
}
