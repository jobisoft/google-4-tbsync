/**
 * ID / token generators. Thin wrappers over crypto.randomUUID so tests and
 * migration paths have a single seam to patch.
 *
 * **MIRRORED INTO EVERY PROVIDER ADD-ON** — see the header of
 * `./protocol.mjs` for the sync rule.
 */

export function uuid() {
  return crypto.randomUUID();
}

export function requestId() {
  return `r-${crypto.randomUUID()}`;
}

export function setupToken() {
  return `t-${crypto.randomUUID()}`;
}

export function folderId() {
  return `f-${crypto.randomUUID()}`;
}
