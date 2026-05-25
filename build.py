#!/usr/bin/env python3
"""
build.py - One-shot PyInstaller build for SC2 UI Editor.

Run from the sc2-ui-editor/ folder:
    python build.py

Produces dist/SC2UIEditor.exe (Windows). The .exe contains:
  - The Python interpreter
  - serve.py + all imports
  - The entire editor/ folder (HTML, JS, CSS, data/stock-frames.json)

What the .exe does when double-clicked:
  - Starts an HTTP server on 127.0.0.1:8765
  - Auto-opens the default browser to the editor
  - No console window pops up (--noconsole)
  - Tries to find a 'mods' folder next to itself, then SC2_ASSETS env var,
    then common SC2 install locations. Editor prompts if none found.
  - Stores user-picked asset paths in sc2-ui-editor-config.json next to the
    exe so the choice persists across runs.

You need PyInstaller installed:
    python -m pip install pyinstaller

The first build is slow (PyInstaller analyzes everything). Subsequent
builds reuse the cache and finish in a few seconds.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
BUILD_CACHE = HERE / "build"
SPEC_FILE = HERE / "SC2UIEditor.spec"


def ensure_pyinstaller() -> None:
    try:
        import PyInstaller  # noqa: F401
        return
    except ImportError:
        pass
    print("[build] PyInstaller not found; installing...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "pyinstaller"])


def clean() -> None:
    """Wipe previous build outputs."""
    for p in (DIST, BUILD_CACHE, SPEC_FILE):
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.exists():
            p.unlink()


def build() -> int:
    ensure_pyinstaller()
    editor_dir = HERE / "editor"
    if not editor_dir.exists():
        print(f"[build] ERROR: editor/ folder not found at {editor_dir}")
        return 1

    # --add-data uses ; on Windows, : on Unix. We target Windows so ; is fine.
    sep = ";" if sys.platform == "win32" else ":"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",                       # single executable
        "--name", "SC2UIEditor",
        "--noconsole",                     # no terminal window pops up
        "--add-data", f"{editor_dir}{sep}editor",
        # Hide pyinstaller's progress output - we'll print our own status.
        "--log-level", "WARN",
    ]
    # Bundle CascLib.dll alongside the .exe so the bundled server can extract
    # textures + fonts from a tester's SC2 install. It's referenced as a sibling
    # of serve.py at native/CascLib.dll.
    casclib = HERE / "native" / "CascLib.dll"
    if casclib.exists():
        cmd += ["--add-binary", f"{casclib}{sep}."]
        cmd += ["--hidden-import", "casc"]
        print(f"[build] bundling CascLib.dll ({casclib.stat().st_size // 1024} KB)")
    else:
        print(f"[build] note: native/CascLib.dll not present - CASC extraction will be unavailable.")
    cmd += [str(HERE / "serve.py")]
    print("[build] running:", " ".join(cmd))
    rc = subprocess.call(cmd, cwd=str(HERE))
    if rc != 0:
        print(f"[build] PyInstaller failed with exit code {rc}")
        return rc
    exe = DIST / "SC2UIEditor.exe"
    if exe.exists():
        size_mb = exe.stat().st_size / (1024 * 1024)
        print(f"[build] success: {exe} ({size_mb:.1f} MB)")
        print("[build] double-click the .exe to test, or distribute it to others.")
        return 0
    print("[build] WARNING: build appeared to succeed but exe not found.")
    return 1


def main() -> int:
    import argparse
    p = argparse.ArgumentParser(description="Build SC2UIEditor.exe with PyInstaller.")
    p.add_argument("--clean", action="store_true",
                   help="Delete previous build outputs before building.")
    args = p.parse_args()
    if args.clean:
        print("[build] cleaning previous outputs...")
        clean()
    return build()


if __name__ == "__main__":
    raise SystemExit(main())
