"""
casc_index.py - One-time CASC enumeration to build a filename->path index.

Run once against a local SC2 install:
    python casc_index.py "F:/StarCraft II" editor/data/casc-index.json

Produces a JSON map of every UI-relevant file in the CASC archive:
    {
      "version": "0.5.0",
      "scanned_at": "...",
      "sc2_build": "5.0.15.96883",
      "files": {
        "ui_heroicons_frame_normalpressed_terran.dds": "Mods\\Core.SC2Mod\\Base.SC2Assets\\Assets\\Textures\\ui_heroicons_frame_normalpressed_terran.dds",
        "btn-upgrade-terran-armoredexoskeletons.dds":  "Mods\\NovaStoryAssets.SC2Mod\\Base.SC2Assets\\Assets\\Textures\\btn-upgrade-terran-armoredexoskeletons.dds",
        ...
      }
    }

The editor uses this index to skip mod-prefix fan-out and go straight to the
correct path for any referenced texture. Generated index is bundled with the
editor and updated whenever the user re-runs this tool.

This tool exits early once we've enumerated enough or the user Ctrl+C's;
it streams progress to stdout so even partial output is useful.
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import time
from ctypes import wintypes
from pathlib import Path

# Reuse the DLL bindings from casc.py.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import casc  # noqa: E402
try:
    from version import VERSION as _VERSION
except ImportError:
    _VERSION = "?"


MAX_PATH = 1024


class CASC_FIND_DATA(ctypes.Structure):
    _fields_ = [
        ("szFileName", ctypes.c_char * MAX_PATH),
        ("szPlainName", ctypes.c_char_p),
        ("CKey", ctypes.c_ubyte * 16),
        ("EKey", ctypes.c_ubyte * 16),
        ("TagString", ctypes.c_char * MAX_PATH),
        ("LocaleFlags", wintypes.DWORD),
        ("ContentFlags", wintypes.DWORD),
        ("FileNameHash", ctypes.c_uint64),
        ("FileDataId", wintypes.DWORD),
        ("FileSize", ctypes.c_uint64),
        ("SpanCount", wintypes.DWORD),
        ("bFileAvailable", wintypes.DWORD),
        ("bData", ctypes.c_ubyte * 28),
    ]


# Extensions we want to index. Everything else gets skipped to keep the
# resulting JSON small and the enumeration fast.
INTERESTING_EXTENSIONS = (
    b".dds", b".tga", b".png", b".jpg",                       # textures
    b".ttf", b".otf", b".dfont",                              # fonts
    b".sc2layout", b".sc2style",                              # layouts + style sheets
)


def build_index(sc2_install: Path, out_path: Path) -> dict:
    dll = casc._load_dll()

    dll.CascFindFirstFile.argtypes = [
        wintypes.HANDLE, ctypes.c_char_p,
        ctypes.POINTER(CASC_FIND_DATA), ctypes.c_char_p,
    ]
    dll.CascFindFirstFile.restype = wintypes.HANDLE
    dll.CascFindNextFile.argtypes = [wintypes.HANDLE, ctypes.POINTER(CASC_FIND_DATA)]
    dll.CascFindNextFile.restype = wintypes.BOOL
    dll.CascFindClose.argtypes = [wintypes.HANDLE]
    dll.CascFindClose.restype = wintypes.BOOL

    print(f"[casc-index] opening {sc2_install}")
    storage = wintypes.HANDLE()
    ok = dll.CascOpenStorage(str(sc2_install).encode("mbcs"), 0, ctypes.byref(storage))
    if not ok or not storage:
        raise casc.CascError("could not open CASC storage", dll.GetCascError())

    files: dict[str, str] = {}
    collisions: dict[str, list[str]] = {}
    total = 0
    last_print = time.time()
    last_index_growth = time.time()
    last_indexed_count = 0
    started = time.time()
    PLATEAU_SECONDS = 5.0   # exit once no new indexed file has appeared this long

    fd = CASC_FIND_DATA()
    find = dll.CascFindFirstFile(storage, b"*", ctypes.byref(fd), None)
    if not find:
        raise casc.CascError("CascFindFirstFile failed", dll.GetCascError())
    try:
        while True:
            total += 1
            name_bytes = bytes(fd.szFileName).rstrip(b"\x00")
            lower = name_bytes.lower()
            if any(lower.endswith(ext) for ext in INTERESTING_EXTENSIONS):
                full = name_bytes.decode("mbcs", errors="replace")
                leaf = full.rsplit("\\", 1)[-1].lower()
                # Compare lower-case versions so case-variant duplicates from
                # CASC enumeration ("Mods\Foo" vs "MODS\foo") aren't recorded
                # as fake collisions. Real different-path collisions (same
                # leaf in different mod folders) still register.
                if leaf in files and files[leaf].lower() != full.lower():
                    collisions.setdefault(leaf, [files[leaf]]).append(full)
                else:
                    files[leaf] = full
            # Track growth so we can bail when CascLib starts walking internal
            # records that aren't named files. SC2's CASC has tens of millions
            # of internal entries to traverse after the ~50k named ones.
            now = time.time()
            if len(files) > last_indexed_count:
                last_indexed_count = len(files)
                last_index_growth = now
            if now - last_print > 2.0:
                last_print = now
                print(f"[casc-index] scanned {total:,} files; indexed {len(files):,} so far "
                      f"({now - started:.1f}s)", flush=True)
            if now - last_index_growth > PLATEAU_SECONDS:
                print(f"[casc-index] plateau detected ({PLATEAU_SECONDS}s no new indexed file), exiting early.",
                      flush=True)
                break
            if not dll.CascFindNextFile(find, ctypes.byref(fd)):
                break
    finally:
        dll.CascFindClose(find)
        dll.CascCloseStorage(storage)

    elapsed = time.time() - started
    print(f"[casc-index] done: {total:,} files scanned, {len(files):,} indexed, "
          f"{len(collisions):,} filename collisions ({elapsed:.1f}s)")

    payload = {
        "version": _VERSION,
        "scanned_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "sc2_install": str(sc2_install),
        "stats": {
            "total_files_scanned": total,
            "indexed_files": len(files),
            "filename_collisions": len(collisions),
            "scan_seconds": round(elapsed, 1),
        },
        "files": dict(sorted(files.items())),
        # Keep collisions around but separately - they're filename duplicates
        # across mods (e.g. same UI texture re-shipped per campaign). The
        # editor can fall back to these if the primary lookup fails.
        "collisions": {k: sorted(set(v)) for k, v in collisions.items()},
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    size_kb = out_path.stat().st_size / 1024
    print(f"[casc-index] wrote {out_path} ({size_kb:.1f} KB)")
    return payload


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sc2_install", type=Path, help="Path to SC2 install (contains StarCraft II.exe).")
    ap.add_argument("out", type=Path, nargs="?",
                    default=Path(__file__).resolve().parent / "editor" / "data" / "casc-index.json")
    args = ap.parse_args()
    if not (args.sc2_install / "StarCraft II.exe").exists():
        print(f"[casc-index] ERROR: not a SC2 install: {args.sc2_install}", file=sys.stderr)
        return 1
    try:
        build_index(args.sc2_install, args.out)
        return 0
    except KeyboardInterrupt:
        print("\n[casc-index] interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
