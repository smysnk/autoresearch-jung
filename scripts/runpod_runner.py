#!/usr/bin/env python3
"""Launch, run, collect, and terminate autoresearch workloads on Runpod."""

from __future__ import annotations

import argparse
import json
import os
import posixpath
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from experiment_log import (
    append_live_event,
    capture_dialectical_state,
    capture_execution_artifacts,
    IterationPaths,
    bind_execution,
    bind_codex_phase_artifacts,
    clear_live_state,
    ensure_session_log,
    finalize_iteration,
    live_phase_dir,
    snapshot_tested_train_py,
    start_iteration,
    write_live_state,
)
from codex_agent import (
    CodexAgentConfig,
    ensure_codex_available,
    load_codex_agent_config,
    phase_output_paths,
    run_codex_phase,
)
from live_monitor import capture_codex_phase_artifacts, snapshot_phase_inputs


API_BASE = "https://rest.runpod.io/v1"
DEFAULT_CONFIG_PATH = "runpod.json"
DEFAULT_PROFILES_PATH = "profiles.json"
DEFAULT_IMAGE = "runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04"
DEFAULT_ENV_PATH = ".env"
REMOTE_LIVE_INPUT = "live/train-events.ndjson"
REMOTE_LIVE_EVENTS = "live/relay-events.ndjson"
REMOTE_LIVE_STATE = "live/relay-state.json"
REMOTE_LIVE_LOG = "live/relay.log"
SYNC_EXCLUDES = [
    ".git/",
    ".venv/",
    "__pycache__/",
    "*.pyc",
    "results.tsv",
    "research_journal.tsv",
    "run.log",
    "remote_runs/",
    "runpod_runs/*/artifacts/",
    "runpod_runs/*/logs/",
    "runpod_runs/*/metadata/",
    "runpod.json",
]
DEFAULT_ARTIFACTS = [
    "run.log",
    "results.tsv",
    "research_journal.tsv",
    REMOTE_LIVE_INPUT,
    REMOTE_LIVE_EVENTS,
    REMOTE_LIVE_STATE,
    REMOTE_LIVE_LOG,
]
TRACKED_REPORT_ARTIFACTS = [
    "run.log",
    "results.tsv",
]
EXTRA_REMOTE_FILES = [
    ".run.exitcode",
    ".run.pid",
    ".runpod_execute.stdout",
    ".runpod_execute.stderr",
]
SUMMARY_KEYS = [
    "val_bpb",
    "training_seconds",
    "total_seconds",
    "peak_vram_mb",
    "mfu_percent",
    "total_tokens_M",
    "num_steps",
    "num_params_M",
    "depth",
]
RUNPOD_GPU_MEMORY_GB = {
    "AMD Instinct MI300X OAM": 192,
    "NVIDIA A100 80GB PCIe": 80,
    "NVIDIA A100-SXM4-80GB": 80,
    "NVIDIA A30": 24,
    "NVIDIA A40": 48,
    "NVIDIA B200": 180,
    "NVIDIA B300 SXM6 AC": 288,
    "NVIDIA GeForce RTX 3070": 8,
    "NVIDIA GeForce RTX 3080": 10,
    "NVIDIA GeForce RTX 3080 Ti": 12,
    "NVIDIA GeForce RTX 3090": 24,
    "NVIDIA GeForce RTX 3090 Ti": 24,
    "NVIDIA GeForce RTX 4070 Ti": 12,
    "NVIDIA GeForce RTX 4080": 16,
    "NVIDIA GeForce RTX 4080 SUPER": 16,
    "NVIDIA GeForce RTX 4090": 24,
    "NVIDIA GeForce RTX 5080": 16,
    "NVIDIA GeForce RTX 5090": 32,
    "NVIDIA H100 80GB HBM3": 80,
    "NVIDIA H100 NVL": 94,
    "NVIDIA H100 PCIe": 80,
    "NVIDIA H200": 141,
    "NVIDIA H200 NVL": 143,
    "NVIDIA L4": 24,
    "NVIDIA L40": 48,
    "NVIDIA L40S": 48,
    "NVIDIA RTX 2000 Ada Generation": 16,
    "NVIDIA RTX 4000 Ada Generation": 20,
    "NVIDIA RTX 4000 SFF Ada Generation": 20,
    "NVIDIA RTX 5000 Ada Generation": 32,
    "NVIDIA RTX 6000 Ada Generation": 48,
    "NVIDIA RTX A2000": 6,
    "NVIDIA RTX A4000": 16,
    "NVIDIA RTX A4500": 20,
    "NVIDIA RTX A5000": 24,
    "NVIDIA RTX A6000": 48,
    "NVIDIA RTX PRO 4500 Blackwell": 32,
    "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition": 96,
    "NVIDIA RTX PRO 6000 Blackwell Server Edition": 96,
    "NVIDIA RTX PRO 6000 Blackwell Workstation Edition": 96,
    "Tesla V100-PCIE-16GB": 16,
    "Tesla V100-SXM2-16GB": 16,
    "Tesla V100-SXM2-32GB": 32,
    "Tesla V100-FHHL-16GB": 16,
}
PROFILE_PRESETS_PATH: Path | None = None
RUN_PROFILE_PRESETS: dict[int, "RunProfilePreset"] = {}


def parse_positive_int(name: str, raw_value: Any, *, default: int | None = None) -> int:
    if raw_value in (None, ""):
        if default is None:
            raise SystemExit(f"{name} is required")
        return default
    try:
        value = int(raw_value)
    except (TypeError, ValueError) as exc:
        raise SystemExit(f"{name} must be a positive integer, got {raw_value!r}") from exc
    if value < 1:
        raise SystemExit(f"{name} must be >= 1, got {value}")
    return value


@dataclass
class GPURequirements:
    min_memory_gb: int | None = None
    max_memory_gb: int | None = None
    preferred_gpu_type_ids: list[str] = field(default_factory=list)
    excluded_gpu_type_ids: list[str] = field(default_factory=list)
    order: str = "memory-asc"

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "GPURequirements":
        data = data or {}
        return cls(
            min_memory_gb=int(data["min_memory_gb"]) if data.get("min_memory_gb") is not None else None,
            max_memory_gb=int(data["max_memory_gb"]) if data.get("max_memory_gb") is not None else None,
            preferred_gpu_type_ids=list(data.get("preferred_gpu_type_ids", [])),
            excluded_gpu_type_ids=list(data.get("excluded_gpu_type_ids", [])),
            order=data.get("order", "memory-asc"),
        )

    def is_active(self) -> bool:
        return any(
            [
                self.min_memory_gb is not None,
                self.max_memory_gb is not None,
                bool(self.preferred_gpu_type_ids),
                bool(self.excluded_gpu_type_ids),
            ]
        )


@dataclass
class GPUValueHeuristic:
    min_price_per_gpu_hour: float | None = None
    max_price_per_gpu_hour: float | None = None
    min_memory_gb: int | None = None
    max_memory_gb: int | None = None
    preferred_gpu_type_ids: list[str] = field(default_factory=list)
    excluded_gpu_type_ids: list[str] = field(default_factory=list)
    stock_weight: float = 0.55
    price_weight: float = 0.30
    memory_weight: float = 0.15

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "GPUValueHeuristic":
        data = data or {}
        return cls(
            min_price_per_gpu_hour=float(data["min_price_per_gpu_hour"]) if data.get("min_price_per_gpu_hour") is not None else None,
            max_price_per_gpu_hour=float(data["max_price_per_gpu_hour"]) if data.get("max_price_per_gpu_hour") is not None else None,
            min_memory_gb=int(data["min_memory_gb"]) if data.get("min_memory_gb") is not None else None,
            max_memory_gb=int(data["max_memory_gb"]) if data.get("max_memory_gb") is not None else None,
            preferred_gpu_type_ids=list(data.get("preferred_gpu_type_ids", [])),
            excluded_gpu_type_ids=list(data.get("excluded_gpu_type_ids", [])),
            stock_weight=float(data.get("stock_weight", 0.55)),
            price_weight=float(data.get("price_weight", 0.30)),
            memory_weight=float(data.get("memory_weight", 0.15)),
        )

    def is_active(self) -> bool:
        return any(
            [
                self.min_price_per_gpu_hour is not None,
                self.max_price_per_gpu_hour is not None,
                self.min_memory_gb is not None,
                self.max_memory_gb is not None,
                bool(self.preferred_gpu_type_ids),
                bool(self.excluded_gpu_type_ids),
            ]
        )


@dataclass(frozen=True)
class RunProfilePreset:
    profile_id: int
    name: str
    description: str
    rationale: str
    gpu_value_heuristic: GPUValueHeuristic
    min_ram_per_gpu_gb: int
    min_vcpu_per_gpu: int
    gpu_type_priority: str = "custom"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "RunProfilePreset":
        return cls(
            profile_id=int(data["profile_id"]),
            name=str(data["name"]),
            description=str(data["description"]),
            rationale=str(data["rationale"]),
            gpu_value_heuristic=GPUValueHeuristic.from_dict(data.get("gpu_value_heuristic")),
            min_ram_per_gpu_gb=int(data["min_ram_per_gpu_gb"]),
            min_vcpu_per_gpu=int(data["min_vcpu_per_gpu"]),
            gpu_type_priority=str(data.get("gpu_type_priority", "custom")),
        )


