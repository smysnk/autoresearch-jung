#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import time
from typing import Any


MAX_CAPTURE_CHARS = 20_000


def trim(value: str) -> str:
    if len(value) <= MAX_CAPTURE_CHARS:
        return value
    return value[: MAX_CAPTURE_CHARS - 1] + "…"


def maybe_parse_json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def main(argv: list[str]) -> int:
    if "--" not in argv:
        raise SystemExit("Usage: test_station_check.py -- <command> [args...]")

    delimiter = argv.index("--")
    command = argv[delimiter + 1 :]
    if not command:
        raise SystemExit("Expected a command after --")

    started = time.time()
    completed = subprocess.run(command, capture_output=True, text=True)
    duration_ms = int((time.time() - started) * 1000)

    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    parsed_stdout = maybe_parse_json(stdout.strip()) if stdout.strip() else None

    payload: dict[str, Any] = {
        "status": "passed" if completed.returncode == 0 else "failed",
        "message": (
            f"Command completed successfully: {' '.join(command)}"
            if completed.returncode == 0
            else f"Command failed with exit code {completed.returncode}: {' '.join(command)}"
        ),
        "command": command,
        "exitCode": completed.returncode,
        "durationMs": duration_ms,
        "stdout": trim(stdout),
        "stderr": trim(stderr),
    }

    if parsed_stdout is not None:
        payload["commandPayload"] = parsed_stdout

    print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
