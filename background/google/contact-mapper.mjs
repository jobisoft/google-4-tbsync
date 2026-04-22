/**
 * Translate Google People API `Person` resources ↔ vCard 4.0 strings.
 *
 * `personToVCard` and `vCardToPerson` handle the server↔local direction.
 * `readIdentity` and `stampIdentity` read/write the two bookkeeping
 * X-properties the pull+push passes use to correlate local cards with
 * server records:
 *
 *   X-GOOGLE-RESOURCENAME:people/c...   ← primary key (matches legacy)
 *   X-GOOGLE-ETAG:<string>               ← change detector
 *
 * All vCard parsing/serialisation goes through the vendored ICAL.js library
 * (see `../../vendor/ical.min.js`), per the Thunderbird WebExtension vCard
 * guide: https://webextension-api.thunderbird.net/en/mv2/guides/vcard.html
 * Hand-rolling either direction was a dead end — TB's vCard output carries
 * details (parameter casing, line folding, value escaping, X-* preservation)
 * that the library already handles correctly.
 */

import ICAL from "../../vendor/ical.min.js";

const X_RESOURCENAME = "x-google-resourcename";
const X_ETAG = "x-google-etag";

// ── Public API ───────────────────────────────────────────────────────────

/** Build a vCard 4.0 string from a Google Person. */
export function personToVCard(person) {
  const comp = newVCard();
  writeNames(comp, person);
  writeNickname(comp, person);
  writeEmails(comp, person);
  writePhones(comp, person);
  writeAddresses(comp, person);
  writeUrls(comp, person);
  writeIms(comp, person);
  writeOrganization(comp, person);
  writeDate(comp, "bday", person.birthdays?.[0]?.date);
  const anniv = (person.events ?? []).find(e => /anniversary/i.test(e.type ?? ""));
  writeDate(comp, "anniversary", anniv?.date);
  writeNote(comp, person);
  if (person.resourceName) comp.addPropertyWithValue(X_RESOURCENAME, person.resourceName);
  if (person.etag) comp.addPropertyWithValue(X_ETAG, person.etag);
  return comp.toString();
}

/**
 * Parse a vCard string back into a Google-shaped Person. X-GOOGLE-* lines
 * are ignored here — the push path has the identity separately via
 * `readIdentity`.
 */
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

  return person;
}

/** Extract the two X-GOOGLE-* identity properties from a vCard string.
 *  Returns null when neither is present. */
export function readIdentity(vCard) {
  const comp = parseVCard(vCard);
  if (!comp) return null;
  const resourceName = comp.getFirstPropertyValue(X_RESOURCENAME);
  if (!resourceName) return null;
  const etag = comp.getFirstPropertyValue(X_ETAG);
  return {
    resourceName: stringOf(resourceName),
    etag: etag != null ? stringOf(etag) : null,
  };
}

/**
 * Replace (or insert) the X-GOOGLE-RESOURCENAME / X-GOOGLE-ETAG lines in an
 * existing vCard. Used after a successful push to stamp the local card with
 * the server's latest etag so the next sync's conflict check is accurate.
 */
export function stampIdentity(vCard, { resourceName, etag }) {
  const comp = parseVCard(vCard) ?? newVCard();
  comp.removeAllProperties(X_RESOURCENAME);
  comp.removeAllProperties(X_ETAG);
  if (resourceName) comp.addPropertyWithValue(X_RESOURCENAME, resourceName);
  if (etag) comp.addPropertyWithValue(X_ETAG, etag);
  return comp.toString();
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

/** ICAL sometimes returns a typed value object (e.g. VCardTime) for dates;
 *  coerce anything non-string to string for plain reads. */
function stringOf(v) {
  return typeof v === "string" ? v : String(v);
}

// ── Names ────────────────────────────────────────────────────────────────

function writeNames(comp, person) {
  const name = person.names?.[0];
  if (!name) return;
  // N is a 5-component structured text property; FN is the free-form
  // display form. Google's Person gives us both independently.
  const n = new ICAL.Property("n", comp);
  n.setValue([
    name.familyName ?? "",
    name.givenName ?? "",
    name.middleName ?? "",
    name.honorificPrefix ?? "",
    name.honorificSuffix ?? "",
  ]);
  comp.addProperty(n);
  // FN is required in vCard 4.0 — synthesize one if Google didn't give a
  // displayName so we never emit an invalid card.
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
  return out.filter(e => e.value);
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
      "",                              // PO box (unused)
      addr.extendedAddress ?? "",
      addr.streetAddress ?? "",
      addr.city ?? "",
      addr.region ?? "",
      addr.postalCode ?? "",
      addr.country ?? "",
    ];
    if (parts.every(s => !s)) continue;
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
    if (![extended, street, city, region, postalCode, country].some(Boolean)) continue;
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
      out.push({ protocol: str.slice(0, colon), username: str.slice(colon + 1) });
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
    // ORG in vCard 4.0 is a semicolon-separated list (unit components);
    // Google's Person.organizations[].name is a single string.
    out.name = Array.isArray(orgValue) ? orgValue.filter(Boolean).join(" ") : stringOf(orgValue);
  }
  if (title) out.title = stringOf(title);
  return out;
}

// ── Dates (BDAY / ANNIVERSARY) ──────────────────────────────────────────

function writeDate(comp, propName, date) {
  if (!date) return;
  const s = formatPartialDate(date);
  if (!s) return;
  // VALUE=text handles partial dates (no year / no month) that the default
  // date-and-or-time type won't serialise cleanly.
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

/** Google Person dates have optional year/month/day; vCard 4.0 allows
 *  partial dates via `--MM-DD` / `YYYY----`. Emit with explicit placeholders
 *  so the value remains round-trippable. */
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
    return { year: Number(compact[1]), month: Number(compact[2]), day: Number(compact[3]) };
  }
  return null;
}

// ── Parameter helpers ────────────────────────────────────────────────────

/** Read a single TYPE parameter value, normalising the array form
 *  (`TYPE=home,work`) down to a single string for consumers that only care
 *  about the first. */
function paramValue(prop, name) {
  const v = prop.getParameter(name);
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// ── Type normalisation (Google ↔ vCard) ─────────────────────────────────

function normalizeEmailType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  return "other";
}

function denormalizeEmailType(type) {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  return "other";
}

function normalizePhoneType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  if (lower === "mobile" || lower === "cell") return "cell";
  if (lower === "fax" || lower === "workfax" || lower === "homefax") return "fax";
  if (lower === "pager") return "pager";
  return null;
}

function denormalizePhoneType(type) {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  if (lower === "cell") return "mobile";
  if (lower === "fax") return "workFax";
  if (lower === "pager") return "pager";
  return undefined;
}

function normalizeAddressType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  return null;
}

function denormalizeAddressType(type) {
  if (!type) return undefined;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  return undefined;
}
