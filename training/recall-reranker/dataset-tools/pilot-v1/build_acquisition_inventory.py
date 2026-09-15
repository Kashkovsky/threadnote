"""Inventory immutable public source snapshots without approving them for training."""

from __future__ import annotations

import hashlib
import json
import re
import tarfile
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path
from pathlib import PurePosixPath

PROJECT_ROOT = Path(__file__).resolve().parents[4]
SOURCES_ROOT = PROJECT_ROOT / ".artifacts/training/recall-reranker/sources"
OUTPUT_ROOT = Path(__file__).resolve().parent
SELECTION_REVISION = "public-source-inventory-v1"
SENSITIVE_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
)

REPOSITORIES = (
    {
        "id": "effect-2026-09-15",
        "slug": "effect",
        "repository": "Effect-TS/effect",
        "revision": "90695b0d5bee3aa33e67cbea1aa2e6298816a64f",
        "archiveSha256": "785c74888524427540b30e6b425c741621979fffa4d24301ea84a01ba3c0d183",
        "license": "MIT",
        "licenseFiles": ("LICENSE", "packages/effect/LICENSE"),
        "licenseSha256": "774c3bc5924ad8ae6c5a75f1c53db13feb238ade15989625c513d07b60dedf30",
        "prefixes": ("packages/effect/src/",),
        "suffixes": (".ts",),
    },
    {
        "id": "typescript-2026-09-15",
        "slug": "typescript",
        "repository": "microsoft/TypeScript",
        "revision": "57d9528db25b8dc8375e18468a870ec3f4277d62",
        "archiveSha256": "859d837132da59fe9ea996fe02a038488e1a85497daeb3a0ecdc6be5724e3c56",
        "license": "Apache-2.0",
        "licenseFiles": ("LICENSE.txt",),
        "licenseSha256": "a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47",
        "noticeFiles": ("NOTICE.txt",),
        "noticeSha256": "f5c708b59114507b8b27b48181b6883d106bbca0c1634bbee45b5e344237b66b",
        "prefixes": ("packages/typescript/src/",),
        "suffixes": (".ts",),
    },
    {
        "id": "go-2026-09-15",
        "slug": "go",
        "repository": "golang/go",
        "revision": "8f5d82065574065efc3016ca075fb9548ea9cf1e",
        "archiveSha256": "1f927d7a8a7c146917160aab449a1999ad4533a0ecf72c38e5288e9dd88ebe8e",
        "license": "BSD-3-Clause",
        "licenseFiles": ("LICENSE",),
        "licenseSha256": "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad",
        "prefixes": (
            "src/net/",
            "src/crypto/",
            "src/encoding/",
            "src/database/",
            "src/sync/",
            "src/strings/",
            "src/time/",
            "src/io/",
            "src/context/",
            "src/errors/",
            "src/regexp/",
        ),
        "suffixes": (".go",),
    },
    {
        "id": "rust-book-2026-09-15",
        "slug": "rust-book",
        "repository": "rust-lang/book",
        "revision": "1500248d8f230566e4ec9f27fcbb8fe9e2898ab1",
        "archiveSha256": "e4d11084f9e46cb13d2563be7a970864c5236fce51043b9665082e017e42b0e2",
        "license": "MIT OR Apache-2.0",
        "licenseFiles": ("LICENSE-MIT", "LICENSE-APACHE"),
        "licenseSha256": (
            "0621878e61f0d0fda054bcbe02df75192c28bde1ecc8289cbd86aeba2dd72720",
            "0f2763086f981043fb18879abfa15e75ecfc188219ef9eba4483f45ce7438e1c",
        ),
        "prefixes": ("src/",),
        "suffixes": (".md",),
    },
    {
        "id": "bazel-2026-09-15",
        "slug": "bazel",
        "repository": "bazelbuild/bazel",
        "revision": "f4a3bfda175174418bf56cd81adfc7a64a04a969",
        "archiveSha256": "77928c1438efaae34bb4c4433e1f8d4bfd3d450a40dda556c8f5e6f63301354e",
        "license": "Apache-2.0",
        "licenseFiles": ("LICENSE",),
        "licenseSha256": "9fe6dae7684812d0117f5a0611aa773656776545797608f201fef88fa7363e0b",
        "prefixes": (
            "src/main/java/com/google/devtools/build/lib/analysis/",
            "src/main/java/com/google/devtools/build/lib/actions/",
            "src/main/java/com/google/devtools/build/lib/packages/",
            "src/main/java/com/google/devtools/build/lib/rules/",
            "src/main/java/com/google/devtools/build/lib/skyframe/",
            "src/main/starlark/",
        ),
        "suffixes": (".java", ".bzl", ".md"),
    },
    {
        "id": "rules-swift-2026-09-15",
        "slug": "rules-swift",
        "repository": "bazelbuild/rules_swift",
        "revision": "1f94286323b261a8d122f3bd2dc7b0530d918002",
        "archiveSha256": "f0920e9102b3fe42d417551cc97d1a9c97803f97b65507b18c6cc33104079d81",
        "license": "Apache-2.0",
        "licenseFiles": ("LICENSE",),
        "licenseSha256": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
        "prefixes": ("swift/", "doc/"),
        "suffixes": (".bzl", ".md", ".swift"),
    },
    {
        "id": "swift-2026-09-15",
        "slug": "swift",
        "repository": "swiftlang/swift",
        "revision": "f1d2faf44333d2ec0e653ddf5c93bd37540ea165",
        "archiveSha256": "4c0f7bf6ffd3dcd62783d385acb1b87517c364db56186ff769a2c8d7488f8ca6",
        "license": "Apache-2.0 with Runtime Library Exception",
        "licenseFiles": ("LICENSE.txt",),
        "licenseSha256": "770af8291f708538d8ff885a0bbc4e045cd700531741c4f99528d435c14d7f55",
        "prefixes": (
            "docs/",
            "lib/Frontend/",
            "lib/Parse/",
            "lib/Sema/",
            "SwiftCompilerSources/",
        ),
        "suffixes": (".swift", ".cpp", ".h", ".md", ".rst"),
    },
)

