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

import os
import sys

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
        """
        print(f"  -- section {section}")
        s.mark()
        probes.reset(s)

    return run(tests, s, prepare=prepare)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
