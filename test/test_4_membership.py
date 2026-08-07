"""4. Mailing-list membership.

Adding a contact to a list used to survive only until the next sync: nothing
recorded the change, so the pull reconciled the book back to the server and
the membership vanished. Memberships were server->local by construction.

4.4 is the other half of that fix. The provider applies the server's
memberships locally, and if those writes are not pre-tagged they come back as
pending user edits and are pushed again on every sync, forever.
"""

import harness
import probes
from bridge import ok
from harness import Skip, test

NAME = f"{probes.LIST_PREFIX} members"
SLUG = "member"
ANCHOR = probes.email_of(SLUG)


def _writable(s):
    if s.read_only:
        raise Skip("account is in read-only mode; turn it off to run write tests")


def _setup(s):
    """A list and a card, both already on Google."""
    ok("lists.create", name=NAME)
    ok("contacts.create", vCard=probes.card(SLUG))
    s.sync()
    lst, card = s.find_list(NAME), s.find_card(ANCHOR)
    harness.true(lst is not None and card is not None, "setup did not reach Google")
    harness.true(s.resource_name(card) is not None, "the card was not stamped")
    return lst, card


@test("4.1", "add a member - the change is recorded rather than lost")
def t_4_1(s):
    _writable(s)
    lst, card = _setup(s)
    # Add the card to the list locally and DON'T sync yet - this test is
    # about what gets recorded, 4.2 is about what the sync does with it.
    ok("lists.addMember", id=lst["id"], contactId=card["id"])

    # The changelog must now hold a membership entry; without one the next
    # pull reconciles the book back to the server and the add vanishes.
    kinds = [e.get("kind") for e in s.changelog()]
    harness.contains(
        kinds,
        "membership",
        "no membership entry was queued - nothing observed the change, so "
        "the next pull will simply revert it",
    )


@test("4.2", "sync - the membership survives instead of being reverted")
def t_4_2(s):
    _writable(s)
    lst = s.find_list(NAME)
    # Sync the pending membership from 4.1: push sends it, then the pull of
    # the SAME sync must not revert it (the original bug reconciled against
    # a pre-push snapshot).
    s.sync()
    harness.eq(s.changelog(), [], "changelog drained")
    harness.eq(
        len(s.members(lst["id"])),
        1,
        "the membership was reverted by the same sync that pushed it - the "
        "pull reconciled against a snapshot taken before the push",
    )


@test("4.3", "clean re-pull - the membership came from Google, not local state")
def t_4_3(s):
    _writable(s)
    # Drop the book, pull it fresh: the membership must be rebuilt from the
    # server's group data, which proves the push actually landed.
    s.rebind()
    lst = s.find_list(NAME)
    harness.true(lst is not None, "the list did not survive the re-pull")
    harness.eq(len(s.members(lst["id"])), 1, "the membership did not reach Google")


@test("4.4", "a server-applied membership does not re-queue itself")
def t_4_4(s):
    _writable(s)
    # 4.3's rebind made the provider apply the server's membership locally.
    # That write must be pre-tagged as the provider's own - otherwise it
    # shows up here as a pending user edit and re-pushes forever.
    harness.eq(
        s.changelog(),
        [],
        "applying the server's memberships queued them as user edits - the "
        "provider's own writes were not pre-tagged",
    )
    s.sync()
    harness.eq(s.changelog(), [], "still empty after another sync")


@test("4.5", "remove a member - the removal is pushed and sticks")
def t_4_5(s):
    _writable(s)
    lst = s.find_list(NAME)
    members = s.members(lst["id"])
    harness.true(members, "4.3 must have left a member to remove")
    # Remove the member locally and push it.
    ok("lists.removeMember", id=lst["id"], contactId=members[0]["id"])
    s.sync()
    harness.eq(s.changelog(), [], "changelog drained")
    harness.eq(len(s.members(lst["id"])), 0, "the member is gone locally")
    # The second sync's pull is where a removal that never reached Google
    # would come back.
    s.sync()
    harness.eq(
        len(s.members(lst["id"])),
        0,
        "the member was restored by the pull - the removal never reached Google",
    )
    # Last membership test: clear the probe list and card for section 6.
    probes.reset(s)
