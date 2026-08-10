/**
 * Translate Google People API `Person` resources ↔ vCard 4.0 strings.
 *
 * Local cards carry two X-properties that correlate them with server
 * records:
 *   X-GOOGLE-RESOURCENAME:people/c...   primary key
 *   X-GOOGLE-ETAG:<string>               change detector
 *
 * All parsing/serialisation goes through ICAL.js (Thunderbird's own vCard
 * library, per https://webextension-api.thunderbird.net/en/mv2/guides/vcard.html).
 */

import ICAL from "../../vendor/ical.min.js";

const X_RESOURCENAME = "x-google-resourcename";
const X_ETAG = "x-google-etag";
// Photo bookkeeping. The URL is the server's current photo address (change
// detection on pull: same URL, no refetch); the hash is sha-1 of the local
// PHOTO's base64 payload as of the last server exchange (change detection on
// push: different hash, upload).
const X_PHOTO_URL = "x-google-photo-url";
const X_PHOTO_HASH = "x-google-photo-hash";
// The mapper revision that last round-tripped the card. A card below the
// current revision predates some field families; pushing it verbatim would
// clear those families on Google (a field in the update mask but absent
// from the person is cleared server-side). Absence of the stamp means
// revision 1 - every card written before this property existed.
const X_SYNC_REV = "x-google-sync-rev";

/** Bump whenever the mapper learns new field families, and record what the
 *  new revision introduced in `REVISION_FAMILIES` below. */
export const SYNC_REVISION = 2;

// ── Public API ───────────────────────────────────────────────────────────

/** Build a vCard 4.0 string from a Google Person. When `uid` is provided
 *  it's written as the vCard `UID` property; TB derives the contact's
 *  `id` from that, so callers can pre-tag the changelog with a known
 *  itemId before calling `messenger.contacts.create`. Omit for paths
 *  that don't need to control the id. */
export function personToVCard(person, uid, { photo } = {}) {
  const comp = newVCard();
  if (uid) comp.addPropertyWithValue("uid", uid);
  writeNames(comp, person);
  writeNickname(comp, person);
  writeEmails(comp, person);
  writePhones(comp, person);
  writeAddresses(comp, person);
  writeUrls(comp, person);
  writeIms(comp, person);
  writeOrganization(comp, person);
  writeDate(comp, "bday", person.birthdays?.[0]?.date);
  const anniv = (person.events ?? []).find((e) =>
    /anniversary/i.test(e.type ?? ""),
  );
  writeDate(comp, "anniversary", anniv?.date);
  writeNote(comp, person);
  writeCustomFields(comp, person);
  writeGender(comp, person);
  writeRole(comp, person);
  writeRelations(comp, person);
  writeCalendarUrls(comp, person);
  writePhoto(comp, photo);
  if (person.resourceName)
    comp.addPropertyWithValue(X_RESOURCENAME, person.resourceName);
  if (person.etag) comp.addPropertyWithValue(X_ETAG, person.etag);
  // A rebuilt card reflects everything the current mapper knows.
  comp.addPropertyWithValue(X_SYNC_REV, String(SYNC_REVISION));
  return comp.toString();
}

/** Parse a vCard string into a Google-shaped Person. X-GOOGLE-* lines
 *  are handled separately by `readIdentity`. */
