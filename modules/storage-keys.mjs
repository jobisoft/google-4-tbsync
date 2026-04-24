/**
 * Keys the Google provider uses in its own storage.local.
 *
 * Host storage owns per-account user-config (clientID, clientSecret, toggles)
 * and per-folder binding (targetID/targetName). The provider keeps only:
 *   - OAuth refresh tokens (secret isolation),
 *   - the changelog of pending local mutations,
 *   - the contact-group ↔ mailing-list map.
 * All are transient/secret state that a full resync (or a sign-in-again click)
 * can regenerate — no loss of user configuration if this storage is wiped.
 */

export const KEYS = {
  OAUTH_TOKENS: "google.oauthTokens",
  CHANGELOG: "google.changelog",
  GROUP_MAP: "google.groupMap",
};
