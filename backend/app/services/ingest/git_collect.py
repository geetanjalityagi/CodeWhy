from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

from app.services.ingest.git_probe import (
    CommandRunner,
    RECORD_END,
    RECORD_START,
    FIELD_SEP,
    default_runner,
)

COMMIT_FORMAT = (
    f"{RECORD_START}%H{FIELD_SEP}%P{FIELD_SEP}%aI{FIELD_SEP}%cI{FIELD_SEP}"
    f"%an{FIELD_SEP}%s{FIELD_SEP}%b{RECORD_END}"
)
DIFF_CAP_BYTES = 200 * 1024
SUBJECT_PR_NUMBER = re.compile(r"\(#(\d+)\)")
MERGE_PR_NUMBER = re.compile(r"^Merge pull request #(\d+)")
DOC_MAX_BYTES = 500 * 1024
TEXT_SUFFIXES = frozenset({".md", ".rst", ".txt", ".adoc", ".markdown"})
CHANGELOG_NAMES = ("CHANGES", "CHANGELOG")
DEFAULT_DOC_DIRS = ("docs", "adr", "rfcs")

FENCED_CODE = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`\n]*`")
ISSUE_REFERENCE = re.compile(r"(?<![\w&/])#(\d{1,6})(?![\w&])")

TRAILER_LINE = re.compile(r"^(?P<token>[A-Za-z][A-Za-z0-9_-]*):[ \t]*(?P<value>\S.*?)[ \t]*$")
GITHUB_PULL_URL = re.compile(
    r"https?://github\.com/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/pull/(?P<number>\d+)\b"
)
GITHUB_ISSUE_URL = re.compile(
    r"https?://github\.com/(?P<owner>[^/\s]+)/(?P<repo>[^/\s]+)/issues/(?P<number>\d+)\b"
)
CLOSING_TRAILERS = ("fixes", "closes", "resolves")
MENTION_TRAILERS = ("references", "related", "see-also")


@dataclass
class CollectedCommit:
    sha: str
    parent_shas: list[str] = field(default_factory=list)
    authored_at: str = ""
    committed_at: str = ""
    author_name: str = ""
    subject: str = ""
    message: str = ""
    pull_requests: list[int] = field(default_factory=list)
    closing: list[int] = field(default_factory=list)
    mentions: list[int] = field(default_factory=list)
    trailers: dict[str, list[str]] = field(default_factory=dict)
    files: list[dict[str, Optional[str]]] = field(default_factory=list)
    diff: str = ""
    diff_truncated: bool = False

    def as_row(self) -> dict[str, object]:
        return {
            "sha": self.sha,
            "authored_at": self.authored_at,
            "committed_at": self.committed_at,
            "author_name": self.author_name,
            "subject": self.subject,
            "message": self.message,
            "parent_shas": self.parent_shas,
            "pull_requests": self.pull_requests,
            "closing": self.closing,
            "mentions": self.mentions,
            "trailers": self.trailers,
        }


@dataclass
class CollectedDocument:
    path: str
    content: str
    content_hash: str
    sha: str
    truncated: bool = False


def extract_pull_request_numbers(subject: str) -> list[int]:
    numbers: list[int] = []
    merge = MERGE_PR_NUMBER.match(subject.strip())
    if merge:
        numbers.append(int(merge.group(1)))
    for found in SUBJECT_PR_NUMBER.findall(subject):
        value = int(found)
        if value not in numbers:
            numbers.append(value)
    return numbers


def strip_code(text: str) -> str:
    without_fences = FENCED_CODE.sub(" ", text or "")
    return INLINE_CODE.sub(" ", without_fences)


def extract_issue_numbers(text: str) -> list[int]:
    return sorted({int(number) for number in ISSUE_REFERENCE.findall(strip_code(text))})

