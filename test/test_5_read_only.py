"""5. Read-only mode.

Read-only is the default for a new Google account, and it is a legitimate
configuration rather than a fault - so what matters is that a local edit is
discarded predictably and the account stays usable, not that it is refused.

These run only when the account is actually in read-only mode; the write
sections skip in the same way when it is not. The two halves are mutually
exclusive on purpose - a single run cannot test both.
"""

import harness
import probes
from bridge import ok
from harness import Skip, test

SLUG = "readonly"
ANCHOR = probes.email_of(SLUG)


def _read_only(s):
    if not s.read_only:
        raise Skip("account is read-write; enable read-only mode to run these")


@test("5.1", "a local edit is queued, then dropped by the sync")
def t_5_1(s):
    _read_only(s)
    ok("contacts.create", vCard=probes.card(SLUG))
    harness.true(s.changelog(), "the edit was not queued at all")
    s.sync()
    harness.eq(
        s.changelog(),
        [],
        "the pending edit was left to accumulate - in read-only mode it will "
        "never be pushed, so it has to be dropped rather than retried forever",
    )


@test("5.2", "the folder stays green - read-only is not an error")
def t_5_2(s):
    _read_only(s)
    harness.eq(s.status(), "success", "folder status")
    harness.eq(s.folder()["error"], None, "folder error")


@test("5.3", "the drop is explained in the log")
def t_5_3(s):
    _read_only(s)
    # The edit vanishes from the user's point of view, so something has to
    # say why. It is only a log line today - the folder row shows nothing.
    harness.true(
        s.log_lines("read-only"),
        "nothing in the log explains why the edit disappeared",
    )


@test("5.4", "the local card is not destroyed, and Google is untouched")
def t_5_4(s):
    _read_only(s)
    card = s.find_card(ANCHOR)
    harness.true(card is not None, "the locally-created card was deleted outright")
    harness.true(
        s.resource_name(card) is None,
        "the card carries a Google identity, so it was pushed despite "
        "read-only mode",
    )
    ok("contacts.remove", id=card["id"])
    s.sync()
