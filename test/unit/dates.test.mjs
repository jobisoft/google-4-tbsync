/**
 * Birthdays and anniversaries between Google and Thunderbird's vCard.
 *
 * Thunderbird's contact editor hides a TEXT-typed BDAY/ANNIVERSARY, so the
 * mapper must write DATE, and it must read every shape Thunderbird writes,
 * including a date without a year (`--0417`).
 *
 * Run with `npm run test:unit` (node --test).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  personToVCard,
  vCardToPerson,
  dropTextDates,
} from "../../src/modules/google/contact-mapper.mjs";

const person = (birthday, anniversary) => ({
  names: [{ givenName: "A", familyName: "B" }],
  birthdays: birthday ? [{ date: birthday }] : undefined,
  events: anniversary ? [{ type: "anniversary", date: anniversary }] : undefined,
});

const lines = (vCard, name) =>
  vCard
    .split(/\r?\n/)
    .filter((l) => l.toUpperCase().startsWith(name));

const card = (...extra) =>
  [
    "BEGIN:VCARD",
    "VERSION:4.0",
    "FN:A B",
    "N:B;A;;;",
    ...extra,
    "END:VCARD",
    "",
  ].join("\r\n");

const SHAPES = [
  ["full", { year: 1978, month: 12, day: 10 }, "19781210"],
  ["no year", { month: 4, day: 17 }, "--0417"],
  ["year only", { year: 1978 }, "1978"],
  ["year and month", { year: 1978, month: 4 }, "1978-04"],
];

for (const [label, date, text] of SHAPES) {
  test(`${label}: written as a DATE, not TEXT`, () => {
    const out = personToVCard(person(date));
    assert.deepEqual(lines(out, "BDAY"), [`BDAY;VALUE=DATE:${text}`]);
    assert.ok(!/VALUE=TEXT/i.test(out), "no TEXT value anywhere");
    assert.ok(!out.includes("---"), "nothing malformed");
  });

  test(`${label}: survives Google to vCard to Google`, () => {
    const back = vCardToPerson(personToVCard(person(date, date)));
    assert.deepEqual(back.birthdays[0].date, { year: undefined, month: undefined, day: undefined, ...date });
    assert.deepEqual(back.events[0].date, { year: undefined, month: undefined, day: undefined, ...date });
  });
}

test("an empty date writes nothing", () => {
  assert.equal(lines(personToVCard(person({})), "BDAY").length, 0);
});

test("every shape Thunderbird can store is read", () => {
  const read = (l) => vCardToPerson(card(l)).birthdays?.[0]?.date;
  assert.deepEqual(read("BDAY;VALUE=DATE:19781210"), { year: 1978, month: 12, day: 10, });
  assert.equal(read("BDAY;VALUE=DATE:1978-12-10").month, 12);
  for (const v of ["--0417", "--04-17"]) {
    const d = read(`BDAY;VALUE=DATE:${v}`);
    assert.deepEqual([d.year, d.month, d.day], [undefined, 4, 17], v);
  }
  assert.deepEqual(read("BDAY:--0417")?.month, 4, "without a VALUE parameter");
  assert.equal(read("BDAY;VALUE=DATE:---17").day, 17);
});

test("TEXT values from older cards are still read", () => {
  const read = (l) => vCardToPerson(card(l)).birthdays?.[0]?.date;
  assert.equal(read("BDAY;VALUE=TEXT:1978-12-10").year, 1978);
  // What this add-on used to write for a date without a year.
  const d = read("BDAY;VALUE=TEXT:---04-17");
  assert.deepEqual([d.year, d.month, d.day], [undefined, 4, 17]);
});

test("what cannot be read gives no date", () => {
  assert.equal(vCardToPerson(card("BDAY;VALUE=TEXT:someday")).birthdays, undefined);
});

test("dropTextDates turns TEXT into DATE, both properties", () => {
  const out = dropTextDates(
    card("BDAY;VALUE=TEXT:1978-12-10", "ANNIVERSARY;VALUE=TEXT:---04-17", "NOTE:keep"),
  );
  assert.deepEqual(lines(out, "BDAY"), ["BDAY;VALUE=DATE:19781210"]);
  assert.deepEqual(lines(out, "ANNIVERSARY"), ["ANNIVERSARY;VALUE=DATE:--0417"]);
  assert.match(out, /NOTE:keep/, "nothing else is touched");
});

test("dropTextDates leaves everything else alone", () => {
  assert.equal(dropTextDates(card("BDAY;VALUE=DATE:19781210")), null);
  assert.equal(dropTextDates(card("NOTE:none")), null);
  assert.equal(dropTextDates(card("BDAY;VALUE=TEXT:someday")), null);
  assert.equal(dropTextDates(""), null);
});

test("dropTextDates finds nothing on a second pass", () => {
  const once = dropTextDates(card("BDAY;VALUE=TEXT:1978-12-10"));
  assert.equal(dropTextDates(once), null);
});
