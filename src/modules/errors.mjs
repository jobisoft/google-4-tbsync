/**
 * Stringify any thrown / rejected value for inclusion in user-facing
 * messages (event log, dialog error banners, console hints).
 */

export function stringifyError(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  return err.message ?? String(err);
}

/** Provider-internal sentinel error codes. Distinct from the host-side
 *  `ERR.*` set in `vendor/tbsync/protocol.mjs` (those travel over the
 *  wire); these are local-only control flow used by the People API
 *  client to signal etag conflict / 404, and by the address-book
 *  wrapper to signal "the underlying TB record is gone". */
export const PUSH_ERR = {
  CONFLICT: "E:CONFLICT",
  NOT_FOUND: "E:NOT_FOUND",
};
