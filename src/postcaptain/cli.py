"""Command-line entry point for the capture spike.

    python3 -m postcaptain.cli capture --db ./postcaptain.db
    python3 -m postcaptain.cli stats   --db ./postcaptain.db

``capture`` runs the local collectors into the SQLite store (idempotent — safe
to re-run). ``stats`` prints a quick read-back so you can eyeball what landed.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter

from .collectors import copilot
from .events import EventKind
from .store import EventStore


def _cmd_capture(args: argparse.Namespace) -> int:
    with EventStore(args.db) as store:
        new = store.add_many(copilot.collect())
        total = store.count(EventKind.AI_INTERACTION)
    print(f"copilot: +{new} new ai_interaction events ({total} total) → {args.db}")
    return 0


def _cmd_stats(args: argparse.Namespace) -> int:
    with EventStore(args.db) as store:
        total = store.count()
        events = store.query(kind=EventKind.AI_INTERACTION)
    print(f"events: {total} total")
    by_project = Counter(e.project or "(unknown)" for e in events)
    by_model = Counter((e.payload.get("model") or "(unknown)") for e in events)
    tokens = sum(int(e.payload.get("tokens_est") or 0) for e in events)
    print(f"ai_interaction: {len(events)} events, ~{tokens} est. tokens")
    print("  top projects:", dict(by_project.most_common(5)))
    print("  by model:    ", dict(by_model.most_common(5)))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="postcaptain")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default="./postcaptain.db", help="SQLite store path")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("capture", parents=[common], help="run collectors into the store")
    sub.add_parser("stats", parents=[common], help="summarize what's in the store")

    args = parser.parse_args(argv)
    if args.cmd == "capture":
        return _cmd_capture(args)
    if args.cmd == "stats":
        return _cmd_stats(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
