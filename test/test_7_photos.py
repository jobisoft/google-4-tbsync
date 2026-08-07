"""7. Photo round trip.

Photos take their own road: Google serves them from a URL and accepts them
through `updateContactPhoto`, never inside the person payload - so this is
the one field a green section 6 says nothing about. The local shape is the
same as the EAS provider's (PHOTO;VALUE=URI with a data URI), which
Thunderbird is proven to store.

Byte identity is deliberately not asserted: Google recompresses and resizes
every upload. What must hold is presence, the bookkeeping stamps
(X-GOOGLE-PHOTO-URL / -HASH), and that a removal reaches Google.
"""

import re

import harness
import probes
from bridge import ok
from harness import test
from test_2_contacts import _writable

SLUG = "fototest"
ANCHOR = probes.email_of(SLUG)

# A 10x10 red JPEG. A JPEG rather than the tiniest possible PNG: Google
# re-encodes whatever arrives, and a 1x1 PNG upscaled through their pipeline
# has come back as a surprisingly large monochrome JPEG - fine for us, but a
# realistic input keeps the test honest.
JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR"
    "CAAKAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAA"
    "AAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA"
    "DAMBAAIRAxEAPwCdABmX/9k="
)
DATA_URI = f"data:image/jpeg;base64,{JPEG_B64}"


def _photo_lines(s, card):
    return [
        line
        for line in s.unfold(s.vcard(card))
        if line.upper().startswith(("PHOTO", "X-GOOGLE-PHOTO"))
    ]


@test("7.1", "create a card with a photo - the photo is uploaded and stamped")
def t_7_1(s):
    _writable(s)
    ok(
        "contacts.create",
        vCard=probes.card(SLUG, extra=(f"PHOTO;VALUE=URI:{DATA_URI}",)),
    )
    s.sync()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card vanished after the push")
    lines = _photo_lines(s, card)
    harness.true(
        any(l.upper().startswith("X-GOOGLE-PHOTO-URL") for l in lines),
        f"no photo URL stamp - updateContactPhoto never ran; photo lines: {lines}",
    )
    harness.true(
        any(l.upper().startswith("X-GOOGLE-PHOTO-HASH") for l in lines),
        "no photo hash stamp - local edits would re-upload forever",
    )
    harness.eq(s.changelog(), [], "changelog drained")


@test("7.2", "clean re-pull - the photo comes back from Google")
def t_7_2(s):
    _writable(s)
    s.rebind()
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the card did not survive the re-pull")
    lines = _photo_lines(s, card)
    harness.true(
        any(re.match(r"PHOTO[^:]*:data:image/", l, re.I) for l in lines),
        f"no PHOTO data URI came back from Google; photo lines: {lines}",
    )
    harness.true(
        any(l.upper().startswith("X-GOOGLE-PHOTO-URL") for l in lines),
        "the pulled photo carries no URL stamp - the next pull will refetch "
        "every photo every time",
    )


@test("7.3", "sync again with no edit - the photo is not re-fetched or re-sent")
def t_7_3(s):
    _writable(s)
    card_before = s.find_card(ANCHOR)
    s.sync()
    card_after = s.find_card(ANCHOR)
    harness.eq(
        _photo_lines(s, card_before),
        _photo_lines(s, card_after),
        "an untouched photo changed across a no-op sync",
    )
    harness.eq(s.changelog(), [], "changelog drained")


@test("7.4", "remove the photo - the removal reaches Google and sticks")
def t_7_4(s):
    _writable(s)
    card = s.find_card(ANCHOR)
    # Unfold first so the PHOTO line and its folded continuation lines drop
    # together, then rebuild the card without them.
    unfolded = s.unfold(s.vcard(card))
    kept = [l for l in unfolded if not l.upper().startswith("PHOTO")]
    ok("contacts.update", id=card["id"], vCard="\r\n".join(kept) + "\r\n")
    s.sync()
    s.rebind()
    card2 = s.find_card(ANCHOR)
    harness.true(card2 is not None, "the card did not survive the re-pull")
    lines = _photo_lines(s, card2)
    harness.true(
        not any(l.upper().startswith("PHOTO") for l in lines),
        f"the photo came back after removal - deleteContactPhoto never ran; "
        f"photo lines: {lines}",
    )
    ok("contacts.remove", id=card2["id"])
    s.sync()

def _png_data_uri(r, g, b):
    """A 1x1 PNG in the given color - two calls give two distinct, valid
    images, which is all a replacement test needs."""
    import base64, struct, zlib

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(
            ">I", zlib.crc32(c) & 0xFFFFFFFF
        )

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    idat = zlib.compress(b"\x00" + bytes((r, g, b)))
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", idat)
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(png).decode()


@test("7.5", "replace the photo - the new image is uploaded, not skipped")
def t_7_5(s):
    _writable(s)
    slug = "fotowechsel"
    ok(
        "contacts.create",
        vCard=probes.card(slug, extra=(f"PHOTO;VALUE=URI:{_png_data_uri(255, 0, 0)}",)),
    )
    s.sync()
    card = s.find_card(probes.email_of(slug))
    harness.true(card is not None, "setup card did not reach Google")
    before = [
        l for l in s.unfold(s.vcard(card)) if l.upper().startswith("X-GOOGLE-PHOTO-HASH")
    ]
    harness.true(before, "no hash stamp after the first upload")

    unfolded = s.unfold(s.vcard(card))
    swapped = []
    for line in unfolded:
        if line.upper().startswith("PHOTO"):
            swapped.append(f"PHOTO;VALUE=URI:{_png_data_uri(0, 0, 255)}")
        else:
            swapped.append(line)
    ok("contacts.update", id=card["id"], vCard="\r\n".join(swapped) + "\r\n")
    s.sync()
    card2 = s.find_card(probes.email_of(slug))
    after = [
        l for l in s.unfold(s.vcard(card2)) if l.upper().startswith("X-GOOGLE-PHOTO-HASH")
    ]
    harness.true(
        after and after != before,
        "the hash stamp did not change - the replacement photo was never "
        "uploaded (the hash comparison thinks nothing changed)",
    )
    ok("contacts.remove", id=card2["id"])
    s.sync()

