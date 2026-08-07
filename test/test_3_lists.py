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
    ok("lists.create", name=NAME)
    s.sync()
    harness.true(s.find_list(NAME) is not None, "the list vanished after the push")
    harness.eq(s.changelog(), [], "changelog drained")
    harness.eq(s.status(), "success", "folder status")


@test("3.2", "clean re-pull - the list comes back from Google")
def t_3_2(s):
    _writable(s)
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
    ok("lists.remove", id=lst["id"])
    s.sync()
    harness.true(
        s.find_list(NAME) is None,
        "the deleted list came back - the pull re-created it, and with it "
        "overwrote the mapping the delete pass needed to find it on Google",
    )
    harness.eq(s.changelog(), [], "changelog drained")
    s.sync()
    harness.true(s.find_list(NAME) is None, "still gone after a settling sync")


@test("3.4", "the deletion reached Google, not just the local book")
def t_3_4(s):
    _writable(s)
    s.rebind()
    harness.true(
        s.find_list(NAME) is None,
        "the list is back after a clean re-pull, so the delete never left "
        "this machine",
    )


@test("3.5", "rename a list, sync - the new name reaches Google and survives")
def t_3_5(s):
    _writable(s)
    ok("lists.create", name=NAME)
    s.sync()
    lst = s.find_list(NAME)
    harness.true(lst is not None, "setup list did not reach Google")
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
    lst2 = s.find_list(renamed)
    ok("lists.remove", id=lst2["id"])
    s.sync()

