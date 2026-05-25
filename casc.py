"""
casc.py - SC2 install detection + on-demand CASC archive extraction.

Wraps CascLib.dll via ctypes so the editor's server can read textures and
fonts directly out of a tester's StarCraft II installation. Used by the
POST /__cascextract endpoint in serve.py.

Key types:
    CascStorage - long-lived handle to an opened CASC archive. Open is
                  expensive (~30s on a fresh launch as CascLib indexes),
                  so the server keeps one alive for the whole session.

Why CascLib (and not the pure-Python `pycasc` package): pycasc lacks a SC2
root-file handler (its `rootfiles/` folder covers Diablo3, Hearthstone, OW,
WoW, WC3 but not SC2). CascLib has a battle-tested SC2 handler.

The DLL is bundled with the editor's .exe (see build.py --add-binary).
At runtime we look for it in:
    1. sys._MEIPASS/CascLib.dll       (PyInstaller --onefile extraction dir)
    2. <repo>/native/CascLib.dll      (development mode)
"""
from __future__ import annotations

import ctypes
import json
import sys
import threading
from ctypes import wintypes
from pathlib import Path


# ---------------------------------------------------------------------------
# DLL loading
# ---------------------------------------------------------------------------

class CascError(Exception):
    """Raised when a CASC operation fails. .code is the last Windows error."""
    def __init__(self, msg: str, code: int = 0):
        super().__init__(f"{msg} (CASC error 0x{code:08X})" if code else msg)
        self.code = code


def _find_dll() -> Path | None:
    if getattr(sys, "frozen", False):
        # PyInstaller --onefile extracts data + DLLs to a temp dir.
        meipass = Path(getattr(sys, "_MEIPASS"))
        for candidate in (meipass / "CascLib.dll", meipass / "native" / "CascLib.dll"):
            if candidate.exists():
                return candidate
    # Development mode: serve.py's parent / native / CascLib.dll
    here = Path(__file__).resolve().parent
    candidate = here / "native" / "CascLib.dll"
    if candidate.exists():
        return candidate
    return None


_dll: ctypes.WinDLL | None = None

def _load_dll() -> ctypes.WinDLL:
    global _dll
    if _dll is not None:
        return _dll
    dll_path = _find_dll()
    if not dll_path:
        raise CascError(
            "CascLib.dll not found. Re-run build.py so the DLL is bundled, "
            "or place it under native/CascLib.dll for development.")
    _dll = ctypes.WinDLL(str(dll_path))

    # The bundled CascLib.dll is built without UNICODE defined, so LPCTSTR
    # resolves to LPCSTR (ANSI char*). Paths must be encoded bytes, not wstr.
    # bool CascOpenStorage(LPCSTR szParams, DWORD dwLocaleMask, HANDLE *phStorage);
    _dll.CascOpenStorage.argtypes = [ctypes.c_char_p, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    _dll.CascOpenStorage.restype = wintypes.BOOL
    # bool CascCloseStorage(HANDLE hStorage);
    _dll.CascCloseStorage.argtypes = [wintypes.HANDLE]
    _dll.CascCloseStorage.restype = wintypes.BOOL
    # bool CascOpenFile(HANDLE hStorage, const void *pvFileName, DWORD dwLocaleFlags, DWORD dwOpenFlags, HANDLE *PtrFileHandle);
    _dll.CascOpenFile.argtypes = [wintypes.HANDLE, ctypes.c_char_p, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    _dll.CascOpenFile.restype = wintypes.BOOL
    # bool CascReadFile(HANDLE hFile, void *lpBuffer, DWORD dwToRead, PDWORD pdwRead);
    _dll.CascReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    _dll.CascReadFile.restype = wintypes.BOOL
    # bool CascCloseFile(HANDLE hFile);
    _dll.CascCloseFile.argtypes = [wintypes.HANDLE]
    _dll.CascCloseFile.restype = wintypes.BOOL
    # bool CascGetFileSize64(HANDLE hFile, PULONGLONG PtrFileSize);
    _dll.CascGetFileSize64.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_uint64)]
    _dll.CascGetFileSize64.restype = wintypes.BOOL
    # DWORD GetCascError();
    _dll.GetCascError.argtypes = []
    _dll.GetCascError.restype = wintypes.DWORD
    return _dll


# CASC open file flag for "open by name" - matches CASC_OPEN_BY_NAME in CascLib.h.
CASC_OPEN_BY_NAME = 0x00000000  # default; just use name lookup
CASC_LOCALE_NONE = 0x00


