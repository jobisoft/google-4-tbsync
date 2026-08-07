"""Preflight, and the helpers every test uses.

The contract is a Google account granting its contacts resource. Anything
else stops the run with a message saying what to change in the Bridge tab -
testing the wrong account is worse than not testing.

Read-only mode is reported rather than refused. It is a legitimate
configuration (and the default for a new Google account), so the write tests
skip with that as their stated reason instead of failing.

Nothing hard-codes an account or folder id: both change when an account is
reconfigured, and during this suite's development the folder id changed twice
in an afternoon.
"""

import os
import time

import bridge
from bridge import ok, rpc


# Smallest gap between two syncs of the same account. One test can sync four
# or more times - a rebind is two, and `settle` retries up to three - so
# pacing the syncs matters more than pacing the tests. Google rate-limits the
# People API, and a suite running flat out is exactly the shape it limits.
#   TBSYNC_TEST_SYNC_GAP=0 npm test
MIN_SYNC_GAP_S = float(os.environ.get("TBSYNC_TEST_SYNC_GAP", "5"))


class PreflightError(Exception):
    """The bridge is not pointed at something this suite can test."""


class Session:
    def __init__(self, account, folder_id, read_only):
        self.account = account
        self.account_id = account["accountId"]
        self.contacts = folder_id
        self.read_only = read_only
        # No version gating for Google - the People API has one shape. The
        # attribute exists because the harness asks every session for it.
        self.version = "people-v1"
        self.family = "people"
        self._last_sync = 0.0
        # Where the current section began in the event log. `log` reads from
        # here, so a section's wire assertions see this section and not the
        # whole run. Errors need no marking - every bridge call checks.
        self.section_seq = 0
        # What preflight selected. One resource here, but the rule is the
        # same as the EAS suite's: a verb against an unselected resource
        # fails with the platform's "not bound to an address book yet",
        # which reads like a product fault and is really a test reaching
        # past what it asked for.
        self.active = ()

    # ── folder and status ───────────────────────────────────────────────

    def _require_bound(self):
        if "contacts" not in self.active:
            raise AssertionError(
                "this run did not select the contacts resource - preflight "
                "binds only what the selected sections need."
            )

    def folder(self):
        for row in ok("getFolders", accountId=self.account_id)["folders"]:
            if row["folderId"] == self.contacts:
                return row
        raise AssertionError(f"folder {self.contacts} has vanished")

    def changelog(self):
        """Pending entries, read from the folder row - the only place the
        changelog exists. There is no `getChangelog` verb, and a helper that
        called one anyway returned [] on failure, which is indistinguishable
        from a drained queue."""
        return self.folder().get("changelog") or []

    def status(self):
        return self.folder()["status"]

    # ── syncing ─────────────────────────────────────────────────────────

    def sync(self, allow_errors=False):
        """Sync the account, then fail if the sync itself reported an error.

        Checking is the point. A test asserts on values, so a sync that threw
        can still leave every assertion satisfied - the local store is
        unchanged and "the card is still there" reads as success. The EAS
        suite reported a whole section passing while the log held a TypeError
        from the folder sync, which is the failure this prevents.

        Waits out `MIN_SYNC_GAP_S` first, so back-to-back syncs inside one
        test do not arrive as a burst.
        """
        waited = time.time() - self._last_sync
        if waited < MIN_SYNC_GAP_S:
            time.sleep(MIN_SYNC_GAP_S - waited)
        ok("syncAccount", accountId=self.account_id)
        self._last_sync = time.time()
        time.sleep(2)
        try:
            bridge.audit()
        except bridge.LoggedError:
            if not allow_errors:
                raise

    def settle(self, tries=3):
        for _ in range(tries):
            if not self.changelog():
                return True
            self.sync()
        return not self.changelog()

    def rebind(self):
        """Deselect and reselect: deletes the local book and pulls it down
        again. The only way to see what Google actually stored rather than
        what we still hold locally."""
        ok(
            "setFolderSelected",
            accountId=self.account_id,
            folderId=self.contacts,
            selected=False,
        )
        time.sleep(3)
        self.sync()
        ok(
            "setFolderSelected",
            accountId=self.account_id,
            folderId=self.contacts,
            selected=True,
        )
        time.sleep(3)
        self.sync()

    # ── contacts and lists ──────────────────────────────────────────────

    def cards(self):
        self._require_bound()
        return ok("contacts.query")

    def lists(self):
        self._require_bound()
        return ok("lists.query")

    def members(self, list_id):
        return ok("lists.listMembers", id=list_id)

    def vcard(self, card):
        return (card.get("properties") or {}).get("vCard") or ""

    def unfold(self, text):
        """vCard lines with continuations joined. Without this a long NOTE
        looks truncated and a test 'proves' data loss that never happened."""
        out = []
        for raw in text.splitlines():
            if raw.startswith((" ", "\t")) and out:
                out[-1] += raw[1:]
            else:
                out.append(raw)
        return out

    def find_card(self, marker):
        """First card containing `marker`.

        Anchor on the email address. Never on FN: a round trip rebuilds it
        from the name components, so a card sent as "Testkarte Google" comes
        back as "Dr. Testkarte Q Google" and matching on the sent value
        reports a healthy round trip as a missing contact.
        """
        for card in self.cards():
            if marker in self.vcard(card):
                return card
        return None

    def find_list(self, name):
        for lst in self.lists():
            if lst.get("name") == name:
                return lst
        return None

    def resource_name(self, card):
        """Google's identity for a card, stamped on push. Its presence is
        what distinguishes 'saved locally' from 'reached the server'."""
        for line in self.unfold(self.vcard(card)):
            if line.startswith("X-GOOGLE-RESOURCENAME:"):
                return line.split(":", 1)[1]
        return None

    # ── the log ─────────────────────────────────────────────────────────

    def mark(self):
        """Remember where the log stands, so `log` and `log_lines` below
        report on what happens next rather than on the whole run.

        This replaces clearing. The log is the record of what the add-on did
        and is worth keeping whole - a section that fails is read afterwards,
        and a clear would have thrown that away.
        """
        self.section_seq = ok("getEventLog")["lastSeq"]

    def log(self):
        return ok("getEventLog", sinceSeq=self.section_seq)["entries"]

    def log_lines(self, *needles):
        return [
            e["message"]
            for e in self.log()
            if any(n in (e.get("message") or "") for n in needles)
        ]


