"""2. Contact round trip - create, modify, delete.

The delete steps exist because of a real bug: deletes were pushed *after* the
pull, so the pull re-created the very card the user had just deleted and it
sat in the address book until the next sync noticed the server no longer had
it. 2.4 is the assertion that would have caught it.

Every step ends with a clean re-pull where local state could otherwise pass
for a successful push.
"""

import harness
import probes
from bridge import ok
from harness import Skip, test

SLUG = "roundtrip"
ANCHOR = probes.email_of(SLUG)


def _writable(s):
    if s.read_only:
        raise Skip("account is in read-only mode; turn it off to run write tests")


@test("2.1", "create, sync - the card reaches Google and is stamped")
def t_2_1(s):
    _writable(s)
    before = len(s.cards())
    ok("contacts.create", vCard=probes.card(SLUG))
    s.sync()

    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card vanished after the push")
    harness.true(
        s.resource_name(card) is not None,
        "no X-GOOGLE-RESOURCENAME - the card was saved locally but never "
        "reached Google",
    )
    harness.eq(len(s.cards()), before + 1, "card count")
    harness.eq(s.changelog(), [], "changelog drained")
    harness.eq(s.status(), "success", "folder status")


@test("2.2", "modify, sync - the edit sticks and the identity does not move")
def t_2_2(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "2.1 must have left a card to modify")
    was = s.resource_name(card)

    body = s.vcard(card)
    body = body.replace("TITLE:Protokolltester", "TITLE:Protokolltester (geaendert)")
    body = body.replace("+49 228 1234567", "+49 228 7777777")
    ok("contacts.update", id=card["id"], vCard=body)
    s.sync()

    after = s.find_card(ANCHOR)
    harness.eq(s.resource_name(after), was, "resourceName changed under an edit")
    lines = s.unfold(s.vcard(after))
    harness.true(
        any("Protokolltester (geaendert)" in l for l in lines), "the title edit held"
    )
    harness.true(any("7777777" in l for l in lines), "the phone edit held")
    harness.eq(s.changelog(), [], "changelog drained")


@test("2.3", "clean re-pull - the card comes back from Google intact")
def t_2_3(s):
    _writable(s)
    s.rebind()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card did not survive a clean re-pull")
    lines = s.unfold(s.vcard(card))
    # Field-level fidelity. Unfold first: a long NOTE is wrapped, and reading
    # the raw lines makes an intact note look truncated.
    for expected in (
        "N:roundtrip;PROBE;Q;Dr.;",
        "TEL;TYPE=cell:+49 170 7654321",
        "ADR;TYPE=work:;;Musterweg 4;Bonn;NRW;53111;Deutschland",
        "NOTE:Angelegt vom Test. Umlaute: aeoeue AEOEUE ss.",
    ):
        harness.true(
            any(l == expected for l in lines),
            f"{expected!r} did not survive the round trip; got {lines}",
        )
    harness.true(
        any(l.startswith("BDAY") and "0229" in l.replace("-", "") for l in lines),
        "the leap-day birthday did not survive",
    )


@test("2.4", "delete, sync - it stays deleted and is not re-created by the pull")
def t_2_4(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "2.3 must have left a card to delete")
    before = len(s.cards())
    ok("contacts.remove", id=card["id"])
    s.sync()

    harness.true(
        s.find_card(ANCHOR) is None,
        "the deleted card came back - the pull ran before the delete was "
        "pushed and could not tell it from a card it had never seen",
    )
    harness.eq(len(s.cards()), before - 1, "card count")
    harness.eq(s.changelog(), [], "changelog drained")
    s.sync()
    harness.true(s.find_card(ANCHOR) is None, "still gone after a settling sync")
