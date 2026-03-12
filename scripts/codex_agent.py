#!/usr/bin/env python3
"""Shared Codex CLI integration for runner-managed experiment loops."""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


DEFAULT_PROGRAM_PATH = "program.md"
DEFAULT_CODEX_EXECUTABLE = "codex"
DEFAULT_STATE_PATH = "research_state/current_iteration.json"


def _env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


@dataclass(frozen=True)
class CodexAgentConfig:
    enabled: bool
    executable: str
    model: str | None
    profile: str | None
    bypass_sandbox: bool
    program_path: Path
    state_path: Path


def phase_output_paths(
    *,
    repo_root: Path,
    session_id: str,
    experiment_index: int,
    phase: str,
) -> tuple[Path, Path]:
    base_dir = repo_root / "research_state" / "codex" / session_id
    stem = f"{experiment_index:03d}-{phase}"
    return base_dir / f"{stem}.log", base_dir / f"{stem}.txt"


def load_codex_agent_config(repo_root: Path) -> CodexAgentConfig:
    executable = os.environ.get("AUTORESEARCH_CODEX_EXECUTABLE", DEFAULT_CODEX_EXECUTABLE)
    program_path = repo_root / os.environ.get("AUTORESEARCH_PROGRAM_PATH", DEFAULT_PROGRAM_PATH)
    state_path = repo_root / os.environ.get("AUTORESEARCH_STATE_PATH", DEFAULT_STATE_PATH)
    enabled = _env_flag("AUTORESEARCH_USE_CODEX", True)
    return CodexAgentConfig(
        enabled=enabled,
        executable=executable,
        model=os.environ.get("AUTORESEARCH_CODEX_MODEL") or None,
        profile=os.environ.get("AUTORESEARCH_CODEX_PROFILE") or None,
        bypass_sandbox=_env_flag("AUTORESEARCH_CODEX_BYPASS_SANDBOX", True),
        program_path=program_path,
        state_path=state_path,
    )


def ensure_codex_available(cfg: CodexAgentConfig) -> None:
    if not cfg.enabled:
        return
    if Path(cfg.executable).exists():
        return
    if shutil.which(cfg.executable) is not None:
        return
    raise SystemExit(
        f"Codex CLI is enabled but {cfg.executable!r} was not found. "
        "Set AUTORESEARCH_USE_CODEX=0 to disable agent integration."
    )


def read_keep_discard_status(state_path: Path) -> str | None:
    if not state_path.exists():
        return None
    import json

    try:
        data = json.loads(state_path.read_text())
    except json.JSONDecodeError:
        return None
    result = data.get("result") or {}
    value = result.get("keep_discard_status")
    if value in (None, ""):
        return None
    return str(value)


def build_codex_phase_prompt(
    *,
    cfg: CodexAgentConfig,
    runner_mode: str,
    branch: str,
    experiment_index: int,
    phase: str,
    baseline_run: bool,
    run_log_path: Path | None = None,
    summary_path: Path | None = None,
    execution_dir: Path | None = None,
) -> str:
    if phase not in {"prepare", "reflect"}:
        raise ValueError(f"Unsupported Codex phase: {phase}")

    lines = [
        "You are the autoresearch agent running inside a runner-managed experiment loop.",
        f"Read and follow {cfg.program_path.name} before making any changes.",
        "",
        f"Runner mode: {runner_mode}",
        f"Branch: {branch}",
        f"Experiment index: {experiment_index}",
        f"Phase: {phase}",
        "",
        "Hard constraints:",
        "- The runner owns all git operations. Never run git, never create branches, never commit, never reset, never push.",
        "- The runner owns experiment execution. Never run uv run train.py, never invoke scripts/remote_runner.py, and never invoke scripts/runpod_runner.py.",
        "- Do not modify prepare.py, dependency files, or runner scripts in this phase.",
        f"- The structured state file for this iteration is {cfg.state_path.as_posix()}.",
    ]

    if phase == "prepare":
        lines.extend(
            [
                "",
                "Prepare the next experiment candidate.",
                "- Update train.py only if the next experiment requires it.",
                f"- Update only {cfg.state_path.as_posix()} plus train.py and optional untracked scratchpads.",
                "- Fill in the plan-stage fields the runner will capture.",
                "- You may update untracked scratchpads like research_journal.tsv if useful.",
            ]
        )
        if baseline_run:
            lines.extend(
                [
                    "- This is the required baseline experiment.",
                    "- Leave train.py unchanged unless you are only normalizing formatting without changing behavior.",
                    "- Focus on writing a strong baseline prediction and active tensions state.",
                ]
            )
        else:
            lines.extend(
                [
                    "- Use the latest local session logs and reports to choose the next move.",
                    "- Preserve the Jungian method: active tensions, contradiction tracking, and a concrete transcendent-function candidate when appropriate.",
                ]
            )
        lines.extend(
            [
                "",
                "When finished, leave the repository ready for the runner to commit and execute.",
                "In your final response, summarize the planned move, prediction, and whether train.py changed.",
            ]
        )
        return "\n".join(lines) + "\n"

    if run_log_path is None:
        raise ValueError("reflect phase requires run_log_path")

    lines.extend(
        [
            "",
            "Reflect on the completed experiment.",
            f"- Read the completed run log at {run_log_path.as_posix()}.",
            "- Do not edit train.py in this phase.",
            f"- Update only the result and transcendent sections of {cfg.state_path.as_posix()} so the runner can materialize the canonical session log.",
            "- Set result.outcome, result.contradicted_assumption, result.keep_discard_status, result.framing_diagnosis, result.next_move_type, and result.summary_text.",
            "- Set transcendent.result_status and any other transcendent fields needed to explain what emerged from the tension of opposites.",
        ]
    )
    if summary_path is not None:
        lines.append(f"- Read the structured summary at {summary_path.as_posix()} if it exists.")
    if execution_dir is not None:
        lines.append(f"- The current execution bundle lives under {execution_dir.as_posix()}.")
    lines.extend(
        [
            "",
            "When finished, leave the repository ready for the runner to capture the result state.",
            "In your final response, summarize the outcome, keep/discard/crash decision, and next movement.",
        ]
    )
    return "\n".join(lines) + "\n"


def run_codex_phase(
    *,
    repo_root: Path,
    cfg: CodexAgentConfig,
    runner_mode: str,
    branch: str,
    experiment_index: int,
    phase: str,
    log_path: Path,
    output_path: Path,
    baseline_run: bool = False,
    run_log_path: Path | None = None,
    summary_path: Path | None = None,
    execution_dir: Path | None = None,
) -> None:
    if not cfg.enabled:
        return

    prompt = build_codex_phase_prompt(
        cfg=cfg,
        runner_mode=runner_mode,
        branch=branch,
        experiment_index=experiment_index,
        phase=phase,
        baseline_run=baseline_run,
        run_log_path=run_log_path,
        summary_path=summary_path,
        execution_dir=execution_dir,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    cmd = [
        cfg.executable,
        "exec",
        "-C",
        str(repo_root),
        "--output-last-message",
        str(output_path),
        "-",
    ]
    if cfg.bypass_sandbox:
        cmd.insert(2, "--dangerously-bypass-approvals-and-sandbox")
    else:
        cmd[2:2] = ["--full-auto"]
    if cfg.model:
        cmd[2:2] = ["-m", cfg.model]
    if cfg.profile:
        cmd[2:2] = ["-p", cfg.profile]

    with log_path.open("w") as fh:
        subprocess.run(
            cmd,
            cwd=repo_root,
            input=prompt,
            text=True,
            check=True,
            stdout=fh,
            stderr=subprocess.STDOUT,
        )
