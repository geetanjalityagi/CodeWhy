"""
Auto-generate a targets JSON file by ranking the top N most-changed files
in a cloned repository using git log.

Usage:
    python scripts/auto_targets.py --repo owner/name --clone-dir data/clones --out targets/auto_owner_name.json --top 20
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import Counter
from pathlib import Path

# File extensions to skip (non-code / config noise)
SKIP_EXTENSIONS = {".md", ".txt", ".rst", ".lock", ".yaml", ".yml", ".toml"}
# JSON is skipped by default unless it's a small set of the top files
SKIP_EXTENSIONS_SOFT = {".json"}


def find_clone_dir(clone_dir: Path, owner: str, name: str) -> Path:
    """Locate the cloned repo directory, checking both naming conventions."""
    double_underscore = clone_dir / f"{owner}__{name}"
    single_underscore = clone_dir / f"{owner}_{name}"
    slash_replaced = clone_dir / f"{owner}/{name}"

    for candidate in (double_underscore, single_underscore, slash_replaced):
        if candidate.exists() and (candidate / ".git").exists():
            return candidate

    raise FileNotFoundError(
        f"Could not find clone of {owner}/{name} under {clone_dir}. "
        f"Tried: {double_underscore}, {single_underscore}"
    )


def rank_files(clone_path: Path, top_n: int) -> list[tuple[str, int]]:
    """Run git log to count per-file changes; return top N code files."""
    result = subprocess.run(
        ["git", "log", "--name-only", "--format="],
        cwd=str(clone_path),
        capture_output=True,
        text=True,
        check=True,
    )
    counter: Counter[str] = Counter()
    for line in result.stdout.splitlines():
        path = line.strip()
        if not path:
            continue
        suffix = Path(path).suffix.lower()
        if suffix in SKIP_EXTENSIONS:
            continue
        counter[path] += 1

    # Allow .json files only if they would make the top-N list after hard-skip files
    # are exhausted — handled by sorting all non-hard-skipped files and slicing
    ranked = counter.most_common()

    # First pass: prefer non-soft-skip files
    primary = [(p, c) for p, c in ranked if Path(p).suffix.lower() not in SKIP_EXTENSIONS_SOFT]
    if len(primary) >= top_n:
        return primary[:top_n]

    # Pad with soft-skip files if needed
    soft = [(p, c) for p, c in ranked if Path(p).suffix.lower() in SKIP_EXTENSIONS_SOFT]
    combined = primary + soft
    return combined[:top_n]


def build_targets_json(repo: str, files: list[tuple[str, int]]) -> dict:
    """Build the targets JSON structure compatible with IngestTargets schema."""
    owner, name = repo.split("/", 1)
    targets_list = []
    for path, _count in files:
        targets_list.append(path)

    return {
        "repo": repo,
        "files": targets_list,
        "dirs": [],
        "config_keys": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Auto-generate a targets JSON file from the top N most-changed files."
    )
    parser.add_argument("--repo", required=True, help="owner/name slug")
    parser.add_argument("--clone-dir", default="data/clones", help="Root clone directory")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--top", type=int, default=20, help="Number of files to include")
    args = parser.parse_args()

    if "/" not in args.repo:
        sys.exit(f"ERROR: --repo must be owner/name, got: {args.repo!r}")

    owner, name = args.repo.split("/", 1)
    clone_dir = Path(args.clone_dir)
    out_path = Path(args.out)

    try:
        clone_path = find_clone_dir(clone_dir, owner, name)
    except FileNotFoundError as exc:
        sys.exit(f"ERROR: {exc}")

    print(f"Using clone at: {clone_path}", file=sys.stderr)

    try:
        ranked = rank_files(clone_path, args.top)
    except subprocess.CalledProcessError as exc:
        sys.exit(f"ERROR: git log failed: {exc.stderr}")

    if not ranked:
        sys.exit("ERROR: No code files found in git history.")

    print(f"Top {len(ranked)} files selected:", file=sys.stderr)
    for path, count in ranked:
        print(f"  {count:>5}  {path}", file=sys.stderr)

    payload = build_targets_json(args.repo, ranked)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