TECHQA = {
    "id": "nvidia-techqa-2026-09-15",
    "revision": "0b5bbc84b7f07d6d09d063130e90b716d8d4a32a",
    "files": {
        "README.md": "8d85191f81a748f2a66bb32cecb972727e69fcc0541c1f936c4debfa4823190b",
        "train.json": "69d97231509482ed6bd5ec1c4bc0607acb82a88d11169eb8383592d0ca8b93c7",
        "corpus.zip": "c06aa287dcc1abf8db6b49b8495df095db73342d729f6451ac330785245d10be",
    },
}


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            h.update(block)
    return h.hexdigest()


def selected_path(path: str, source: dict) -> bool:
    if not path.startswith(source["prefixes"]) or not path.endswith(source["suffixes"]):
        return False
    if any(part in {"vendor", "testdata", "__tests__", "tests", "generated"} for part in PurePosixPath(path).parts):
        return False
    if path.endswith(("_test.go", ".test.ts", ".spec.ts", ".generated.ts", ".generated.go")):
        return False
    if "/internal/" in path and source["slug"] == "go":
        return False
    return True


def repository_inventory(source: dict) -> tuple[list[dict], dict]:
    archive = SOURCES_ROOT / f"{source['slug']}-{source['revision']}" / "source.tar.gz"
    assert digest_file(archive) == source["archiveSha256"], f"Archive changed: {source['id']}"
    rows: list[dict] = []
    excluded_sensitive_files = 0
    nested_rights_files: list[dict] = []
    with tarfile.open(archive, "r:gz") as bundle:
        members = {}
        for member in bundle.getmembers():
            if not member.isfile() or "/" not in member.name:
                continue
            path = member.name.split("/", 1)[1]
            parts = PurePosixPath(path).parts
            assert path and not path.startswith("/") and ".." not in parts
            members[path] = member
        for index, license_path in enumerate(source["licenseFiles"]):
            expected = source["licenseSha256"]
            if isinstance(expected, tuple):
                expected = expected[index]
            assert digest(bundle.extractfile(members[license_path]).read()) == expected
        for notice_path in source.get("noticeFiles", ()):
            assert digest(bundle.extractfile(members[notice_path]).read()) == source["noticeSha256"]
        for path, member in members.items():
            filename = PurePosixPath(path).name.upper()
            if (
                any(path.startswith(prefix) for prefix in source["prefixes"])
                and (filename in {"LICENSE", "LICENSE.TXT", "NOTICE", "NOTICE.TXT", "COPYING", "COPYING.TXT"}
                     or filename.startswith("LICENSE-"))
                and not (source["slug"] == "go" and "/internal/" in path)
                and path not in source["licenseFiles"]
                and path not in source.get("noticeFiles", ())
            ):
                nested_rights_files.append({"path": path, "sha256": digest(bundle.extractfile(member).read())})
        for path, member in members.items():
            if not selected_path(path, source) or member.size > 1024 * 1024:
                continue
            content = bundle.extractfile(member).read()
            if b"\x00" in content:
                continue
            try:
                text = content.decode("utf8")
            except UnicodeDecodeError:
                continue
            if any(pattern.search(text) for pattern in SENSITIVE_PATTERNS):
                excluded_sensitive_files += 1
                continue
            rows.append({
                "sourceId": source["id"],
                "repository": source["repository"],
                "revision": source["revision"],
                "path": path,
                "rawSha256": digest(content),
                "bytes": len(content),
                "lines": text.count("\n") + 1,
                "selectionRevision": SELECTION_REVISION,
                "reviewed": False,
            })
    rows.sort(key=lambda row: row["path"])
    receipt = {
        "id": source["id"],
        "kind": "public_repository",
        "repository": source["repository"],
        "revision": source["revision"],
        "sourceUri": f"https://github.com/{source['repository']}/tree/{source['revision']}",
        "license": source["license"],
        "licenseFiles": list(source["licenseFiles"]),
        "licenseSha256": source["licenseSha256"],
        "noticeSha256": source.get("noticeSha256"),
        "archiveSha256": source["archiveSha256"],
        "selectedFiles": len(rows),
        "excludedPotentialSensitiveFiles": excluded_sensitive_files,
        "nestedRightsFiles": sorted(nested_rights_files, key=lambda row: row["path"]),
        "selectionRevision": SELECTION_REVISION,
        "rightsReviewed": False,
        "privacyReviewed": False,
        "trainingApproved": False,
        "redistributionApproved": False,
    }
    return rows, receipt


