#!/usr/bin/env python3
"""
Launch an action template against every mission visible to the authenticated
account (optionally scoped to a single project).

Auth (see README.md in this folder for details): set the environment
variables KLEINKRAM_API_KEY, KLEINKRAM_API_ENDPOINT and KLEINKRAM_S3_ENDPOINT
before running this script. These are picked up automatically by the
`kleinkram` package - no `klein login` or config file needed.

Usage:
    python trigger_all_missions.py --template <template-name-or-uuid>
    python trigger_all_missions.py --template <template-name-or-uuid> --project <project-name-or-uuid>
"""
from __future__ import annotations

import argparse
import sys

import kleinkram
from kleinkram.api.client import AuthenticatedClient
from kleinkram.errors import NotAuthenticated
from kleinkram.utils import is_valid_uuid4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--template", required=True, help="Action template name or UUID to launch.")
    parser.add_argument(
        "--project",
        default=None,
        help="Restrict to missions in this project (name or UUID). Omit to target every mission.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List the missions that would be targeted, without launching anything.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    try:
        client = AuthenticatedClient()
    except NotAuthenticated:
        print(
            "not authenticated: set KLEINKRAM_API_KEY and KLEINKRAM_API_ENDPOINT "
            "(and KLEINKRAM_S3_ENDPOINT) - see README.md",
            file=sys.stderr,
        )
        return 2

    project_kwargs = {}
    if args.project is not None:
        if is_valid_uuid4(args.project):
            project_kwargs["project_ids"] = [args.project]
        else:
            project_kwargs["project_names"] = [args.project]

    missions = kleinkram.list_missions(client=client, **project_kwargs)
    if not missions:
        print("no missions found")
        return 0

    print(f"found {len(missions)} mission(s)")

    failures = 0
    for mission in missions:
        if args.dry_run:
            print(f"[DRY RUN] would launch template '{args.template}' on mission {mission.id} ({mission.name})")
            continue

        try:
            execution_uuid = kleinkram.launch_execution(args.template, mission_id=mission.id, client=client)
            print(f"[OK] mission {mission.id} ({mission.name}) -> execution {execution_uuid}")
        except Exception as e:
            print(f"[FAIL] mission {mission.id} ({mission.name}): {e}")
            failures += 1

    if failures:
        print(f"\n{failures}/{len(missions)} mission(s) failed to launch", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
