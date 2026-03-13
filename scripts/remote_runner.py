#!/usr/bin/env python3
"""Bootstrap and run autoresearch experiments on a remote CUDA machine."""

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
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from experiment_log import (
    bind_execution,
    capture_dialectical_state,
    capture_execution_artifacts,
    ensure_session_log,
    finalize_iteration,
    snapshot_tested_train_py,
    start_iteration,
)
from codex_agent import (
    ensure_codex_available,
    load_codex_agent_config,
    phase_output_paths,
    run_codex_phase,
)
from knowledge_base import rebuild_knowledge_base, seed_state_with_knowledge_suggestion


DEFAULT_ENV_PATH = ".env"
REMOTE_HOST_ENV = "AUTORESEARCH_REMOTE_HOST"
REMOTE_DIR_ENV = "AUTORESEARCH_REMOTE_DIR"
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
SYNC_EXCLUDES = [
    ".git/",
    ".venv/",
    "__pycache__/",
    "*.pyc",
    "results.tsv",
    "research_journal.tsv",
    "run.log",
    "remote_runs/",
]


@dataclass
class RemoteConfig:
    host: str
    remote_dir: str
    repo_root: Path
    repo_url: str
    repo_push_target: str
    ssh_private_key_path: Path | None

    @property
    def local_run_log(self) -> Path:
        return self.repo_root / "run.log"

    @property
    def local_run_archive_dir(self) -> Path:
        return self.repo_root / "remote_runs"

    @property
    def local_train_py(self) -> Path:
        return self.repo_root / "train.py"

    @property
    def remote_run_log(self) -> str:
        return f"{self.remote_dir}/run.log"

    @property
    def remote_train_py(self) -> str:
        return f"{self.remote_dir}/train.py"


def shell(script: str) -> str:
    return f"bash -lc {shlex.quote(script)}"


def run_local(
    cmd: list[str],
    *,
    cwd: Path,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, check=check, env=env)


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


def resolve_private_key_path(raw_value: str | None, *, env_name: str) -> Path | None:
    if raw_value in (None, ""):
        return None
    path = Path(raw_value).expanduser()
    if not path.exists():
        raise SystemExit(f"{env_name} does not exist: {path}")
    if not path.is_file():
        raise SystemExit(f"{env_name} must point to a file: {path}")
    return path


def build_git_env(private_key_path: Path | None) -> dict[str, str] | None:
    if private_key_path is None:
        return None
    env = os.environ.copy()
    env["GIT_SSH_COMMAND"] = (
        f"ssh -i {shlex.quote(str(private_key_path))} "
        "-o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
    )
    return env


def ssh_base_args(cfg: RemoteConfig) -> list[str]:
    args = ["-o", "StrictHostKeyChecking=accept-new"]
    if cfg.ssh_private_key_path is not None:
        args.extend(["-i", str(cfg.ssh_private_key_path), "-o", "IdentitiesOnly=yes"])
    return args


def scp_base_args(cfg: RemoteConfig) -> list[str]:
    args = ["-o", "StrictHostKeyChecking=accept-new"]
    if cfg.ssh_private_key_path is not None:
        args.extend(["-i", str(cfg.ssh_private_key_path), "-o", "IdentitiesOnly=yes"])
    return args


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


def push_repo(repo_root: Path, push_target: str, ssh_private_key_path: Path | None) -> None:
    branch = current_branch(repo_root)
    if not branch:
        raise SystemExit("Auto-push requires an active git branch; detached HEAD is not supported")
    print(f"pushing branch {branch} to {push_target}")
    cmd = ["git", "push"]
    if push_target == "origin":
        cmd.append("--set-upstream")
    cmd.extend([push_target, f"HEAD:refs/heads/{branch}"])
    run_local(cmd, cwd=repo_root, env=build_git_env(ssh_private_key_path))