def techqa_inventory() -> tuple[list[dict], dict]:
    root = SOURCES_ROOT / f"techqa-{TECHQA['revision']}"
    for file_name, expected in TECHQA["files"].items():
        assert digest_file(root / file_name) == expected, f"TechQA file changed: {file_name}"
    questions = json.loads((root / "train.json").read_text())
    assert isinstance(questions, list) and len(questions) == 910
    rows: list[dict] = []
    files_by_split: dict[str, set[str]] = defaultdict(set)
    normalized_queries: set[str] = set()
    duplicate_queries = 0
    answerability: dict[str, int] = defaultdict(int)
    for question in questions:
        row_id = question["id"]
        split = row_id.split("_", 1)[0]
        impossible = bool(question["is_impossible"])
        query = question["question"]
        normalized = " ".join(unicodedata.normalize("NFKC", query).casefold().split())
        if normalized in normalized_queries:
            duplicate_queries += 1
        normalized_queries.add(normalized)
        context_files = sorted({context["filename"] for context in question["contexts"] if context.get("filename")})
        files_by_split[split].update(context_files)
        answerability[f"{split}:{'impossible' if impossible else 'answerable'}"] += 1
        rows.append({
            "sourceId": TECHQA["id"],
            "revision": TECHQA["revision"],
            "rowId": row_id,
            "originalSplit": split,
            "isImpossible": impossible,
            "querySha256": digest(query.encode()),
            "contextFilenames": context_files,
            "reviewed": False,
        })
    with zipfile.ZipFile(root / "corpus.zip") as archive:
        names = archive.namelist()
        assert all(not name.startswith("/") and ".." not in PurePosixPath(name).parts for name in names)
        archive_members = len(names)
    rows.sort(key=lambda row: row["rowId"])
    receipt = {
        "id": TECHQA["id"],
        "kind": "public_dataset",
        "sourceUri": f"https://huggingface.co/datasets/nvidia/TechQA-RAG-Eval/tree/{TECHQA['revision']}",
        "revision": TECHQA["revision"],
        "publisherCardLicense": "Apache-2.0",
        "filesSha256": TECHQA["files"],
        "rows": len(rows),
        "answerability": dict(sorted(answerability.items())),
        "duplicateNormalizedQueries": duplicate_queries,
        "sharedContextFilenamesAcrossOriginalSplits": len(files_by_split["TRAIN"] & files_by_split["DEV"]),
        "corpusArchiveMembers": archive_members,
        "sourceDocumentRightsReviewed": False,
        "privacyReviewed": False,
        "trainingApproved": False,
        "redistributionApproved": False,
    }
    return rows, receipt