@dataclass
class RunpodConfig:
    api_key: str
    ssh_private_key: str
    repo_url: str
    repo_push_target: str
    profile: int | None = None
    experiment_count: int = 1
    name_prefix: str = "autoresearch"
    image_name: str = DEFAULT_IMAGE
    gpu_type_ids: list[str] = field(default_factory=list)
    gpu_requirements: GPURequirements = field(default_factory=GPURequirements)
    gpu_value_heuristic: GPUValueHeuristic = field(default_factory=GPUValueHeuristic)
    gpu_type_priority: str = "availability"
    gpu_count: int = 1
    cloud_type: str = "SECURE"
    interruptible: bool = False
    support_public_ip: bool = True
    container_disk_gb: int = 50
    volume_gb: int = 0
    allowed_cuda_versions: list[str] = field(default_factory=lambda: ["12.8"])
    min_ram_per_gpu_gb: int | None = None
    min_vcpu_per_gpu: int | None = None
    ports: list[str] = field(default_factory=lambda: ["22/tcp"])
    relay_port: int = 8765
    ssh_user: str = "root"
    remote_base_dir: str = "/root/autoresearch"
    prepare_num_shards: int = 10
    poll_interval_seconds: int = 15
    pod_ready_timeout_seconds: int = 1800
    ssh_ready_timeout_seconds: int = 900
    run_command: str = ".venv/bin/python train.py > run.log 2>&1"
    collect_artifacts: list[str] = field(default_factory=lambda: DEFAULT_ARTIFACTS.copy())

    @classmethod
    def from_sources(cls, path: Path, repo_root: Path) -> "RunpodConfig":
        data: dict[str, Any] = {}
        if path.exists():
            data = json.loads(path.read_text())
        api_key = os.environ.get("RUNPOD_API_KEY") or data.get("api_key", "")
        ssh_private_key = resolve_private_key_path(
            os.environ.get("RUNPOD_SSH_PRIVATE_KEY") or data.get("ssh_private_key", "~/.ssh/id_ed25519"),
            env_name="RUNPOD_SSH_PRIVATE_KEY",
        )
        repo_value = os.environ.get("AUTORESEARCH_REPO") or data.get("repo")
        repo_url = normalize_repo_url(repo_root, repo_value, prefer_ssh=False)
        repo_push_target = resolve_push_target(repo_root, repo_value, prefer_ssh=ssh_private_key is not None)
        profile_raw = os.environ.get("RUNPOD_PROFILE")
        if profile_raw is None:
            profile_raw = data.get("profile")
        profile = int(profile_raw) if profile_raw not in (None, "") else None
        experiment_count = parse_positive_int(
            "RUNPOD_EXPERIMENT_COUNT",
            os.environ.get("RUNPOD_EXPERIMENT_COUNT", data.get("experiment_count")),
            default=1,
        )
        if not api_key:
            raise SystemExit("RUNPOD_API_KEY is required (env var or runpod.json)")
        if not ssh_private_key:
            raise SystemExit("RUNPOD_SSH_PRIVATE_KEY is required (env var or runpod.json ssh_private_key)")
        cfg = cls(
            api_key=api_key,
            ssh_private_key=ssh_private_key,
            repo_url=repo_url,
            repo_push_target=repo_push_target,
            profile=profile,
            experiment_count=experiment_count,
            name_prefix=data.get("name_prefix", cls.name_prefix),
            image_name=data.get("image_name", DEFAULT_IMAGE),
            gpu_type_ids=list(data.get("gpu_type_ids", [])),
            gpu_requirements=GPURequirements.from_dict(data.get("gpu_requirements")),
            gpu_value_heuristic=GPUValueHeuristic.from_dict(data.get("gpu_value_heuristic")),
            gpu_type_priority=data.get("gpu_type_priority", "availability"),
            gpu_count=int(data.get("gpu_count", 1)),
            cloud_type=data.get("cloud_type", "SECURE"),
            interruptible=bool(data.get("interruptible", False)),
            support_public_ip=bool(data.get("support_public_ip", True)),
            container_disk_gb=int(data.get("container_disk_gb", 50)),
            volume_gb=int(data.get("volume_gb", 0)),
            allowed_cuda_versions=list(data.get("allowed_cuda_versions", ["12.8"])),
            min_ram_per_gpu_gb=int(data["min_ram_per_gpu_gb"]) if data.get("min_ram_per_gpu_gb") is not None else None,
            min_vcpu_per_gpu=int(data["min_vcpu_per_gpu"]) if data.get("min_vcpu_per_gpu") is not None else None,
            ports=list(data.get("ports", ["22/tcp"])),
            relay_port=int(data.get("relay_port", 8765)),
            ssh_user=data.get("ssh_user", "root"),
            remote_base_dir=data.get("remote_base_dir", "/root/autoresearch"),
            prepare_num_shards=int(data.get("prepare_num_shards", 10)),
            poll_interval_seconds=int(data.get("poll_interval_seconds", 15)),
            pod_ready_timeout_seconds=int(data.get("pod_ready_timeout_seconds", 1800)),
            ssh_ready_timeout_seconds=int(data.get("ssh_ready_timeout_seconds", 900)),
            run_command=data.get("run_command", ".venv/bin/python train.py > run.log 2>&1"),
            collect_artifacts=list(data.get("collect_artifacts", DEFAULT_ARTIFACTS)),
        )
        if cfg.profile is not None:
            apply_profile(cfg, cfg.profile)
        return cfg

    def redacted(self) -> dict[str, Any]:
        data = asdict(self)
        data["api_key"] = "<set>"
        data["ssh_private_key"] = "<set>"
        return data


@dataclass
class SSHConnection:
    host: str
    port: int
    user: str
    key_path: Path


@dataclass
class ExecutionPaths:
    execution_dir: Path
    metadata_dir: Path
    logs_dir: Path
    artifacts_dir: Path
    reports_dir: Path


@dataclass
class PodSession:
    client: "RunpodClient"
    pod_id: str
    conn: SSHConnection
    remote_repo_dir: str
    gpu_type_ids: list[str]
    gpu_type_priority: str
    payload: dict[str, Any]
    created_pod: dict[str, Any]
    ready_pod: dict[str, Any]
    selected_gpu_type: str | None = None
    gpu_candidates: Any | None = None