def preflight(bind=True):
    """Locate the granted Google account and return a ready Session.

    NOT read-only by default: the final step (`_bind`) runs a FULL ACCOUNT
    SYNC to prove the contacts resource actually binds to an address book.
    Any pending changelog entry is pushed and the pull pass runs - state
    staged for a later test is consumed here. This once silently destroyed
    a prepared migration fixture that a script only meant to *look at*.

    Pass `bind=False` for a genuinely read-only session: no folder
    toggling, no sync - just locate the account and folder. The caller
    then owns the guarantee that the folder is bound (verbs against an
    unbound folder fail with the platform's "not bound" error).
    """
    if not bridge.is_up():
        raise PreflightError(
            f"the bridge is not answering on 127.0.0.1:{bridge.PORT}.\n"
            f"  Start Thunderbird and switch the bridge on in TbSync's "
            f"Bridge tab."
        )

    # From here on every bridge call checks the event log; anything logged
    # before this point belongs to an earlier run.
    bridge.arm()

    accounts = ok("getState")["accounts"]
    granted = _granted_account(accounts)
    if not granted:
        raise PreflightError(
            "no account is granted to the bridge.\n"
            "  Pick one in TbSync's Bridge tab."
        )
    if granted["provider"] != "google":
        raise PreflightError(
            f"the bridge is pointed at a {granted['provider']!r} account "
            f"({granted['accountName']}), but this suite tests Google.\n"
            f"  Re-point it in the Bridge tab."
        )

    folder_id = _granted_contacts_folder(granted["accountId"])
    if not folder_id:
        raise PreflightError(
            f"{granted['accountName']} does not grant a contacts resource.\n"
            f"  Grant it in the Bridge tab."
        )

    read_only = bool((granted.get("custom") or {}).get("readOnlyMode"))
    session = Session(granted, folder_id, read_only)
    session.active = ("contacts",)
    session.mark()
    if bind:
        try:
            _bind(session)
        except AssertionError as e:
            raise PreflightError(f"the initial sync failed.\n  {e}") from None
    return session


def _granted_account(accounts):
    """Probing scope is the only way to ask: rewriting an account's autosync
    interval with the value it already has is a no-op that succeeds solely
    for the granted account."""
    for account in accounts:
        reply = rpc(
            "setAutoSyncInterval",
            accountId=account["accountId"],
            minutes=account.get("autoSyncIntervalMinutes", 0),
        )
        if reply.get("ok"):
            return account
    return None


def _granted_contacts_folder(account_id):
    """Find the granted contacts folder by probing scope, like
    `_granted_account`: re-submitting a folder's current `selected` value is
    a no-op that only succeeds on the folder the grant covers. Nothing is
    changed and nothing syncs - selection keeps the value it already has."""
    for row in ok("getFolders", accountId=account_id)["folders"]:
        if row.get("targetType") != "contacts":
            continue
        reply = rpc(
            "setFolderSelected",
            accountId=account_id,
            folderId=row["folderId"],
            selected=row["selected"],
        )
        if reply.get("ok"):
            return row["folderId"]
    return None


def _bind(session):
    """Select the contacts folder and RUN A FULL ACCOUNT SYNC, so every test
    starts against a folder that is proven to be bound to an address book.

    This is the sync `preflight()` warns about: it pushes whatever the
    changelog holds and runs the pull pass. Scripts that must observe state
    without changing it use `preflight(bind=False)` and skip this entirely.
    """
    # `syncAccount` syncs everything selected, not just the folder a test is
    # looking at, so anything else still selected would be swept along and
    # its errors attributed here. Google offers one contacts folder today,
    # but the account is stated rather than assumed.
    for row in ok("getFolders", accountId=session.account_id)["folders"]:
        if row["folderId"] != session.contacts and row["selected"]:
            print(f"       deselecting {row['displayName']}")
            ok(
                "setFolderSelected",
                accountId=session.account_id,
                folderId=row["folderId"],
                selected=False,
            )
            time.sleep(2)

    row = session.folder()
    if not row["selected"]:
        ok(
            "setFolderSelected",
            accountId=session.account_id,
            folderId=session.contacts,
            selected=True,
        )
        time.sleep(2)
    session.sync()
    row = session.folder()
    if not row.get("targetID"):
        raise PreflightError(
            f"the contacts resource ({row['displayName']}) did not bind to an "
            f"address book after a sync - status {row['status']!r}, error "
            f"{row.get('error')!r}."
        )