# ---------------------------------------------------------------------------
# SC2 install detection
# ---------------------------------------------------------------------------

# Subfolder patterns checked under every available drive letter. SC2 modders
# often install on non-C: drives (one user had it at F:\StarCraft II) so we
# enumerate drives broadly rather than hard-coding a few popular ones.
SC2_SUBFOLDER_PATTERNS = [
    "StarCraft II",
    "Games\\StarCraft II",
    "Battle.net\\Games\\StarCraft II",
    "Battle.net\\StarCraft II",
    "Program Files\\StarCraft II",
    "Program Files (x86)\\StarCraft II",
]


def _enumerate_windows_drives() -> list[Path]:
    """Return every fixed/removable drive letter that exists, A: through Z:."""
    if sys.platform != "win32":
        return []
    drives = []
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        root = Path(f"{letter}:\\")
        if root.exists():
            drives.append(root)
    return drives


def _registry_install_paths() -> list[tuple[Path, str]]:
    """Mine the Windows registry for any plausible SC2 install hint."""
    if sys.platform != "win32":
        return []
    hits = []
    try:
        import winreg
    except ImportError:
        return []
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Blizzard Entertainment\StarCraft II"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Blizzard Entertainment\StarCraft II"),
        (winreg.HKEY_CURRENT_USER,  r"SOFTWARE\Blizzard Entertainment\StarCraft II"),
        # Battle.net's per-product install record on newer launchers.
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Blizzard Entertainment\Battle.net\Capabilities\Applications\Battle.net Game\SC2"),
    ]
    value_names = ("InstallPath", "GamePath", "InstallLocation", "Path")
    for hive, sub in keys:
        try:
            with winreg.OpenKey(hive, sub) as key:
                for name in value_names:
                    try:
                        value, _ = winreg.QueryValueEx(key, name)
                        p = Path(value)
                        if (p / "StarCraft II.exe").exists():
                            hits.append((p, f"registry: {sub}\\{name}"))
                    except FileNotFoundError:
                        continue
        except OSError:
            continue
    return hits


def detect_sc2_install() -> tuple[Path | None, str]:
    """Find SC2 on the local machine.

    Strategy (first hit wins):
      1. Windows registry (HKLM + WOW64 + HKCU, multiple value names)
      2. Every drive letter A:..Z: with a handful of conventional subfolders

    Returns (install_path, source) where install_path contains 'StarCraft II.exe'.
    """
    for path, source in _registry_install_paths():
        return path, source
    for drive in _enumerate_windows_drives():
        for pattern in SC2_SUBFOLDER_PATTERNS:
            p = drive / pattern
            if (p / "StarCraft II.exe").exists():
                return p, f"drive scan: {drive}{pattern}"
    return None, "not found"


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_files(sc2_install: Path, file_list: list[str], out_dir: Path) -> dict:
    """Open the SC2 CASC storage and extract requested files to out_dir.

    file_list entries are SC2 mod-relative paths like:
        Mods\\Core.SC2Mod\\Base.SC2Assets\\Assets\\Textures\\foo.dds

    out_dir/<file> mirrors the input path (so out_dir/Mods/.../foo.dds).
    Existing files are skipped. Returns {extracted, skipped, failed, bytes}.
    """
    dll = _load_dll()
    sc2_install = Path(sc2_install)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    storage = wintypes.HANDLE()
    # CascLib_dll was built ANSI; encode the path to bytes.
    ok = dll.CascOpenStorage(str(sc2_install).encode("mbcs"), CASC_LOCALE_NONE, ctypes.byref(storage))
    if not ok or not storage:
        raise CascError(f"could not open CASC storage at {sc2_install}", dll.GetCascError())

    extracted, skipped, failed = [], [], []
    total_bytes = 0
    try:
        for raw_path in file_list:
            # CascLib expects backslashes. Editor-side aliases tend to use them
            # already, but normalise just in case.
            casc_name = raw_path.replace("/", "\\").lstrip("\\")
            local_target = out_dir / casc_name.replace("\\", "/")
            if local_target.exists() and local_target.stat().st_size > 0:
                skipped.append(raw_path)
                continue
            try:
                local_target.parent.mkdir(parents=True, exist_ok=True)
                _extract_one(dll, storage, casc_name, local_target)
                extracted.append(raw_path)
                total_bytes += local_target.stat().st_size
            except CascError as err:
                failed.append({"file": raw_path, "error": str(err), "code": err.code})
            except Exception as err:
                failed.append({"file": raw_path, "error": str(err)})
    finally:
        dll.CascCloseStorage(storage)
    return {
        "extracted": len(extracted),
        "skipped": len(skipped),
        "failed": failed,
        "bytes": total_bytes,
    }


