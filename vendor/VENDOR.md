# Vendored third-party libraries

## ical.min.js

- **Library:** [ical.js](https://github.com/kewisch/ical.js)
- **Version:** v2.2.1
- **Source:** https://github.com/kewisch/ical.js/releases/download/v2.2.1/ical.min.js
- **License:** MPL 2.0 (see header of `ical.min.js`)
- **Used for:** parsing and serialising vCard 4.0 strings exchanged with
  Thunderbird's `messenger.contacts.*` API. We rely on its vCard design set
  rather than hand-rolling a parser/serializer, per the Thunderbird
  WebExtension vCard guide:
  https://webextension-api.thunderbird.net/en/mv2/guides/vcard.html

## Upgrade procedure

1. Download the new `ical.min.js` from the kewisch/ical.js releases page.
2. Replace the file in this directory.
3. Update the version number above.
4. Run sync against a live Google account and confirm contact round-trip.
