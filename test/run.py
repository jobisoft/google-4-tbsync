#!/usr/bin/env python3
"""Bridge test suite for google-4-tbsync.

    npm test                 everything that applies
    npm test -- 4            section 4
    npm test -- 2.3          one step
    npm test -- --list       what would run

Drives a live Google account through TbSync's bridge, so it needs Thunderbird
running with the bridge switched on and pointed at a Google account granting
its contacts resource.

Read-only mode is not an error: section 5 tests it, and the write sections
skip themselves with that as the reason. Turn it off in the account's
settings to exercise them.
"""

import json
import os
import pathlib
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
# `test/vendor/` holds the two files TbSync owns - the bridge client and the
# run loop. Both directories go on the path so a test module's `import
# harness` reads the same regardless of which side of the boundary it is on.
sys.path.insert(0, os.path.join(_HERE, "vendor"))
sys.path.insert(0, _HERE)

import probes
import session as session_mod
from harness import REGISTRY, run, select

MODULES = [
    "test_1_handshake",
    "test_2_contacts",
    "test_3_lists",
    "test_4_membership",
    "test_6_fields",
    "test_7_photos",
    "test_8_oldcards",
    "test_5_read_only",
]


def main(argv):
    selectors = [a for a in argv if not a.startswith("-")]
    listing = "--list" in argv

    for name in MODULES:
        __import__(name)

    tests = select(selectors)
    if not tests:
        known = sorted({t["section"] for t in REGISTRY})
        print(f"nothing matches {selectors!r}. Sections: {', '.join(known)}")
        return 2

    if listing:
        for t in tests:
            print(f"  {t['id']:<5} {t['description']}")
        print(f"\n  {len(tests)} test(s)")
        return 0

    try:
        s = session_mod.preflight()
    except session_mod.PreflightError as e:
        print(f"\n  Cannot run: {e}\n")
        return 2

    mode = "read-only" if s.read_only else "read-write"
    print(f"\n  account  {s.account['accountName']}  ({mode})")
    print(f"  folder   {s.contacts}")
    print()

    def prepare(section):
        """Per-section preflight: put the account into a known state rather
        than inheriting whatever the last section left.

        The log is marked rather than cleared: `log` and `log_lines` then
        report on this section, while the record of what the add-on actually
        did stays whole for reading afterwards. Errors need no marking -
        every bridge call audits, and the run stops at the first one.

        Rebinding first is what makes a section a complete statement: it
        starts from Google's copy of the book and inherits nothing local.
        `reset` then deletes leftovers, which queues deletes of its own, and
        a delete Google refuses would otherwise stay owed with nothing
        looking again.
        """
        print(f"  -- section {section}")
        s.mark()
        session_mod.isolate(s, indent="       ")
        probes.reset(s)
        session_mod.drain_queues(s, indent="       ")

    def finish(section):
        """The other half of `prepare`: a section says what it leaves behind.

        The next section's setup purges, so anything still owed here is
        about to be discarded unseen - including an edit that never reached
        Google, which is a real failure wearing the disguise of a clean
        start. Draining first tells the two apart: work that can still be
        pushed is pushed, and only what refuses to leave fails the section.
        """
        session_mod.drain_queues(s, indent="       ")
        try:
            owed = s.changelog()
        except AssertionError:
            return  # not bound, so nothing of ours can be owed
        if owed:
            statuses = sorted({e.get("status") for e in owed})
            raise AssertionError(
                f"{len(owed)} edit(s) still owed after the section finished "
                f"and the queue was drained ({', '.join(statuses)}) - the "
                f"section left work that will not push"
            )

    rc = run(tests, s, prepare=prepare, finish=finish)
    save_wire(s, selectors, rc)
    return rc


def save_wire(session, selectors, rc):
    """Keep the event log of every run, and say where it went.

    The log is the only evidence there is for an intermittent failure, and
    preflight clears the buffer at the start of each run - so without this,
    every run destroys the previous one's. Two days of chasing an EAS
    failure were spent on runs whose record had already been thrown away.

    Written on success as well as failure: the interesting comparison is a
    failing run against a passing one, and which is which is not known until
    afterwards.
    """
    from bridge import ok as bridge_ok

    try:
        entries = bridge_ok("getEventLog")["entries"]
    except Exception as e:  # noqa: BLE001 - never fail a run over its own record
        print(f"\n  (could not save the event log: {e})")
        return
    out = pathlib.Path(__file__).resolve().parent / "wire"
    out.mkdir(exist_ok=True)
    name = (
        f"{time.strftime('%Y%m%d-%H%M%S')}"
        f"-{session.account['accountName'].split('@')[0]}"
        f"-{'+'.join(selectors) or 'all'}"
        f"-{'pass' if rc == 0 else 'FAIL'}.json"
    )
    path = out / name
    path.write_text(json.dumps(entries, indent=1))
    print(f"  wire     {path} ({len(entries)} entries)")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