export function vCardToPerson(vCard) {
  const comp = parseVCard(vCard);
  if (!comp) return {};
  const person = {};

  const names = readNames(comp);
  if (names) person.names = [names];

  const nickname = comp.getFirstPropertyValue("nickname");
  if (nickname) person.nicknames = [{ value: stringOf(nickname) }];

  const emails = readEmails(comp);
  if (emails.length) person.emailAddresses = emails;

  const phones = readPhones(comp);
  if (phones.length) person.phoneNumbers = phones;

  const addresses = readAddresses(comp);
  if (addresses.length) person.addresses = addresses;

  const urls = readUrls(comp);
  if (urls.length) person.urls = urls;

  const ims = readIms(comp);
  if (ims.length) person.imClients = ims;

  const org = readOrganization(comp);
  if (org) person.organizations = [org];

  const bday = readDate(comp, "bday");
  if (bday) person.birthdays = [{ date: bday }];

  const anniv = readDate(comp, "anniversary");
  if (anniv) person.events = [{ type: "anniversary", date: anniv }];

  const note = comp.getFirstPropertyValue("note");
  if (note) person.biographies = [{ value: stringOf(note) }];

  const custom = readCustomFields(comp);
  if (custom.length) person.userDefined = custom;

  const gender = readGender(comp);
  if (gender) person.genders = [gender];

  const role = comp.getFirstPropertyValue("role");
  if (role) person.occupations = [{ value: stringOf(role) }];

  const relations = readRelations(comp);
  if (relations.length) person.relations = relations;

  const calUrls = readCalendarUrls(comp);
  if (calUrls.length) person.calendarUrls = calUrls;

  return person;
}

// ── Custom fields ────────────────────────────────────────────────────────
//
// Thunderbird models exactly four free-text custom fields (X-CUSTOM1..4 in
// its vCards); Google models an open list of key/value pairs. The mapping is
// positional, like the original Google-4-TbSync's: the first four
// `userDefined` entries land in the four slots, and the slots go back as
// keys Custom1..Custom4. An entry's original key does not survive a local
// edit - the cost of squeezing an open list into four fixed slots.

const CUSTOM_SLOTS = ["x-custom1", "x-custom2", "x-custom3", "x-custom4"];

function writeCustomFields(comp, person) {
  const entries = (person.userDefined ?? []).filter((e) => e?.value);
  entries.slice(0, CUSTOM_SLOTS.length).forEach((entry, i) => {
    comp.addPropertyWithValue(CUSTOM_SLOTS[i], entry.value);
  });
}

function readCustomFields(comp) {
  const out = [];
  CUSTOM_SLOTS.forEach((slot, i) => {
    const v = comp.getFirstPropertyValue(slot);
    if (v) out.push({ key: `Custom${i + 1}`, value: stringOf(v) });
  });
  return out;
}

// ── Gender ───────────────────────────────────────────────────────────────
//
// Single letter only. vCard 4 allows `sex;identity`, but Thunderbird
// silently discards the ENTIRE card when a GENDER value contains the `;`
// component - contacts.create returns an id and the card never exists
// (measured against TB 153; single letters store fine). So Google's three
// standard values map onto M/F/U, any custom value becomes a bare O, and
// the custom text is the one thing this mapping knowingly loses.

function writeGender(comp, person) {
  const value = person.genders?.[0]?.value;
  if (!value) return;
  const letter =
    { male: "M", female: "F", unspecified: "U" }[value.toLowerCase()] ?? "O";
  comp.addPropertyWithValue("gender", letter);
}

function readGender(comp) {
  const raw = comp.getFirstPropertyValue("gender");
  if (!raw) return null;
  const sex = stringOf(raw).split(";")[0];
  const value = { M: "male", F: "female", U: "unspecified", O: "other" }[
    sex?.toUpperCase()
  ];
  return value ? { value } : null;
}

// ── Occupation ───────────────────────────────────────────────────────────

function writeRole(comp, person) {
  const value = person.occupations?.[0]?.value;
  if (value) comp.addPropertyWithValue("role", value);
}

// ── Relations ────────────────────────────────────────────────────────────
//
// Google: `{ person: "Jane", type: "spouse" }`. vCard 4 RELATED wants a URI
// or VALUE=TEXT; the person is a display name, so TEXT it is.

function writeRelations(comp, person) {
  for (const rel of person.relations ?? []) {
    if (!rel?.person) continue;
    const p = new ICAL.Property("related", comp);
    p.setParameter("value", "TEXT");
    if (rel.type) p.setParameter("type", rel.type);
    p.setValue(rel.person);
    comp.addProperty(p);
  }
}

