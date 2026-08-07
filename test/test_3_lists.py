"""3. Mailing lists.

A list deletion used to be lost outright: the pull re-created the locally
deleted list, and because the group map holds a single entry per group the
re-create overwrote its mailingListId - so the delete pass then looked up the
id the user had actually deleted, found nothing, and dropped the entry
without a word. The changelog drained and the sync looked clean.

3.3 is that bug's assertion. It has to survive a *second* sync, because the
first one is where the pull would put the list back.
"""

import harness
import probes
from bridge import ok
from harness import Skip, test

NAME = f"{probes.LIST_PREFIX} alpha"


def _writable(s):
    if s.read_only:
        raise Skip("account is in read-only mode; turn it off to run write tests")


@test("3.1", "create a list, sync - it reaches Google")
def t_3_1(s):
    _writable(s)
    # Create the mailing list locally, sync: the push must create the
    # matching contact group on Google.
    ok("lists.create", name=NAME)
    s.sync()
    harness.true(s.find_list(NAME) is not None, "the list vanished after the push")
    harness.eq(s.changelog(), [], "changelog drained")
    harness.eq(s.status(), "success", "folder status")


@test("3.2", "clean re-pull - the list comes back from Google")
def t_3_2(s):
    _writable(s)
    # Drop the local book and re-pull: only a list that actually exists as
    # a group on Google survives this.
    s.rebind()
    harness.true(
        s.find_list(NAME) is not None,
        "the list did not survive a clean re-pull, so it never reached Google",
    )


@test("3.3", "delete a list, sync - it stays deleted")
def t_3_3(s):
    _writable(s)
    lst = s.find_list(NAME)
    harness.true(lst is not None, "3.2 must have left a list to delete")
    # Delete locally, then sync once: the delete must be pushed before the
    # pull can re-create the list (the bug in the section docstring).
    ok("lists.remove", id=lst["id"])
    s.sync()
    harness.true(
        s.find_list(NAME) is None,
        "the deleted list came back - the pull re-created it, and with it "
        "overwrote the mapping the delete pass needed to find it on Google",
    )
    harness.eq(s.changelog(), [], "changelog drained")
    # The second sync is the regression: its pull is where the original bug
    # put the list back.
    s.sync()
    harness.true(s.find_list(NAME) is None, "still gone after a settling sync")


@test("3.4", "the deletion reached Google, not just the local book")
def t_3_4(s):
    _writable(s)
    # Re-pull from scratch: if the group still exists on Google, the delete
    # only ever happened locally.
    s.rebind()
    harness.true(
        s.find_list(NAME) is None,
        "the list is back after a clean re-pull, so the delete never left "
        "this machine",
    )


@test("3.5", "rename a list, sync - the new name reaches Google and survives")
def t_3_5(s):
    _writable(s)
    # Fresh setup list (3.3/3.4 deleted the previous one).
    ok("lists.create", name=NAME)
    s.sync()
    lst = s.find_list(NAME)
    harness.true(lst is not None, "setup list did not reach Google")
    # Rename locally, push it, then re-pull from scratch - the rename must
    # come back from Google, not merely survive in local state.
    renamed = f"{NAME} renamed"
    ok("lists.update", id=lst["id"], name=renamed)
    s.sync()
    s.rebind()
    harness.true(
        s.find_list(renamed) is not None,
        "the rename did not survive a clean re-pull - it never reached "
        "Google, or the pull restored the old name",
    )
    harness.true(s.find_list(NAME) is None, "the old name still exists")
    # Clean up the renamed list so section 4 starts from the baseline.
    lst2 = s.find_list(renamed)
    ok("lists.remove", id=lst2["id"])
    s.sync()

