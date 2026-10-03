#!/usr/bin/env python3
"""File a GitHub issue for a defect in the @sprintcx/openclaw-cliq plugin.

Searches open issues first to link existing reports instead of filing duplicates,
and scrubs credential and secret patterns before text leaves the machine.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

DEFAULT_REPO = "sprintberlin/openclaw-cliq"
REPO_ENV = "CLIQ_PLUGIN_REPO"

KINDS = (
    "parser-bug",
    "api-error",
    "cli-bug",
    "doc-mismatch",
)

_REDACTIONS = (
    (re.compile(r"(?i)\b1000\.[A-Za-z0-9._-]{6,}"), "[REDACTED_OAUTH_TOKEN]"),
    (re.compile(r"(?i)\b[a-f0-9]{64}\b"), "[REDACTED_HEX_SECRET]"),
    (re.compile(r"(?i)\bbearer\s+(?:[\"']?)[^\s\"']+"), "Bearer [REDACTED]"),
    (
        re.compile(r"(?i)(https?://)[^/\s:@]+:[^@\s/]+@"),
        r"\1[REDACTED_CREDENTIALS]@",
    ),
    (
        re.compile(
            r"(?i)(?P<key_quote>[\"']?)"
            r"(?P<prefix>(?:--)?(?:client[-_]?secret|refresh[-_]?token|webhook[-_]?secret|access[-_]?token|auth(?:orization)?[-_]?code|api[-_]?key|password|secret|token))"
            r"(?P=key_quote)"
            r"(?P<sep>\s*[:=]\s*|\s+)"
            r"(?P<value_quote>[\"']?)"
            r"(?!\[REDACTED)[^\s\"',;}\]&]+"
            r"(?P=value_quote)"
        ),
        r"\g<key_quote>\g<prefix>\g<key_quote>\g<sep>\g<value_quote>[REDACTED]\g<value_quote>",
    ),
    (re.compile(r"(?i)([?&](?:secret|token|password|auth_code)=)[^&#\s]+"), r"\1[REDACTED]"),
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"), "[REDACTED_EMAIL]"),
)


def scrub(text: str | None) -> str:
    """Strip credential patterns from text."""
    value = str(text or "")
    for pattern, replacement in _REDACTIONS:
        value = pattern.sub(replacement, value)
    return value.strip()


def resolve_repo(args: argparse.Namespace | None = None) -> str:
    """Resolve target repository slug."""
    explicit = getattr(args, "repo", None) if args is not None else None
    return explicit or os.environ.get(REPO_ENV) or DEFAULT_REPO


def run_gh(argv: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Execute one gh command."""
    try:
        result = subprocess.run(
            ["gh", *argv], capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError:
        return 127, "", "gh executable not found"
    except subprocess.TimeoutExpired:
        return 124, "", "gh call timed out"
    return result.returncode, result.stdout, result.stderr


def find_existing(repo: str, query: str, timeout: int = 30) -> dict | None:
    """Return the first open issue matching query, or None."""
    code, out, err = run_gh(
        [
            "issue",
            "list",
            "--repo",
            repo,
            "--state",
            "open",
            "--search",
            query,
            "--limit",
            "5",
            "--json",
            "number,title,url",
        ],
        timeout=timeout,
    )
    if code != 0:
        return {"error": err.strip() or "gh issue list failed"}
    try:
        found = json.loads(out or "[]")
    except json.JSONDecodeError:
        return {"error": "gh returned invalid JSON"}
    return found[0] if found else None


def build_body(args: argparse.Namespace) -> str:
    """Render issue body from scrubbed arguments."""
    sections = [
        ("Kind", args.kind),
        ("Expected", scrub(args.expected)),
        ("Actual", scrub(args.actual)),
        ("Reproduction steps", scrub(args.repro)),
        ("Component / CLI", scrub(args.component)),
        ("Observed version", scrub(args.plugin_version)),
    ]
    body = "\n\n".join(f"### {label}\n{value}" for label, value in sections if value)
    return (
        f"{body}\n\n---\n"
        "Filed by an agent or operator using the bundled cliq skill. "
        "Sensitive tokens and secrets have been redacted."
    )


def create_issue(repo: str, title: str, body: str, labels: list[str], timeout: int = 30) -> tuple[int, str, str]:
    """Create the GitHub issue, falling back to no labels if a label does not exist."""
    argv = ["issue", "create", "--repo", repo, "--title", title, "--body", body]
    if labels:
        argv += ["--label", ",".join(labels)]
    code, out, err = run_gh(argv, timeout=timeout)
    if code != 0 and labels and "label" in err.lower():
        code, out, err = run_gh(
            ["issue", "create", "--repo", repo, "--title", title, "--body", body],
            timeout=timeout,
        )
    return code, out, err


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="File a GitHub issue for a defect in @sprintcx/openclaw-cliq."
    )
    parser.add_argument("--title", required=True, help="one-line defect summary")
    parser.add_argument("--kind", required=True, choices=KINDS, help="defect category")
    parser.add_argument("--expected", help="expected behavior per docs or contract")
    parser.add_argument("--actual", help="actual behavior observed")
    parser.add_argument("--repro", help="minimal reproduction steps, secrets redacted")
    parser.add_argument("--component", help="CLI command or component involved")
    parser.add_argument("--plugin-version", help="plugin version or commit SHA")
    parser.add_argument("--search", help="dedupe search query (default: title)")
    parser.add_argument("--label", action="append", default=[], help="optional issue label")
    parser.add_argument("--repo", help=f"target repo (default: {REPO_ENV} or {DEFAULT_REPO})")
    parser.add_argument("--force", action="store_true", help="file even if a potential duplicate exists")
    parser.add_argument("--dry-run", action="store_true", help="print payload without filing")
    parser.add_argument("--json", action="store_true", help="emit JSON output")
    parser.add_argument(
        "--timeout", type=int, default=30, help="gh timeout in seconds (default: 30)"
    )
    return parser


def emit(payload: dict, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
    elif payload.get("url"):
        print(f"{payload['status']}: {payload['url']}")
    else:
        print(payload.get("body") or payload.get("status", ""))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    repo = resolve_repo(args)
    title = scrub(args.title)
    if not title:
        print("Error: --title is empty after redaction", file=sys.stderr)
        return 1
    body = build_body(args)

    if args.dry_run:
        emit({"status": "dry-run", "repo": repo, "title": title, "body": body}, args.json)
        return 0

    if not args.force:
        search_query = scrub(args.search) or title
        existing = find_existing(repo, search_query, timeout=args.timeout)
        if isinstance(existing, dict) and existing.get("error"):
            print(f"Error: {existing['error']}", file=sys.stderr)
            return 1
        if existing:
            emit(
                {
                    "status": "existing",
                    "repo": repo,
                    "url": existing.get("url", ""),
                    "title": existing.get("title", ""),
                },
                args.json,
            )
            return 0

    labels = [scrub(label) for label in args.label if scrub(label)]
    if not labels:
        labels.append("bug")

    code, out, err = create_issue(repo, title, body, labels, timeout=args.timeout)
    if code != 0:
        print(f"Error: {err.strip() or 'gh issue create failed'}", file=sys.stderr)
        return 1
    emit({"status": "created", "repo": repo, "url": out.strip()}, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
