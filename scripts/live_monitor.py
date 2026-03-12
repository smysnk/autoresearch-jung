#!/usr/bin/env python3
"""Helpers for runner-emitted live monitoring state and Codex phase patches."""

from __future__ import annotations

import difflib
import json
from pathlib import Path
from typing import Any

from experiment_log import iso_now, write_json


def _safe_patch_name(relative_path: str) -> str:
    return relative_path.replace("/", "__").replace("\\", "__")


def _iter_phase_watch_files(repo_root: Path) -> list[Path]:
    watched: list[Path] = []
    for rel_path in ("train.py", "results.tsv", "research_journal.tsv"):
        path = repo_root / rel_path
        if path.exists() and path.is_file():
            watched.append(path)

    research_state_root = repo_root / "research_state"
    if research_state_root.exists():
        for path in sorted(research_state_root.rglob("*")):
            if not path.is_file():
                continue
            if "codex" in path.parts:
                continue
            watched.append(path)
    return watched


def snapshot_phase_inputs(repo_root: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    for path in _iter_phase_watch_files(repo_root):
        snapshot[str(path.relative_to(repo_root))] = path.read_text(errors="replace")
    return snapshot


def _summary_from_last_message(text: str | None) -> str | None:
    if not text:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return lines[0] if lines else None


def capture_codex_phase_artifacts(
    *,
    repo_root: Path,
    before_snapshot: dict[str, str],
    phase: str,
    phase_dir: Path,
    log_path: Path,
    output_path: Path,
) -> dict[str, Any]:
    phase_dir.mkdir(parents=True, exist_ok=True)
    patches_dir = phase_dir / "patches"
    patches_dir.mkdir(parents=True, exist_ok=True)

    after_snapshot = snapshot_phase_inputs(repo_root)
    changed_entries: list[dict[str, Any]] = []

    for relative_path in sorted(set(before_snapshot) | set(after_snapshot)):
        before_text = before_snapshot.get(relative_path)
        after_text = after_snapshot.get(relative_path)
        if before_text == after_text:
            continue
        status = "modified"
        if before_text is None:
            status = "added"
        elif after_text is None:
            status = "deleted"
        patch_text = "".join(
            difflib.unified_diff(
                (before_text or "").splitlines(keepends=True),
                (after_text or "").splitlines(keepends=True),
                fromfile=f"before/{relative_path}",
                tofile=f"after/{relative_path}",
            )
        )
        patch_path = patches_dir / f"{_safe_patch_name(relative_path)}.diff.patch"
        patch_path.write_text(patch_text)
        changed_entries.append(
            {
                "path": relative_path,
                "status": status,
                "patch_path": str(patch_path.relative_to(phase_dir)),
            }
        )

    last_message_text = output_path.read_text(errors="replace") if output_path.exists() else None
    transcript_text = log_path.read_text(errors="replace") if log_path.exists() else None
    state_path = repo_root / "research_state" / "current_iteration.json"
    if state_path.exists():
        (phase_dir / "current_iteration.json").write_text(state_path.read_text(errors="replace"))
    if output_path.exists():
        (phase_dir / "last-message.txt").write_text(last_message_text or "")
    if log_path.exists():
        (phase_dir / "transcript.log").write_text(transcript_text or "")

    manifest = {
        "phase": phase,
        "captured_at": iso_now(),
        "summary": _summary_from_last_message(last_message_text),
        "modified_files": [entry["path"] for entry in changed_entries],
        "changed_count": len(changed_entries),
        "patches": changed_entries,
        "last_message_path": "last-message.txt" if output_path.exists() else None,
        "transcript_path": "transcript.log" if log_path.exists() else None,
        "state_path": "current_iteration.json" if state_path.exists() else None,
    }
    write_json(phase_dir / "manifest.json", manifest)
    return manifest
