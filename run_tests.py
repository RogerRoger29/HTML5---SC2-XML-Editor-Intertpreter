#!/usr/bin/env python3
"""Run the SC2 UI Editor's self-contained and optional integration tests.

Examples:
    python run_tests.py
    python run_tests.py --integration
    python run_tests.py --layouts path/to/mod path/to/file.SC2Layout
"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


HERE = Path(__file__).resolve().parent
INTEGRATION_TESTS = {
    "test_aliases.mjs",
    "test_stock_load.mjs",
    "test_stock_overrides.mjs",
}
SPECIAL_TESTS = INTEGRATION_TESTS | {"test_roundtrip.mjs"}


def run(label: str, command: list[str], *, env: dict[str, str] | None = None) -> bool:
    print(f"\n== {label} ==", flush=True)
    result = subprocess.run(command, cwd=HERE, env=env, check=False)
    if result.returncode:
        print(f"FAILED: {label} (exit {result.returncode})", flush=True)
        return False
    return True


def layout_files(inputs: list[str]) -> list[str]:
    found: set[Path] = set()
    for raw in inputs:
        path = Path(raw).expanduser().resolve()
        if path.is_file():
            found.add(path)
        elif path.is_dir():
            found.update(p for p in path.rglob("*.SC2Layout") if p.is_file())
        else:
            print(f"warning: layout path does not exist: {path}", file=sys.stderr)
    return [str(path) for path in sorted(found, key=lambda p: str(p).lower())]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_server(base_url: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + 10
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"serve.py exited early with code {process.returncode}")
        try:
            with urllib.request.urlopen(base_url + "/__config", timeout=0.5):
                return
        except Exception as err:  # server may still be binding
            last_error = err
            time.sleep(0.1)
    raise RuntimeError(f"serve.py did not become ready: {last_error}")


def run_integration() -> bool:
    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(
        [sys.executable, str(HERE / "serve.py"), "--port", str(port), "--no-open"],
        cwd=HERE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    ok = True
    try:
        wait_for_server(base_url, process)
        env = os.environ.copy()
        env["SC2UI_TEST_BASE"] = base_url
        for name in sorted(INTEGRATION_TESTS):
            ok = run(name, ["node", name], env=env) and ok
    except Exception as err:
        print(f"FAILED: integration server ({err})", file=sys.stderr)
        ok = False
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--integration",
        action="store_true",
        help="start serve.py and run stock-layout and asset-resolution tests",
    )
    parser.add_argument(
        "--layouts",
        nargs="+",
        default=[],
        metavar="PATH",
        help="round-trip every .SC2Layout file found at these files/directories",
    )
    args = parser.parse_args()

    passed = True
    js_tests = sorted(
        path.name for path in HERE.glob("test_*.mjs") if path.name not in SPECIAL_TESTS
    )
    for name in js_tests:
        passed = run(name, ["node", name]) and passed

    passed = run(
        "Python unit tests",
        [sys.executable, "-m", "unittest", "discover", "-v", "-p", "test_*.py"],
    ) and passed

    layouts = layout_files(args.layouts)
    if args.layouts and not layouts:
        print("FAILED: --layouts did not find any .SC2Layout files", file=sys.stderr)
        passed = False
    elif layouts:
        # Keep each command comfortably below Windows' process command-line
        # limit when a full extracted SC2 tree contains hundreds of layouts.
        for offset in range(0, len(layouts), 100):
            batch = layouts[offset:offset + 100]
            label = (
                f"XML byte-exact round trip "
                f"({offset + 1}-{offset + len(batch)} of {len(layouts)})"
            )
            passed = run(label, ["node", "test_roundtrip.mjs", *batch]) and passed

    if args.integration:
        passed = run_integration() and passed

    print("\nALL TESTS PASSED" if passed else "\nTEST FAILURES", flush=True)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
