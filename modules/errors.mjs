/**
 * Stringify any thrown / rejected value for inclusion in user-facing
 * messages (event log, dialog error banners, console hints). Centralised
 * to avoid the slight-variation `err?.message ?? err` / `err.message ??
 * String(err)` drift that accumulated across modules.
 */

export function stringifyError(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  return err.message ?? String(err);
}