class RunpodClient:
    def __init__(self, api_key: str):
        self.api_key = api_key

    def request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = API_BASE + path
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Runpod API {method} {path} failed: {exc.code} {detail}") from exc
        if not body:
            return {}
        return json.loads(body)

    def graphql(self, query: str) -> dict[str, Any]:
        url = "https://api.runpod.io/graphql?api_key=" + urllib.parse.quote(self.api_key, safe="")
        req = urllib.request.Request(
            url,
            data=json.dumps({"query": query}).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"Runpod GraphQL failed: {exc.code} {detail}") from exc
        data = json.loads(body)
        if "errors" in data:
            raise RuntimeError(f"Runpod GraphQL returned errors: {data['errors']}")
        return data

    def create_pod(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/pods", payload)

    def get_pod(self, pod_id: str) -> dict[str, Any]:
        return self.request("GET", f"/pods/{pod_id}")

    def terminate_pod(self, pod_id: str) -> dict[str, Any]:
        return self.request("DELETE", f"/pods/{pod_id}")


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        os.environ.setdefault(key, value)


def load_profile_presets(path: Path) -> dict[int, RunProfilePreset]:
    if not path.exists():
        raise SystemExit(f"Runpod profile file not found: {path}")
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise SystemExit(f"Runpod profile file must be a JSON object keyed by profile number: {path}")

    presets: dict[int, RunProfilePreset] = {}
    for key, value in raw.items():
        if not isinstance(value, dict):
            raise SystemExit(f"Profile {key!r} in {path} must be a JSON object")
        profile_id = int(key)
        preset = RunProfilePreset.from_dict(value)
        if preset.profile_id != profile_id:
            raise SystemExit(
                f"Profile key {profile_id} in {path} does not match embedded profile_id={preset.profile_id}"
            )
        presets[profile_id] = preset
    if not presets:
        raise SystemExit(f"No Runpod profiles found in {path}")
    return presets


def ensure_profile_presets_loaded() -> None:
    global RUN_PROFILE_PRESETS
    if RUN_PROFILE_PRESETS:
        return
    if PROFILE_PRESETS_PATH is None:
        raise SystemExit("Runpod profile path is not initialized")
    RUN_PROFILE_PRESETS = load_profile_presets(PROFILE_PRESETS_PATH)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_now() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def timestamp_slug() -> str:
    return utc_now().strftime("%Y%m%dT%H%M%SZ")


def slugify(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-").lower()


def ensure_tool(name: str) -> None:
    if shutil.which(name) is None:
        raise SystemExit(f"Required tool not found on PATH: {name}")


def make_execution_paths(repo_root: Path, prefix: str) -> ExecutionPaths:
    execution_id = f"{timestamp_slug()}-{slugify(prefix)}"
    execution_dir = repo_root / "runpod_runs" / execution_id
    metadata_dir = execution_dir / "metadata"
    logs_dir = execution_dir / "logs"
    artifacts_dir = execution_dir / "artifacts"
    reports_dir = execution_dir / "reports"
    for path in (execution_dir, metadata_dir, logs_dir, artifacts_dir, reports_dir):
        path.mkdir(parents=True, exist_ok=True)
    return ExecutionPaths(execution_dir, metadata_dir, logs_dir, artifacts_dir, reports_dir)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    return json.loads(path.read_text())


def append_jsonl(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(data, sort_keys=True) + "\n")


def append_log(path: Path, message: str) -> None:
    stamp = iso_now()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(f"[{stamp}] {message}\n")
    print(message)


def copy_if_exists(src: Path, dest: Path) -> None:
    if not src.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)


def profile_name(profile_id: int | None) -> str | None:
    if profile_id is None:
        return None
    return get_profile_preset(profile_id).name


def write_execution_metadata(paths: ExecutionPaths, cfg: RunpodConfig, *, branch: str, experiment_index: int) -> None:
    write_json(paths.metadata_dir / "config.effective.json", cfg.redacted())
    write_json(
        paths.metadata_dir / "git-branch.json",
        {
            "branch": branch,
            "experiment_index": experiment_index,
        },
    )


def write_gpu_selection_metadata(
    paths: ExecutionPaths,
    cfg: RunpodConfig,
    *,
    gpu_type_ids: list[str],
    gpu_type_priority: str,
) -> None:
    write_json(
        paths.metadata_dir / "gpu-selection.json",
        {
            "profile": cfg.profile,
            "profile_name": profile_name(cfg.profile),
            "gpu_type_ids": gpu_type_ids,
            "gpu_type_priority": gpu_type_priority,
        },
    )
    if cfg.profile is not None:
        write_json(paths.metadata_dir / "profile.json", asdict(get_profile_preset(cfg.profile)))


def write_pod_session_metadata(paths: ExecutionPaths, cfg: RunpodConfig, pod_session: PodSession) -> None:
    write_gpu_selection_metadata(
        paths,
        cfg,
        gpu_type_ids=pod_session.gpu_type_ids,
        gpu_type_priority=pod_session.gpu_type_priority,
    )
    if pod_session.gpu_candidates is not None:
        write_json(paths.metadata_dir / "gpu-candidates.json", pod_session.gpu_candidates)
    write_json(paths.metadata_dir / "pod-create-request.json", pod_session.payload)
    write_json(paths.metadata_dir / "pod-created.json", pod_session.created_pod)
    write_json(paths.metadata_dir / "pod-ready.json", pod_session.ready_pod)
    write_json(
        paths.metadata_dir / "pod-session.json",
        {
            "pod_id": pod_session.pod_id,
            "remote_repo_dir": pod_session.remote_repo_dir,
            "selected_gpu_type": pod_session.selected_gpu_type,
        },
    )
    append_jsonl(paths.metadata_dir / "pod-status-history.ndjson", {"timestamp": iso_now(), "pod": pod_session.ready_pod})


def write_tracked_reports(
    paths: ExecutionPaths,
    *,
    branch: str,
    experiment_index: int,
    cfg: RunpodConfig,
    gpu_type_ids: list[str],
    gpu_type_priority: str,
    selected_gpu_type: str | None,
    cost_per_hr: float | int | str | None,
    exit_code: int,
    summary: dict[str, str],
) -> None:
    for rel_path in TRACKED_REPORT_ARTIFACTS:
        copy_if_exists(paths.artifacts_dir / rel_path, paths.reports_dir / Path(rel_path).name)
    write_json(paths.reports_dir / "summary.json", summary)
    write_json(
        paths.reports_dir / "run-metadata.json",
        {
            "execution_id": paths.execution_dir.name,
            "branch": branch,
            "experiment_index": experiment_index,
            "profile": cfg.profile,
            "profile_name": profile_name(cfg.profile),
            "gpu_type_ids": gpu_type_ids,
            "gpu_type_priority": gpu_type_priority,
            "selected_gpu_type": selected_gpu_type,
            "cost_per_hr": cost_per_hr,
            "exit_code": exit_code,
            "metrics": summary,
        },
    )


def build_live_state_payload(
    *,
    session_id: str,
    branch: str,
    runner_mode: str,
    phase: str,
    status: str,
    experiment_index: int,
    experiment_count: int,
    iteration_label: str,
    execution_dir: Path | None,
    run_log_path: Path | None,
    telemetry_events_path: Path | None = None,
    relay_state_path: Path | None = None,
    relay_ws_url: str | None = None,
    prepare_manifest: dict[str, Any] | None = None,
    reflect_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "session_id": session_id,
        "branch": branch,
        "runner_mode": runner_mode,
        "is_active": status not in {"completed", "failed", "aborted"},
        "phase": phase,
        "status": status,
        "experiment_index": experiment_index,
        "experiment_count": experiment_count,
        "current_iteration_label": iteration_label,
        "execution_id": execution_dir.name if execution_dir is not None else None,
        "execution_dir": str(execution_dir) if execution_dir is not None else None,
        "run_log_path": str(run_log_path) if run_log_path is not None else None,
        "telemetry_events_path": str(telemetry_events_path) if telemetry_events_path is not None else None,
        "relay_state_path": str(relay_state_path) if relay_state_path is not None else None,
        "relay_ws_url": relay_ws_url,
        "prepare": prepare_manifest,
        "reflect": reflect_manifest,
        "updated_at": iso_now(),
    }


def effective_ports(cfg: RunpodConfig) -> list[str]:
    ports = list(cfg.ports)
    relay_port_spec = f"{cfg.relay_port}/tcp"
    if relay_port_spec not in ports:
        ports.append(relay_port_spec)
    return ports


def effective_artifacts(artifacts: list[str]) -> list[str]:
    merged: list[str] = []
    for rel_path in [*artifacts, REMOTE_LIVE_INPUT, REMOTE_LIVE_EVENTS, REMOTE_LIVE_STATE, REMOTE_LIVE_LOG]:
        if rel_path not in merged:
            merged.append(rel_path)
    return merged


def ssh_base_args(conn: SSHConnection) -> list[str]:
    return [
        "-i",
        str(conn.key_path),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-p",
        str(conn.port),
    ]


def scp_base_args(conn: SSHConnection) -> list[str]:
    return [
        "-i",
        str(conn.key_path),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-P",
        str(conn.port),
    ]


def run_local(
    cmd: list[str],
    *,
    cwd: Path,
    check: bool = True,
    stdout=None,
    stderr=None,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, check=check, stdout=stdout, stderr=stderr, env=env)


def git_stdout(repo_root: Path, args: list[str], *, check: bool = True) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=check,
    )
    return result.stdout.strip()


def current_branch(repo_root: Path) -> str:
    return git_stdout(repo_root, ["branch", "--show-current"])


def git_config_value(repo_root: Path, key: str) -> str:
    return git_stdout(repo_root, ["config", "--get", key], check=False)


def resolve_private_key_path(raw_value: str | None, *, env_name: str) -> str | None:
    if raw_value in (None, ""):
        return None
    path = Path(raw_value).expanduser()
    if not path.exists():
        raise SystemExit(f"{env_name} does not exist: {path}")
    if not path.is_file():
        raise SystemExit(f"{env_name} must point to a file: {path}")
    return str(path)


def build_git_env(private_key_path: str | None) -> dict[str, str] | None:
    if private_key_path is None:
        return None
    env = os.environ.copy()
    env["GIT_SSH_COMMAND"] = (
        f"ssh -i {shlex.quote(private_key_path)} "
        "-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    )
    return env


def normalize_repo_url(repo_root: Path, repo_value: str | None, *, prefer_ssh: bool = False) -> str:
    candidate = (repo_value or git_config_value(repo_root, "remote.origin.url")).strip()
    if not candidate:
        raise SystemExit("AUTORESEARCH_REPO is required when remote.origin.url is not configured")
    github_slug = re.fullmatch(r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", candidate)
    if github_slug:
        slug = github_slug.group(1)
        return f"git@github.com:{slug}.git" if prefer_ssh else f"https://github.com/{slug}.git"
    github_ssh = re.fullmatch(r"git@github\.com:([^/]+/[^/]+?)(?:\.git)?", candidate)
    if github_ssh:
        slug = github_ssh.group(1)
        return f"git@github.com:{slug}.git" if prefer_ssh else f"https://github.com/{slug}.git"
    github_https = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?", candidate)
    if github_https:
        slug = github_https.group(1)
        return f"git@github.com:{slug}.git" if prefer_ssh else f"https://github.com/{slug}.git"
    return candidate


def resolve_push_target(repo_root: Path, repo_value: str | None, *, prefer_ssh: bool = False) -> str:
    candidate = (repo_value or "").strip()
    if not candidate:
        if not prefer_ssh:
            return "origin"
        candidate = git_config_value(repo_root, "remote.origin.url").strip()
    if not candidate:
        return "origin"
    github_slug = re.fullmatch(r"([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)", candidate)
    if github_slug:
        return f"git@github.com:{github_slug.group(1)}.git"
    github_ssh = re.fullmatch(r"git@github\.com:([^/]+/[^/]+?)(?:\.git)?", candidate)
    if github_ssh:
        return f"git@github.com:{github_ssh.group(1)}.git"
    github_https = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?", candidate)
    if github_https:
        return f"git@github.com:{github_https.group(1)}.git"
    return candidate


def branch_exists(repo_root: Path, branch: str) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", branch],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return result.returncode == 0


def experiment_tag(now: datetime | None = None) -> str:
    now = now or datetime.now().astimezone()
    return f"{now.strftime('%b').lower()}{now.day}-{now.strftime('%H%M')}"


def ensure_experiment_branch(repo_root: Path) -> str:
    prefix = "codex/transcendent/fn-"
    branch = current_branch(repo_root)
    if branch.startswith(prefix):
        return branch

    base = f"{prefix}{experiment_tag()}"
    candidate = base
    suffix = 2
    while branch_exists(repo_root, candidate):
        candidate = f"{base}-{suffix}"
        suffix += 1
    run_local(["git", "switch", "-c", candidate], cwd=repo_root)
    return candidate


def has_nonignored_changes(repo_root: Path) -> bool:
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=True,
    )
    return bool(result.stdout.strip())


def commit_nonignored_changes(repo_root: Path, message: str) -> str | None:
    if not has_nonignored_changes(repo_root):
        return None
    run_local(["git", "add", "-A"], cwd=repo_root)
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo_root,
        text=True,
        check=False,
    )
    if diff.returncode == 0:
        return None
    run_local(["git", "commit", "-m", message], cwd=repo_root)
    return git_stdout(repo_root, ["rev-parse", "--short", "HEAD"])


def push_repo(repo_root: Path, log_path: Path, push_target: str, private_key_path: str | None) -> None:
    branch = current_branch(repo_root)
    if not branch:
        raise SystemExit("Auto-push requires an active git branch; detached HEAD is not supported")
    append_log(log_path, f"pushing branch {branch} to {push_target}")
    cmd = ["git", "push"]
    if push_target == "origin":
        cmd.append("--set-upstream")
    cmd.extend([push_target, f"HEAD:refs/heads/{branch}"])
    run_local(cmd, cwd=repo_root, env=build_git_env(private_key_path))


