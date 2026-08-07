"""6. Field fidelity across the server.

Section 2 proves a card survives; this section proves its *fields* do. One
rich card goes up, the book is torn down and re-pulled, and every mapped
field has to come back from Google - the re-pull is the only view of what
the server actually stored rather than what the local book still remembers.

Covers the field families added for parity with the original
Google-4-TbSync and beyond it: the four custom slots (People API
`userDefined`), GENDER (`genders`), ROLE (`occupations`), RELATED
(`relations`), CALURI (`calendarUrls`) - plus IMPP and ANNIVERSARY, which
were mapped from the start but never round-trip-tested.
"""

import re

import harness
import probes
from bridge import ok
from harness import test
from test_2_contacts import _writable

SLUG = "feldtest"
ANCHOR = probes.email_of(SLUG)

# (label, regex against the unfolded re-pulled vCard). What each field looks
# like after Google has normalised it - values must survive; parameter
# spelling may change.
ROUND_TRIP_FIELDS = [
    ("given name", r"^N:[^;\r\n]*;PROBE"),
    ("nickname", r"^NICKNAME[^:\r\n]*:"),
    ("organization", r"^ORG[^:\r\n]*:Beispiel GmbH"),
    ("title", r"^TITLE[^:\r\n]*:Protokolltester"),
    ("work email", rf"^EMAIL[^:\r\n]*:{re.escape(ANCHOR)}"),
    ("home email", rf"^EMAIL[^:\r\n]*:{re.escape(SLUG)}-home@probe\.invalid"),
    ("work phone", r"^TEL[^:\r\n]*:\+49 228 1234567"),
    ("cell phone", r"^TEL[^:\r\n]*:\+49 170 7654321"),
    ("street", r"^ADR[^:\r\n]*:[^\r\n]*Musterweg 4"),
    ("birthday", r"^BDAY[^:\r\n]*:.*(19800229|1980-02-29)"),
    ("anniversary", r"^ANNIVERSARY[^:\r\n]*:.*(20100615|2010-06-15)"),
    ("im address", r"^IMPP[^:\r\n]*:xmpp:probe@jabber\.invalid"),
    ("url", r"^URL[^:\r\n]*:.*example\.invalid/probe"),
    ("custom 1", r"^X-CUSTOM1[^:\r\n]*:Erste Notiz"),
    ("custom 2", r"^X-CUSTOM2[^:\r\n]*:Zweite Notiz"),
    ("gender", r"^GENDER[^:\r\n]*:F"),
    ("role", r"^ROLE[^:\r\n]*:Testperson"),
    ("relation", r"^RELATED[^:\r\n]*:Jane Probe"),
    ("calendar link", r"^CALURI[^:\r\n]*:.*example\.invalid/probe\.ics"),
    ("note", r"^NOTE[^:\r\n]*:Angelegt vom Test"),
]


def _unfolded(s, card):
    return "\n".join(s.unfold(s.vcard(card)))


@test("6.1", "create the rich card, sync - it reaches Google and is stamped")
def t_6_1(s):
    _writable(s)
    # The full-fat probe card: every mapped field family filled in. Create
    # locally, sync so the push sends it.
    ok("contacts.create", vCard=probes.card(SLUG))
    s.sync()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card vanished after the push")
    harness.true(
        s.resource_name(card) is not None,
        "no X-GOOGLE-RESOURCENAME - the card never reached Google",
    )
    harness.eq(s.changelog(), [], "changelog drained")


@test("6.2", "clean re-pull - every mapped field comes back from Google")
def t_6_2(s):
    _writable(s)
    # Drop the book and re-pull: the card is now rebuilt purely from what
    # Google stored, so a field missing here was lost in the round trip.
    s.rebind()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card did not survive a clean re-pull")
    body = _unfolded(s, card)
    # Check every family in one pass and report all losses at once.
    missing = [
        label
        for label, pattern in ROUND_TRIP_FIELDS
        if not re.search(pattern, body, re.M | re.I)
    ]
    harness.eq(
        missing,
        [],
        f"fields lost in the Google round trip; the pulled card was:\n{body}",
    )


@test("6.3", "edit a custom field - the edit survives the next re-pull")
def t_6_3(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "6.2 must have left the card in place")
    # Edit X-CUSTOM1's value locally, push it, then re-pull from scratch:
    # the new value must come back from Google.
    edited = s.vcard(card).replace("Erste Notiz", "Erste Notiz v2")
    harness.true("Erste Notiz v2" in edited, "the field to edit was present")
    ok("contacts.update", id=card["id"], vCard=edited)
    s.sync()
    s.rebind()
    body = _unfolded(s, s.find_card(ANCHOR))
    harness.contains(
        body,
        "Erste Notiz v2",
        "the custom-field edit did not survive - the push mask is missing "
        "userDefined, so Google reverts it",
    )


@test("6.4", "field removal - cleared fields stay cleared on Google")
def t_6_4(s):
    # The class of bug the EAS suite found server-side (omitted elements
    # keep their server copy): Google's updateContact should clear any
    # masked field the person omits - this is the proof.
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "6.3 must have left the card in place")
    # Rewrite the card WITHOUT these lines - the way a user removes fields.
    # One representative per family type, plus BDAY for the date writers.
    cleared = ("NICKNAME", "X-CUSTOM2", "ROLE", "RELATED", "CALURI", "BDAY")
    kept = [
        line
        for line in s.unfold(s.vcard(card))
        if not line.upper().startswith(cleared)
    ]
    ok("contacts.update", id=card["id"], vCard="\r\n".join(kept) + "\r\n")
    # Push the removal, then re-pull from scratch: Google must report the
    # fields as gone, not hand their old values back.
    s.sync()
    s.rebind()
    body = _unfolded(s, s.find_card(ANCHOR))
    survivors = [
        f
        for f in cleared
        if re.search(rf"^{f}[^:\r\n]*:.", body, re.M | re.I)
    ]
    harness.eq(
        survivors,
        [],
        "locally removed fields came back from Google - either missing from "
        f"the update mask or restored by the pull; the card was:\n{body}",
    )


@test("6.5", "delete the card, sync - gone and staying gone")
def t_6_5(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "6.3 must have left the card in place")
    # Delete the rich card and push the delete.
    ok("contacts.remove", id=card["id"])
    s.sync()
    harness.true(s.find_card(ANCHOR) is None, "the card is gone locally")
    # A second sync catches the delete echoing back from a pull.
    s.sync()
    harness.true(s.find_card(ANCHOR) is None, "the echo re-created the card")
    harness.eq(s.changelog(), [], "changelog drained")
