"""1. Handshake and baseline.

The cheapest statement that the account is usable, and the baseline every
later section cleans back to.
"""

import harness
from harness import test


@test("1.1", "the granted account is a connected Google account")
def t_1_1(s):
    # Pure state inspection - `s.account` is the getState row preflight
    # already fetched; nothing here talks to Google.
    harness.eq(s.account["provider"], "google", "provider")
    harness.true(s.account["enabled"], "account is enabled")
    harness.eq(s.account["error"], None, "account error")


@test("1.2", "sync - the contacts folder binds and goes green")
def t_1_2(s):
    # One explicit full sync (preflight already ran one via _bind; this one
    # is the assertion), then read the folder row it left behind.
    s.sync()
    harness.eq(s.status(), "success", "folder status")
    harness.eq(s.folder()["error"], None, "folder error")
    # targetID is the address book the folder bound to - without it every
    # contacts verb fails with "not bound".
    harness.true(s.folder()["targetID"], "bound to an address book")


@test("1.3", "baseline - nothing of ours is left over, changelog drained")
def t_1_3(s):
    # The per-section `probes.reset` must have removed every probe card;
    # a leftover means an earlier run crashed mid-cleanup and later
    # sections would match the wrong copy of a card.
    left = [c for c in s.cards() if "probe.invalid" in s.vcard(c)]
    harness.eq(left, [], "probe cards left over from an earlier run")
    # An empty changelog means no local edit is still waiting to be pushed.
    harness.eq(s.changelog(), [], "changelog drained")


@test("1.4", "every pulled card carries Google's identity for it")
def t_1_4(s):
    # A card without a resourceName is one the pull invented or one a push
    # failed to stamp; either way it will not match on the next sync.
    for c in s.cards():
        harness.true(
            s.resource_name(c) is not None,
            f"a card has no X-GOOGLE-RESOURCENAME: {s.vcard(c)[:120]!r}",
        )