def run_ssh(conn: SSHConnection, script: str, *, check: bool = True, capture_output: bool = False) -> subprocess.CompletedProcess[str]:
    cmd = ["ssh", *ssh_base_args(conn), f"{conn.user}@{conn.host}", "bash -s"]
    return subprocess.run(cmd, input=script, text=True, check=check, capture_output=capture_output)


def run_scp(conn: SSHConnection, remote_path: str, local_path: Path, *, recursive: bool = False) -> subprocess.CompletedProcess[str]:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["scp", *scp_base_args(conn)]
    if recursive:
        cmd.append("-r")
    cmd.extend([f"{conn.user}@{conn.host}:{remote_path}", str(local_path)])
    return subprocess.run(cmd, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def deploy_clone_to_remote(
    repo_root: Path,
    conn: SSHConnection,
    remote_repo_dir: str,
    branch: str,
    repo_url: str,
) -> None:
    remote_dir = remote_repo_dir.rstrip("/")
    parent_dir = posixpath.dirname(remote_dir) or "."
    git_name = git_config_value(repo_root, "user.name") or "autoresearch"
    git_email = git_config_value(repo_root, "user.email") or "autoresearch@localhost"
    script = f"""
set -euo pipefail
repo_dir={json.dumps(remote_dir)}
parent_dir={json.dumps(parent_dir)}
repo_url={json.dumps(repo_url)}
branch_name={json.dumps(branch)}
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y git
  else
    echo "git is required on the remote host" >&2
    exit 1
  fi
fi
mkdir -p "$parent_dir"
if [ -d "$repo_dir/.git" ]; then
  git -C "$repo_dir" remote set-url origin "$repo_url"
  git -C "$repo_dir" fetch origin "$branch_name"
  git -C "$repo_dir" checkout -B "$branch_name" FETCH_HEAD
  git -C "$repo_dir" reset --hard FETCH_HEAD
  git -C "$repo_dir" clean -fd -e .venv/
else
  rm -rf "$repo_dir"
  git clone --branch "$branch_name" "$repo_url" "$repo_dir"
fi
git -C "$repo_dir" config user.name {json.dumps(git_name)}
git -C "$repo_dir" config user.email {json.dumps(git_email)}
"""
    run_ssh(conn, script)


def get_profile_preset(profile_id: int) -> RunProfilePreset:
    ensure_profile_presets_loaded()
    preset = RUN_PROFILE_PRESETS.get(profile_id)
    if preset is None:
        raise SystemExit(f"Unknown RUNPOD profile: {profile_id}. Available profiles: {sorted(RUN_PROFILE_PRESETS)}")
    return preset


def apply_profile(cfg: RunpodConfig, profile_id: int) -> None:
    preset = get_profile_preset(profile_id)
    cfg.profile = profile_id
    cfg.gpu_type_ids = []
    cfg.gpu_requirements = GPURequirements()
    cfg.gpu_value_heuristic = GPUValueHeuristic(**asdict(preset.gpu_value_heuristic))
    cfg.gpu_type_priority = preset.gpu_type_priority
    cfg.min_ram_per_gpu_gb = preset.min_ram_per_gpu_gb
    cfg.min_vcpu_per_gpu = preset.min_vcpu_per_gpu


def quote_graphql_string(value: str) -> str:
    return json.dumps(value)


def fetch_gpu_market_snapshot(client: RunpodClient, cfg: RunpodConfig, gpu_type_id: str) -> dict[str, Any] | None:
    secure_cloud = "true" if cfg.cloud_type == "SECURE" else "false"
    min_disk = max(cfg.container_disk_gb, 0)
    min_memory = cfg.min_ram_per_gpu_gb if cfg.min_ram_per_gpu_gb is not None else 8
    min_vcpu = cfg.min_vcpu_per_gpu if cfg.min_vcpu_per_gpu is not None else 2
    query = f"""
query {{
  gpuTypes(input: {{ id: {quote_graphql_string(gpu_type_id)} }}) {{
    id
    displayName
    memoryInGb
    lowestPrice(input: {{
      compliance: null,
      dataCenterId: null,
      globalNetwork: false,
      gpuCount: {cfg.gpu_count},
      minDisk: {min_disk},
      minMemoryInGb: {min_memory},
      minVcpuCount: {min_vcpu},
      secureCloud: {secure_cloud}
    }}) {{
      minimumBidPrice
      uninterruptablePrice
      minVcpu
      minMemory
      stockStatus
      compliance
      maxUnreservedGpuCount
      availableGpuCounts
    }}
  }}
}}
"""
    response = client.graphql(query)
    gpu_types = ((response.get("data") or {}).get("gpuTypes")) or []
    return gpu_types[0] if gpu_types else None


def normalize(value: float, low: float, high: float, *, invert: bool = False) -> float:
    if high <= low:
        return 1.0
    score = (value - low) / (high - low)
    score = max(0.0, min(1.0, score))
    return 1.0 - score if invert else score


def stock_score(stock_status: str | None, max_unreserved_gpu_count: int | None) -> float:
    base = {
        "HIGH": 1.0,
        "MEDIUM": 0.7,
        "LOW": 0.35,
    }.get((stock_status or "").upper(), 0.5)
    if max_unreserved_gpu_count is None:
        return base
    bonus = min(max_unreserved_gpu_count, 8) / 8.0
    return max(0.0, min(1.0, 0.7 * base + 0.3 * bonus))


def memory_fit_score(memory_gb: float, heuristic: GPUValueHeuristic, cohort: list[dict[str, Any]]) -> float:
    if not cohort:
        return 1.0
    cohort_memories = [candidate["memory_gb"] for candidate in cohort]
    cohort_low, cohort_high = min(cohort_memories), max(cohort_memories)
    if heuristic.min_memory_gb is not None and heuristic.max_memory_gb is not None:
        target = (heuristic.min_memory_gb + heuristic.max_memory_gb) / 2.0
        distance = abs(memory_gb - target)
        max_distance = max(abs(cohort_low - target), abs(cohort_high - target), 1.0)
        return 1.0 - min(distance / max_distance, 1.0)
    if heuristic.min_memory_gb is not None:
        target = float(heuristic.min_memory_gb)
        return normalize(memory_gb, target, max(cohort_high, target + 1.0), invert=True)
    if heuristic.max_memory_gb is not None:
        target = float(heuristic.max_memory_gb)
        return normalize(memory_gb, min(cohort_low, target - 1.0), target, invert=False)
    return 1.0


def resolve_gpu_type_ids_from_value_heuristic(client: RunpodClient, cfg: RunpodConfig, paths: ExecutionPaths) -> list[str]:
    heuristic = cfg.gpu_value_heuristic
    preferred = list(heuristic.preferred_gpu_type_ids)
    excluded = set(heuristic.excluded_gpu_type_ids)
    unknown = [gpu_type for gpu_type in preferred + list(excluded) if gpu_type not in RUNPOD_GPU_MEMORY_GB]
    if unknown:
        raise SystemExit(f"Unknown gpu_value_heuristic GPU type ids: {unknown}")

    candidates = []
    for gpu_type_id, memory_gb in RUNPOD_GPU_MEMORY_GB.items():
        if heuristic.min_memory_gb is not None and memory_gb < heuristic.min_memory_gb:
            continue
        if heuristic.max_memory_gb is not None and memory_gb > heuristic.max_memory_gb:
            continue
        if gpu_type_id in excluded:
            continue
        market = fetch_gpu_market_snapshot(client, cfg, gpu_type_id)
        if market is None:
            continue
        lowest = market.get("lowestPrice") or {}
        if not lowest:
            continue
        available_counts = [int(count) for count in lowest.get("availableGpuCounts") or []]
        if cfg.gpu_count not in available_counts:
            continue
        effective_price = lowest.get("minimumBidPrice") if cfg.interruptible else lowest.get("uninterruptablePrice")
        if effective_price is None:
            continue
        effective_price = float(effective_price)
        if heuristic.min_price_per_gpu_hour is not None and effective_price < heuristic.min_price_per_gpu_hour:
            continue
        if heuristic.max_price_per_gpu_hour is not None and effective_price > heuristic.max_price_per_gpu_hour:
            continue
        candidates.append(
            {
                "gpu_type_id": gpu_type_id,
                "display_name": market.get("displayName") or gpu_type_id,
                "memory_gb": float(market.get("memoryInGb") or RUNPOD_GPU_MEMORY_GB[gpu_type_id]),
                "effective_price_per_gpu_hour": effective_price,
                "stock_status": lowest.get("stockStatus"),
                "max_unreserved_gpu_count": lowest.get("maxUnreservedGpuCount"),
                "available_gpu_counts": available_counts,
                "min_vcpu": lowest.get("minVcpu"),
                "min_memory": lowest.get("minMemory"),
            }
        )
    if not candidates:
        raise SystemExit("gpu_value_heuristic did not match any currently available Runpod GPU types")

    prices = [candidate["effective_price_per_gpu_hour"] for candidate in candidates]
    price_low, price_high = min(prices), max(prices)
    for candidate in candidates:
        candidate["stock_score"] = stock_score(candidate["stock_status"], candidate["max_unreserved_gpu_count"])
        candidate["price_score"] = normalize(candidate["effective_price_per_gpu_hour"], price_low, price_high, invert=True)
        candidate["memory_score"] = memory_fit_score(candidate["memory_gb"], heuristic, candidates)
        preferred_bonus = 0.05 if candidate["gpu_type_id"] in preferred else 0.0
        candidate["value_score"] = (
            heuristic.stock_weight * candidate["stock_score"]
            + heuristic.price_weight * candidate["price_score"]
            + heuristic.memory_weight * candidate["memory_score"]
            + preferred_bonus
        )

    candidates.sort(
        key=lambda candidate: (
            candidate["value_score"],
            candidate["stock_score"],
            -candidate["effective_price_per_gpu_hour"],
        ),
        reverse=True,
    )
    write_json(
        paths.metadata_dir / "gpu-candidates.json",
        {
            "heuristic": asdict(heuristic),
            "interruptible": cfg.interruptible,
            "cloud_type": cfg.cloud_type,
            "gpu_count": cfg.gpu_count,
            "candidates": candidates,
        },
    )
    return [candidate["gpu_type_id"] for candidate in candidates]


def resolve_gpu_type_ids_from_catalog_fallback(
    cfg: RunpodConfig,
    paths: ExecutionPaths,
    *,
    reason: str,
) -> list[str]:
    heuristic = cfg.gpu_value_heuristic
    preferred = list(heuristic.preferred_gpu_type_ids)
    preferred_ranks = {gpu_type_id: index for index, gpu_type_id in enumerate(preferred)}
    excluded = set(heuristic.excluded_gpu_type_ids)
    unknown = [gpu_type for gpu_type in preferred + list(excluded) if gpu_type not in RUNPOD_GPU_MEMORY_GB]
    if unknown:
        raise SystemExit(f"Unknown gpu_value_heuristic GPU type ids: {unknown}")

    candidates: list[dict[str, Any]] = []
    for gpu_type_id, memory_gb in RUNPOD_GPU_MEMORY_GB.items():
        if heuristic.min_memory_gb is not None and memory_gb < heuristic.min_memory_gb:
            continue
        if heuristic.max_memory_gb is not None and memory_gb > heuristic.max_memory_gb:
            continue
        if gpu_type_id in excluded:
            continue
        candidates.append(
            {
                "gpu_type_id": gpu_type_id,
                "memory_gb": float(memory_gb),
                "preferred_rank": preferred_ranks.get(gpu_type_id),
            }
        )
    if not candidates:
        raise SystemExit("gpu_value_heuristic fallback did not match any known Runpod GPU types")

    for candidate in candidates:
        candidate["memory_score"] = memory_fit_score(candidate["memory_gb"], heuristic, candidates)

    preferred_candidates = sorted(
        [candidate for candidate in candidates if candidate["preferred_rank"] is not None],
        key=lambda candidate: candidate["preferred_rank"],
    )
    remaining_candidates = sorted(
        [candidate for candidate in candidates if candidate["preferred_rank"] is None],
        key=lambda candidate: (
            -candidate["memory_score"],
            candidate["memory_gb"],
            candidate["gpu_type_id"],
        ),
    )
    ordered_candidates = preferred_candidates + remaining_candidates
    for index, candidate in enumerate(ordered_candidates, start=1):
        candidate["selection_rank"] = index

    write_json(
        paths.metadata_dir / "gpu-candidates.json",
        {
            "mode": "catalog-fallback",
            "reason": reason,
            "warning": (
                "Using REST-only catalog ordering because the live Runpod GraphQL market lookup was unavailable. "
                "Memory filters and preferred ordering were applied, but current price and stock filters were not."
            ),
            "heuristic": asdict(heuristic),
            "interruptible": cfg.interruptible,
            "cloud_type": cfg.cloud_type,
            "gpu_count": cfg.gpu_count,
            "candidates": ordered_candidates,
        },
    )
    return [candidate["gpu_type_id"] for candidate in ordered_candidates]


def resolve_gpu_type_ids(cfg: RunpodConfig) -> list[str]:
    if cfg.gpu_type_ids:
        return list(cfg.gpu_type_ids)

    req = cfg.gpu_requirements
    if not req.is_active():
        return []
    if req.order not in {"memory-asc", "memory-desc"}:
        raise SystemExit("gpu_requirements.order must be 'memory-asc' or 'memory-desc'")

    excluded = set(req.excluded_gpu_type_ids)
    preferred = list(req.preferred_gpu_type_ids)
    unknown = [gpu_type for gpu_type in preferred + list(excluded) if gpu_type not in RUNPOD_GPU_MEMORY_GB]
    if unknown:
        raise SystemExit(f"Unknown gpu_requirements GPU type ids: {unknown}")

    candidates: list[str] = []
    for gpu_type, memory_gb in RUNPOD_GPU_MEMORY_GB.items():
        if req.min_memory_gb is not None and memory_gb < req.min_memory_gb:
            continue
        if req.max_memory_gb is not None and memory_gb > req.max_memory_gb:
            continue
        if gpu_type in excluded:
            continue
        candidates.append(gpu_type)
    if not candidates:
        raise SystemExit("gpu_requirements did not match any known Runpod GPU types")

    reverse = req.order == "memory-desc"
    candidates.sort(key=lambda gpu_type: (RUNPOD_GPU_MEMORY_GB[gpu_type], gpu_type), reverse=reverse)

    ordered: list[str] = []
    for gpu_type in preferred:
        if gpu_type in candidates and gpu_type not in ordered:
            ordered.append(gpu_type)
    for gpu_type in candidates:
        if gpu_type not in ordered:
            ordered.append(gpu_type)
    return ordered


def resolve_gpu_selection(client: RunpodClient, cfg: RunpodConfig, paths: ExecutionPaths) -> tuple[list[str], str]:
    if cfg.gpu_type_ids:
        return resolve_gpu_type_ids(cfg), cfg.gpu_type_priority
    if cfg.gpu_value_heuristic.is_active():
        try:
            return resolve_gpu_type_ids_from_value_heuristic(client, cfg, paths), "custom"
        except (RuntimeError, urllib.error.URLError) as exc:
            message = str(exc)
            print(f"GraphQL market lookup unavailable, falling back to catalog ordering: {message}")
            return resolve_gpu_type_ids_from_catalog_fallback(cfg, paths, reason=message), "custom"
    return resolve_gpu_type_ids(cfg), cfg.gpu_type_priority


def build_create_payload(cfg: RunpodConfig, execution_name: str, gpu_type_ids: list[str], gpu_type_priority: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": execution_name,
        "imageName": cfg.image_name,
        "computeType": "GPU",
        "gpuCount": cfg.gpu_count,
        "cloudType": cfg.cloud_type,
        "interruptible": cfg.interruptible,
        "supportPublicIp": cfg.support_public_ip,
        "containerDiskInGb": cfg.container_disk_gb,
        "ports": effective_ports(cfg),
    }
    if gpu_type_ids:
        payload["gpuTypeIds"] = gpu_type_ids
        payload["gpuTypePriority"] = gpu_type_priority
    if cfg.allowed_cuda_versions:
        payload["allowedCudaVersions"] = cfg.allowed_cuda_versions
    if cfg.min_ram_per_gpu_gb is not None:
        payload["minRAMPerGPU"] = cfg.min_ram_per_gpu_gb
    if cfg.min_vcpu_per_gpu is not None:
        payload["minVCPUPerGPU"] = cfg.min_vcpu_per_gpu
    if cfg.volume_gb > 0:
        payload["volumeInGb"] = cfg.volume_gb
        payload["volumeMountPath"] = "/workspace"
    return payload


def pod_ssh_connection(pod: dict[str, Any], cfg: RunpodConfig) -> SSHConnection | None:
    public_ip = (
        pod.get("publicIp")
        or (pod.get("machine") or {}).get("publicIp")
        or (pod.get("runtime") or {}).get("publicIp")
    )
    port_mappings = pod.get("portMappings") or {}
    ssh_port = None
    if isinstance(port_mappings, dict):
        ssh_port = port_mappings.get("22") or port_mappings.get(22)
    elif isinstance(port_mappings, list):
        for item in port_mappings:
            private_port = item.get("privatePort") or item.get("containerPort") or item.get("port")
            if str(private_port) != "22":
                continue
            ssh_port = (
                item.get("publicPort")
                or item.get("hostPort")
                or item.get("externalPort")
                or item.get("port")
            )
            if ssh_port:
                break
    if not public_ip or not ssh_port:
        return None
    return SSHConnection(
        host=str(public_ip),
        port=int(ssh_port),
        user=cfg.ssh_user,
        key_path=Path(cfg.ssh_private_key).expanduser(),
    )


def wait_for_pod_ready(client: RunpodClient, pod_id: str, cfg: RunpodConfig, paths: ExecutionPaths) -> tuple[dict[str, Any], SSHConnection]:
    deadline = time.time() + cfg.pod_ready_timeout_seconds
    history_path = paths.metadata_dir / "pod-status-history.ndjson"
    while time.time() < deadline:
        pod = client.get_pod(pod_id)
        append_jsonl(history_path, {"timestamp": iso_now(), "pod": pod})
        conn = pod_ssh_connection(pod, cfg)
        if conn is not None:
            write_json(paths.metadata_dir / "pod-ready.json", pod)
            return pod, conn
        time.sleep(cfg.poll_interval_seconds)
    raise TimeoutError(f"Timed out waiting for pod {pod_id} to expose SSH")


def wait_for_ssh(conn: SSHConnection, cfg: RunpodConfig) -> None:
    deadline = time.time() + cfg.ssh_ready_timeout_seconds
    while time.time() < deadline:
        result = run_ssh(conn, "echo ssh-ready", check=False, capture_output=True)
        if result.returncode == 0 and "ssh-ready" in result.stdout:
            return
        time.sleep(cfg.poll_interval_seconds)
    raise TimeoutError(f"Timed out waiting for SSH on {conn.host}:{conn.port}")


def create_pod_session(
    cfg: RunpodConfig,
    *,
    branch: str,
    execution_name: str,
    paths: ExecutionPaths,
    log_path: Path,
) -> PodSession:
    client = RunpodClient(cfg.api_key)
    gpu_type_ids, gpu_type_priority = resolve_gpu_selection(client, cfg, paths)
    write_gpu_selection_metadata(
        paths,
        cfg,
        gpu_type_ids=gpu_type_ids,
        gpu_type_priority=gpu_type_priority,
    )
    payload = build_create_payload(cfg, execution_name, gpu_type_ids, gpu_type_priority)
    write_json(paths.metadata_dir / "pod-create-request.json", payload)
    append_log(log_path, "creating shared pod for batch")
    pod = client.create_pod(payload)
    write_json(paths.metadata_dir / "pod-created.json", pod)
    pod_id = str(pod["id"])
    selected_gpu_type = (pod.get("machine") or {}).get("gpuTypeId")
    append_log(log_path, f"pod_id={pod_id}")

    append_log(log_path, "waiting for pod to expose SSH")
    ready_pod, conn = wait_for_pod_ready(client, pod_id, cfg, paths)
    selected_gpu_type = (ready_pod.get("machine") or {}).get("gpuTypeId") or selected_gpu_type
    append_log(log_path, f"pod public_ip={conn.host} ssh_port={conn.port}")

    append_log(log_path, "waiting for SSH to accept connections")
    wait_for_ssh(conn, cfg)

    return PodSession(
        client=client,
        pod_id=pod_id,
        conn=conn,
        remote_repo_dir=posixpath.join(cfg.remote_base_dir, "branches", slugify(branch)),
        gpu_type_ids=gpu_type_ids,
        gpu_type_priority=gpu_type_priority,
        payload=payload,
        created_pod=pod,
        ready_pod=ready_pod,
        selected_gpu_type=selected_gpu_type,
        gpu_candidates=read_json(paths.metadata_dir / "gpu-candidates.json"),
    )


def bootstrap_remote(conn: SSHConnection, cfg: RunpodConfig, remote_repo_dir: str, log_path: Path) -> None:
    script = f"""
set -euo pipefail
cd {json.dumps(remote_repo_dir)}
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
uv_python="python3"
if command -v python3.11 >/dev/null 2>&1; then
  uv_python="python3.11"
fi
py_minor="$($uv_python - <<'PY'
import sys
print(f"{{sys.version_info.major}}.{{sys.version_info.minor}}")
PY
)"
if [ ! -f "/usr/include/python${{py_minor}}/Python.h" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y "python${{py_minor}}-dev" python3-dev build-essential || apt-get install -y python3-dev build-essential
  else
    echo "Python.h missing and no supported package manager available to install python3-dev" >&2
    exit 1
  fi
fi
if ! command -v uv >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  else
    python3 -m pip install --user uv
  fi
fi
uv sync --python "$uv_python" --frozen
if [ ! -f "$HOME/.cache/autoresearch/tokenizer/tokenizer.pkl" ]; then
  .venv/bin/python prepare.py --num-shards {cfg.prepare_num_shards}
fi
"""
    cmd = ["ssh", *ssh_base_args(conn), f"{conn.user}@{conn.host}", "bash -s"]
    with log_path.open("w") as fh:
        subprocess.run(cmd, input=script, text=True, check=True, stdout=fh, stderr=subprocess.STDOUT)


def write_remote_run_script(
    paths: ExecutionPaths,
    remote_repo_dir: str,
    run_command: str,
    *,
    cfg: RunpodConfig,
    branch: str,
    session_id: str,
) -> Path:
    local_script = paths.metadata_dir / "remote_execute.sh"
    remote_live_input = posixpath.join(remote_repo_dir, REMOTE_LIVE_INPUT)
    remote_live_events = posixpath.join(remote_repo_dir, REMOTE_LIVE_EVENTS)
    remote_live_state = posixpath.join(remote_repo_dir, REMOTE_LIVE_STATE)
    remote_live_log = posixpath.join(remote_repo_dir, REMOTE_LIVE_LOG)
    local_script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"cd {json.dumps(remote_repo_dir)}\n"
        "export PATH=\"$(pwd)/.venv/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH\"\n"
        "mkdir -p live\n"
        f"rm -f {json.dumps(REMOTE_LIVE_INPUT)} {json.dumps(REMOTE_LIVE_EVENTS)} {json.dumps(REMOTE_LIVE_STATE)} {json.dumps(REMOTE_LIVE_LOG)}\n"
        f"export AUTORESEARCH_LIVE_EVENTS_PATH={json.dumps(remote_live_input)}\n"
        f"export AUTORESEARCH_SESSION_ID={json.dumps(session_id)}\n"
        f"export AUTORESEARCH_BRANCH={json.dumps(branch)}\n"
        f"export AUTORESEARCH_EXECUTION_ID={json.dumps(paths.execution_dir.name)}\n"
        f".venv/bin/python scripts/pod_live_relay.py --input {shlex.quote(remote_live_input)} --output {shlex.quote(remote_live_events)} --state {shlex.quote(remote_live_state)} --log {shlex.quote(remote_live_log)} --port {cfg.relay_port} > {shlex.quote(remote_live_log)} 2>&1 &\n"
        "relay_pid=$!\n"
        "cleanup() {\n"
        "  if [ -n \"${relay_pid:-}\" ]; then\n"
        "    kill \"$relay_pid\" >/dev/null 2>&1 || true\n"
        "    wait \"$relay_pid\" >/dev/null 2>&1 || true\n"
        "  fi\n"
        "}\n"
        "trap cleanup EXIT\n"
        "rm -f .run.exitcode\n"
        "status=0\n"
        f"{run_command} || status=$?\n"
        "printf '%s\\n' \"$status\" > .run.exitcode\n",
    )
    local_script.chmod(0o755)
    return local_script


