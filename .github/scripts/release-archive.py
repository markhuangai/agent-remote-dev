import hashlib
import io
import json
from pathlib import Path
import stat
import sys
import tarfile
import zipfile
import zlib

LIMIT = 128 * 1024 * 1024
ASSETS = {"action.tar.gz", "remote-codex.tar.gz", "SHA256SUMS"}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def safe_path(name):
    require(isinstance(name, str) and len(name) <= 512 and not any(c in name for c in "\\\0:")
            and all(part not in ("", ".", "..") for part in name.split("/")), "unsafe_release_archive_path")


def verify_tar(data, expected):
    decoder = zlib.decompressobj(31)
    expanded = decoder.decompress(data, LIMIT + 1)
    require(len(expanded) <= LIMIT and not decoder.unconsumed_tail and decoder.eof and not decoder.unused_data,
            "release_archive_expansion_limit")
    seen, files, total, end = set(), set(), 0, 0
    directories = {"/".join(name.split("/")[:i]) for name in expected for i in range(1, len(name.split("/")))}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as archive:
        for index, entry in enumerate(archive):
            require(index < 10000, "release_archive_entry_limit")
            name = entry.name.removesuffix("/") if entry.isdir() else entry.name
            safe_path(name)
            require(name not in seen, "duplicate_release_archive_entry")
            seen.add(name)
            require(not entry.pax_headers and (entry.isfile() or entry.isdir()), "linked_or_special_release_entry")
            end = max(end, entry.offset_data + ((entry.size + 511) // 512) * 512)
            if entry.isdir():
                require(name in directories and entry.size == 0, "release_archive_inventory_mismatch")
                continue
            require(name in expected, "release_archive_inventory_mismatch")
            item = expected[name]
            require(0 <= entry.size == item["size"] <= LIMIT and entry.mode == int(item["mode"], 8) & 0o777,
                    "release_archive_metadata_mismatch")
            total += entry.size
            require(total <= LIMIT, "release_archive_expansion_limit")
            content = archive.extractfile(entry).read(entry.size + 1)
            actual = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
            require(len(content) == entry.size and actual == item["sha"], "release_archive_source_mismatch")
            files.add(name)
    require(files == set(expected), "release_archive_inventory_mismatch")
    require(len(expanded) % 512 == 0 and len(expanded) - end >= 1024 and not any(expanded[end:]), "release_archive_trailing_data")


def verify(archive_path, expected_path, output):
    expected = json.loads(Path(expected_path).read_text())
    payloads, total = {}, 0
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        require(len(entries) == len(ASSETS), "release_artifact_inventory_mismatch")
        for entry in entries:
            safe_path(entry.filename)
            require(entry.filename in ASSETS and entry.filename not in payloads, "release_artifact_inventory_mismatch")
            require(not entry.flag_bits & 1, "encrypted_release_archive")
            kind = stat.S_IFMT(entry.external_attr >> 16)
            require(not entry.is_dir() and kind in (0, stat.S_IFREG), "linked_or_special_release_entry")
            total += entry.file_size
            require(0 < entry.file_size <= LIMIT and total <= LIMIT, "release_archive_expansion_limit")
            content = archive.read(entry)
            require(len(content) == entry.file_size, "truncated_release_archive")
            payloads[entry.filename] = content
    require(set(payloads) == ASSETS, "release_artifact_inventory_mismatch")
    for name in ("action.tar.gz", "remote-codex.tar.gz"):
        verify_tar(payloads[name], expected[name])
    sums = "".join(f"{hashlib.sha256(payloads[name]).hexdigest()}  {name}\n" for name in ("action.tar.gz", "remote-codex.tar.gz"))
    require(payloads["SHA256SUMS"] == sums.encode(), "release_asset_hash_mismatch")
    Path(output).mkdir(mode=0o700)
    for name, content in payloads.items():
        with open(Path(output) / name, "xb") as file:
            file.write(content)
    return {"files": sum(len(items) for items in expected.values()), "sha256": {name: hashlib.sha256(content).hexdigest() for name, content in payloads.items()}}


if __name__ == "__main__":
    try:
        print(json.dumps(verify(*sys.argv[1:])))
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) and str(error).startswith(("release_", "unsafe_", "duplicate_", "linked_", "encrypted_", "truncated_")) else "invalid_release_archive"
        print(json.dumps({"reason": reason}), file=sys.stderr)
        sys.exit(1)
