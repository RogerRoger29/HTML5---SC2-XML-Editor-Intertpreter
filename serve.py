#!/usr/bin/env python3
"""
serve.py - Static file server for the SC2 UI Editor.

Two run modes:
  1. Development (python serve.py from the sc2-ui-editor/ folder)
  2. Frozen executable (PyInstaller --onefile output, double-clicked .exe)

URL routes:
  /                 -> editor/    (the HTML/JS/CSS app, bundled into the exe)
  /project/         -> the folder containing user mod .SC2Mod directories
  /assets/          -> extracted SC2 stock mods (core/liberty/swarm/void)
  /__config         -> GET: editor learns current paths
  /__config         -> POST: editor writes a new assets path; persisted to disk
  /__ls?path=...    -> directory listing as JSON (used by file picker)

Asset path resolution (first hit wins):
  1. --assets <path>                   (command-line flag)
  2. SC2_ASSETS environment variable
  3. config.json next to the exe (or serve.py): {"assets_root": "..."}
  4. ./mods/                            (sibling of the exe)
  5. ./extracted/mods/
  6. Hard-coded common SC2 install locations on Windows
  7. The development path (only when running from source)
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import socketserver
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

# Single source of truth for the editor's Python-side version. Mirrors
# editor/js/version.js. Used in the /__config response so the in-browser
# About dialog and tester bug reports show the correct version. Robust to
# the import not resolving (frozen-mode oddities) by falling back to "?".
sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from version import VERSION
except ImportError:
    VERSION = "?"


# ---------------------------------------------------------------------------
# Path discovery: dev mode vs PyInstaller --onefile bundle.
# ---------------------------------------------------------------------------

def _is_frozen() -> bool:
    return getattr(sys, "frozen", False)


def _bundle_dir() -> Path:
    """Where the bundled editor/ tree lives.

    Frozen: PyInstaller extracts it to a temp dir at sys._MEIPASS.
    Dev: alongside this script.
    """
    if _is_frozen():
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def _exe_dir() -> Path:
    """Where the exe / launcher lives (used for config.json + nearby mods/ folder)."""
    if _is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


BUNDLE_DIR = _bundle_dir()
EXE_DIR = _exe_dir()
EDITOR_ROOT = BUNDLE_DIR / "editor"
CONFIG_PATH = EXE_DIR / "sc2-ui-editor-config.json"

# Hard-coded fallback list for auto-detection. The first one that exists wins.
WINDOWS_COMMON_PATHS = [
    Path(r"C:\Program Files (x86)\StarCraft II\Mods"),
    Path(r"C:\Program Files\StarCraft II\Mods"),
    Path(r"D:\StarCraft II\Mods"),
]
# When running from source on the developer's machine.
DEV_ASSETS_PATH = Path(r"F:\Users\Nicholas\Downloads\Work\mods")


# Module-level lock guarding ALL shared state mutated by request threads:
#   - load_config / save_config (concurrent /__config POSTs could lose writes)
#   - Router.casc_storage lazy init (two POSTs could both create one, leak the loser)
#   - Router.casc_index lazy init (same)
#   - Router.assets_root / assets_source updates from /__cascextract /__config
# The HTTP server is ThreadingTCPServer, so any of these can race in practice.
_STATE_LOCK = threading.RLock()


def load_config() -> dict:
    with _STATE_LOCK:
        if CONFIG_PATH.exists():
            try:
                return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            except Exception as err:
                print(f"[serve] warning: could not read {CONFIG_PATH}: {err}", file=sys.stderr)
        return {}


def save_config(cfg: dict) -> None:
    # Atomic write: serialize to a temp sibling, then rename. Rename is atomic
    # on the same filesystem, so a concurrent read either sees the old file
    # or the complete new one - never a half-written JSON.
    with _STATE_LOCK:
        try:
            tmp = CONFIG_PATH.with_suffix(CONFIG_PATH.suffix + ".tmp")
            tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
            os.replace(tmp, CONFIG_PATH)
        except Exception as err:
            print(f"[serve] warning: could not write {CONFIG_PATH}: {err}", file=sys.stderr)


def autodetect_assets() -> tuple[Path | None, str]:
    """Try every known location for the extracted SC2 mods folder.

    Returns (path, reason). Reason describes which heuristic matched, useful
    for the editor to surface to the user.
    """
    # 1. CLI flag handled by caller.
    # 2. Env var.
    env = os.environ.get("SC2_ASSETS")
    if env and Path(env).exists():
        return Path(env), "SC2_ASSETS env var"
    # 3. config.json
    cfg = load_config()
    cfg_path = cfg.get("assets_root")
    if cfg_path:
        p = Path(cfg_path)
        if p.exists():
            return p, "config.json"
    # 4. mods/ next to the exe (most likely for distributed copies).
    for sibling in ("mods", "extracted/mods", "data/mods"):
        p = EXE_DIR / sibling
        if p.exists() and any(p.iterdir()):
            return p, f"./{sibling} next to launcher"
    # 5. SC2 game install (won't actually have extracted mods but worth trying).
    for p in WINDOWS_COMMON_PATHS:
        if p.exists():
            return p, "SC2 install Mods folder"
    # 6. Dev path - only used when running from source.
    if not _is_frozen() and DEV_ASSETS_PATH.exists():
        return DEV_ASSETS_PATH, "dev default"
    return None, "none found"


def autodetect_project_root() -> Path:
    """The folder containing user mod .SC2Mod directories.

    Defaults to the exe's parent (so dropping mods next to the .exe works).
    """
    return EXE_DIR


# ---------------------------------------------------------------------------
# HTTP handler.
# ---------------------------------------------------------------------------

class Router(http.server.SimpleHTTPRequestHandler):
    assets_root: Path | None = None
    project_root: Path = EXE_DIR
    assets_source: str = "unset"
    # CascStorage and CascIndex are heavyweight and live for the whole server
    # lifetime so the first CASC open (~30s) only happens once per session.
    casc_storage = None     # type: 'casc.CascStorage | None'
    casc_index = None       # type: 'casc.CascIndex | None'

    def translate_path(self, path: str) -> str:
        parsed = urllib.parse.urlsplit(path)
        url_path = urllib.parse.unquote(parsed.path)
        # Routing prefixes onto distinct filesystem roots.
        if url_path.startswith("/assets/") or url_path == "/assets":
            base = self.assets_root or EDITOR_ROOT
            rel = url_path[len("/assets"):].lstrip("/")
        elif url_path.startswith("/project/") or url_path == "/project":
            base = self.project_root
            rel = url_path[len("/project"):].lstrip("/")
        else:
            base = EDITOR_ROOT
            rel = url_path.lstrip("/")
        rel = rel.replace("\\", "/")
        # Filter out empty, current-dir, parent-dir, AND any Windows drive
        # letter (e.g. "C:") - because Path.joinpath('C:', ...) on Windows
        # silently RESETS the path to that absolute drive, escaping `base`.
        # Reserved/UNC components are similarly hostile.
        parts = []
        for p in rel.split("/"):
            if p in ("", ".", ".."):
                continue
            # Drive letter (C:, D:, etc.) or any segment with a colon or
            # leading backslash - reject defensively.
            if len(p) == 2 and p[1] == ":" and p[0].isalpha():
                continue
            if ":" in p or p.startswith("\\"):
                continue
            parts.append(p)
        candidate = base.joinpath(*parts)
        # Final belt-and-braces: resolve and verify the result still lives
        # under base. This catches symlink shenanigans and any traversal
        # the per-segment filter missed.
        try:
            resolved = candidate.resolve(strict=False)
            base_resolved = base.resolve(strict=False)
            # Path.is_relative_to is 3.9+ (project requires 3.10+).
            if not resolved.is_relative_to(base_resolved):
                return str(base_resolved)   # safe fallback: serve base itself
        except (OSError, ValueError):
            return str(base)
        return str(candidate)

    def do_GET(self):  # noqa: N802 (http.server naming)
        path = self.path.split("?", 1)[0]
        if path == "/__config":
            return self._send_config()
        if path.startswith("/__ls"):
            return self._send_ls()
        super().do_GET()

    def do_POST(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/__config":
            return self._receive_config()
        if path == "/__download":
            return self._download_stock()
        if path == "/__cascextract":
            return self._casc_extract()
        self.send_error(404, "Not Found")

    # -- CASC extraction ---------------------------------------------------
    # POST /__cascextract  body keys (any combination):
    #   "files":          ["Mods\\Core.SC2Mod\\..."]    # explicit CASC paths
    #   "filenames":      ["ui_foo.dds", ...]           # leaf names, resolved
    #                                                    via casc-index.json
    #   "texture_refs":   ["@@@UI/Foo", "Assets\\...\\foo.dds"]  # SC2 layout
    #                                                    refs, resolved via
    #                                                    Assets.txt aliases
    #   "all_textures":   true                          # every Assets.txt
    #                                                    entry across the
    #                                                    14 known mod prefixes
    #   "include_fonts":  true                          # known UI font files
    #
    # The persistent CascStorage handle is opened lazily on first call so
    # there's a one-time ~30s wait. Subsequent calls in the same session
    # reuse the handle and finish in ms per file.
    def _casc_extract(self):
        try:
            from casc import (
                CascStorage, CascIndex, detect_sc2_install,
                common_texture_paths_from_aliases,
            )
        except Exception as err:
            return self._send_json({"error": "casclib_unavailable", "detail": str(err)}, status=500)
        try:
            # Cap body at 1 MB. Texture-ref lists are tiny (maybe 10 KB for
            # the largest layout); anything larger is a misuse and an
            # unbounded Content-Length would OOM the server thread.
            length = int(self.headers.get("Content-Length") or 0)
            if length > 1_048_576:
                return self._send_json({"error": "body_too_large", "limit": 1_048_576}, status=413)
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except Exception as err:
            return self._send_json({"error": "bad_json", "detail": str(err)}, status=400)

        cfg = load_config()
        cfg_sc2 = cfg.get("sc2_install")
        if cfg_sc2 and Path(cfg_sc2).exists() and (Path(cfg_sc2) / "StarCraft II.exe").exists():
            sc2_install, source = Path(cfg_sc2), "config.json (user-set)"
        else:
            sc2_install, source = detect_sc2_install()
        if not sc2_install:
            return self._send_json({"error": "sc2_not_found"}, status=404)

        # Lazy-create the long-lived storage handle on the first request.
        # When the install path CHANGES (user repointed SC2 install path in
        # config), close the old storage first - otherwise CascLib keeps the
        # previous archive's mapped memory (~100 MB) until process exit.
        # Lock so two concurrent /__cascextract POSTs don't both create a
        # CascStorage and leak one.
        with _STATE_LOCK:
            if Router.casc_storage is None or Router.casc_storage.install_path != sc2_install:
                if Router.casc_storage is not None:
                    try: Router.casc_storage.close()
                    except Exception: pass
                Router.casc_storage = CascStorage(sc2_install)
            if Router.casc_index is None:
                Router.casc_index = CascIndex()
                idx_path = EDITOR_ROOT / "data" / "casc-index.json"
                n = Router.casc_index.load(idx_path)
                if n:
                    print(f"[serve] loaded CASC index: {n} files from {idx_path}", file=sys.stderr)

        # Build the final list of CASC paths to try.
        files: list[str] = list(body.get("files") or [])
        # filenames -> resolve via index, fall back to mod-prefix fan-out.
        aliases = self._load_alias_map()
        for leaf in body.get("filenames") or []:
            files.extend(self._resolve_to_casc_paths(leaf, aliases))
        # texture_refs (SC2 alias or literal path strings as they appear in XML).
        for ref in body.get("texture_refs") or []:
            ref_clean = ref.lstrip("@").replace("/", "\\")
            # An alias key -> Assets.txt value
            if ref.lstrip("@") in aliases:
                resolved = aliases[ref.lstrip("@")]
                files.extend(self._resolve_to_casc_paths(resolved, aliases))
            else:
                files.extend(self._resolve_to_casc_paths(ref_clean, aliases))
        # layout_refs: template file basenames like "StandardTemplates" or
        # "HeroPanel". Resolve to the corresponding .SC2Layout via index.
        for base in body.get("layout_refs") or []:
            leaf = base.split("/")[-1].split("\\")[-1]
            if not leaf.lower().endswith((".sc2layout", ".sc2style")):
                leaf = leaf + ".SC2Layout"
            files.extend(self._resolve_to_casc_paths(leaf, aliases))
        # include_refs: <Include path="..."/> values. Take the filename leaf
        # since the index is keyed by leaf.
        for inc in body.get("include_refs") or []:
            leaf = inc.replace("/", "\\").rsplit("\\", 1)[-1]
            if leaf:
                files.extend(self._resolve_to_casc_paths(leaf, aliases))
        # When the open file uses <Style val="..."/>, pull FontStyles +
        # the BlizzardGlobal/Eurostile fonts so labels render in real type.
        if body.get("include_fontstyles"):
            for leaf in ("FontStyles.SC2Style", "DescIndex.SC2Layout",
                         "bl.ttf", "Eurostile-Reg.otf", "Eurostile-Bol.otf",
                         "Eurostile-Med.otf", "EurostileExt-Reg.otf",
                         "EurostileExt-Med.otf"):
                files.extend(self._resolve_to_casc_paths(leaf, aliases))
        if body.get("all_textures"):
            # Prefer the bundled CASC index: it maps each filename to its EXACT
            # archive path (no fan-out misses). Falls back to the old broad
            # fan-out only when no index is loaded.
            if Router.casc_index and Router.casc_index.files:
                for value in aliases.values():
                    leaf = value.replace("/", "\\").rsplit("\\", 1)[-1]
                    matches = Router.casc_index.lookup(leaf)
                    files.extend(matches)
            else:
                files.extend(common_texture_paths_from_aliases(aliases))
        if body.get("include_fonts"):
            # Look up font filenames in the index when available; otherwise use
            # the hard-coded list.
            if Router.casc_index and Router.casc_index.files:
                for leaf in ("bl.ttf", "Eurostile-Reg.otf", "Eurostile-Bol.otf",
                             "Eurostile-Med.otf", "EurostileExt-Reg.otf",
                             "EurostileExt-Med.otf", "FontStyles.SC2Style"):
                    matches = Router.casc_index.lookup(leaf)
                    files.extend(matches)
            else:
                files.extend(self._known_font_paths())
        # Dedupe while preserving order.
        seen = set()
        files = [f for f in files if not (f in seen or seen.add(f))]
        if not files:
            return self._send_json({"error": "no_files_requested"}, status=400)

        out_dir = (Router.assets_root or EXE_DIR / "stock-data")
        try:
            Router.casc_storage.open()
            result = Router.casc_storage.extract_batch(files, out_dir)
        except Exception as err:
            return self._send_json({"error": "extract_failed", "detail": str(err)}, status=500)
        result["assets_root"] = str(out_dir)
        result["sc2_install"] = str(sc2_install)
        result["source"] = source
        result["index_loaded"] = len(Router.casc_index.files) if Router.casc_index else 0
        # If we just downloaded our first content here, promote stock-data as
        # the active assets root (only when no assets folder is already set).
        with _STATE_LOCK:
            if not Router.assets_root and result["extracted"]:
                Router.assets_root = out_dir
                Router.assets_source = "casc-extracted"
                cfg["assets_root"] = str(out_dir)
                save_config(cfg)
        self._send_json(result)

    def _resolve_to_casc_paths(self, ref: str, aliases: dict) -> list[str]:
        """Map a texture filename or relative path to plausible CASC paths.

        Uses the CASC index first (exact-match lookup, no false negatives);
        falls back to the legacy mod-prefix fan-out if no index is loaded
        or the leaf name isn't in it."""
        idx = Router.casc_index
        leaf = ref.replace("/", "\\").rsplit("\\", 1)[-1]
        if idx:
            matches = idx.lookup(leaf)
            if matches:
                return matches
        # Fallback: fan-out across known mod prefixes.
        from casc import CASC_MOD_PREFIXES
        rel = ref.replace("/", "\\").lstrip("\\")
        # If the caller already passed a Mods\\... prefix, use as-is.
        if rel.lower().startswith("mods\\"):
            return [rel]
        # Otherwise assume Assets\\Textures\\foo.dds style.
        return [f"Mods\\{mod}.{ext}\\Base.SC2Assets\\{rel}"
                for (mod, ext) in CASC_MOD_PREFIXES]

    # Load Assets.txt aliases from the active assets_root (if any).
    def _load_alias_map(self) -> dict:
        out = {}
        root = Router.assets_root
        if not root:
            return out
        for mod in ("core.sc2mod", "liberty.sc2mod", "swarm.sc2mod", "void.sc2mod"):
            for variant in (root / mod / "base.sc2data" / "GameData" / "Assets.txt",
                            root / mod / "Base.SC2Data" / "GameData" / "Assets.txt"):
                if variant.exists():
                    for line in variant.read_text(encoding="utf-8", errors="ignore").splitlines():
                        line = line.strip()
                        if not line or line.startswith("//") or line.startswith(";"):
                            continue
                        if "=" not in line:
                            continue
                        k, v = line.split("=", 1)
                        out[k.strip()] = v.strip()
                    break
        return out

    def _known_font_paths(self) -> list:
        # Both BlizzardGlobal (bl.ttf) and Eurostile variants ship with Core.
        # FontStyles.SC2Style references them by these names, and Windows is
        # case-insensitive so the exact casing here doesn't matter for serving.
        return [
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\bl.ttf",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\Eurostile-Reg.otf",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\Eurostile-Bol.otf",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\Eurostile-Med.otf",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\EurostileExt-Reg.otf",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\EurostileExt-Med.otf",
            # FontStyles also references these (per the file's CodepointRange entries).
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\FontStyles.SC2Style",
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Layout\DescIndex.SC2Layout",
        ]

    # -- stock-data downloader ---------------------------------------------
    # Reads editor/data/stock-manifest.json, fetches each file from its baseUrl,
    # writes to ./stock-data/<relative path>, sets that as the new assets_root,
    # and persists the choice to config.json.
    def _download_stock(self):
        manifest_path = EDITOR_ROOT / "data" / "stock-manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as err:
            return self._send_json({"error": "manifest_read_failed", "detail": str(err)}, status=500)
        base_url = manifest.get("baseUrl", "").rstrip("/") + "/"
        files = manifest.get("files", [])
        if not base_url or not files:
            return self._send_json({"error": "manifest_invalid"}, status=500)
        out_dir = (EXE_DIR / "stock-data").resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        downloaded, skipped, failed = [], [], []
        total_bytes = 0
        # Defense in depth: the manifest is bundled with the editor so it's
        # trusted in practice, but a stray `../../etc` in a `rel` field would
        # let it write outside out_dir. Resolve the target and verify it
        # stays under our extraction root before writing.
        for rel in files:
            target = (out_dir / rel.replace("/", os.sep))
            try:
                target_resolved = target.resolve(strict=False)
                if not target_resolved.is_relative_to(out_dir):
                    failed.append({"file": rel, "error": "path_escape"})
                    continue
            except (OSError, ValueError):
                failed.append({"file": rel, "error": "path_invalid"})
                continue
            if target.exists() and target.stat().st_size > 0:
                skipped.append(rel)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            url = base_url + rel
            try:
                req = urllib.request.Request(url, headers={"User-Agent": f"sc2-ui-editor/0.5"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = resp.read()
                target.write_bytes(data)
                downloaded.append(rel)
                total_bytes += len(data)
            except Exception as err:
                failed.append({"file": rel, "error": str(err)})
        # Promote stock-data to the active assets root.
        with _STATE_LOCK:
            Router.assets_root = out_dir
            Router.assets_source = "downloaded"
            cfg = load_config()
            cfg["assets_root"] = str(out_dir)
            save_config(cfg)
        self._send_json({
            "downloaded": len(downloaded),
            "skipped": len(skipped),
            "failed": failed,
            "total": len(files),
            "bytes": total_bytes,
            "assets_root": str(out_dir),
        })

    # -- JSON helpers -------------------------------------------------------
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_config(self) -> None:
        # Honour a user-set SC2 install path from config.json before auto-detecting.
        cfg = load_config()
        sc2_install, sc2_source = None, "not found"
        cfg_sc2 = cfg.get("sc2_install")
        if cfg_sc2 and Path(cfg_sc2).exists() and (Path(cfg_sc2) / "StarCraft II.exe").exists():
            sc2_install, sc2_source = Path(cfg_sc2), "config.json (user-set)"
        else:
            try:
                from casc import detect_sc2_install
                sc2_install, sc2_source = detect_sc2_install()
            except Exception as err:
                sc2_source = f"detect failed: {err}"
        self._send_json({
            "version": VERSION,
            "frozen": _is_frozen(),
            "exe_dir": str(EXE_DIR),
            "project_root": str(Router.project_root),
            "assets_root": str(Router.assets_root) if Router.assets_root else None,
            "assets_present": bool(Router.assets_root and Router.assets_root.exists()),
            "assets_source": Router.assets_source,
            "sc2_install": str(sc2_install) if sc2_install else None,
            "sc2_install_source": sc2_source,
        })

    def _receive_config(self) -> None:
        try:
            # Cap body at 64 KB - config payloads are tiny; an unbounded
            # Content-Length here would OOM the server.
            length = int(self.headers.get("Content-Length") or 0)
            if length > 65536:
                return self._send_json({"error": "body_too_large", "limit": 65536}, status=413)
            body = self.rfile.read(length).decode("utf-8") if length else "{}"
            data = json.loads(body)
        except Exception as err:
            return self._send_json({"error": "bad_json", "detail": str(err)}, status=400)
        # All config read/mutate/write happens under the global state lock so
        # two concurrent POSTs can't lose each other's updates.
        with _STATE_LOCK:
            cfg = load_config()
            # Assets path override.
            new_path = data.get("assets_root")
            if new_path:
                p = Path(new_path)
                if not p.exists():
                    return self._send_json({"error": "not_found", "path": str(p)}, status=400)
                Router.assets_root = p
                Router.assets_source = "user-set"
                cfg["assets_root"] = str(p)
            # SC2 install path override - used by /__cascextract when auto-detect
            # misses the user's install (non-standard location / Battle.net layout).
            new_sc2 = data.get("sc2_install")
            if new_sc2:
                p = Path(new_sc2)
                if not (p.exists() and (p / "StarCraft II.exe").exists()):
                    return self._send_json({"error": "sc2_not_found_at_path", "path": str(p)}, status=400)
                cfg["sc2_install"] = str(p)
            save_config(cfg)
        return self._send_config()

    def _send_ls(self) -> None:
        query = urllib.parse.urlsplit(self.path).query
        params = urllib.parse.parse_qs(query)
        target_url = params.get("path", [""])[0]
        fs_path = Path(self.translate_path(target_url or "/"))
        if not fs_path.exists():
            return self._send_json({"error": "not_found", "path": str(fs_path)}, status=404)
        if not fs_path.is_dir():
            return self._send_json({"error": "not_a_directory", "path": str(fs_path)}, status=400)
        try:
            entries = [
                {"name": c.name, "is_dir": c.is_dir(), "size": (c.stat().st_size if c.is_file() else None)}
                for c in sorted(fs_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            ]
        except PermissionError:
            return self._send_json({"error": "permission_denied", "path": str(fs_path)}, status=403)
        self._send_json({"path": str(fs_path), "entries": entries})

    def log_message(self, fmt: str, *args) -> None:
        # In frozen (no-console) mode there is no stderr to write to; silence
        # default chatter. Errors still surface via send_error if needed.
        if _is_frozen():
            return
        sys.stderr.write("[serve] %s - %s\n" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="SC2 UI Editor static server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--assets", type=Path, default=None,
                        help="Path to extracted SC2 stock mods (folder containing core.sc2mod, etc.)")
    parser.add_argument("--project", type=Path, default=None,
                        help="Path to the folder containing user mod .SC2Mod folders.")
    parser.add_argument("--no-open", action="store_true", help="Do not auto-open the browser")
    args = parser.parse_args()

    if not EDITOR_ROOT.exists():
        print(f"[serve] FATAL: editor/ folder not found at {EDITOR_ROOT}", file=sys.stderr)
        return 2

    # Resolve assets root (CLI > autodetect).
    assets_path, source = None, "unset"
    if args.assets:
        if args.assets.exists():
            assets_path, source = args.assets, "command line"
        else:
            print(f"[serve] WARNING: --assets path does not exist: {args.assets}", file=sys.stderr)
    if not assets_path:
        assets_path, source = autodetect_assets()

    Router.assets_root = assets_path
    Router.assets_source = source
    Router.project_root = args.project or autodetect_project_root()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    # Port fallback: walk forward from --port up to 10 ports so another app
    # using 8765 doesn't keep the editor from launching. The first successful
    # bind wins.
    httpd = None
    bound_port = None
    bind_errors = []
    for candidate in range(args.port, args.port + 10):
        try:
            httpd = Server(("127.0.0.1", candidate), Router)
            bound_port = candidate
            break
        except OSError as err:
            bind_errors.append((candidate, err))
    if not httpd:
        msg = f"[serve] FATAL: could not bind any port in {args.port}..{args.port + 9}.\n"
        for p, err in bind_errors:
            msg += f"  port {p}: {err}\n"
        print(msg, file=sys.stderr)
        return 2

    url = f"http://127.0.0.1:{bound_port}/"
    if not _is_frozen():
        if bound_port != args.port:
            print(f"[serve] note: port {args.port} was busy, using {bound_port} instead.")
        print(f"[serve] editor:   {url}")
        print(f"[serve] project:  {url}project/   ({Router.project_root})")
        if assets_path:
            print(f"[serve] assets:   {url}assets/    ({assets_path})   [{source}]")
        else:
            print(f"[serve] assets:   NOT FOUND - the editor will run in degraded mode.")
            print(f"[serve]           Pass --assets PATH or set SC2_ASSETS, then restart.")
        print("[serve] press Ctrl+C to stop.")

    with httpd:
        if not args.no_open:
            opened = False
            err_msg = None
            try:
                opened = webbrowser.open(url)
            except Exception as err:
                err_msg = str(err)
            # If we couldn't auto-open the browser AND we're in frozen mode
            # (no console output visible to the user), surface the URL via a
            # Tk messagebox so the user actually knows what happened. Without
            # this they get a black screen with nothing to click on.
            if not opened and _is_frozen():
                try:
                    import tkinter as tk
                    import tkinter.messagebox as mb
                    root = tk.Tk(); root.withdraw()
                    mb.showinfo(
                        "SC2 UI Editor",
                        f"Could not open your default browser automatically.\n\n"
                        f"Open this URL manually:\n  {url}\n\n"
                        + (f"Reason: {err_msg}" if err_msg else
                           "webbrowser.open returned False - no browser is registered as your default."))
                    root.destroy()
                except Exception:
                    pass    # tk also missing - nothing more we can do
            if opened and not _is_frozen():
                pass    # already printed the URL above; browser launched fine
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            if not _is_frozen():
                print("\n[serve] shutting down.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