def scp_to_remote(conn: SSHConnection, local_path: Path, remote_path: str) -> None:
    cmd = ["scp", *scp_base_args(conn), str(local_path), f"{conn.user}@{conn.host}:{remote_path}"]
    run_local(cmd, cwd=local_path.parent)


def sync_remote_train_py_to_local(conn: SSHConnection, remote_repo_dir: str, repo_root: Path) -> None:
    local_train_py = repo_root / "train.py"
    remote_train_py = posixpath.join(remote_repo_dir, "train.py")
    cmd = ["scp", *scp_base_args(conn), f"{conn.user}@{conn.host}:{remote_train_py}", str(local_train_py)]
    run_local(cmd, cwd=repo_root)


def start_remote_run(conn: SSHConnection, remote_repo_dir: str, local_script: Path) -> None:
    remote_script = posixpath.join(remote_repo_dir, ".runpod_execute.sh")
    scp_to_remote(conn, local_script, remote_script)
    script = f"""
set -euo pipefail
cd {json.dumps(remote_repo_dir)}
chmod +x .runpod_execute.sh
nohup bash ./.runpod_execute.sh > .runpod_execute.stdout 2> .runpod_execute.stderr < /dev/null &
echo $! > .run.pid
"""
    run_ssh(conn, script)


def collect_artifacts(conn: SSHConnection, remote_repo_dir: str, paths: ExecutionPaths, artifacts: list[str]) -> None:
    seen: set[str] = set()
    for rel_path in effective_artifacts(artifacts) + EXTRA_REMOTE_FILES:
        if rel_path in seen:
            continue
        seen.add(rel_path)
        remote_path = posixpath.join(remote_repo_dir, rel_path)
        local_path = paths.artifacts_dir / rel_path
        run_scp(conn, remote_path, local_path)