function readRelations(comp) {
  const out = [];
  for (const p of comp.getAllProperties("related")) {
    const value = p.getFirstValue();
    if (!value) continue;
    const type = paramValue(p, "type");
    out.push({ person: stringOf(value), ...(type ? { type } : {}) });
  }
  return out;
}

// ── Calendar links ───────────────────────────────────────────────────────

function writeCalendarUrls(comp, person) {
  for (const cal of person.calendarUrls ?? []) {
    if (cal?.url) comp.addPropertyWithValue("caluri", cal.url);
  }
}

function readCalendarUrls(comp) {
  const out = [];
  for (const p of comp.getAllProperties("caluri")) {
    const value = p.getFirstValue();
    if (value) out.push({ url: stringOf(value) });
  }
  return out;
}

// ── Photo ────────────────────────────────────────────────────────────────
//
// Same local shape the EAS provider uses: PHOTO;VALUE=URI with a data URI,
// which Thunderbird stores and displays. The bytes never ride in the Person
// object - Google serves them from a URL and takes them through the
// updateContactPhoto endpoint - so the mapper only carries what the sync
// hands it.

function writePhoto(comp, photo) {
  if (!photo?.dataUri) return;
  const p = new ICAL.Property("photo", comp);
  p.setParameter("value", "uri");
  p.setValue(photo.dataUri);
  comp.addProperty(p);
  if (photo.url) comp.addPropertyWithValue(X_PHOTO_URL, photo.url);
  if (photo.hash) comp.addPropertyWithValue(X_PHOTO_HASH, photo.hash);
}

/** The photo state a stored vCard carries: the local PHOTO data URI (null
 *  when the card has none) and the two bookkeeping stamps. */
export function readPhoto(vCard) {
  const comp = parseVCard(vCard);
  if (!comp) return { dataUri: null, url: null, hash: null, base64: null };
  const raw = comp.getFirstPropertyValue("photo");
  const dataUri = raw ? stringOf(raw) : null;
  const m = dataUri ? /^data:[^;]+;base64,(.+)$/is.exec(dataUri) : null;
  const urlProp = comp.getFirstPropertyValue(X_PHOTO_URL);
  const hashProp = comp.getFirstPropertyValue(X_PHOTO_HASH);
  return {
    dataUri,
    base64: m ? m[1].replace(/\s+/g, "") : null,
    url: urlProp ? stringOf(urlProp) : null,
    hash: hashProp ? stringOf(hashProp) : null,
  };
}

/** Rewrite the photo bookkeeping stamps on a stored vCard (after an upload
 *  or deletion), leaving everything else untouched. Pass nulls to clear. */
export function stampPhotoState(vCard, { url, hash }) {
  const comp = parseVCard(vCard);
  if (!comp) return vCard;
  comp.removeAllProperties(X_PHOTO_URL);
  comp.removeAllProperties(X_PHOTO_HASH);
  if (url) comp.addPropertyWithValue(X_PHOTO_URL, url);
  if (hash) comp.addPropertyWithValue(X_PHOTO_HASH, hash);
  return comp.toString();
}

/** Extract the two X-GOOGLE-* identity properties from a vCard string.
 *  Returns null when the vCard can't be parsed or carries no
 *  X-GOOGLE-RESOURCENAME (the `resourceName` is the primary key - etag
 *  alone is meaningless without it, so we treat the resourceName as
 *  load-bearing). */
export function readIdentity(vCard) {
  const comp = parseVCard(vCard);
  if (!comp) return null;
  const resourceName = comp.getFirstPropertyValue(X_RESOURCENAME);
  if (!resourceName) return null;
  const etag = comp.getFirstPropertyValue(X_ETAG);
  const rev = parseInt(comp.getFirstPropertyValue(X_SYNC_REV), 10);
  return {
    resourceName: stringOf(resourceName),
    etag: etag != null ? stringOf(etag) : null,
    // Absent or garbled means the card predates the stamp: revision 1.
    syncRev: Number.isInteger(rev) && rev > 0 ? rev : 1,
  };
}