def main() -> None:
    source_rows: list[dict] = []
    receipts: list[dict] = []
    for source in REPOSITORIES:
        rows, receipt = repository_inventory(source)
        source_rows.extend(rows)
        receipts.append(receipt)
    techqa_rows, techqa_receipt = techqa_inventory()
    receipts.append(techqa_receipt)
    proposed_sources = []
    for receipt in receipts:
        if receipt["kind"] == "public_dataset":
            license_url = f"https://huggingface.co/datasets/nvidia/TechQA-RAG-Eval/blob/{receipt['revision']}/README.md"
            license_name = receipt["publisherCardLicense"]
            provenance = (
                f"Pinned dataset revision {receipt['revision']}; file hashes {receipt['filesSha256']}; "
                f"original-split shared Technote filenames {receipt['sharedContextFilenamesAcrossOriginalSplits']}; "
                "publisher card license only; underlying Technote rights and privacy are unreviewed."
            )
        else:
            license_url = (
                f"https://github.com/{receipt['repository']}/blob/{receipt['revision']}/"
                f"{receipt['licenseFiles'][0]}"
            )
            license_name = receipt["license"]
            provenance = (
                f"Pinned archive sha256 {receipt['archiveSha256']}; license sha256 {receipt['licenseSha256']}; "
                f"notice sha256 {receipt['noticeSha256']}; selected file inventory under {SELECTION_REVISION}; "
                "subtree rights and content privacy await review."
            )
        proposed_sources.append({
            "id": receipt["id"],
            "kind": receipt["kind"],
            "license": license_name,
            "licenseUrl": license_url,
            "privacyBasis": "public_licensed",
            "provenance": provenance,
            "redistributionApproved": False,
            "revision": receipt["revision"],
            "sourceUri": receipt["sourceUri"],
            "trainingApproved": False,
        })
    source_rows.sort(key=lambda row: (row["sourceId"], row["path"]))
    inventory_jsonl = "".join(json.dumps(row, sort_keys=True) + "\n" for row in source_rows)
    techqa_jsonl = "".join(json.dumps(row, sort_keys=True) + "\n" for row in techqa_rows)
    acquisition = {
        "observedAt": "2026-09-15",
        "selectionRevision": SELECTION_REVISION,
        "repositoryInventorySha256": digest(inventory_jsonl.encode()),
        "techqaRowInventorySha256": digest(techqa_jsonl.encode()),
        "repositoryFiles": len(source_rows),
        "techqaRows": len(techqa_rows),
        "sources": receipts,
        "status": "source-acquired-unreviewed",
    }
    (OUTPUT_ROOT / "public-source-inventory.jsonl").write_text(inventory_jsonl)
    (OUTPUT_ROOT / "techqa-row-inventory.jsonl").write_text(techqa_jsonl)
    (OUTPUT_ROOT / "acquisition.json").write_text(json.dumps(acquisition, indent=2) + "\n")
    (OUTPUT_ROOT / "sources.proposed.json").write_text(json.dumps(proposed_sources, indent=2) + "\n")
    print(f"Inventoried {len(source_rows)} repository files and {len(techqa_rows)} TechQA rows; all unreviewed.")


if __name__ == "__main__":
    main()