def read_remote_exitcode(conn: SSHConnection, remote_repo_dir: str) -> int | None:
    script = f"""
set -euo pipefail
cd {json.dumps(remote_repo_dir)}
if [ -f .run.exitcode ]; then
  cat .run.exitcode
fi
"""
    result = run_ssh(conn, script, check=False, capture_output=True)
    if result.returncode != 0:
        return None
    text = result.stdout.strip()
    if not text:
        return None
    return int(text)


def parse_summary(run_log: Path) -> dict[str, str]:
    if not run_log.exists():
        return {}
    summary: dict[str, str] = {}
    for line in run_log.read_text(errors="replace").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key in SUMMARY_KEYS:
            summary[key] = value.strip()
    return summary


def monitor_run(client: RunpodClient, pod_id: str, conn: SSHConnection, cfg: RunpodConfig, remote_repo_dir: str, paths: ExecutionPaths) -> int:
    history_path = paths.metadata_dir / "pod-status-history.ndjson"
    while True:
        pod = client.get_pod(pod_id)
        append_jsonl(history_path, {"timestamp": iso_now(), "pod": pod})
        collect_artifacts(conn, remote_repo_dir, paths, cfg.collect_artifacts)
        exit_code = read_remote_exitcode(conn, remote_repo_dir)
        if exit_code is not None:
            return exit_code
        time.sleep(cfg.poll_interval_seconds)


def terminate_pod(client: RunpodClient, pod_id: str, paths: ExecutionPaths) -> None:
    response = client.terminate_pod(pod_id)
    write_json(paths.metadata_dir / "pod-terminated.json", response)


