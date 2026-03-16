#!/usr/bin/env python3
from __future__ import annotations

import json
import py_compile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def source_files() -> list[Path]:
    roots = [
        REPO_ROOT / "prepare.py",
        REPO_ROOT / "train.py",
    ]
    script_root = REPO_ROOT / "scripts"
    roots.extend(sorted(script_root.glob("*.py")))
    return [path for path in roots if path.exists() and path.is_file()]


def main() -> int:
    checked_files: list[str] = []
    for file_path in source_files():
        py_compile.compile(str(file_path), doraise=True)
        checked_files.append(file_path.relative_to(REPO_ROOT).as_posix())

    print(
        json.dumps(
            {
                "checkedCount": len(checked_files),
                "checkedFiles": checked_files,
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
