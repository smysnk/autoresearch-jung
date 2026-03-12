#!/usr/bin/env python3
"""Create canonical experiment session logs for future visualizers."""

from __future__ import annotations

import difflib
import json
import re
import subprocess
from shutil import copy2, copytree
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
DIALECTICAL_STATE_RELATIVE_PATH = Path("research_state/current_iteration.json")


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def slugify(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-").lower()


def session_id_for_branch(branch: str) -> str:
    return slugify(branch)


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


@dataclass(frozen=True)
class SessionPaths:
    repo_root: Path
    branch: str
    session_id: str
    session_dir: Path
    iterations_dir: Path
    live_dir: Path
    session_path: Path
    manifest_path: Path


@dataclass(frozen=True)
class IterationPaths:
    session: SessionPaths
    iteration: int
    iteration_label: str
    parent_commit: str | None
    candidate_commit: str | None
    iteration_dir: Path
    actual_dir: Path
    codex_dir: Path
    execution_dir: Path
    tensions_dir: Path
    transcendent_dir: Path
    plan_path: Path
    result_path: Path


def ensure_session_log(
    repo_root: Path,
    *,
    branch: str,
    runner_mode: str,
    objective: str = "val_bpb",
) -> SessionPaths:
    session_id = session_id_for_branch(branch)
    session_dir = repo_root / "experiment_logs" / session_id
    iterations_dir = session_dir / "iterations"
    live_dir = session_dir / "live"
    session_path = session_dir / "session.json"
    manifest_path = session_dir / "manifest.json"
    iterations_dir.mkdir(parents=True, exist_ok=True)
    live_dir.mkdir(parents=True, exist_ok=True)

    now = iso_now()

    session_data = read_json(session_path)
    if not session_data:
        session_data = {
            "schema_version": SCHEMA_VERSION,
            "session_id": session_id,
            "branch": branch,
            "runner_mode": runner_mode,
            "objective": objective,
            "created_at": now,
            "updated_at": now,
            "notes": "",
        }
    else:
        session_data["schema_version"] = SCHEMA_VERSION
        session_data["branch"] = branch
        session_data.setdefault("runner_mode", runner_mode)
        session_data.setdefault("objective", objective)
        session_data.setdefault("created_at", now)
        session_data["updated_at"] = now
        session_data.setdefault("notes", "")
    write_json(session_path, session_data)

    manifest = read_json(manifest_path)
    if not manifest:
        manifest = {
            "schema_version": SCHEMA_VERSION,
            "session_id": session_id,
            "branch": branch,
            "created_at": now,
            "updated_at": now,
            "latest_iteration": None,
            "best_iteration": None,
            "current_kept_commit": None,
            "iterations": [],
        }
    else:
        manifest["schema_version"] = SCHEMA_VERSION
        manifest["branch"] = branch
        manifest.setdefault("created_at", now)
        manifest["updated_at"] = now
        manifest.setdefault("latest_iteration", None)
        manifest.setdefault("best_iteration", None)
        manifest.setdefault("current_kept_commit", None)
        manifest.setdefault("iterations", [])
    write_json(manifest_path, manifest)

    return SessionPaths(
        repo_root=repo_root,
        branch=branch,
        session_id=session_id,
        session_dir=session_dir,
        iterations_dir=iterations_dir,
        live_dir=live_dir,
        session_path=session_path,
        manifest_path=manifest_path,
    )


def start_iteration(
    session: SessionPaths,
    *,
    runner_mode: str,
    experiment_index: int | None,
    parent_commit: str | None,
    candidate_commit: str | None,
) -> IterationPaths:
    manifest = read_json(session.manifest_path)
    existing = manifest.get("iterations", [])
    latest_iteration = manifest.get("latest_iteration") or 0
    if existing:
        latest_iteration = max(latest_iteration, max(int(item["iteration"]) for item in existing))
    iteration = latest_iteration + 1
    iteration_label = f"{iteration:03d}"
    iteration_dir = session.iterations_dir / iteration_label
    actual_dir = iteration_dir / "actual"
    codex_dir = iteration_dir / "codex"
    execution_dir = iteration_dir / "execution"
    tensions_dir = iteration_dir / "tensions"
    transcendent_dir = iteration_dir / "transcendent"
    plan_path = iteration_dir / "plan.json"
    result_path = iteration_dir / "result.json"
    actual_dir.mkdir(parents=True, exist_ok=True)
    codex_dir.mkdir(parents=True, exist_ok=True)
    execution_dir.mkdir(parents=True, exist_ok=True)
    tensions_dir.mkdir(parents=True, exist_ok=True)
    transcendent_dir.mkdir(parents=True, exist_ok=True)

    now = iso_now()
    write_json(
        plan_path,
        {
            "schema_version": SCHEMA_VERSION,
            "session_id": session.session_id,
            "iteration": iteration,
            "iteration_label": iteration_label,
            "status": "planned",
            "created_at": now,
            "runner_mode": runner_mode,
            "experiment_index": experiment_index or iteration,
            "parent_commit": parent_commit,
            "candidate_commit": candidate_commit,
            "execution_id": None,
            "execution_dir": None,
        },
    )
    write_json(
        result_path,
        {
            "schema_version": SCHEMA_VERSION,
            "session_id": session.session_id,
            "iteration": iteration,
            "iteration_label": iteration_label,
            "status": "pending",
            "created_at": now,
            "completed_at": None,
            "exit_code": None,
            "summary": {},
            "execution_id": None,
            "execution_dir": None,
        },
    )

    manifest["latest_iteration"] = iteration
    manifest["updated_at"] = now
    if candidate_commit:
        manifest["current_kept_commit"] = candidate_commit
    manifest.setdefault("iterations", []).append(
        {
            "iteration": iteration,
            "iteration_label": iteration_label,
            "path": f"iterations/{iteration_label}",
            "status": "planned",
            "created_at": now,
            "candidate_commit": candidate_commit,
        }
    )
    write_json(session.manifest_path, manifest)

    return IterationPaths(
        session=session,
        iteration=iteration,
        iteration_label=iteration_label,
        parent_commit=parent_commit,
        candidate_commit=candidate_commit,
        iteration_dir=iteration_dir,
        actual_dir=actual_dir,
        codex_dir=codex_dir,
        execution_dir=execution_dir,
        tensions_dir=tensions_dir,
        transcendent_dir=transcendent_dir,
        plan_path=plan_path,
        result_path=result_path,
    )


def bind_execution(iteration: IterationPaths, *, execution_dir: Path) -> None:
    relative_execution_dir = str(execution_dir.relative_to(iteration.session.repo_root))
    execution_id = execution_dir.name

    plan = read_json(iteration.plan_path)
    plan["execution_id"] = execution_id
    plan["execution_dir"] = relative_execution_dir
    write_json(iteration.plan_path, plan)

    result = read_json(iteration.result_path)
    result["execution_id"] = execution_id
    result["execution_dir"] = relative_execution_dir
    write_json(iteration.result_path, result)


def live_state_path(session: SessionPaths) -> Path:
    return session.live_dir / "state.json"


def live_events_path(session: SessionPaths) -> Path:
    return session.live_dir / "events.ndjson"


def live_phase_dir(session: SessionPaths, *, iteration_label: str, phase: str) -> Path:
    path = session.live_dir / "iterations" / iteration_label / phase
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_live_state(session: SessionPaths, payload: dict[str, Any]) -> None:
    write_json(live_state_path(session), payload)


def append_live_event(session: SessionPaths, payload: dict[str, Any]) -> None:
    path = live_events_path(session)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def clear_live_state(session: SessionPaths, *, final_phase: str, status: str) -> None:
    state = read_json(live_state_path(session))
    if not state:
        return
    state["is_active"] = False
    state["phase"] = final_phase
    state["status"] = status
    state["updated_at"] = iso_now()
    write_live_state(session, state)
    append_live_event(
        session,
        {
            "timestamp": iso_now(),
            "type": "live_state_closed",
            "phase": final_phase,
            "status": status,
        },
    )


def bind_codex_phase_artifacts(iteration: IterationPaths, *, phase: str, source_dir: Path) -> None:
    if not source_dir.exists():
        return
    target_dir = iteration.codex_dir / phase
    copytree(source_dir, target_dir, dirs_exist_ok=True)
    manifest = read_json(target_dir / "manifest.json")
    relative_target_dir = _relative_to_session(iteration, target_dir)

    if phase == "prepare":
        plan = read_json(iteration.plan_path)
        plan["prepare_phase_path"] = relative_target_dir
        plan["prepare_modified_files"] = manifest.get("modified_files", [])
        plan["prepare_summary"] = manifest.get("summary")
        write_json(iteration.plan_path, plan)
        return

    if phase == "reflect":
        result = read_json(iteration.result_path)
        result["reflect_phase_path"] = relative_target_dir
        result["reflect_modified_files"] = manifest.get("modified_files", [])
        result["reflect_summary"] = manifest.get("summary")
        write_json(iteration.result_path, result)
        return

    raise RuntimeError(f"unsupported codex phase: {phase}")


def snapshot_tested_train_py(
    iteration: IterationPaths,
    *,
    repo_root: Path,
    train_py_path: Path,
    parent_commit: str | None,
) -> None:
    actual_train_py = iteration.actual_dir / "train.py"
    actual_diff_patch = iteration.actual_dir / "train.diff.patch"
    copy2(train_py_path, actual_train_py)

    current_text = train_py_path.read_text()
    previous_text = ""
    if parent_commit:
        result = subprocess.run(
            ["git", "show", f"{parent_commit}:train.py"],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            previous_text = result.stdout

    diff_lines = list(
        difflib.unified_diff(
            previous_text.splitlines(keepends=True),
            current_text.splitlines(keepends=True),
            fromfile=f"{parent_commit or 'empty'}/train.py",
            tofile="actual/train.py",
        )
    )
    actual_diff_patch.write_text("".join(diff_lines))

    relative_train_py = str(actual_train_py.relative_to(iteration.session.session_dir))
    relative_diff_patch = str(actual_diff_patch.relative_to(iteration.session.session_dir))

    plan = read_json(iteration.plan_path)
    plan["actual_train_py"] = relative_train_py
    plan["actual_train_diff_patch"] = relative_diff_patch
    write_json(iteration.plan_path, plan)

    result_json = read_json(iteration.result_path)
    result_json["actual_train_py"] = relative_train_py
    result_json["actual_train_diff_patch"] = relative_diff_patch
    write_json(iteration.result_path, result_json)


def load_dialectical_state(repo_root: Path) -> dict[str, Any]:
    path = repo_root / DIALECTICAL_STATE_RELATIVE_PATH
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def _relative_to_session(iteration: IterationPaths, path: Path) -> str:
    return str(path.relative_to(iteration.session.session_dir))


def _git_show_train_py(repo_root: Path, commit: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{commit}:train.py"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not resolve train.py from commit {commit}")
    return result.stdout


def _resolve_snapshot_source(
    repo_root: Path,
    *,
    current_train_py_path: Path,
    source: Any,
) -> tuple[str, dict[str, Any]]:
    if source in (None, "", {}):
        return current_train_py_path.read_text(), {"type": "current", "path": "train.py"}
    if isinstance(source, str):
        source = {"type": "path", "path": source}
    if not isinstance(source, dict):
        raise RuntimeError(f"unsupported train.py snapshot source: {source!r}")

    source_type = source.get("type", "path")
    if source_type == "current":
        return current_train_py_path.read_text(), {"type": "current", "path": "train.py"}
    if source_type == "path":
        raw_path = source.get("path")
        if not raw_path:
            raise RuntimeError("path source requires 'path'")
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = repo_root / path
        if not path.exists():
            raise RuntimeError(f"snapshot path does not exist: {path}")
        resolved_path = str(path.relative_to(repo_root)) if path.is_relative_to(repo_root) else str(path)
        return path.read_text(), {"type": "path", "path": resolved_path}
    if source_type == "commit":
        commit = source.get("commit")
        if not commit:
            raise RuntimeError("commit source requires 'commit'")
        return _git_show_train_py(repo_root, commit), {"type": "commit", "commit": commit}
    if source_type == "inline":
        text = source.get("text")
        if text is None:
            raise RuntimeError("inline source requires 'text'")
        return text, {"type": "inline"}
    raise RuntimeError(f"unsupported source type: {source_type}")


def _capture_active_tensions(
    iteration: IterationPaths,
    *,
    repo_root: Path,
    current_train_py_path: Path,
    state: dict[str, Any],
) -> list[str]:
    active_ids: list[str] = []
    for index, raw_tension in enumerate(state.get("active_tensions", []), start=1):
        label = raw_tension.get("label") or raw_tension.get("id") or f"tension-{index}"
        tension_id = slugify(raw_tension.get("id") or label or f"tension-{index}")
        tension_dir = iteration.tensions_dir / tension_id
        thesis_dir = tension_dir / "thesis"
        antithesis_dir = tension_dir / "antithesis"
        thesis_dir.mkdir(parents=True, exist_ok=True)
        antithesis_dir.mkdir(parents=True, exist_ok=True)

        thesis_text, thesis_source = _resolve_snapshot_source(
            repo_root,
            current_train_py_path=current_train_py_path,
            source=(raw_tension.get("thesis") or {}).get("source"),
        )
        antithesis_text, antithesis_source = _resolve_snapshot_source(
            repo_root,
            current_train_py_path=current_train_py_path,
            source=(raw_tension.get("antithesis") or {}).get("source"),
        )

        thesis_path = thesis_dir / "train.py"
        antithesis_path = antithesis_dir / "train.py"
        write_text(thesis_path, thesis_text)
        write_text(antithesis_path, antithesis_text)

        write_json(
            tension_dir / "meta.json",
            {
                "schema_version": SCHEMA_VERSION,
                "id": tension_id,
                "label": label,
                "kind": raw_tension.get("kind"),
                "why_active": raw_tension.get("why_active"),
                "favored_side": raw_tension.get("favored_side"),
                "created_in_iteration": iteration.iteration,
                "updated_in_iteration": iteration.iteration,
                "thesis_summary": (raw_tension.get("thesis") or {}).get("summary"),
                "antithesis_summary": (raw_tension.get("antithesis") or {}).get("summary"),
                "thesis_source": thesis_source,
                "antithesis_source": antithesis_source,
                "thesis_train_py": _relative_to_session(iteration, thesis_path),
                "antithesis_train_py": _relative_to_session(iteration, antithesis_path),
            },
        )
        active_ids.append(tension_id)
    return active_ids


def _capture_transcendent_state(
    iteration: IterationPaths,
    *,
    repo_root: Path,
    current_train_py_path: Path,
    state: dict[str, Any],
) -> dict[str, Any]:
    transcendent = state.get("transcendent") or {}
    result_payload: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "source_tension_ids": list(transcendent.get("source_tension_ids", [])),
        "thesis_ref": transcendent.get("thesis_ref"),
        "antithesis_ref": transcendent.get("antithesis_ref"),
        "emergent_thought": transcendent.get("emergent_thought"),
        "concrete_change": transcendent.get("concrete_change"),
        "tested_in_iteration": transcendent.get("tested_in_iteration"),
        "result_status": transcendent.get("result_status"),
    }
    train_py_source = transcendent.get("train_py_source")
    if train_py_source not in (None, "", {}):
        text, resolved_source = _resolve_snapshot_source(
            repo_root,
            current_train_py_path=current_train_py_path,
            source=train_py_source,
        )
        train_py_path = iteration.transcendent_dir / "train.py"
        write_text(train_py_path, text)
        result_payload["train_py_source"] = resolved_source
        result_payload["train_py"] = _relative_to_session(iteration, train_py_path)
    write_json(iteration.transcendent_dir / "result.json", result_payload)
    return result_payload


def capture_dialectical_state(
    iteration: IterationPaths,
    *,
    repo_root: Path,
    current_train_py_path: Path,
    stage: str,
) -> None:
    state = load_dialectical_state(repo_root)
    active_tension_ids = _capture_active_tensions(
        iteration,
        repo_root=repo_root,
        current_train_py_path=current_train_py_path,
        state=state,
    )
    transcendent_payload = _capture_transcendent_state(
        iteration,
        repo_root=repo_root,
        current_train_py_path=current_train_py_path,
        state=state,
    )

    if stage == "plan":
        plan = read_json(iteration.plan_path)
        plan["prediction"] = state.get("prediction")
        plan["move_type"] = state.get("move_type")
        plan["why_now"] = state.get("why_now")
        plan["thesis"] = state.get("thesis")
        plan["antithesis"] = state.get("antithesis")
        plan["synthesis_candidate"] = state.get("synthesis_candidate")
        plan["active_tension_ids"] = active_tension_ids
        plan["active_tension_count"] = len(active_tension_ids)
        plan["tensions_path"] = _relative_to_session(iteration, iteration.tensions_dir)
        plan["transcendent_result_path"] = _relative_to_session(iteration, iteration.transcendent_dir / "result.json")
        write_json(iteration.plan_path, plan)
        return

    if stage == "result":
        result_payload = read_json(iteration.result_path)
        result_state = state.get("result") or {}
        result_payload["outcome"] = result_state.get("outcome")
        result_payload["contradicted_assumption"] = result_state.get("contradicted_assumption")
        result_payload["keep_discard_status"] = result_state.get("keep_discard_status")
        result_payload["framing_diagnosis"] = result_state.get("framing_diagnosis")
        result_payload["next_move_type"] = result_state.get("next_move_type")
        result_payload["summary_text"] = result_state.get("summary_text")
        result_payload["active_tension_ids"] = active_tension_ids
        result_payload["active_tension_count"] = len(active_tension_ids)
        result_payload["tensions_path"] = _relative_to_session(iteration, iteration.tensions_dir)
        result_payload["transcendent_result_path"] = _relative_to_session(iteration, iteration.transcendent_dir / "result.json")
        result_payload["transcendent_result"] = transcendent_payload
        write_json(iteration.result_path, result_payload)
        return

    raise RuntimeError(f"unsupported dialectical capture stage: {stage}")


def capture_execution_artifacts(
    iteration: IterationPaths,
    *,
    run_log_path: Path | None,
    telemetry_events_path: Path | None,
    relay_state_path: Path | None,
    summary: dict[str, Any],
    run_metadata: dict[str, Any],
    execution_ref: dict[str, Any],
) -> None:
    if run_log_path is not None and run_log_path.exists():
        copy2(run_log_path, iteration.execution_dir / "run.log")
    if telemetry_events_path is not None and telemetry_events_path.exists():
        copy2(telemetry_events_path, iteration.execution_dir / "live-events.ndjson")
    if relay_state_path is not None and relay_state_path.exists():
        copy2(relay_state_path, iteration.execution_dir / "relay-state.json")
    write_json(iteration.execution_dir / "summary.json", summary)
    write_json(iteration.execution_dir / "run-metadata.json", run_metadata)
    write_json(iteration.execution_dir / "execution-ref.json", execution_ref)


def finalize_iteration(
    iteration: IterationPaths,
    *,
    exit_code: int | None,
    summary: dict[str, Any] | None,
    status: str,
) -> None:
    now = iso_now()
    result = read_json(iteration.result_path)
    result["status"] = status
    result["completed_at"] = now
    result["exit_code"] = exit_code
    result["summary"] = summary or {}
    write_json(iteration.result_path, result)

    manifest = read_json(iteration.session.manifest_path)
    manifest["updated_at"] = now
    for entry in manifest.get("iterations", []):
        if int(entry["iteration"]) == iteration.iteration:
            entry["status"] = status
            entry["completed_at"] = now
            if summary:
                entry["summary"] = summary
            break
    write_json(iteration.session.manifest_path, manifest)