def execute_on_pod(
    repo_root: Path,
    cfg: RunpodConfig,
    *,
    session_log,
    branch: str,
    experiment_index: int,
    experiment_count: int,
    iteration_log: IterationPaths,
    paths: ExecutionPaths,
    pod_session: PodSession,
    codex_cfg: CodexAgentConfig,
    prepare_manifest: dict[str, Any] | None,
) -> tuple[int, dict[str, str]]:
    log_path = paths.logs_dir / "orchestrator.log"
    exit_code: int | None = None
    summary: dict[str, str] = {}
    finalized_iteration = False
    telemetry_events_path = paths.artifacts_dir / REMOTE_LIVE_EVENTS
    relay_state_path = paths.artifacts_dir / REMOTE_LIVE_STATE
    relay_ws_url = f"ws://{pod_session.conn.host}:{cfg.relay_port}"
    try:
        write_live_state(
            session_log,
            build_live_state_payload(
                session_id=session_log.session_id,
                branch=branch,
                runner_mode="runpod",
                phase="deploy",
                status="deploying",
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_label=iteration_log.iteration_label,
                execution_dir=paths.execution_dir,
                run_log_path=paths.artifacts_dir / "run.log",
                telemetry_events_path=telemetry_events_path,
                relay_state_path=relay_state_path,
                prepare_manifest=prepare_manifest,
            ),
        )
        append_live_event(
            session_log,
            {
                "timestamp": iso_now(),
                "type": "deploy_started",
                "iteration_label": iteration_log.iteration_label,
                "experiment_index": experiment_index,
            },
        )
        append_log(log_path, "syncing git checkout on shared pod")
        deploy_clone_to_remote(
            repo_root,
            pod_session.conn,
            pod_session.remote_repo_dir,
            branch,
            cfg.repo_url,
        )

        append_log(log_path, "bootstrapping remote environment")
        bootstrap_remote(pod_session.conn, cfg, pod_session.remote_repo_dir, paths.logs_dir / "bootstrap.log")

        append_log(log_path, "starting remote run")
        local_script = write_remote_run_script(
            paths,
            pod_session.remote_repo_dir,
            cfg.run_command,
            cfg=cfg,
            branch=branch,
            session_id=session_log.session_id,
        )
        start_remote_run(pod_session.conn, pod_session.remote_repo_dir, local_script)
        write_live_state(
            session_log,
            build_live_state_payload(
                session_id=session_log.session_id,
                branch=branch,
                runner_mode="runpod",
                phase="train",
                status="running",
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_label=iteration_log.iteration_label,
                execution_dir=paths.execution_dir,
                run_log_path=paths.artifacts_dir / "run.log",
                telemetry_events_path=telemetry_events_path,
                relay_state_path=relay_state_path,
                relay_ws_url=relay_ws_url,
                prepare_manifest=prepare_manifest,
            ),
        )
        append_live_event(
            session_log,
            {
                "timestamp": iso_now(),
                "type": "train_started",
                "iteration_label": iteration_log.iteration_label,
                "execution_id": paths.execution_dir.name,
            },
        )

        append_log(log_path, "monitoring remote run")
        exit_code = monitor_run(
            pod_session.client,
            pod_session.pod_id,
            pod_session.conn,
            cfg,
            pod_session.remote_repo_dir,
            paths,
        )
        append_log(log_path, f"remote run exit_code={exit_code}")

        collect_artifacts(pod_session.conn, pod_session.remote_repo_dir, paths, cfg.collect_artifacts)
        sync_remote_train_py_to_local(pod_session.conn, pod_session.remote_repo_dir, repo_root)
        snapshot_tested_train_py(
            iteration_log,
            repo_root=repo_root,
            train_py_path=repo_root / "train.py",
            parent_commit=iteration_log.parent_commit,
        )
        summary = parse_summary(paths.artifacts_dir / "run.log")
        write_json(paths.metadata_dir / "summary.json", summary)
        append_log(log_path, "running Codex reflect phase")
        write_live_state(
            session_log,
            build_live_state_payload(
                session_id=session_log.session_id,
                branch=branch,
                runner_mode="runpod",
                phase="reflect",
                status="reflecting",
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_label=iteration_log.iteration_label,
                execution_dir=paths.execution_dir,
                run_log_path=paths.artifacts_dir / "run.log",
                telemetry_events_path=telemetry_events_path,
                relay_state_path=relay_state_path,
                relay_ws_url=relay_ws_url,
                prepare_manifest=prepare_manifest,
            ),
        )
        append_live_event(
            session_log,
            {
                "timestamp": iso_now(),
                "type": "reflect_started",
                "iteration_label": iteration_log.iteration_label,
            },
        )
        reflect_before_snapshot = snapshot_phase_inputs(repo_root)
        reflect_log_path, reflect_output_path = phase_output_paths(
            repo_root=repo_root,
            session_id=iteration_log.session.session_id,
            experiment_index=iteration_log.iteration,
            phase="reflect",
        )
        run_codex_phase(
            repo_root=repo_root,
            cfg=codex_cfg,
            runner_mode="runpod",
            branch=branch,
            experiment_index=iteration_log.iteration,
            phase="reflect",
            log_path=reflect_log_path,
            output_path=reflect_output_path,
            run_log_path=paths.artifacts_dir / "run.log",
            summary_path=paths.metadata_dir / "summary.json",
            execution_dir=paths.execution_dir,
        )
        reflect_live_dir = live_phase_dir(session_log, iteration_label=iteration_log.iteration_label, phase="reflect")
        reflect_manifest = capture_codex_phase_artifacts(
            repo_root=repo_root,
            before_snapshot=reflect_before_snapshot,
            phase="reflect",
            phase_dir=reflect_live_dir,
            log_path=reflect_log_path,
            output_path=reflect_output_path,
        )
        bind_codex_phase_artifacts(iteration_log, phase="reflect", source_dir=reflect_live_dir)
        capture_dialectical_state(
            iteration_log,
            repo_root=repo_root,
            current_train_py_path=repo_root / "train.py",
            stage="result",
        )
        reflected_result = read_json(iteration_log.result_path) or {}
        reflected_transcendent = reflected_result.get("transcendent_result") or {}
        write_live_state(
            session_log,
            build_live_state_payload(
                session_id=session_log.session_id,
                branch=branch,
                runner_mode="runpod",
                phase="reflect_complete",
                status="reflect_complete",
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_label=iteration_log.iteration_label,
                execution_dir=paths.execution_dir,
                run_log_path=paths.artifacts_dir / "run.log",
                telemetry_events_path=telemetry_events_path,
                relay_state_path=relay_state_path,
                relay_ws_url=relay_ws_url,
                prepare_manifest=prepare_manifest,
                reflect_manifest=reflect_manifest,
            ),
        )
        append_live_event(
            session_log,
            {
                "timestamp": iso_now(),
                "type": "reflection_completed",
                "iteration_label": iteration_log.iteration_label,
                "experiment_index": experiment_index,
                "runner_phase": "reflect_complete",
                "outcome": reflected_result.get("outcome"),
                "contradicted_assumption": reflected_result.get("contradicted_assumption"),
                "keep_discard_status": reflected_result.get("keep_discard_status"),
                "framing_diagnosis": reflected_result.get("framing_diagnosis"),
                "next_move_type": reflected_result.get("next_move_type"),
                "reflect_changes": {
                    "modified_files": reflect_manifest.get("modified_files", []),
                    "summary": reflect_manifest.get("summary"),
                },
                "transcendent_result": {
                    "result_status": reflected_transcendent.get("result_status"),
                    "emergent_thought": reflected_transcendent.get("emergent_thought"),
                },
            },
        )
        final_pod = pod_session.client.get_pod(pod_session.pod_id)
        write_json(paths.metadata_dir / "pod-final.json", final_pod)
        pod_session.selected_gpu_type = ((final_pod.get("machine") or {}).get("gpuTypeId")) or pod_session.selected_gpu_type
        write_tracked_reports(
            paths,
            branch=branch,
            experiment_index=experiment_index,
            cfg=cfg,
            gpu_type_ids=pod_session.gpu_type_ids,
            gpu_type_priority=pod_session.gpu_type_priority,
            selected_gpu_type=pod_session.selected_gpu_type,
            cost_per_hr=final_pod.get("costPerHr"),
            exit_code=exit_code,
            summary=summary,
        )
        capture_execution_artifacts(
            iteration_log,
            run_log_path=paths.reports_dir / "run.log",
            telemetry_events_path=telemetry_events_path,
            relay_state_path=relay_state_path,
            summary=summary,
            run_metadata=json.loads((paths.reports_dir / "run-metadata.json").read_text())
            if (paths.reports_dir / "run-metadata.json").exists()
            else {},
            execution_ref={
                "runner_mode": "runpod",
                "execution_id": paths.execution_dir.name,
                "raw_execution_dir": str(paths.execution_dir.relative_to(repo_root)),
                "reports_dir": str(paths.reports_dir.relative_to(repo_root)),
            },
        )
        finalize_iteration(
            iteration_log,
            exit_code=exit_code,
            summary=summary,
            status="completed" if exit_code == 0 else "failed",
        )
        finalized_iteration = True
        post_commit = commit_nonignored_changes(
            repo_root,
            f"experiment {experiment_index:03d}: complete Runpod run on {branch} (val_bpb {summary.get('val_bpb', 'unknown')})",
        )
        if post_commit is not None:
            append_log(log_path, f"committed post-run changes: {post_commit}")
        write_live_state(
            session_log,
            build_live_state_payload(
                session_id=session_log.session_id,
                branch=branch,
                runner_mode="runpod",
                phase="commit",
                status="committing",
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_label=iteration_log.iteration_label,
                execution_dir=paths.execution_dir,
                run_log_path=paths.artifacts_dir / "run.log",
                telemetry_events_path=telemetry_events_path,
                relay_state_path=relay_state_path,
                relay_ws_url=relay_ws_url,
                prepare_manifest=prepare_manifest,
                reflect_manifest=reflect_manifest,
            ),
        )
        push_repo(repo_root, log_path, cfg.repo_push_target, cfg.ssh_private_key)
        return exit_code, summary
    finally:
        if not finalized_iteration:
            capture_dialectical_state(
                iteration_log,
                repo_root=repo_root,
                current_train_py_path=repo_root / "train.py",
                stage="result",
            )
            finalize_iteration(
                iteration_log,
                exit_code=exit_code,
                summary=summary,
                status="failed",
            )


