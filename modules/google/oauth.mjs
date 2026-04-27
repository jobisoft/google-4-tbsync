/**
 * Google OAuth 2.0. Two client-type flows:
 *
 *   "desktop" - Google "Desktop App" client. `redirect_uri` is the
 *               legacy out-of-band sentinel `urn:ietf:wg:oauth:2.0:oob`.
 *               Driven by a popup window we open ourselves; on success
 *               Google sets the page title to `Success code=…` (and
 *               `Error …` / `Denied …` on failure). We watch
 *               `tabs.onUpdated` for that title, parse the code, and
 *               exchange it at the token endpoint. No redirect-URI setup
 *               required in the GCP console.
 *
 *   "web"     - Google "Web Application" client. Uses
 *               `browser.identity.launchWebAuthFlow` with the loopback
 *               redirect (`http://127.0.0.1/mozoauth2/<subdomain>`).
 *               The user must add that exact URL to the OAuth client's
 *               Authorized redirect URIs in the GCP console.
 *
 * Default is the modern "web" flow for new accounts.
 *
 * Access tokens are cached in-memory per accountId, never persisted.
 * OAuth credentials + the refresh token live on the host account row
 * under `custom.*`; callers prime an in-memory cache here at the top of
 * each on* hook so people-api can refresh tokens without re-reading host
 * state mid-sync.
 */

import { ERR, withCode } from "../../vendor/tbsync/provider.mjs";
import { stringifyError } from "../errors.mjs";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES = [
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/userinfo.email",
];

/** Out-of-band redirect - the desktop-client sentinel. Google's consent
 *  page renders the auth code into the page title rather than redirecting
 *  to a real URL. */
const OOB_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

/** accessTokenCache: accountId -> { token, expiresAt } */
const accessTokenCache = new Map();

/** authCache: accountId -> { clientID, clientSecret, refreshToken }.
 *  Transient in-memory mirror of the three host-stored OAuth fields, primed
 *  at the top of each on* hook that hits the People API. Cleared on
 *  account-disabled/deleted. */
const authCache = new Map();

/** Access-token safety margin: refresh 30 s before expiry. */
const REFRESH_SKEW_MS = 30_000;

export function primeAuth(accountId, { clientID, clientSecret, refreshToken }) {
  if (!clientID || !clientSecret || !refreshToken) return;
  authCache.set(accountId, { clientID, clientSecret, refreshToken });
}

/** Clear every in-memory token state for the account - both the
 *  cached access token and the primed clientID/secret/refreshToken
 *  triple. Callers that disable, delete, or re-credential an account
 *  call this to drop all OAuth state in one step. */
export function forgetAuth(accountId) {
  authCache.delete(accountId);
  accessTokenCache.delete(accountId);
}

/**
 * Redirect URI for the "web" client type. Pasted into the Google Cloud
 * OAuth client's Authorized redirect URIs. The loopback form
 * (`http://127.0.0.1/mozoauth2/<subdomain>`) is equivalent to the managed
 * `.extensions.allizom.org` URL but looks less alarming in the GCP console.
 */
export function getRedirectURL() {
  const managed = new URL(browser.identity.getRedirectURL());
  const subdomain = managed.hostname.split(".")[0];
  return `http://127.0.0.1/mozoauth2/${subdomain}`;
}

/**
 * Open the Google consent screen, exchange the code for tokens, and fetch
 * the authenticated user's email.
 *
 * `loginHint` pre-selects a Google account on the consent screen. Google
 * treats it as a hint, not a lock - the caller must still verify the
 * returned email matches.
 */
export async function startAuth({ clientID, clientSecret, loginHint, clientType }) {
  if (!clientID || !clientSecret) {
    throw withCode(new Error("Missing client ID or client secret"), ERR.AUTH);
  }
  const isWeb = clientType === "web";
  const redirectUri = isWeb ? getRedirectURL() : OOB_REDIRECT_URI;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set("client_id", clientID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  if (loginHint) authUrl.searchParams.set("login_hint", loginHint);

  const code = isWeb
    ? await consentViaWebAuthFlow(authUrl.toString())
    : await consentViaPopup(authUrl.toString());

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

/** Web client type: Mozilla's managed launchWebAuthFlow. Returns the
 *  authorization code parsed out of the loopback redirect's query. */
async function consentViaWebAuthFlow(authUrl) {
  let responseUrl;
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch (err) {
    const msg = stringifyError(err);
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
  return code;
}

/** Desktop client type: open Google's consent screen in our own popup
 *  window, watch the popup's tab title for the OOB success / error
 *  signal, parse the auth code. The popup is closed automatically once
 *  resolved; user closing it first surfaces ERR.CANCELLED. */
async function consentViaPopup(authUrl) {
  const popup = await browser.windows.create({
    url: authUrl,
    type: "popup",
    width: 500,
    height: 750,
  });

  return new Promise((resolve, reject) => {
    let done = false;

    const cleanup = () => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.windows.onRemoved.removeListener(onClosed);
    };

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      cleanup();
      try { browser.windows.remove(popup.id); } catch { /* already gone */ }
      fn(value);
    };

    const onUpdated = (_tabId, changeInfo, tab) => {
      if (tab.windowId !== popup.id) return;
      const title = changeInfo.title ?? tab.title;
      if (typeof title !== "string") return;
      // Google's OOB approval page sets the title to
      // `Success code=4/0AY0e-…&scope=…` on consent and
      // `Denied error=access_denied` (or similar) on rejection.
      if (title.startsWith("Success ")) {
        const m = /\bcode=([^&\s]+)/.exec(title);
        if (m) finish(resolve, decodeURIComponent(m[1]));
      } else if (/^(Error|Denied)\b/.test(title)) {
        finish(reject, withCode(new Error(`Google returned: ${title}`), ERR.AUTH));
      }
    };

    const onClosed = (windowId) => {
      if (windowId !== popup.id) return;
      finish(reject, withCode(new Error("Sign-in cancelled"), ERR.CANCELLED));
    };

    browser.tabs.onUpdated.addListener(onUpdated);
    browser.windows.onRemoved.addListener(onClosed);
  });
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
 *  transparently when needed. Requires `primeAuth(accountId,
 *  {clientID, clientSecret, refreshToken})` to have been called first -
 *  callers (provider on* hooks, sync flow) seed that at the top of any
 *  work that hits the People API. */
export async function getAccessToken(accountId) {
  const cached = accessTokenCache.get(accountId);
  if (cached && cached.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return cached.token;
  }
  const auth = authCache.get(accountId);
  if (!auth?.clientID || !auth?.clientSecret || !auth?.refreshToken) {
    throw withCode(new Error("OAuth auth not primed - call primeAuth first"), ERR.AUTH);
  }
  const fresh = await refreshAccessToken({
    clientID: auth.clientID,
    clientSecret: auth.clientSecret,
    refreshToken: auth.refreshToken,
  });
  accessTokenCache.set(accountId, {
    token: fresh.access_token,
    expiresAt: Date.now() + (fresh.expires_in ?? 3600) * 1000,
  });
  return fresh.access_token;
}

export function invalidateAccessToken(accountId) {
  accessTokenCache.delete(accountId);
}

/** Seed the access-token cache from a fresh exchange. */
export function primeAccessToken(accountId, token, expiresIn) {
  accessTokenCache.set(accountId, {
    token,
    expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
  });
}

/** Hit /userinfo with the given access token and return the email
 *  address. Used at sign-in and to backfill `authenticatedUserEmail`
 *  for accounts where it isn't on file yet. */
export async function fetchUserEmail(accessToken) {
  const resp = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data.email ?? null;
}