/** Set X-GOOGLE-RESOURCENAME / X-GOOGLE-ETAG on the vCard, replacing any
 *  existing values. */
export function stampIdentity(vCard, { resourceName, etag }) {
  const comp = parseVCard(vCard) ?? newVCard();
  comp.removeAllProperties(X_RESOURCENAME);
  comp.removeAllProperties(X_ETAG);
  if (resourceName) comp.addPropertyWithValue(X_RESOURCENAME, resourceName);
  if (etag) comp.addPropertyWithValue(X_ETAG, etag);
  return comp.toString();
}

// ── Sync revision ────────────────────────────────────────────────────────
//
// What each mapper revision introduced. When a below-revision card is about
// to be pushed, the sync clean-pulls the server Person first and merges
// exactly these families into the card - local changes win - so a card that
// simply never knew a family cannot clear it on Google. Families the card's
// revision already knew are left alone: absence there is a deliberate
// removal and must keep clearing.

const REVISION_FAMILIES = {
  2: [
    {
      field: "userDefined",
      props: CUSTOM_SLOTS,
      write: writeCustomFields,
      // Positional overlay over the four slots (the same projection the
      // slot mapping uses everywhere): a locally filled slot wins its
      // position, server entries fill the holes, and the server tail
      // beyond the slots survives in the pushed person (the card cannot
      // carry it, `writeCustomFields` projects to four slots).
      merge(comp, server) {
        const out = [];
        CUSTOM_SLOTS.forEach((slot, i) => {
          const v = comp.getFirstPropertyValue(slot);
          if (v) out.push({ key: `Custom${i + 1}`, value: stringOf(v) });
          else if (server[i]?.value) out.push(server[i]);
        });
        out.push(...server.slice(CUSTOM_SLOTS.length));
        return out;
      },
    },
    {
      field: "genders",
      props: ["gender"],
      write: writeGender,
      merge(comp, server) {
        const local = readGender(comp);
        return local ? [local] : server;
      },
    },
    {
      field: "occupations",
      props: ["role"],
      write: writeRole,
      merge(comp, server) {
        const role = comp.getFirstPropertyValue("role");
        return role ? [{ value: stringOf(role) }] : server;
      },
    },
    {
      field: "relations",
      props: ["related"],
      write: writeRelations,
      merge(comp, server) {
        const local = readRelations(comp);
        const key = (r) => `${r.person}\u0000${r.type ?? ""}`;
        const seen = new Set(local.map(key));
        return [
          ...local,
          ...server.filter((r) => r?.person && !seen.has(key(r))),
        ];
      },
    },
    {
      field: "calendarUrls",
      props: ["caluri"],
      write: writeCalendarUrls,
      merge(comp, server) {
        const local = readCalendarUrls(comp);
        const seen = new Set(local.map((c) => c.url));
        return [
          ...local,
          ...server.filter((c) => c?.url && !seen.has(c.url)),
        ];
      },
    },
  ],
};

/** Replace the revision stamp with the current one, leaving everything
 *  else untouched. */
export function stampRevision(vCard) {
  const comp = parseVCard(vCard);
  if (!comp) return vCard;
  comp.removeAllProperties(X_SYNC_REV);
  comp.addPropertyWithValue(X_SYNC_REV, String(SYNC_REVISION));
  return comp.toString();
}

/** Bring a below-revision card up to the current revision before a push:
 *  merge the server Person's values for every family the card's revision
 *  did not know (local changes win), stamp it current, and return both the
 *  upgraded vCard and the Person to push. The Person is returned separately
 *  because some merged values do not fit the card - the userDefined tail
 *  beyond the four slots exists only server-side and must still ride in
 *  the push, or the mask would clear it. */
