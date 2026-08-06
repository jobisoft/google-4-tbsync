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
    s.rebind()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card did not survive a clean re-pull")
    body = _unfolded(s, card)
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


@test("6.4", "delete the card, sync - gone and staying gone")
def t_6_4(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "6.3 must have left the card in place")
    ok("contacts.remove", id=card["id"])
    s.sync()
    harness.true(s.find_card(ANCHOR) is None, "the card is gone locally")
    s.sync()
    harness.true(s.find_card(ANCHOR) is None, "the echo re-created the card")
    harness.eq(s.changelog(), [], "changelog drained")
