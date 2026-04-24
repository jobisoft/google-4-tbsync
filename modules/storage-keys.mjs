/**
 * Keys the Google provider uses in its own storage.local.
 *
 * Host storage owns everything durable — user-config, OAuth secrets,
 * per-folder binding. The provider keeps only transient sync scaffolding:
 *   - the changelog of pending local mutations,
 *   - the contact-group ↔ mailing-list map.
 * Both regenerate fully on a fresh sync — losing this storage is cheap.
 */

export const KEYS = {
  CHANGELOG: "google.changelog",
  GROUP_MAP: "google.groupMap",
};