export function upgradeVCard(vCard, serverPerson, cardRev) {
  const comp = parseVCard(vCard);
  if (!comp) return { vCard, person: vCardToPerson(vCard) };

  const overrides = {};
  for (const [rev, families] of Object.entries(REVISION_FAMILIES)) {
    if (Number(rev) <= cardRev) continue;
    for (const family of families) {
      const merged = family.merge(comp, serverPerson[family.field] ?? []);
      for (const prop of family.props) comp.removeAllProperties(prop);
      family.write(comp, { [family.field]: merged });
      overrides[family.field] = merged;
    }
  }
  comp.removeAllProperties(X_SYNC_REV);
  comp.addPropertyWithValue(X_SYNC_REV, String(SYNC_REVISION));

  const upgraded = comp.toString();
  const person = vCardToPerson(upgraded);
  for (const [field, merged] of Object.entries(overrides)) {
    if (merged.length) person[field] = merged;
    else delete person[field];
  }
  return { vCard: upgraded, person };
}

// ── vCard plumbing ───────────────────────────────────────────────────────

function newVCard() {
  const comp = new ICAL.Component(["vcard", [], []]);
  comp.updatePropertyWithValue("version", "4.0");
  return comp;
}

function parseVCard(vCardString) {
  if (!vCardString) return null;
  try {
    return new ICAL.Component(ICAL.parse(vCardString));
  } catch {
    return null;
  }
}

/** Coerce ICAL typed values (like VCardTime) to strings. */
function stringOf(v) {
  return typeof v === "string" ? v : String(v);
}

// ── Names ────────────────────────────────────────────────────────────────

function writeNames(comp, person) {
  const name = person.names?.[0];
  if (!name) return;
  const n = new ICAL.Property("n", comp);
  n.setValue([
    name.familyName ?? "",
    name.givenName ?? "",
    name.middleName ?? "",
    name.honorificPrefix ?? "",
    name.honorificSuffix ?? "",
  ]);
  comp.addProperty(n);
  // FN is required in vCard 4.0; synthesise one if the Person lacks a displayName.
  const display =
    name.displayName ??
    person.emailAddresses?.[0]?.value ??
    person.organizations?.[0]?.name ??
    "Unknown";
  comp.addPropertyWithValue("fn", display);
}

function readNames(comp) {
  const fn = comp.getFirstPropertyValue("fn");
  const nProp = comp.getFirstProperty("n");
  const parts = nProp?.getFirstValue();
  if (!fn && !parts) return null;
  const [familyName, givenName, middleName, honorificPrefix, honorificSuffix] =
    Array.isArray(parts) ? parts : ["", "", "", "", ""];
  const out = {};
  if (familyName) out.familyName = familyName;
  if (givenName) out.givenName = givenName;
  if (middleName) out.middleName = middleName;
  if (honorificPrefix) out.honorificPrefix = honorificPrefix;
  if (honorificSuffix) out.honorificSuffix = honorificSuffix;
  if (fn) out.displayName = stringOf(fn);
  return Object.keys(out).length ? out : null;
}

// ── Nickname / Note ──────────────────────────────────────────────────────

function writeNickname(comp, person) {
  const nick = person.nicknames?.[0]?.value;
  if (nick) comp.addPropertyWithValue("nickname", nick);
}

function writeNote(comp, person) {
  const note = person.biographies?.[0]?.value;
  if (note) comp.addPropertyWithValue("note", note);
}

// ── Emails ───────────────────────────────────────────────────────────────

function writeEmails(comp, person) {
  const emails = person.emailAddresses ?? [];
  emails.forEach((email, i) => {
    if (!email?.value) return;
    const p = new ICAL.Property("email", comp);
    p.setValue(email.value);
    const type = normalizeEmailType(email.type);
    if (type) p.setParameter("type", type);
    if (i === 0) p.setParameter("pref", "1");
    comp.addProperty(p);
  });
}

function readEmails(comp) {
  const out = [];
  for (const p of comp.getAllProperties("email")) {
    const value = p.getFirstValue();
    if (!value) continue;
    out.push({
      value: stringOf(value),
      type: denormalizeEmailType(paramValue(p, "type")),
    });
  }
  return out.filter((e) => e.value);
}

// ── Phones ───────────────────────────────────────────────────────────────