def _extract_one(dll, storage, casc_name: str, out_path: Path) -> None:
    file_handle = wintypes.HANDLE()
    # CascLib.dll is built ANSI - paths must be mbcs-encoded bytes, not
    # utf-8. ASCII-only paths work either way; non-ASCII (Cyrillic /
    # accented locale variants) silently 404 under utf-8.
    name_bytes = casc_name.encode("mbcs")
    ok = dll.CascOpenFile(storage, name_bytes, CASC_LOCALE_NONE, CASC_OPEN_BY_NAME, ctypes.byref(file_handle))
    if not ok or not file_handle:
        raise CascError(f"open {casc_name}", dll.GetCascError())
    try:
        size = ctypes.c_uint64(0)
        if not dll.CascGetFileSize64(file_handle, ctypes.byref(size)):
            raise CascError(f"size {casc_name}", dll.GetCascError())
        n = int(size.value)
        if n == 0:
            out_path.write_bytes(b"")
            return
        buf = (ctypes.c_ubyte * n)()
        read = wintypes.DWORD(0)
        # CascReadFile may need to be looped for large files; SC2 UI assets are
        # small so a single call is fine in practice. Loop defensively.
        offset = 0
        with open(out_path, "wb") as fp:
            while offset < n:
                want = min(n - offset, 1 << 20)  # 1 MiB chunks
                ok = dll.CascReadFile(file_handle, ctypes.byref(buf, offset), want, ctypes.byref(read))
                if not ok:
                    raise CascError(f"read {casc_name}", dll.GetCascError())
                if read.value == 0:
                    break
                fp.write(bytes(buf[offset:offset + read.value]))
                offset += read.value
    finally:
        dll.CascCloseFile(file_handle)


# Mods (and .stormmod packs) under which SC2 stores its UI/asset content in
# CASC. A given texture might live in any one of these.
# Empirically verified examples:
#   ui_heroicons_*.dds                -> Core
#   sc2_ui_glues_*.dds, btn-*.dds     -> Liberty
#   ui_nova_storymode_*.dds           -> NovaStoryAssets
#   renee_war3_btn*.dds               -> War3Data (WC3 crossover)
#   btn-unit-collection-*.dds         -> AlliedCommanders or campaign
# We try each prefix in order until one hits; misses cost nothing (CascLib
# just returns FILE_NOT_FOUND immediately).
# Once data/casc-index.json is generated (via casc_index.py), the server
# prefers exact-match lookup and this list becomes a fallback only.
CASC_MOD_PREFIXES = [
    # Sc2mod (.SC2Mod extension on disk)
    ("Core", "SC2Mod"),
    ("Liberty", "SC2Mod"),
    ("Swarm", "SC2Mod"),
    ("Void", "SC2Mod"),
    ("NovaStoryAssets", "SC2Mod"),
    ("LibertyStory", "SC2Mod"),
    ("SwarmStory", "SC2Mod"),
    ("VoidStory", "SC2Mod"),
    ("LibertyMulti", "SC2Mod"),
    ("SwarmMulti", "SC2Mod"),
    ("VoidMulti", "SC2Mod"),
    ("BalanceMulti", "SC2Mod"),
    ("AlliedCommanders", "SC2Mod"),
    ("VoidPrologue", "SC2Mod"),
    ("War3Data", "SC2Mod"),         # WC3 crossover textures (renee_war3_*)
    ("Frontiers", "SC2Mod"),
    ("Challenges", "SC2Mod"),
    ("Mutators", "SC2Mod"),
    # Storm mods (.StormMod) - shared with Heroes of the Storm, contain some
    # additional collection / unit / portrait textures.
    ("Core", "StormMod"),
    ("Heroes", "StormMod"),
    ("HeroesData", "StormMod"),
]


# ---------------------------------------------------------------------------
# Persistent storage handle (used by the server for on-demand extraction)
# ---------------------------------------------------------------------------

