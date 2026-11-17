import hashlib
import json
import os
import stat
import sys
import zipfile
from pathlib import Path


class ArchiveError(ValueError):
    def __init__(self, reason, **details):
        super().__init__(reason)
        self.details = details


def require(condition, reason, **details):
    if not condition:
        raise ArchiveError(reason, **details)


def unpack(archive, destination, kind):
    limit = 256 * 1024 * 1024 if kind == "checkpoint" else 2 * 1024 * 1024
    require(os.path.getsize(archive) <= limit, "archive_size_limit")
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        require(0 < len(entries) <= 10001, "archive_entry_limit")
        names = set()
        total = 0
        for entry in entries:
            name = entry.filename
            parts = name.rstrip("/").split("/")
            mode = entry.external_attr >> 16
            require(name == entry.orig_filename and len(name) <= 512 and not name.startswith("/") and
                    "\\" not in name and ":" not in name and "\0" not in name and
                    all(part not in ("", ".", "..") for part in parts), "unsafe_archive_path")
            require(name not in names, "duplicate_archive_entry")
            names.add(name)
            require(not entry.flag_bits & 1, "encrypted_archive")
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR) and
                    (not stat.S_ISDIR(mode) or entry.is_dir()), "linked_archive_entry")
            total += entry.file_size
            require(total <= limit and entry.file_size >= 0, "archive_expansion_limit")
        record = "manifest.json" if kind == "checkpoint" else "record.json"
        require(record in names, "missing_archive_manifest")
        payload = json.loads(source.read(record))
        require(isinstance(payload, dict), "invalid_archive_manifest")
        expected = {record: None}
        if kind == "checkpoint":
            schema = payload.get("schema_version")
            require(schema == 4, "unsupported_checkpoint_schema", expected=4, observed=schema if type(schema) is int else None)
            inventory = payload.get("files")
            require(isinstance(inventory, list) and len(inventory) <= 10000, "invalid_checkpoint_inventory")
            databases = {"state_5.sqlite", "thread_history_1.sqlite", "goals_1.sqlite", "queue_1.sqlite", "memories_1.sqlite", "memories_v2_1.sqlite"}
            for item in inventory:
                require(isinstance(item, dict) and isinstance(item.get("path"), str), "invalid_checkpoint_file")
                path = item["path"]
                parts = path.split("/")
                allowed = (len(parts) == 2 and parts[0] == "codex" and parts[1] in databases) or (
                    len(parts) >= 3 and parts[0] == "codex" and parts[1] in ("sessions", "archived_sessions") and
                    (path.endswith(".jsonl") or path.endswith(".jsonl.zst")))
                require(allowed and path not in expected, "unexpected_checkpoint_file")
                expected[path] = item
        directories = {parent + "/" for name in expected for parent in [str(p) for p in Path(name).parents if str(p) != "."]}
        require(names <= set(expected) | directories and set(expected) <= names, "archive_inventory_mismatch")
        for name, item in expected.items():
            data = source.read(name)
            if item is not None:
                require(len(data) == item.get("bytes") and hashlib.sha256(data).hexdigest() == item.get("sha256"), "checkpoint_file_hash_mismatch")
        root = Path(destination)
        require(not root.exists(), "restore_destination_exists")
        root.mkdir(mode=0o700)
        for name in expected:
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with target.open("xb") as output:
                output.write(source.read(name))
            target.chmod(0o600)
        print(json.dumps({"files": len(expected), "bytes": total}))


if __name__ == "__main__":
    try:
        unpack(*sys.argv[1:])
    except (ValueError, OSError, zipfile.BadZipFile, KeyError, TypeError) as error:
        print(json.dumps({"reason": str(error) if isinstance(error, ArchiveError) else "archive_read_failed", **getattr(error, "details", {})}), file=sys.stderr)
        sys.exit(1)