function writePhones(comp, person) {
  for (const phone of person.phoneNumbers ?? []) {
    if (!phone?.value) continue;
    const p = new ICAL.Property("tel", comp);
    p.setValue(phone.value);
    const type = normalizePhoneType(phone.type);
    if (type) p.setParameter("type", type);
    comp.addProperty(p);
  }
}

function readPhones(comp) {
  const out = [];
  for (const p of comp.getAllProperties("tel")) {
    const value = p.getFirstValue();
    if (!value) continue;
    out.push({
      value: stringOf(value),
      type: denormalizePhoneType(paramValue(p, "type")),
    });
  }
  return out;
}

// ── Addresses ────────────────────────────────────────────────────────────

function writeAddresses(comp, person) {
  for (const addr of person.addresses ?? []) {
    if (!addr) continue;
    const parts = [
      "", // PO box (unused)
      addr.extendedAddress ?? "",
      addr.streetAddress ?? "",
      addr.city ?? "",
      addr.region ?? "",
      addr.postalCode ?? "",
      addr.country ?? "",
    ];
    if (parts.every((s) => !s)) continue;
    const p = new ICAL.Property("adr", comp);
    p.setValue(parts);
    const type = normalizeAddressType(addr.type);
    if (type) p.setParameter("type", type);
    comp.addProperty(p);
  }
}

function readAddresses(comp) {
  const out = [];
  for (const p of comp.getAllProperties("adr")) {
    const parts = p.getFirstValue();
    if (!Array.isArray(parts)) continue;
    const [, extended, street, city, region, postalCode, country] = parts;
    if (![extended, street, city, region, postalCode, country].some(Boolean))
      continue;
    out.push({
      extendedAddress: extended || undefined,
      streetAddress: street || undefined,
      city: city || undefined,
      region: region || undefined,
      postalCode: postalCode || undefined,
      country: country || undefined,
      type: denormalizeAddressType(paramValue(p, "type")),
    });
  }
  return out;
}

// ── URLs ─────────────────────────────────────────────────────────────────

function writeUrls(comp, person) {
  for (const url of person.urls ?? []) {
    if (!url?.value) continue;
    const p = new ICAL.Property("url", comp);
    p.setValue(url.value);
    if (/work/i.test(url.type ?? "")) p.setParameter("type", "work");
    comp.addProperty(p);
  }
}

function readUrls(comp) {
  const out = [];
  for (const p of comp.getAllProperties("url")) {
    const value = p.getFirstValue();
    if (!value) continue;
    out.push({
      value: stringOf(value),
      type: /work/i.test(paramValue(p, "type") ?? "") ? "work" : undefined,
    });
  }
  return out;
}

// ── IMPP ─────────────────────────────────────────────────────────────────

function writeIms(comp, person) {
  for (const im of person.imClients ?? []) {
    if (!im?.username) continue;
    const protocol = (im.protocol ?? "x-unknown")
      .toLowerCase()
      .replace(/[^a-z0-9+.-]/g, "");
    comp.addPropertyWithValue("impp", `${protocol}:${im.username}`);
  }
}

function readIms(comp) {
  const out = [];
  for (const p of comp.getAllProperties("impp")) {
    const value = p.getFirstValue();
    if (!value) continue;
    const str = stringOf(value);
    const colon = str.indexOf(":");
    if (colon > 0) {
      out.push({
        protocol: str.slice(0, colon),
        username: str.slice(colon + 1),
      });
    } else {
      out.push({ username: str });
    }
  }
  return out;
}

// ── Organisation ─────────────────────────────────────────────────────────

function writeOrganization(comp, person) {
  const org = person.organizations?.[0];
  if (!org) return;
  if (org.name) comp.addPropertyWithValue("org", org.name);
  if (org.title) comp.addPropertyWithValue("title", org.title);
}

