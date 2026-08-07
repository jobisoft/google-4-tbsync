"""8. Old cards - the sync-revision guard.

Cards written before the field-family expansion carry none of the new
lines (X-CUSTOM1..4, GENDER, ROLE, RELATED, CALURI) and no revision stamp.
Pushed verbatim they would clear those families on Google, because a field
in the update mask but absent from the person is cleared server-side -
demonstrated live before this guard existed: a title edit left the server
card with nothing but the title.

The guard: every card the provider writes is stamped X-GOOGLE-SYNC-REV
with the mapper's current revision; a below-revision card about to be
pushed is clean-pulled first and the unknown families merged in, local
changes winning. An old card is simulated the way the live demo did it -
strip the new-family lines and the stamp off a synced card, exactly the
shape the pre-expansion mapper left behind.
"""

import re

import harness
import probes
from bridge import ok
from harness import test
from test_2_contacts import _writable

SLUG = "altkarte"
ANCHOR = probes.email_of(SLUG)

# Everything the pre-expansion mapper did not know, plus the stamp itself.
NEW_FAMILY = ("X-CUSTOM", "GENDER", "ROLE", "RELATED", "CALURI")
STRIP = NEW_FAMILY + ("X-GOOGLE-SYNC-REV",)


def _unfolded(s, card):
    return "\n".join(s.unfold(s.vcard(card)))


def _sync_rev(s, card):
    for line in s.unfold(s.vcard(card)):
        m = re.match(r"^X-GOOGLE-SYNC-REV[^:]*:(\S+)", line, re.I)
        if m:
            return m.group(1)
    return None


def _as_old_card(s, card, edits=(), extra=()):
    """The vCard as the pre-expansion mapper would have stored it: new
    families and stamp gone, identity stamps kept, plus optional edits."""
    kept = [
        line
        for line in s.unfold(s.vcard(card))
        if not line.upper().startswith(STRIP)
    ]
    for old, new in edits:
        kept = [line.replace(old, new) for line in kept]
    end = kept.index("END:VCARD")
    kept[end:end] = list(extra)
    return "\r\n".join(kept) + "\r\n"


@test("8.1", "an old card's edit no longer clears the new families on Google")
def t_8_1(s):
    _writable(s)
    # Setup: push the rich probe card so Google holds values in every new
    # family. This is the server-side data the guard must protect.
    ok("contacts.create", vCard=probes.card(SLUG))
    s.sync()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card vanished after the push")
    # The push path must have stamped the card current (stampLocalCard).
    harness.eq(
        _sync_rev(s, card),
        "2",
        "a pushed card must carry the current revision stamp",
    )

    # Back-date the card and make an ordinary edit - the pre-guard code
    # cleared every new family on Google for exactly this shape.
    ok(
        "contacts.update",
        id=card["id"],
        vCard=_as_old_card(
            s, card, edits=[("TITLE:Protokolltester", "TITLE:Altkarten-Edit")]
        ),
    )
    # This sync is the moment of truth: pushModify sees syncRev 1 < 2,
    # clean-pulls the server person, merges, and pushes the upgraded card.
    s.sync()

    # The push must have upgraded the local card: families merged back in,
    # stamp current.
    local = s.find_card(ANCHOR)
    body = _unfolded(s, local)
    harness.contains(body, "Erste Notiz", "the merge did not restore X-CUSTOM1")
    harness.eq(_sync_rev(s, local), "2", "the pushed old card was not restamped")

    # Server truth: drop the book, re-pull, and check what Google kept.
    s.rebind()
    body = _unfolded(s, s.find_card(ANCHOR))
    harness.contains(body, "Altkarten-Edit", "the actual edit got lost")
    lost = [
        label
        for label, pattern in [
            ("custom 1", r"^X-CUSTOM1[^:\r\n]*:Erste Notiz"),
            ("custom 2", r"^X-CUSTOM2[^:\r\n]*:Zweite Notiz"),
            ("gender", r"^GENDER[^:\r\n]*:F"),
            ("role", r"^ROLE[^:\r\n]*:Testperson"),
            ("relation", r"^RELATED[^:\r\n]*:Jane Probe"),
            ("calendar link", r"^CALURI[^:\r\n]*:.*probe\.ics"),
        ]
        if not re.search(pattern, body, re.M | re.I)
    ]
    harness.eq(
        lost,
        [],
        f"the old-card push cleared server fields; the re-pulled card was:\n{body}",
    )


@test("8.2", "local changes win in the old-card merge")
def t_8_2(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "8.1 must have left the card in place")

    # Old shape again, but this time the user also added a custom field
    # locally - their value must reach Google while the server's other
    # entries survive.
    ok(
        "contacts.update",
        id=card["id"],
        vCard=_as_old_card(s, card, extra=["X-CUSTOM1:Lokal gewonnen"]),
    )
    # Push (guard merges: local slot 1 wins, server fills the rest), then
    # re-pull from scratch for the server's verdict.
    s.sync()
    s.rebind()
    body = _unfolded(s, s.find_card(ANCHOR))
    harness.contains(body, "Lokal gewonnen", "the local addition lost the merge")
    harness.true(
        "Erste Notiz" not in body,
        "the local value did not replace the server's slot 1",
    )
    harness.contains(body, "Zweite Notiz", "the merge dropped the server's slot 2")


@test("8.3", "removals on a current-revision card still clear on Google")
def t_8_3(s):
    # The guard must not soften deliberate removals: on a stamped card an
    # absent family is absent because the user removed it (6.4 semantics).
    _writable(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "8.2 must have left the card in place")
    harness.eq(_sync_rev(s, card), "2", "the re-pulled card must be current")
    # Remove one custom line from the stamped card - a deliberate removal,
    # not an old card's ignorance.
    kept = [
        line
        for line in s.unfold(s.vcard(card))
        if "Lokal gewonnen" not in line
    ]
    ok("contacts.update", id=card["id"], vCard="\r\n".join(kept) + "\r\n")
    # Push (no merge this time - the card is current), then re-pull.
    s.sync()
    s.rebind()
    body = _unfolded(s, s.find_card(ANCHOR))
    harness.true(
        "Lokal gewonnen" not in body,
        "the removed custom field came back - the guard resurrected it",
    )
    # The slot mapping is positional, so the surviving entry may change
    # slots - it must survive somewhere.
    harness.contains(body, "Zweite Notiz", "the untouched entry was lost too")
