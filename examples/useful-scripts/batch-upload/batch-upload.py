from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

import kleinkram
from kleinkram.errors import MissionExists

# The extensions considered valid (lowercase, with leading dot)
VALID_EXTENSIONS = [".mcap", ".yaml"]
PROJECT_NAME = "Driverless"
MAX_WORKERS = 2


@dataclass
class FileOutcome:
    path: Path
    mission_name: str
    uploaded: bool = False
    skipped: bool = False
    failed: bool = False
    bytes_uploaded: int = 0
    error: Optional[str] = None


def find_valid_files(folder):
    """Walk folder recursively. Returns (entries, ignored_count) where entries is a
    list of (mission_name, absolute_path) for every file with a valid extension."""
    if not folder.is_dir():
        raise NotADirectoryError(f"Folder not found: {folder}")

    entries = []
    ignored_count = 0

    # rglob("*") walks folder and every nested subfolder, at any depth
    for path in sorted(folder.rglob("*")):
        # Skip folders; only look at files
        if not path.is_file():
            continue

        extension = path.suffix.lower()
        absolute_path = folder.joinpath(path.relative_to(folder))

        if extension in VALID_EXTENSIONS:
            mission_name = path.parent.stem.lower()
            entries.append((mission_name, absolute_path))
        else:
            print(f"Ignoring: {absolute_path} (extension '{extension}' not included)")
            ignored_count += 1

    return entries, ignored_count


def ensure_mission_exists(mission_name, project_id):
    # Mission auto-creation races if done concurrently (unique name constraint), so this
    # must run before the threaded upload pass below, not inside it.
    try:
        kleinkram.create_mission(
            mission_name=mission_name,
            project_id=project_id,
            metadata={},
        )
        print(f"Created mission: {mission_name}")
    except MissionExists:
        print(f"Mission already exists: {mission_name}")


def upload_one(mission_name, absolute_path, testing_session) -> FileOutcome:
    """Uploads, verifies and tags a single file. Exceptions are caught and recorded on
    the returned FileOutcome rather than raised, so one bad file doesn't stop the batch
    or prevent the summary from reflecting every other file."""
    outcome = FileOutcome(path=absolute_path, mission_name=mission_name)

    try:
        print(f"Uploading: {absolute_path}")

        upload_result = kleinkram.upload(
            project_name=PROJECT_NAME,
            mission_name=mission_name,
            files=[absolute_path],
            create=False,  # mission is guaranteed to already exist, see ensure_mission_exists
        )
        print(f"Upload Result: {upload_result}")

        outcome.uploaded = upload_result.uploaded > 0
        outcome.skipped = upload_result.skipped > 0
        outcome.failed = upload_result.failed > 0
        outcome.bytes_uploaded = upload_result.total_bytes

        status = kleinkram.verify(
            project_name=PROJECT_NAME,
            mission_name=mission_name,
            files=[str(absolute_path)],
        )
        print(f"Uploaded File Status: {status}")

        missions = kleinkram.list_missions(
            mission_names=[mission_name],
            project_names=[PROJECT_NAME],
        )
        mission_id = missions[0].id

        kleinkram.update_mission(mission_id=mission_id, metadata={"testing_session": testing_session})

    except Exception as exc:
        outcome.failed = True
        outcome.error = str(exc)
        print(f"Failed: {absolute_path}: {exc}")

    return outcome


def print_summary(outcomes: List[FileOutcome], ignored_count: int) -> None:
    uploaded = skipped = failed = 0
    total_bytes = 0

    for outcome in outcomes:
        total_bytes += outcome.bytes_uploaded
        # Classify by priority so every outcome lands in exactly one bucket, even
        # though e.g. a file can be uploaded and then fail a later step.
        if outcome.failed:
            failed += 1
        elif outcome.uploaded:
            uploaded += 1
        elif outcome.skipped:
            skipped += 1

    print("\n=== Upload summary ===")
    print(f"Considered:            {len(outcomes) + ignored_count}")
    print(f"Ignored (extension):   {ignored_count}")
    print(f"Uploaded:              {uploaded}")
    print(f"Skipped (unchanged):   {skipped}")
    print(f"Failed:                {failed}")
    print(f"Bytes uploaded:        {total_bytes}")

    if failed:
        print("\nFailed files:")
        for outcome in outcomes:
            if outcome.failed:
                reason = outcome.error or "upload reported failure"
                print(f"  - {outcome.path} (mission: {outcome.mission_name}): {reason}")


def main(folders):
    uploads = []
    ignored_count = 0

    for folder in folders:
        entries, folder_ignored_count = find_valid_files(folder)
        ignored_count += folder_ignored_count
        testing_session = folder.stem.lower()
        uploads.extend((mission_name, absolute_path, testing_session) for mission_name, absolute_path in entries)

    if not uploads:
        print_summary([], ignored_count)
        return

    projects = kleinkram.list_projects(project_names=[PROJECT_NAME])
    if not projects:
        raise ValueError(f"Project not found: {PROJECT_NAME}")
    project_id = projects[0].id

    # Deduplicate mission names (the same mission folder might show up under multiple
    # top-level folders) and create them all up front, one at a time.
    mission_names = {mission_name for mission_name, _, _ in uploads}
    for mission_name in sorted(mission_names):
        ensure_mission_exists(mission_name, project_id)

    # All missions exist now, so uploading different files concurrently is safe.
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = [
            executor.submit(upload_one, mission_name, absolute_path, testing_session)
            for mission_name, absolute_path, testing_session in uploads
        ]
        outcomes = [future.result() for future in futures]

    print_summary(outcomes, ignored_count)


if __name__ == "__main__":
    folders = [
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_03"),
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_09"),
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_25"),
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_26"),
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_27"),
        Path("C:/Users/merri/MMS_bags/2026_07_11/2026_07_11_stint_28"),
    ]
    main(folders)
