"""The cards and lists the tests push, and the cleanup that finds them again.

Everything a test creates carries `PROBE` in a field that survives a round
trip - the email address for a card, the name for a list. Neither is rebuilt
by Google, unlike `FN`, which is regenerated from the name components and so
cannot identify anything after a sync.

`reset` runs from the suite's per-section preflight, so a previous crash
cannot make a run fail or quietly pass, and once more at the very end, so the
account is left as it was found.
"""

from bridge import rpc

MARKER = "PROBE"
LIST_PREFIX = f"{MARKER} list"


def card(slug, extra=()):
    """A card with enough shape to notice a mapper regression - structured
    name, two emails, two phone numbers, an address, a leap-day birthday and
    a note with non-ASCII in it."""
    lines = [
        "BEGIN:VCARD",
        "VERSION:4.0",
        f"FN:{MARKER} {slug}",
        f"N:{slug};{MARKER};Q;Dr.;",
        "NICKNAME:Probey",
        "ORG:Beispiel GmbH;Entwicklung",
        "TITLE:Protokolltester",
        f"EMAIL;TYPE=work:{slug}@probe.invalid",
        f"EMAIL;TYPE=home:{slug}-home@probe.invalid",
        "TEL;TYPE=work:+49 228 1234567",
        "TEL;TYPE=cell:+49 170 7654321",
        "ADR;TYPE=work:;;Musterweg 4;Bonn;NRW;53111;Deutschland",
        "BDAY:19800229",
        "ANNIVERSARY:20100615",
        "IMPP:xmpp:probe@jabber.invalid",
        "URL:https://example.invalid/probe",
        "X-CUSTOM1:Erste Notiz",
        "X-CUSTOM2:Zweite Notiz",
        "GENDER:F",
        "ROLE:Testperson",
        "RELATED;VALUE=TEXT;TYPE=spouse:Jane Probe",
        "CALURI:https://example.invalid/probe.ics",
        "NOTE:Angelegt vom Test. Umlaute: aeoeue AEOEUE ss.",
    ]
    lines += list(extra) + ["END:VCARD", ""]
    return "\r\n".join(lines)


def email_of(slug):
    """The anchor a test matches on - stable across a round trip."""
    return f"{slug}@probe.invalid"


def reset(s):
    """Evaluate the current state and clear anything a test left behind.

    Every section calls this first. A crashed or throttled run leaves probe
    data on the server, and the next run then matches whichever copy comes
    first - so clearing is what makes a section a complete statement rather
    than something that only works after the one before it.
    """
    removed = False
    for lst in s.lists():
        if (lst.get("name") or "").startswith(LIST_PREFIX):
            rpc("lists.remove", id=lst["id"])
            removed = True
    for c in s.cards():
        if "probe.invalid" in s.vcard(c):
            rpc("contacts.remove", id=c["id"])
            removed = True
    if removed:
        s.sync()
        s.settle()
        # A delete that reached Google still leaves the pull to catch up.
        s.sync()
    return removed
