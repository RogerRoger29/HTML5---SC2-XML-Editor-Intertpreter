"""Adversarial test suite for serve.py's Router.translate_path.

translate_path is the URL -> filesystem mapping for ALL HTTP requests.
A bug here lets a remote (or, in our case, any browser tab on the local
machine) read arbitrary files. The most subtle hazard is Windows-specific:
Path.joinpath('C:', ...) SILENTLY resets to that absolute drive, escaping
the base. Round 1's R1.2 added per-segment filtering + a resolve-then-
verify final-path check. This test locks the invariant down so a future
refactor can't accidentally regress it.

Run:
    python -m pytest test_translate_path.py -v
    # or just:
    python test_translate_path.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import Router  # noqa: E402


# A stub Router instance that skips the BaseHTTPRequestHandler constructor.
# translate_path only depends on class attributes + the path argument, so
# the request-handler machinery is unnecessary for this test.
class _StubRouter(Router):
    def __init__(self):
        pass


def _under(child: str, parent: Path) -> bool:
    """Return True iff `child` is under `parent` (case-insensitive on Win)."""
    try:
        return Path(child).resolve(strict=False).is_relative_to(parent.resolve(strict=False))
    except (OSError, ValueError):
        return False


class TranslatePathSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Use real folders the audit-platform Windows knows about. The
        # tempdir wouldn't catch the drive-letter case (joinpath('C:') only
        # misbehaves when there's a real C: root to land on).
        cls.assets = Path(r"F:\Users\Nicholas\Downloads\Work\mods")
        cls.project = Path(r"E:\users\Nicholas\Desktop\Colonies Enemy Capture and Spawn System")
        Router.assets_root = cls.assets
        Router.project_root = cls.project
        cls.r = _StubRouter()

    def assertStaysInside(self, url: str, base: Path):
        out = self.r.translate_path(url)
        self.assertTrue(_under(out, base),
                        f"{url!r} escaped: resolved to {out!r}, expected under {base!r}")

    # ---- parent-traversal --------------------------------------------------
    def test_basic_parent_traversal_assets(self):
        self.assertStaysInside("/assets/../../../etc/passwd", self.assets)

    def test_parent_traversal_project(self):
        self.assertStaysInside("/project/../../etc", self.project)

    def test_url_encoded_parent_traversal(self):
        self.assertStaysInside("/assets/%2e%2e/etc/passwd", self.assets)

    def test_mixed_dotdot(self):
        self.assertStaysInside("/assets/./foo/../bar", self.assets)

    # ---- drive-letter reset (the dangerous Windows case) -------------------
    def test_drive_letter_uppercase(self):
        self.assertStaysInside("/assets/C:/Windows/win.ini", self.assets)

    def test_drive_letter_lowercase(self):
        self.assertStaysInside("/assets/c:/Windows/win.ini", self.assets)

    def test_drive_letter_different_drive(self):
        self.assertStaysInside("/assets/D:/sensitive.txt", self.assets)

    # ---- UNC-ish + backslashes --------------------------------------------
    def test_backslash_segments(self):
        self.assertStaysInside("/assets/\\server\\share\\foo", self.assets)

    def test_unc_prefix(self):
        self.assertStaysInside("/assets//\\\\server\\share", self.assets)

    # ---- normal cases still work ------------------------------------------
    def test_simple_asset_path(self):
        out = self.r.translate_path("/assets/core.sc2mod/foo.dds")
        self.assertTrue(out.endswith(r"core.sc2mod\foo.dds")
                        or out.endswith("core.sc2mod/foo.dds"))
        self.assertTrue(_under(out, self.assets))

    def test_simple_project_path(self):
        self.assertStaysInside("/project/foo/bar.SC2Layout", self.project)

    def test_root_serves_editor(self):
        # /__config and similar route through translate_path too.
        out = self.r.translate_path("/__config")
        # Lands inside editor/ (which is under serve.py's bundle dir).
        self.assertIn("editor", out.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
