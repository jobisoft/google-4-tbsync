# Vendored code

This directory holds drop-in pieces that aren't part of this provider's
domain logic: a third-party library and a reusable TbSync-provider
scaffold. Provider code imports from here; nothing here imports from
[../modules/](../modules/).

## ical.min.js

- **Library:** [ical.js](https://github.com/kewisch/ical.js)
- **Version:** v2.2.1
- **Source:** https://github.com/kewisch/ical.js/releases/download/v2.2.1/ical.min.js
- **License:** MPL 2.0 (see header of [ical.min.js](./ical.min.js))
- **Used for:** parsing and serialising vCard 4.0 strings exchanged with
  Thunderbird's `messenger.contacts.*` API. We rely on its vCard design
  set rather than hand-rolling a parser/serializer, per the Thunderbird
  WebExtension vCard guide:
  https://webextension-api.thunderbird.net/en/mv2/guides/vcard.html

### Upgrade procedure

1. Download the new `ical.min.js` from the kewisch/ical.js releases page.
2. Replace the file in this directory.
3. Update the version number above.
4. Run sync against a live Google account and confirm contact round-trip.

## tbsync/

Reusable base class for TbSync provider add-ons, plus the two wire-protocol
modules the base class and its consumers depend on. Modelled on
webext-support's VfsProviderImplementation:
[/home/john/Documents/GitHub/webext-support/modules/vfs-toolkit/vfs-provider/vfs-provider.mjs](/home/john/Documents/GitHub/webext-support/modules/vfs-toolkit/vfs-provider/vfs-provider.mjs).

Contents:

| File | Role |
|---|---|
| [tbsync/provider.mjs](./tbsync/provider.mjs) | `TbSyncProviderImplementation` — owns the port, handshake, RPC dispatch, setup/config popup machinery. Provider subclasses override `on*` virtual hooks. Also exports `TBSYNC_ID`. |
| [tbsync/protocol.mjs](./tbsync/protocol.mjs) | Wire-protocol constants: port name, command/notification enums, error codes, `withCode` helper. **Mirror-synced with the host's copy** — see file header. |
| [tbsync/status.mjs](./tbsync/status.mjs) | `STATUS_TYPES` enum plus `ok()`/`warning()`/`error()` builders for RPC return values. **Mirror-synced** — same contract as `protocol.mjs`. (`ACCOUNT_STATUS` / `FOLDER_STATUS` are host-only UI values and stay on the host side.) |

### Mirror-sync contract

The two non-`provider.mjs` files are byte-identical to their counterparts
in [../../tbsync-new/tbsync/](../../tbsync-new/tbsync/). Changes originate
in the host copy; re-copy into this directory and verify with:

```
diff -q ../../tbsync-new/tbsync/protocol.mjs ./tbsync/protocol.mjs
diff -q ../../tbsync-new/tbsync/status.mjs   ./tbsync/status.mjs
```

`provider.mjs` is provider-side only — no mirrored host counterpart. RPC
correlation tokens (request ids, setup tokens) are generated inside
`provider.mjs` and are opaque to both the subclass and the host.

### Future extraction

`tbsync/` is a candidate for eventual extraction into its own module under
`webext-support/modules/` so a second provider (EAS, CardDAV, …) can
consume it without duplication. We keep it in-repo until a second
consumer actually exists.
