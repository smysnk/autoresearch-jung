#!/usr/bin/env python3
"""Pod-local relay for structured training telemetry."""

from __future__ import annotations

import argparse
import asyncio
import json
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")


class TelemetryRelay:
    def __init__(
        self,
        *,
        input_path: Path,
        output_path: Path,
        state_path: Path,
        log_path: Path,
        poll_interval: float,
    ) -> None:
        self.input_path = input_path
        self.output_path = output_path
        self.state_path = state_path
        self.log_path = log_path
        self.poll_interval = poll_interval
        self.started_at = iso_now()
        self.event_count = 0
        self.last_event_type: str | None = None
        self.last_progress: dict[str, Any] | None = None
        self.current_gpu: dict[str, Any] | None = None
        self._stream_position = 0
        self._partial_line = ""
        self._shutdown = asyncio.Event()

    def log(self, message: str) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a") as fh:
            fh.write(f"[{iso_now()}] {message}\n")

    def write_state(self, *, status: str) -> None:
        payload = {
            "status": status,
            "started_at": self.started_at,
            "updated_at": iso_now(),
            "input_path": str(self.input_path),
            "output_path": str(self.output_path),
            "event_count": self.event_count,
            "last_event_type": self.last_event_type,
            "current_progress": self.last_progress,
            "current_gpu": self.current_gpu,
        }
        write_json(self.state_path, payload)

    def normalize_event(self, raw_line: str) -> dict[str, Any]:
        try:
            payload = json.loads(raw_line)
        except json.JSONDecodeError:
            payload = {"type": "relay_parse_error", "raw_line": raw_line}
        if not isinstance(payload, dict):
            payload = {"type": "relay_value", "value": payload}
        payload.setdefault("relay_received_at", iso_now())
        payload.setdefault("relay_seq", self.event_count + 1)
        return payload

    def extract_progress(self, event: dict[str, Any]) -> dict[str, Any] | None:
        event_type = event.get("type")
        if event_type == "train_step":
            cuda = event.get("cuda") if isinstance(event.get("cuda"), dict) else {}
            gpu = event.get("gpu") if isinstance(event.get("gpu"), dict) else {}
            return {
                "step": event.get("step"),
                "epoch": event.get("epoch"),
                "progress_pct": event.get("progress_pct"),
                "training_seconds_elapsed": event.get("training_seconds_elapsed"),
                "remaining_seconds": event.get("remaining_seconds"),
                "train_loss_raw": event.get("train_loss_raw"),
                "train_loss_ema": event.get("train_loss_ema"),
                "tokens_per_second": event.get("tokens_per_second"),
                "mfu_percent_instant": event.get("mfu_percent_instant"),
                "step_dt_ms": event.get("step_dt_ms"),
                "memory_allocated_mb": cuda.get("memory_allocated_mb"),
                "memory_reserved_mb": cuda.get("memory_reserved_mb"),
                "max_memory_allocated_mb": cuda.get("max_memory_allocated_mb"),
                "gpu_util_percent": gpu.get("util_percent"),
                "gpu_memory_util_percent": gpu.get("mem_util_percent"),
                "temp_c": gpu.get("temp_c"),
                "power_w": gpu.get("power_w"),
            }
        if event_type == "run_summary":
            gpu = event.get("gpu") if isinstance(event.get("gpu"), dict) else {}
            return {
                "step": event.get("num_steps"),
                "progress_pct": 100,
                "training_seconds_elapsed": event.get("training_seconds"),
                "remaining_seconds": 0,
                "val_bpb": event.get("val_bpb"),
                "peak_vram_mb": event.get("peak_vram_mb"),
                "mfu_percent_instant": event.get("mfu_percent"),
                "gpu_util_percent": gpu.get("util_percent"),
                "gpu_memory_util_percent": gpu.get("mem_util_percent"),
                "temp_c": gpu.get("temp_c"),
                "power_w": gpu.get("power_w"),
            }
        return self.last_progress

    def query_gpu_sample(self) -> dict[str, Any] | None:
        cmd = [
            "nvidia-smi",
            "--query-gpu=utilization.gpu,utilization.memory,temperature.gpu,power.draw,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ]
        try:
            result = subprocess.run(cmd, text=True, capture_output=True, check=False)
        except OSError:
            return None
        if result.returncode != 0:
            return None
        line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
        if not line:
            return None
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 6:
            return None
        values: list[float | None] = []
        for part in parts[:6]:
            try:
                values.append(float(part))
            except ValueError:
                values.append(None)
        util, mem_util, temp_c, power_w, memory_used_mb, memory_total_mb = values
        return {
            "util_percent": util,
            "mem_util_percent": mem_util,
            "temp_c": temp_c,
            "power_w": power_w,
            "memory_used_mb": memory_used_mb,
            "memory_total_mb": memory_total_mb,
            "sampled_at": iso_now(),
        }

    async def sample_gpu_loop(self) -> None:
        while not self._shutdown.is_set():
            sample = await asyncio.to_thread(self.query_gpu_sample)
            if sample is not None:
                self.current_gpu = sample
                self.write_state(status="running")
            await asyncio.sleep(1.0)

    async def ingest_line(self, raw_line: str) -> None:
        line = raw_line.strip()
        if not line:
            return
        event = self.normalize_event(line)
        if isinstance(event.get("gpu"), dict):
            self.current_gpu = event["gpu"]
        elif self.current_gpu is not None:
            event["gpu"] = self.current_gpu
        self.event_count += 1
        self.last_event_type = str(event.get("type") or "unknown")
        self.last_progress = self.extract_progress(event)
        append_jsonl(self.output_path, event)
        self.write_state(status="running")

    async def tail_input(self) -> None:
        while not self._shutdown.is_set():
            if self.input_path.exists():
                with self.input_path.open("r", errors="replace") as fh:
                    fh.seek(self._stream_position)
                    chunk = fh.read()
                    self._stream_position = fh.tell()
                if chunk:
                    data = self._partial_line + chunk
                    lines = data.splitlines(keepends=True)
                    if lines and not lines[-1].endswith(("\n", "\r")):
                        self._partial_line = lines.pop()
                    else:
                        self._partial_line = ""
                    for raw_line in lines:
                        await self.ingest_line(raw_line)
            await asyncio.sleep(self.poll_interval)

    async def run(self) -> None:
        self.log("starting relay")
        self.write_state(status="starting")
        self.write_state(status="running")
        tail_task = asyncio.create_task(self.tail_input(), name="tail-input")
        gpu_task = asyncio.create_task(self.sample_gpu_loop(), name="gpu-sampler")
        try:
            await self._shutdown.wait()
        finally:
            tail_task.cancel()
            gpu_task.cancel()
            await asyncio.gather(tail_task, gpu_task, return_exceptions=True)
            self.log("relay stopped")
            self.write_state(status="stopped")

    def stop(self) -> None:
        self._shutdown.set()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, dest="input_path")
    parser.add_argument("--output", required=True, dest="output_path")
    parser.add_argument("--state", required=True, dest="state_path")
    parser.add_argument("--log", required=True, dest="log_path")
    parser.add_argument("--poll-interval", type=float, default=0.5)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    relay = TelemetryRelay(
        input_path=Path(args.input_path),
        output_path=Path(args.output_path),
        state_path=Path(args.state_path),
        log_path=Path(args.log_path),
        poll_interval=args.poll_interval,
    )
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for signame in ("SIGINT", "SIGTERM"):
        signum = getattr(signal, signame, None)
        if signum is not None:
            loop.add_signal_handler(signum, relay.stop)
    try:
        loop.run_until_complete(relay.run())
    finally:
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