def parse_trailer_block(message: str) -> dict[str, list[str]]:
    """Read the trailing run of trailer paragraphs.

    Git separates the trailer it writes for you from the Signed-off-by block with a blank
    line, so `Fixes: <url>` followed by `Signed-off-by: ...` arrives as two paragraphs.
    Walk backwards while each paragraph is entirely trailer shaped and merge them, but
    stop at the first paragraph that is not, so a `Fixes: #99` mentioned in prose never
    counts as one.
    """
    paragraphs = [block for block in (message or "").split("\n\n") if block.strip()]
    if not paragraphs:
        return {}

    def trailer_lines(block: str) -> Optional[list[tuple[str, str]]]:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if not lines:
            return None
        entries = []
        for line in lines:
            match = TRAILER_LINE.match(line)
            if match is None:
                return None
            entries.append((match.group("token"), match.group("value")))
        return entries

    parsed: dict[str, list[str]] = {}
    for block in reversed(paragraphs):
        entries = trailer_lines(block)
        if entries is None:
            break
        for token, value in entries:
            parsed.setdefault(token, []).insert(0, value)
    return parsed


def _same_repo_issue_numbers(value: str, repo: str) -> list[int]:
    """Issue numbers from a full github.com URL naming this repository.

    GitHub's own web UI writes `Fixes: https://github.com/owner/repo/issues/123`, so a
    bare `#123` regex alone misses most contemporary closing trailers.
    """
    numbers: list[int] = []
    for match in GITHUB_ISSUE_URL.finditer(value or ""):
        if f"{match.group('owner')}/{match.group('repo')}".lower() == repo.lower():
            numbers.append(int(match.group("number")))
    return numbers


def _trailer_values(trailers: dict[str, list[str]], *names: str) -> list[str]:
    values: list[str] = []
    for name in names:
        for token, entries in trailers.items():
            if token.lower() == name:
                values.extend(entries)
    return values


@dataclass
class MessageReferences:
    pull_requests: list[int] = field(default_factory=list)
    closing: list[int] = field(default_factory=list)
    mentions: list[int] = field(default_factory=list)
    trailers: dict[str, list[str]] = field(default_factory=dict)

    def as_dict(self) -> dict[str, object]:
        return {
            "pull_requests": self.pull_requests,
            "closing": self.closing,
            "mentions": self.mentions,
            "trailers": self.trailers,
        }


def extract_references(message: str, repo: str) -> MessageReferences:
    trailers = parse_trailer_block(message)
    references = MessageReferences(trailers=trailers)
    for value in _trailer_values(trailers, "pull-request", "pull_request"):
        match = GITHUB_PULL_URL.search(value)
        if match is None:
            continue
        if f"{match.group('owner')}/{match.group('repo')}".lower() == repo.lower():
            references.pull_requests.append(int(match.group("number")))
    references.pull_requests = sorted(set(references.pull_requests))
    for value in _trailer_values(trailers, *CLOSING_TRAILERS):
        references.closing.extend(extract_issue_numbers(value))
        references.closing.extend(_same_repo_issue_numbers(value, repo))
    for value in _trailer_values(trailers, *MENTION_TRAILERS):
        references.mentions.extend(extract_issue_numbers(value))
        references.mentions.extend(_same_repo_issue_numbers(value, repo))
    references.closing = sorted(set(references.closing))
    references.mentions = sorted(set(references.mentions))
    return references


def parse_commit_records(raw: str, repo: str = "") -> list[CollectedCommit]:
    commits: list[CollectedCommit] = []
    for chunk in raw.split(RECORD_START):
        if not chunk.strip():
            continue
        header, _, remainder = chunk.partition(RECORD_END)
        fields = header.split(FIELD_SEP)
        if len(fields) < 7:
            continue
        sha, parents, authored, committed, author, subject, message = fields[:7]
        message = FIELD_SEP.join(fields[6:])
        references = extract_references(message, repo)
        commits.append(
            CollectedCommit(
                sha=sha,
                parent_shas=[p for p in parents.split() if p],
                authored_at=authored,
                committed_at=committed,
                author_name=author,
                subject=subject,
                message=message,
                pull_requests=sorted(set(extract_pull_request_numbers(subject) + references.pull_requests)),
                closing=references.closing,
                mentions=references.mentions,
                trailers=references.trailers,
                files=parse_name_status(remainder),
            )
        )
    return commits