class CascStorage:
    """Lazily opens and caches a CASC storage handle, with a lock around
    operations because the http.server is multi-threaded.

    CascLib's storage open is slow (~30s on first call as it scans the
    archive); subsequent file extractions through the same handle are fast.
    The server creates one CascStorage at startup and reuses it for every
    incoming /__cascextract request.
    """

    def __init__(self, install_path):
        self.install_path = Path(install_path)
        self._handle = None
        self._lock = threading.Lock()

    def is_open(self):
        return self._handle is not None and bool(self._handle)

    def open(self):
        with self._lock:
            if self.is_open():
                return
            dll = _load_dll()
            handle = wintypes.HANDLE()
            ok = dll.CascOpenStorage(
                str(self.install_path).encode("mbcs"),
                CASC_LOCALE_NONE,
                ctypes.byref(handle),
            )
            if not ok or not handle:
                raise CascError(
                    f"could not open CASC storage at {self.install_path}",
                    dll.GetCascError(),
                )
            self._handle = handle

    def close(self):
        with self._lock:
            if self._handle:
                _load_dll().CascCloseStorage(self._handle)
                self._handle = None

    def extract_batch(self, file_list, out_dir):
        """Extract many files; reuses the long-lived handle so calls are
        fast after the initial open. Returns same shape as extract_files()."""
        self.open()
        dll = _load_dll()
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        extracted, skipped, failed = [], [], []
        total_bytes = 0
        with self._lock:
            for raw in file_list:
                casc_name = raw.replace("/", "\\").lstrip("\\")
                # SC2's CASC namespaces everything under "Mods\<mod>\..." or
                # "Campaigns\<campaign>\...". The editor's URL routing expects
                # the assets folder root to contain those mod folders DIRECTLY
                # (mirrors a typical CASCExplorer extraction's flat layout),
                # so strip the SC2-internal namespace prefix before saving.
                rel_path = _strip_casc_namespace(casc_name)
                local = out_dir / rel_path.replace("\\", "/")
                if local.exists() and local.stat().st_size > 0:
                    skipped.append(raw)
                    continue
                try:
                    local.parent.mkdir(parents=True, exist_ok=True)
                    _extract_one(dll, self._handle, casc_name, local)
                    extracted.append(raw)
                    total_bytes += local.stat().st_size
                except CascError as err:
                    failed.append({"file": raw, "error": str(err), "code": err.code})
                except Exception as err:
                    failed.append({"file": raw, "error": str(err)})
        return {
            "extracted": len(extracted),
            "skipped": len(skipped),
            "failed": failed,
            "bytes": total_bytes,
        }


def _strip_casc_namespace(casc_name: str) -> str:
    """Strip leading 'Mods\\' or 'Campaigns\\' from a CASC archive path so
    extracted files land where the editor expects (assets_root/<mod>/...)."""
    lower = casc_name.lower()
    for prefix in ("mods\\", "campaigns\\"):
        if lower.startswith(prefix):
            return casc_name[len(prefix):]
    return casc_name


# ---------------------------------------------------------------------------
# CASC index lookup (loaded from data/casc-index.json built by casc_index.py)
# ---------------------------------------------------------------------------

class CascIndex:
    """Loads casc-index.json (filename -> full CASC path) so the server can
    skip mod-prefix guessing and go straight to the right archive path."""

    def __init__(self):
        self.files = {}
        self.collisions = {}
        self.loaded_from = None

    def load(self, json_path):
        json_path = Path(json_path)
        if not json_path.exists():
            return 0
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            return 0
        self.files = {k.lower(): v for k, v in (data.get("files") or {}).items()}
        self.collisions = {k.lower(): v for k, v in (data.get("collisions") or {}).items()}
        self.loaded_from = json_path
        return len(self.files)

    def lookup(self, filename):
        """Return every CASC path for a given filename (primary + collisions)."""
        leaf = filename.replace("/", "\\").rsplit("\\", 1)[-1].lower()
        primary = self.files.get(leaf)
        others = self.collisions.get(leaf, [])
        if primary:
            return [primary] + [o for o in others if o != primary]
        return list(others)


def common_texture_paths_from_aliases(aliases: dict) -> list[str]:
    """Take an Assets.txt alias map ({key: relative_path}) and produce CASC
    file paths under every plausible Mods\\<Mod>.<Ext>\\Base.SC2Assets\\ prefix.

    A texture only exists under one prefix in the actual archive, so most
    candidates will return FILE_NOT_FOUND - that's fine and expected; misses
    are silent in CascLib and we record them in `failed` so the caller can
    see what's truly absent vs. just-in-a-different-mod.
    """
    out = []
    seen = set()
    for value in aliases.values():
        rel = value.replace("/", "\\").lstrip("\\")
        for mod, ext in CASC_MOD_PREFIXES:
            casc = f"Mods\\{mod}.{ext}\\Base.SC2Assets\\{rel}"
            if casc in seen:
                continue
            seen.add(casc)
            out.append(casc)
    return out