function readOrganization(comp) {
  const orgValue = comp.getFirstPropertyValue("org");
  const title = comp.getFirstPropertyValue("title");
  if (!orgValue && !title) return null;
  const out = {};
  if (orgValue) {
    // vCard ORG is a semicolon-separated unit list; Google wants a single string.
    out.name = Array.isArray(orgValue)
      ? orgValue.filter(Boolean).join(" ")
      : stringOf(orgValue);
  }
  if (title) out.title = stringOf(title);
  return out;
}

// ── Dates (BDAY / ANNIVERSARY) ──────────────────────────────────────────

function writeDate(comp, propName, date) {
  if (!date) return;
  const s = formatPartialDate(date);
  if (!s) return;
  // VALUE=text handles partial dates the default type can't serialise cleanly.
  const p = new ICAL.Property(propName, comp);
  p.resetType("text");
  p.setValue(s);
  comp.addProperty(p);
}

function readDate(comp, propName) {
  const p = comp.getFirstProperty(propName);
  if (!p) return null;
  const raw = p.getFirstValue();
  if (!raw) return null;
  const s = stringOf(raw).trim();
  return parsePartialDate(s);
}

/** Emit a vCard 4.0 partial date (`YYYY-MM-DD`, `--MM-DD`, `YYYY----`). */
function formatPartialDate(date) {
  const y = date.year ? String(date.year).padStart(4, "0") : "--";
  const m = date.month ? String(date.month).padStart(2, "0") : "--";
  const d = date.day ? String(date.day).padStart(2, "0") : "--";
  if (y === "--" && m === "--" && d === "--") return null;
  return `${y}-${m}-${d}`;
}

function parsePartialDate(s) {
  const dashed = s.match(/^([-\d]{4})-([-\d]{2})-([-\d]{2})$/);
  if (dashed) {
    const [, y, m, d] = dashed;
    return {
      year: y === "--" || y === "----" ? undefined : Number(y) || undefined,
      month: m === "--" ? undefined : Number(m) || undefined,
      day: d === "--" ? undefined : Number(d) || undefined,
    };
  }
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    return {
      year: Number(compact[1]),
      month: Number(compact[2]),
      day: Number(compact[3]),
    };
  }
  return null;
}

// ── Parameter helpers ────────────────────────────────────────────────────

/** Read a parameter's first value (flattens `TYPE=home,work`). */
function paramValue(prop, name) {
  const v = prop.getParameter(name);
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ── Type normalisation (Google ↔ vCard) ─────────────────────────────────
//
// Each table maps lowercased input → canonical output; missing keys fall
// through to the per-call `fallback` argument. `lookupType` is the only
// branching code path - adding a new field family means adding a table,
// not new helper functions.

const EMAIL_NORMALIZE = { home: "home", work: "work" };
const EMAIL_DENORMALIZE = { home: "home", work: "work" };

const PHONE_NORMALIZE = {
  home: "home",
  work: "work",
  mobile: "cell",
  cell: "cell",
  fax: "fax",
  workfax: "fax",
  homefax: "fax",
  pager: "pager",
};
const PHONE_DENORMALIZE = {
  home: "home",
  work: "work",
  cell: "mobile",
  fax: "workFax",
  pager: "pager",
};

const ADDRESS_NORMALIZE = { home: "home", work: "work" };
const ADDRESS_DENORMALIZE = { home: "home", work: "work" };

function lookupType(table, type, fallback) {
  if (!type) return fallback;
  return table[type.toLowerCase()] ?? fallback;
}

function normalizeEmailType(type) {
  return lookupType(EMAIL_NORMALIZE, type, type ? "other" : null);
}
function denormalizeEmailType(type) {
  return lookupType(EMAIL_DENORMALIZE, type, type ? "other" : undefined);
}
function normalizePhoneType(type) {
  return lookupType(PHONE_NORMALIZE, type, null);
}
function denormalizePhoneType(type) {
  return lookupType(PHONE_DENORMALIZE, type, undefined);
}
function normalizeAddressType(type) {
  return lookupType(ADDRESS_NORMALIZE, type, null);
}
function denormalizeAddressType(type) {
  return lookupType(ADDRESS_DENORMALIZE, type, undefined);
}