def run_remote(cfg: RemoteConfig, script: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = ["ssh", *ssh_base_args(cfg), cfg.host, shell(script)]
    return subprocess.run(cmd, text=True, check=check)


def capture_remote(cfg: RemoteConfig, script: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    cmd = ["ssh", *ssh_base_args(cfg), cfg.host, shell(script)]
    return subprocess.run(cmd, text=True, capture_output=True, check=check)


def deploy_clone(cfg: RemoteConfig, branch: str) -> None:
    remote_dir = cfg.remote_dir.rstrip("/")
    parent_dir = posixpath.dirname(remote_dir) or "."
    git_name = git_config_value(cfg.repo_root, "user.name") or "autoresearch"
    git_email = git_config_value(cfg.repo_root, "user.email") or "autoresearch@localhost"

    script = f"""
set -euo pipefail
repo_dir={shlex.quote(remote_dir)}
parent_dir={shlex.quote(parent_dir)}
repo_url={shlex.quote(cfg.repo_url)}
branch_name={shlex.quote(branch)}
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
  git -C "$repo_dir" clean -fd
else
  rm -rf "$repo_dir"
  git clone --branch "$branch_name" "$repo_url" "$repo_dir"
fi
git -C "$repo_dir" config user.name {shlex.quote(git_name)}
git -C "$repo_dir" config user.email {shlex.quote(git_email)}
"""
    run_remote(cfg, script)


def ensure_remote_env(cfg: RemoteConfig, *, prepare_if_missing: bool, prepare_num_shards: int) -> None:
    prepare_step = ""
    if prepare_if_missing:
        prepare_step = f"""
if [ ! -f "$HOME/.cache/autoresearch/tokenizer/tokenizer.pkl" ]; then
  uv run prepare.py --num-shards {prepare_num_shards}
fi
"""
    script = f"""
set -euo pipefail
cd {shlex.quote(cfg.remote_dir)}
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  else
    python3 -m pip install --user uv
  fi
fi
uv sync --frozen
{prepare_step}
"""
    run_remote(cfg, script)


def fetch_run_log(cfg: RemoteConfig) -> Path:
    cfg.local_run_log.parent.mkdir(parents=True, exist_ok=True)
    run_local(
        ["scp", *scp_base_args(cfg), f"{cfg.host}:{cfg.remote_run_log}", str(cfg.local_run_log)],
        cwd=cfg.repo_root,
    )
    cfg.local_run_archive_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_name = sanitize_host(cfg.host) + "-" + stamp + ".log"
    archive_path = cfg.local_run_archive_dir / archive_name
    shutil.copy2(cfg.local_run_log, archive_path)
    return archive_path


def sync_remote_train_py(cfg: RemoteConfig) -> None:
    run_local(
        ["scp", *scp_base_args(cfg), f"{cfg.host}:{cfg.remote_train_py}", str(cfg.local_train_py)],
        cwd=cfg.repo_root,
    )


def sanitize_host(host: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", host)


def parse_summary(text: str) -> dict[str, str]:
    summary: dict[str, str] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        if key in SUMMARY_KEYS:
            summary[key] = value.strip()
    return summary


def print_summary(summary: dict[str, str]) -> None:
    print("---")
    for key in SUMMARY_KEYS:
        if key in summary:
            print(f"{key}: {summary[key]}")


def tail_log(path: Path, lines: int = 50) -> str:
    content = path.read_text()
    parts = content.splitlines()
    return "\n".join(parts[-lines:])


def setup_command(cfg: RemoteConfig, args: argparse.Namespace) -> int:
    branch = ensure_experiment_branch(cfg.repo_root)
    pre_commit = commit_nonignored_changes(
        cfg.repo_root,
        f"experiment: prepare remote setup on {branch}",
    )
    if pre_commit is not None:
        print(f"committed local changes before remote setup: {pre_commit}")
    push_repo(cfg.repo_root, cfg.repo_push_target, cfg.ssh_private_key_path)
    deploy_clone(cfg, branch)
    ensure_remote_env(
        cfg,
        prepare_if_missing=not args.skip_prepare,
        prepare_num_shards=args.prepare_num_shards,
    )
    status_command(cfg, args)
    return 0


def run_command(cfg: RemoteConfig, args: argparse.Namespace) -> int:
    branch = ensure_experiment_branch(cfg.repo_root)
    session_log = ensure_session_log(cfg.repo_root, branch=branch, runner_mode="remote")
    codex_cfg = load_codex_agent_config(cfg.repo_root)
    ensure_codex_available(codex_cfg)
    manifest = json.loads(session_log.manifest_path.read_text())
    next_experiment_index = int(manifest.get("latest_iteration") or 0) + 1
    baseline_run = not bool(manifest.get("iterations", []))
    knowledge_summary = rebuild_knowledge_base(
        cfg.repo_root,
        cfg.repo_root / "knowledge_base",
        suggestion_session_id=session_log.session_id,
    )
    knowledge_suggestion = knowledge_summary.get("prepare_suggestion")
    seed_state_with_knowledge_suggestion(codex_cfg.state_path, knowledge_suggestion)
    prepare_log_path, prepare_output_path = phase_output_paths(
        repo_root=cfg.repo_root,
        session_id=session_log.session_id,
        experiment_index=next_experiment_index,
        phase="prepare",
    )
    prepare_state_backup = codex_cfg.state_path.read_text() if codex_cfg.state_path.exists() else None
    prepare_result = run_codex_phase(
        repo_root=cfg.repo_root,
        cfg=codex_cfg,
        runner_mode="remote",
        branch=branch,
        experiment_index=next_experiment_index,
        phase="prepare",
        log_path=prepare_log_path,
        output_path=prepare_output_path,
        baseline_run=baseline_run,
        knowledge_suggestion=knowledge_suggestion,
    )
    if prepare_result.timed_out:
        print(f"Codex prepare timed out; continuing with {codex_cfg.state_path}")
    if not codex_cfg.state_path.exists() and prepare_state_backup is not None:
        codex_cfg.state_path.parent.mkdir(parents=True, exist_ok=True)
        codex_cfg.state_path.write_text(prepare_state_backup)
        print(f"restored {codex_cfg.state_path} from pre-prepare snapshot")
    if not codex_cfg.state_path.exists():
        raise SystemExit(f"Codex prepare did not leave {codex_cfg.state_path} behind; aborting before deployment.")
    parent_commit = git_stdout(cfg.repo_root, ["rev-parse", "--short", "HEAD"])
    pre_commit = commit_nonignored_changes(
        cfg.repo_root,
        f"experiment: prepare remote run on {branch}",
    )
    if pre_commit is not None:
        print(f"committed local changes before remote run: {pre_commit}")
    candidate_commit = git_stdout(cfg.repo_root, ["rev-parse", "--short", "HEAD"])
    iteration_log = start_iteration(
        session_log,
        runner_mode="remote",
        experiment_index=next_experiment_index,
        parent_commit=parent_commit,
        candidate_commit=candidate_commit,
    )
    snapshot_tested_train_py(
        iteration_log,
        repo_root=cfg.repo_root,
        train_py_path=cfg.local_train_py,
        parent_commit=iteration_log.parent_commit,
    )
    capture_dialectical_state(
        iteration_log,
        repo_root=cfg.repo_root,
        current_train_py_path=cfg.local_train_py,
        stage="plan",
    )
    push_repo(cfg.repo_root, cfg.repo_push_target, cfg.ssh_private_key_path)
    if not args.skip_sync:
        deploy_clone(cfg, branch)
    if args.bootstrap:
        ensure_remote_env(
            cfg,
            prepare_if_missing=not args.skip_prepare,
            prepare_num_shards=args.prepare_num_shards,
        )

    if args.timeout_minutes > 0:
        timeout_seconds = args.timeout_minutes * 60
        run_line = (
            f"if command -v timeout >/dev/null 2>&1; then "
            f"timeout -k 30s {timeout_seconds}s uv run train.py > run.log 2>&1; "
            f"else uv run train.py > run.log 2>&1; fi"
        )
    else:
        run_line = "uv run train.py > run.log 2>&1"

    script = f"""
set -euo pipefail
cd {shlex.quote(cfg.remote_dir)}
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
{run_line}
"""
    result = run_remote(cfg, script, check=False)
    archive_path = fetch_run_log(cfg)
    bind_execution(iteration_log, execution_dir=archive_path)
    sync_remote_train_py(cfg)
    snapshot_tested_train_py(
        iteration_log,
        repo_root=cfg.repo_root,
        train_py_path=cfg.local_train_py,
        parent_commit=iteration_log.parent_commit,
    )
    reflect_log_path, reflect_output_path = phase_output_paths(
        repo_root=cfg.repo_root,
        session_id=session_log.session_id,
        experiment_index=iteration_log.iteration,
        phase="reflect",
    )
    run_codex_phase(
        repo_root=cfg.repo_root,
        cfg=codex_cfg,
        runner_mode="remote",
        branch=branch,
        experiment_index=iteration_log.iteration,
        phase="reflect",
        log_path=reflect_log_path,
        output_path=reflect_output_path,
        run_log_path=cfg.local_run_log,
        execution_dir=iteration_log.execution_dir,
    )
    capture_dialectical_state(
        iteration_log,
        repo_root=cfg.repo_root,
        current_train_py_path=cfg.local_train_py,
        stage="result",
    )
    summary = parse_summary(cfg.local_run_log.read_text())
    capture_execution_artifacts(
        iteration_log,
        run_log_path=cfg.local_run_log,
        telemetry_events_path=None,
        relay_state_path=None,
        summary=summary,
        run_metadata={
            "runner_mode": "remote",
            "branch": branch,
            "host": cfg.host,
            "remote_dir": cfg.remote_dir,
            "archive_log": str(archive_path.relative_to(cfg.repo_root)),
            "exit_code": result.returncode,
            "metrics": summary,
        },
        execution_ref={
            "runner_mode": "remote",
            "archive_log": str(archive_path.relative_to(cfg.repo_root)),
            "host": cfg.host,
            "remote_dir": cfg.remote_dir,
        },
    )
    if summary:
        finalize_iteration(
            iteration_log,
            exit_code=result.returncode,
            summary=summary,
            status="completed",
        )
        rebuild_knowledge_base(
            cfg.repo_root,
            cfg.repo_root / "knowledge_base",
            suggestion_session_id=session_log.session_id,
        )
        print_summary(summary)
        print(f"archive_log: {archive_path}")
        post_commit = commit_nonignored_changes(
            cfg.repo_root,
            f"experiment: complete remote run on {branch} (val_bpb {summary.get('val_bpb', 'unknown')})",
        )
        if post_commit is not None:
            print(f"committed post-run changes: {post_commit}")
        push_repo(cfg.repo_root, cfg.repo_push_target, cfg.ssh_private_key_path)
        if result.returncode != 0:
            print(
                f"remote command exited with status {result.returncode}, but a summary was present",
                file=sys.stderr,
            )
        return 0

    finalize_iteration(
        iteration_log,
        exit_code=result.returncode,
        summary=summary,
        status="failed",
    )
    rebuild_knowledge_base(
        cfg.repo_root,
        cfg.repo_root / "knowledge_base",
        suggestion_session_id=session_log.session_id,
    )
    post_commit = commit_nonignored_changes(
        cfg.repo_root,
        f"experiment: complete remote run on {branch} (crash)",
    )
    if post_commit is not None:
        print(f"committed post-run changes: {post_commit}")
    push_repo(cfg.repo_root, cfg.repo_push_target, cfg.ssh_private_key_path)
    print(f"remote command exited with status {result.returncode}", file=sys.stderr)
    print(f"last_log_lines from {cfg.local_run_log}:", file=sys.stderr)
    print(tail_log(cfg.local_run_log), file=sys.stderr)
    return result.returncode or 1


def fetch_log_command(cfg: RemoteConfig, _args: argparse.Namespace) -> int:
    archive_path = fetch_run_log(cfg)
    sync_remote_train_py(cfg)
    summary = parse_summary(cfg.local_run_log.read_text())
    if summary:
        print_summary(summary)
    print(f"archive_log: {archive_path}")
    return 0


def status_command(cfg: RemoteConfig, _args: argparse.Namespace) -> int:
    script = f"""
set -euo pipefail
mkdir -p {shlex.quote(cfg.remote_dir)}
cd {shlex.quote(cfg.remote_dir)}
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
printf "host: %s\\n" "$(hostname)"
printf "remote_dir: %s\\n" "$PWD"
printf "python: %s\\n" "$(python3 --version)"
if command -v uv >/dev/null 2>&1; then
  printf "uv: %s\\n" "$(uv --version)"
else
  printf "uv: missing\\n"
fi
if command -v nvidia-smi >/dev/null 2>&1; then
  printf "gpu: %s\\n" "$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | paste -sd '; ' -)"
else
  printf "gpu: missing\\n"
fi
if [ -f "$HOME/.cache/autoresearch/tokenizer/tokenizer.pkl" ]; then
  printf "cache: ready\\n"
else
  printf "cache: missing\\n"
fi
if [ -f run.log ]; then
  printf "run_log: present\\n"
else
  printf "run_log: missing\\n"
fi
"""
    result = capture_remote(cfg, script)
    sys.stdout.write(result.stdout)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--host",
        default=None,
        help=f"Remote SSH target (or ${REMOTE_HOST_ENV})",
    )
    parser.add_argument(
        "--remote-dir",
        default=None,
        help=f"Remote checkout directory (or ${REMOTE_DIR_ENV})",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup = subparsers.add_parser("setup", help="Clone the configured repo remotely and bootstrap the environment")
    setup.add_argument(
        "--skip-prepare",
        action="store_true",
        help="Do not run prepare.py when the remote cache is missing",
    )
    setup.add_argument(
        "--prepare-num-shards",
        type=int,
        default=10,
        help="Training shards to download if prepare.py needs to run",
    )

    run = subparsers.add_parser("run", help="Update the remote clone, execute train.py remotely, and fetch run.log")
    run.add_argument("--skip-sync", action="store_true", help="Do not refresh the remote git clone first")
    run.add_argument(
        "--bootstrap",
        action="store_true",
        help="Ensure uv/dependencies and remote cache before running",
    )
    run.add_argument(
        "--skip-prepare",
        action="store_true",
        help="With --bootstrap, skip prepare.py even if the remote cache is missing",
    )
    run.add_argument(
        "--prepare-num-shards",
        type=int,
        default=10,
        help="With --bootstrap, training shards to download if prepare.py needs to run",
    )
    run.add_argument(
        "--timeout-minutes",
        type=int,
        default=10,
        help="Remote timeout for train.py, 0 disables timeout wrapping",
    )

    subparsers.add_parser("fetch-log", help="Fetch the latest remote run.log")
    subparsers.add_parser("status", help="Report remote environment status")
    return parser


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    load_env_file(repo_root / DEFAULT_ENV_PATH)
    parser = build_parser()
    args = parser.parse_args()
    host = args.host or os.environ.get(REMOTE_HOST_ENV)
    remote_dir = args.remote_dir or os.environ.get(REMOTE_DIR_ENV)
    if not host:
        raise SystemExit(f"Remote host is required via --host or ${REMOTE_HOST_ENV}")
    if not remote_dir:
        raise SystemExit(f"Remote directory is required via --remote-dir or ${REMOTE_DIR_ENV}")
    repo_value = os.environ.get("AUTORESEARCH_REPO")
    ssh_private_key_path = resolve_private_key_path(
        os.environ.get("RUNPOD_SSH_PRIVATE_KEY"),
        env_name="RUNPOD_SSH_PRIVATE_KEY",
    )
    cfg = RemoteConfig(
        host=host,
        remote_dir=remote_dir,
        repo_root=repo_root,
        repo_url=normalize_repo_url(repo_root, repo_value, prefer_ssh=False),
        repo_push_target=resolve_push_target(repo_root, repo_value, prefer_ssh=ssh_private_key_path is not None),
        ssh_private_key_path=ssh_private_key_path,
    )

    if args.command == "setup":
        return setup_command(cfg, args)
    if args.command == "run":
        return run_command(cfg, args)
    if args.command == "fetch-log":
        return fetch_log_command(cfg, args)
    if args.command == "status":
        return status_command(cfg, args)
    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