def execute(args: argparse.Namespace) -> int:
    repo_root = Path(__file__).resolve().parents[1]
    for tool in ("ssh", "scp"):
        ensure_tool(tool)

    config_path = (repo_root / args.config).resolve()
    cfg = RunpodConfig.from_sources(config_path, repo_root)
    codex_cfg = load_codex_agent_config(repo_root)
    ensure_codex_available(codex_cfg)
    experiment_count = cfg.experiment_count
    branch = ensure_experiment_branch(repo_root)
    session_log = ensure_session_log(repo_root, branch=branch, runner_mode="runpod")

    batch_records: list[dict[str, Any]] = []
    batch_summary_path: Path | None = None
    if experiment_count > 1:
        batch_summary_dir = repo_root / "runpod_runs" / f"{timestamp_slug()}-{slugify(cfg.name_prefix)}-batch"
        batch_reports_dir = batch_summary_dir / "reports"
        batch_reports_dir.mkdir(parents=True, exist_ok=True)
        batch_summary_path = batch_reports_dir / "batch-summary.json"

    final_exit_code = 0
    pod_session: PodSession | None = None
    last_paths: ExecutionPaths | None = None
    shared_pod_name = f"{cfg.name_prefix}-{timestamp_slug()}-batch"
    try:
        for experiment_index in range(1, experiment_count + 1):
            manifest = read_json(session_log.manifest_path)
            baseline_run = not bool(manifest.get("iterations", []))
            session_iteration = int(manifest.get("latest_iteration") or 0) + 1
            iteration_label = f"{session_iteration:03d}"
            write_live_state(
                session_log,
                build_live_state_payload(
                    session_id=session_log.session_id,
                    branch=branch,
                    runner_mode="runpod",
                    phase="prepare",
                    status="preparing",
                    experiment_index=experiment_index,
                    experiment_count=experiment_count,
                    iteration_label=iteration_label,
                    execution_dir=None,
                    run_log_path=None,
                ),
            )
            append_live_event(
                session_log,
                {
                    "timestamp": iso_now(),
                    "type": "prepare_started",
                    "iteration_label": iteration_label,
                    "experiment_index": experiment_index,
                    "experiment_count": experiment_count,
                },
            )
            prepare_log_path, prepare_output_path = phase_output_paths(
                repo_root=repo_root,
                session_id=session_log.session_id,
                experiment_index=session_iteration,
                phase="prepare",
            )
            prepare_before_snapshot = snapshot_phase_inputs(repo_root)
            run_codex_phase(
                repo_root=repo_root,
                cfg=codex_cfg,
                runner_mode="runpod",
                branch=branch,
                experiment_index=session_iteration,
                phase="prepare",
                log_path=prepare_log_path,
                output_path=prepare_output_path,
                baseline_run=baseline_run,
            )
            prepare_live_dir = live_phase_dir(session_log, iteration_label=iteration_label, phase="prepare")
            prepare_manifest = capture_codex_phase_artifacts(
                repo_root=repo_root,
                before_snapshot=prepare_before_snapshot,
                phase="prepare",
                phase_dir=prepare_live_dir,
                log_path=prepare_log_path,
                output_path=prepare_output_path,
            )
            write_live_state(
                session_log,
                build_live_state_payload(
                    session_id=session_log.session_id,
                    branch=branch,
                    runner_mode="runpod",
                    phase="prepare_complete",
                    status="prepared",
                    experiment_index=experiment_index,
                    experiment_count=experiment_count,
                    iteration_label=iteration_label,
                    execution_dir=None,
                    run_log_path=None,
                    prepare_manifest=prepare_manifest,
                ),
            )
            append_live_event(
                session_log,
                {
                    "timestamp": iso_now(),
                    "type": "prepare_completed",
                    "iteration_label": iteration_label,
                    "modified_files": prepare_manifest.get("modified_files", []),
                    "summary": prepare_manifest.get("summary"),
                },
            )
            parent_commit = git_stdout(repo_root, ["rev-parse", "--short", "HEAD"])
            pre_commit = commit_nonignored_changes(
                repo_root,
                f"experiment {experiment_index:03d}: prepare Runpod deployment on {branch}",
            )
            if pre_commit is not None:
                print(f"committed local changes before Runpod run: {pre_commit}")
            candidate_commit = git_stdout(repo_root, ["rev-parse", "--short", "HEAD"])
            iteration_log = start_iteration(
                session_log,
                runner_mode="runpod",
                experiment_index=experiment_index,
                parent_commit=parent_commit,
                candidate_commit=candidate_commit,
            )
            bind_codex_phase_artifacts(iteration_log, phase="prepare", source_dir=prepare_live_dir)
            snapshot_tested_train_py(
                iteration_log,
                repo_root=repo_root,
                train_py_path=repo_root / "train.py",
                parent_commit=iteration_log.parent_commit,
            )
            capture_dialectical_state(
                iteration_log,
                repo_root=repo_root,
                current_train_py_path=repo_root / "train.py",
                stage="plan",
            )
            execution_prefix = cfg.name_prefix
            if experiment_count > 1:
                execution_prefix = f"{cfg.name_prefix}-exp{experiment_index:02d}"
            paths = make_execution_paths(repo_root, execution_prefix)
            last_paths = paths
            bind_execution(iteration_log, execution_dir=paths.execution_dir)
            log_path = paths.logs_dir / "orchestrator.log"
            append_log(log_path, f"execution_dir={paths.execution_dir}")
            append_log(log_path, f"experiment_branch={branch}")
            write_execution_metadata(paths, cfg, branch=branch, experiment_index=experiment_index)
            print(f"starting experiment {experiment_index}/{experiment_count}")
            append_log(log_path, "pushing branch before pod deployment")
            push_repo(repo_root, log_path, cfg.repo_push_target, cfg.ssh_private_key)

            if pod_session is None:
                pod_session = create_pod_session(
                    cfg,
                    branch=branch,
                    execution_name=shared_pod_name,
                    paths=paths,
                    log_path=log_path,
                )
                write_pod_session_metadata(paths, cfg, pod_session)
            else:
                write_pod_session_metadata(paths, cfg, pod_session)
                append_log(log_path, f"reusing pod_id={pod_session.pod_id}")
                append_log(log_path, f"pod public_ip={pod_session.conn.host} ssh_port={pod_session.conn.port}")

            exit_code, summary = execute_on_pod(
                repo_root,
                cfg,
                session_log=session_log,
                branch=branch,
                experiment_index=experiment_index,
                experiment_count=experiment_count,
                iteration_log=iteration_log,
                paths=paths,
                pod_session=pod_session,
                codex_cfg=codex_cfg,
                prepare_manifest=prepare_manifest,
            )
            record = {
                "experiment_index": experiment_index,
                "execution_dir": str(paths.execution_dir),
                "exit_code": exit_code,
                "summary": summary,
            }
            batch_records.append(record)
            if batch_summary_path is not None:
                write_json(
                    batch_summary_path,
                    {
                        "branch": branch,
                        "name_prefix": cfg.name_prefix,
                        "experiment_count": experiment_count,
                        "completed_experiments": len(batch_records),
                        "records": batch_records,
                    },
                )
            if exit_code != 0:
                final_exit_code = exit_code
                break
    finally:
        if pod_session is not None and not args.keep_pod and last_paths is not None:
            append_log(last_paths.logs_dir / "orchestrator.log", "terminating shared pod")
            try:
                terminate_pod(pod_session.client, pod_session.pod_id, last_paths)
            except Exception as exc:  # pragma: no cover - best effort cleanup
                append_log(last_paths.logs_dir / "orchestrator.log", f"pod termination failed: {exc}")
        clear_live_state(
            session_log,
            final_phase="completed" if final_exit_code == 0 else "failed",
            status="completed" if final_exit_code == 0 else "failed",
        )

    return final_exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    execute_parser = subparsers.add_parser("execute", help="Launch one Pod for a batch, run autoresearch, collect artifacts, terminate")
    execute_parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to runpod.json relative to the repo root",
    )
    execute_parser.add_argument(
        "--keep-pod",
        action="store_true",
        help="Do not terminate the shared Pod after the batch finishes",
    )
    execute_parser.add_argument(
        "--profile",
        type=int,
        help="Override the configured numbered Runpod profile",
    )
    execute_parser.add_argument(
        "--count",
        type=int,
        help="Override how many experiments to run on the same Pod",
    )

    resolve_parser = subparsers.add_parser("resolve-gpu", help="Resolve and print the currently best Runpod GPU candidates")
    resolve_parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to runpod.json relative to the repo root",
    )
    resolve_parser.add_argument(
        "--profile",
        type=int,
        help="Override the configured numbered Runpod profile",
    )
    subparsers.add_parser("profiles", help="List the numbered Runpod profiles from profiles.json")
    return parser


def main() -> int:
    global PROFILE_PRESETS_PATH
    repo_root = Path(__file__).resolve().parents[1]
    PROFILE_PRESETS_PATH = repo_root / DEFAULT_PROFILES_PATH
    load_env_file(repo_root / DEFAULT_ENV_PATH)
    parser = build_parser()
    args = parser.parse_args()
    if args.command == "execute":
        if getattr(args, "profile", None) is not None:
            os.environ["RUNPOD_PROFILE"] = str(args.profile)
        if getattr(args, "count", None) is not None:
            os.environ["RUNPOD_EXPERIMENT_COUNT"] = str(args.count)
        return execute(args)
    if args.command == "resolve-gpu":
        if getattr(args, "profile", None) is not None:
            os.environ["RUNPOD_PROFILE"] = str(args.profile)
        config_path = (repo_root / args.config).resolve()
        cfg = RunpodConfig.from_sources(config_path, repo_root)
        client = RunpodClient(cfg.api_key)
        paths = make_execution_paths(repo_root, cfg.name_prefix + "-resolve")
        gpu_type_ids, gpu_type_priority = resolve_gpu_selection(client, cfg, paths)
        print(
            json.dumps(
                {
                    "profile": cfg.profile,
                    "profile_name": get_profile_preset(cfg.profile).name if cfg.profile is not None else None,
                    "gpu_type_ids": gpu_type_ids,
                    "gpu_type_priority": gpu_type_priority,
                },
                indent=2,
            )
        )
        print(f"metadata_dir={paths.metadata_dir}")
        return 0
    if args.command == "profiles":
        ensure_profile_presets_loaded()
        print(json.dumps({profile_id: asdict(preset) for profile_id, preset in RUN_PROFILE_PRESETS.items()}, indent=2))
        return 0
    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