def parse_name_status(text: str) -> list[dict[str, Optional[str]]]:
    entries: list[dict[str, Optional[str]]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue
        parts = line.split("\t")
        status = parts[0].strip()
        if status.startswith("R") or status.startswith("C"):
            if len(parts) >= 3:
                entries.append({"path": parts[2].strip(), "old_path": parts[1].strip(), "status": status})
        elif len(parts) >= 2:
            entries.append({"path": parts[1].strip(), "old_path": None, "status": status})
    return entries


def split_patches(raw: str) -> dict[str, str]:
    patches: dict[str, str] = {}
    current: Optional[str] = None
    buffer: list[str] = []
    for chunk in raw.split(RECORD_START):
        if not chunk.strip():
            continue
        header, _, remainder = chunk.partition(RECORD_END)
        fields = header.split(FIELD_SEP)
        if len(fields) < 7:
            continue
        sha = fields[0]
        patches[sha] = remainder
    del current, buffer
    return patches


def collect_file_commits(
    clone: Path,
    relative_path: str,
    branch: str,
    *,
    runner: CommandRunner = default_runner,
    repo: str = "",
) -> list[CollectedCommit]:
    metadata = runner(
        [
            "git",
            "log",
            "--follow",
            "--name-status",
            "-M",
            f"--format={COMMIT_FORMAT}",
            branch,
            "--",
            relative_path,
        ],
        clone,
    )
    if metadata.returncode != 0:
        raise RuntimeError(f"git log failed for {relative_path}")
    commits = parse_commit_records(metadata.stdout or "", repo)

    patches_run = runner(
        [
            "git",
            "log",
            "--follow",
            "-p",
            "-U3",
            f"--format={COMMIT_FORMAT}",
            branch,
            "--",
            relative_path,
        ],
        clone,
    )
    patches = split_patches(patches_run.stdout or "")
    for commit in commits:
        patch = patches.get(commit.sha, "")
        encoded = patch.encode("utf-8")
        if len(encoded) > DIFF_CAP_BYTES:
            commit.diff = patch.encode("utf-8")[:DIFF_CAP_BYTES].decode("utf-8", errors="ignore")
            commit.diff_truncated = True
        else:
            commit.diff = patch
            commit.diff_truncated = False
    return commits


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() not in TEXT_SUFFIXES:
        return False
    try:
        path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False
    return True


def collect_documents(
    clone: Path,
    dirs: Sequence[str],
    *,
    head_sha: str,
) -> list[CollectedDocument]:
    wanted = list(dict.fromkeys(list(DEFAULT_DOC_DIRS) + list(dirs)))
    documents: list[CollectedDocument] = []
    for name in sorted(path for path in clone.iterdir() if path.is_file()):
        base = name.name
        if base.endswith(".md") or base.upper().startswith(CHANGELOG_NAMES):
            if is_text_file(name):
                documents.append(_read_document(clone, name, head_sha))
    for directory in wanted:
        target = clone / directory.rstrip("/")
        if not target.is_dir():
            continue
        for path in sorted(target.rglob("*")):
            if not path.is_file() or not is_text_file(path):
                continue
            relative = path.relative_to(clone).as_posix()
            if any(relative == existing.path for existing in documents):
                continue
            documents.append(_read_document(clone, path, head_sha))
    return documents


def _read_document(clone: Path, path: Path, head_sha: str) -> CollectedDocument:
    import hashlib

    relative = path.relative_to(clone).as_posix()
    raw = path.read_bytes()
    truncated = len(raw) > DOC_MAX_BYTES
    content = raw[:DOC_MAX_BYTES].decode("utf-8", errors="ignore")
    return CollectedDocument(
        path=relative,
        content=content,
        content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
        sha=head_sha,
        truncated=truncated,
    )