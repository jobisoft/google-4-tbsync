/* global Services, ExtensionCommon */

"use strict";

var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs",
);

var LegacyAbProperties = class extends ExtensionCommon.ExtensionAPI {
  getAPI(_context) {
    return {
      LegacyAbProperties: {
        /** Returns one entry per card whose underlying nsIAbCard has an
         *  X-GOOGLE-RESOURCENAME property in its MAB property bag. The
         *  WebExtension `messenger.contacts.list` API surfaces the card
         *  as a vCard, but legacy google-4-tbsync wrote the stamp via
         *  the older `card.setProperty(name, value)` interface - those
         *  custom properties are not serialised back to vCard. */
        readGoogleStamps: async (bookId) => {
          const dir = MailServices.ab.getDirectoryFromUID(bookId);
          if (!dir) {
            throw new Error(`No address book found for UID ${bookId}`);
          }
          const out = [];
          for (const card of dir.childCards) {
            if (card.isMailList) continue;
            const resourceName = card.getProperty("X-GOOGLE-RESOURCENAME", "");
            if (!resourceName) continue;
            const etag = card.getProperty("X-GOOGLE-ETAG", "");
            out.push({
              contactId: card.UID,
              resourceName,
              etag,
            });
          }
          return out;
        },
      },
    };
  }
};
