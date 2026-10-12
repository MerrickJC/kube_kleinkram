#!/usr/bin/env python3
"""
Launch an action template against an explicit list of missions.

Auth (see README.md in this folder for details): set the environment
variables KLEINKRAM_API_KEY, KLEINKRAM_API_ENDPOINT and KLEINKRAM_S3_ENDPOINT
before running this script. These are picked up automatically by the
`kleinkram` package - no `klein login` or config file needed.

Usage:
    python trigger_missions.py --template <template-name-or-uuid> \
        --mission <mission-uuid-or-name> [--mission ...]

    # or read missions from a file (one UUID or name per line, # comments allowed)
    python trigger_missions.py --template <template-name-or-uuid> \
        --missions-file missions.txt

If a mission is given by name rather than UUID, --project must be given to
disambiguate it (project name or UUID).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import List
from uuid import UUID

import kleinkram
from kleinkram.api.client import AuthenticatedClient
from kleinkram.errors import NotAuthenticated
from kleinkram.utils import is_valid_uuid4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--template", required=True, help="Action template name or UUID to launch.")
    parser.add_argument(
        "--mission",
        action="append",
        dest="missions",
        default=[],
        help="Mission UUID or name. Repeat for multiple missions.",
    )
    parser.add_argument(
        "--missions-file",
        type=Path,
        default=None,
        help="Path to a file with one mission UUID/name per line ('#' starts a comment).",
    )
    parser.add_argument(
        "--project",
        default=None,
        help="Project name or UUID, required to resolve missions given by name.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve missions and print what would be launched, without launching anything.",
    )
    return parser.parse_args()


def load_missions_file(path: Path) -> List[str]:
    missions = []
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            missions.append(line)
    return missions


def resolve_mission_uuid(mission: str, *, project: str | None) -> UUID:
    if is_valid_uuid4(mission):
        return UUID(mission)

    if project is None:
        raise ValueError(f"mission '{mission}' is not a UUID; --project is required to resolve it by name")

    found = kleinkram.list_missions(mission_names=[mission], project_ids=[project] if is_valid_uuid4(project) else None,
                                     project_names=None if is_valid_uuid4(project) else [project])
    if not found:
        raise ValueError(f"no mission named '{mission}' found in project '{project}'")
    if len(found) > 1:
        raise ValueError(f"mission name '{mission}' is ambiguous in project '{project}' ({len(found)} matches)")
    return found[0].id


def main() -> int:
    args = parse_args()

    missions = list(args.missions)
    if args.missions_file is not None:
        missions.extend(load_missions_file(args.missions_file))

    if not missions:
        print("no missions given, use --mission and/or --missions-file", file=sys.stderr)
        return 2

    try:
        client = AuthenticatedClient()
    except NotAuthenticated:
        print(
            "not authenticated: set KLEINKRAM_API_KEY and KLEINKRAM_API_ENDPOINT "
            "(and KLEINKRAM_S3_ENDPOINT) - see README.md",
            file=sys.stderr,
        )
        return 2

    failures = 0
    for mission in missions:
        try:
            mission_uuid = resolve_mission_uuid(mission, project=args.project)
        except ValueError as e:
            print(f"[SKIP] {mission}: {e}")
            failures += 1
            continue

        if args.dry_run:
            print(f"[DRY RUN] would launch template '{args.template}' on mission {mission_uuid} ({mission})")
            continue

        try:
            execution_uuid = kleinkram.launch_execution(args.template, mission_id=mission_uuid, client=client)
            print(f"[OK] mission {mission_uuid} ({mission}) -> execution {execution_uuid}")
        except Exception as e:
            print(f"[FAIL] mission {mission_uuid} ({mission}): {e}")
            failures += 1

    if failures:
        print(f"\n{failures}/{len(missions)} mission(s) failed to launch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
