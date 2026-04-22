/**
 * Translate Google People API `Person` resources ↔ vCard 4.0 strings.
 *
 * For M2c we only need the one-way direction — Google → vCard — consumed by
 * `messenger.contacts.create({ vCard })` / `messenger.contacts.update`.
 * Local-edit push-back is M3, so no vCard-to-Person translator here.
 *
 * Identity of a card is carried on the vCard itself as two X-properties:
 *   X-GOOGLE-RESOURCENAME:people/c...        ← primary key (matches legacy)
 *   X-GOOGLE-ETAG:<string>                    ← change detector
 *
 * We skip `photos`, `userDefined`, and `memberships` — those are M3 / later
 * and match what the legacy provider did.
 */

/** Google Person → vCard 4.0 string. */
export function personToVCard(person) {
  const lines = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:4.0");

  appendName(lines, person.names?.[0]);
  appendFn(lines, person);
  appendSimple(lines, "NICKNAME", person.nicknames?.[0]?.value);

  for (const email of person.emailAddresses ?? []) {
    appendEmail(lines, email, lines._firstEmail ? false : (lines._firstEmail = true));
  }
  for (const phone of person.phoneNumbers ?? []) appendPhone(lines, phone);
  for (const addr of person.addresses ?? []) appendAddress(lines, addr);
  for (const url of person.urls ?? []) appendUrl(lines, url);
  for (const im of person.imClients ?? []) appendImpp(lines, im);

  appendOrganization(lines, person.organizations?.[0]);
  appendDate(lines, "BDAY", person.birthdays?.[0]?.date);
  const anniv = (person.events ?? []).find(e => /anniversary/i.test(e.type ?? ""));
  if (anniv) appendDate(lines, "ANNIVERSARY", anniv.date);
  appendSimple(lines, "NOTE", person.biographies?.[0]?.value);

  // Identity markers — last so they're easy to spot in raw vCard dumps.
  if (person.resourceName) lines.push(`X-GOOGLE-RESOURCENAME:${escapeValue(person.resourceName)}`);
  if (person.etag) lines.push(`X-GOOGLE-ETAG:${escapeValue(person.etag)}`);

  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Quickly extract identity fields from an existing vCard string so we can
 * diff server vs. local without a full parse. Uses line-level regex because
 * that's cheaper than a full vCard parser and sufficient for X-properties.
 */
export function readIdentity(vCard) {
  if (!vCard) return null;
  const resourceMatch = vCard.match(/^X-GOOGLE-RESOURCENAME:(.+)$/m);
  if (!resourceMatch) return null;
  const etagMatch = vCard.match(/^X-GOOGLE-ETAG:(.+)$/m);
  return {
    resourceName: unescapeValue(resourceMatch[1].trim()),
    etag: etagMatch ? unescapeValue(etagMatch[1].trim()) : null,
  };
}

// ── Field helpers ─────────────────────────────────────────────────────────

function appendName(lines, name) {
  if (!name) return;
  const parts = [
    name.familyName ?? "",
    name.givenName ?? "",
    name.middleName ?? "",
    name.honorificPrefix ?? "",
    name.honorificSuffix ?? "",
  ].map(escapeValue);
  // N is always five ;-separated components — emit even if some are empty.
  lines.push(`N:${parts.join(";")}`);
}

function appendFn(lines, person) {
  const display = person.names?.[0]?.displayName;
  if (display) {
    lines.push(`FN:${escapeValue(display)}`);
    return;
  }
  // FN is required in vCard 4.0 — synthesize one from other fields rather
  // than risk emitting an invalid card.
  const email = person.emailAddresses?.[0]?.value;
  const org = person.organizations?.[0]?.name;
  const fallback = email ?? org ?? "Unknown";
  lines.push(`FN:${escapeValue(fallback)}`);
}

function appendSimple(lines, prop, value) {
  if (!value) return;
  lines.push(`${prop}:${escapeValue(value)}`);
}

function appendEmail(lines, email, isFirst) {
  if (!email?.value) return;
  const type = normalizeEmailType(email.type);
  const params = [];
  if (type) params.push(`TYPE=${type}`);
  if (isFirst) params.push("PREF=1");
  const prefix = params.length ? `EMAIL;${params.join(";")}` : "EMAIL";
  lines.push(`${prefix}:${escapeValue(email.value)}`);
}

function appendPhone(lines, phone) {
  if (!phone?.value) return;
  const type = normalizePhoneType(phone.type);
  const prefix = type ? `TEL;TYPE=${type}` : "TEL";
  lines.push(`${prefix}:${escapeValue(phone.value)}`);
}

function appendAddress(lines, addr) {
  if (!addr) return;
  const parts = [
    "",                                   // PO Box (unused)
    escapeValue(addr.extendedAddress ?? ""),
    escapeValue(addr.streetAddress ?? ""),
    escapeValue(addr.city ?? ""),
    escapeValue(addr.region ?? ""),
    escapeValue(addr.postalCode ?? ""),
    escapeValue(addr.country ?? ""),
  ];
  if (parts.every(p => !p)) return;
  const type = normalizeAddressType(addr.type);
  const prefix = type ? `ADR;TYPE=${type}` : "ADR";
  lines.push(`${prefix}:${parts.join(";")}`);
}

function appendUrl(lines, url) {
  if (!url?.value) return;
  const type = /work/i.test(url.type ?? "") ? "work" : null;
  const prefix = type ? `URL;TYPE=${type}` : "URL";
  lines.push(`${prefix}:${escapeValue(url.value)}`);
}

function appendImpp(lines, im) {
  if (!im?.username) return;
  const protocol = (im.protocol ?? "x-unknown").toLowerCase().replace(/[^a-z0-9+.-]/g, "");
  lines.push(`IMPP:${protocol}:${escapeValue(im.username)}`);
}

function appendOrganization(lines, org) {
  if (!org) return;
  if (org.name) lines.push(`ORG:${escapeValue(org.name)}`);
  if (org.title) lines.push(`TITLE:${escapeValue(org.title)}`);
}

function appendDate(lines, prop, date) {
  if (!date) return;
  // Google returns {year?, month?, day?}. vCard wants YYYY-MM-DD with '-'
  // placeholders for missing components (per RFC 6350 §4.3.4).
  const y = date.year ? String(date.year).padStart(4, "0") : "--";
  const m = date.month ? String(date.month).padStart(2, "0") : "--";
  const d = date.day ? String(date.day).padStart(2, "0") : "--";
  if (y === "--" && m === "--" && d === "--") return;
  lines.push(`${prop}:${y}-${m}-${d}`);
}

// ── Type normalisation ────────────────────────────────────────────────────

function normalizeEmailType(type) {
  if (!type) return null;
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

function normalizeAddressType(type) {
  if (!type) return null;
  const lower = type.toLowerCase();
  if (lower === "home" || lower === "work") return lower;
  return null;
}

// ── vCard value escaping (RFC 6350 §3.4) ─────────────────────────────────

/** Escape a value for inclusion in a vCard property. */
function escapeValue(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Reverse of escapeValue — used when reading X-properties back. */
function unescapeValue(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}
