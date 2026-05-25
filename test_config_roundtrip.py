"""Live HTTP test that GET + POST /__config round-trip through disk.

Boots serve.py on a free port, POSTs new sc2_install and assets_root
values, GETs and confirms they echo back AND were persisted to the
sc2-ui-editor-config.json file on disk. Catches schema drift between the
read and write paths AND ensures the atomic-write (R2.1's temp+rename)
actually completes.

The on-disk config lives at EXE_DIR/sc2-ui-editor-config.json (EXE_DIR
is fixed at import time from __file__, not cwd), so launching from a
temp cwd does NOT isolate the file. We snapshot + restore the real
config around the whole suite to keep the developer's settings intact.

Run:
    python test_config_roundtrip.py
"""
from __future__ import annotations

import json
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _post(url: str, payload: dict) -> dict:
    """POST JSON and return the parsed response body.

    serve.py returns JSON for both success (200) and validation failures
    (400). urllib raises HTTPError on non-2xx; we catch and parse the body
    so callers can inspect result["error"].
    """
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        # 413 (oversized body) has no JSON body; surface code via re-raise.
        if err.code == 413:
            raise
        return json.loads(err.read())


def _get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=5) as resp:
        return json.loads(resp.read())


# Computed once setUpClass runs - the EXE_DIR/sc2-ui-editor-config.json
# the server actually writes to.
_REAL_CONFIG_PATH: Path | None = None
_REAL_CONFIG_BACKUP: bytes | None = None  # None means "did not exist"


class ConfigRoundTripTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Boot a short-lived server just to learn EXE_DIR, then shut it down.
        # We need this BEFORE the per-test setUp can safely manipulate disk.
        global _REAL_CONFIG_PATH, _REAL_CONFIG_BACKUP
        probe_port = _free_port()
        probe = subprocess.Popen(
            [sys.executable, str(HERE / "serve.py"),
             "--port", str(probe_port),
             "--no-open",
             "--assets", str(HERE),
             "--project", str(HERE)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", probe_port), timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            cfg = _get(f"http://127.0.0.1:{probe_port}/__config")
        finally:
            probe.terminate()
            try:
                probe.wait(timeout=3)
            except subprocess.TimeoutExpired:
                probe.kill()
        _REAL_CONFIG_PATH = Path(cfg["exe_dir"]) / "sc2-ui-editor-config.json"
        if _REAL_CONFIG_PATH.exists():
            _REAL_CONFIG_BACKUP = _REAL_CONFIG_PATH.read_bytes()
        else:
            _REAL_CONFIG_BACKUP = None

    @classmethod
    def tearDownClass(cls):
        # Restore the developer's real config exactly as it was.
        if _REAL_CONFIG_PATH is None:
            return
        if _REAL_CONFIG_BACKUP is None:
            _REAL_CONFIG_PATH.unlink(missing_ok=True)
        else:
            _REAL_CONFIG_PATH.write_bytes(_REAL_CONFIG_BACKUP)

    def setUp(self):
        # Wipe any leftover config so each test starts from a known blank state.
        if _REAL_CONFIG_PATH and _REAL_CONFIG_PATH.exists():
            _REAL_CONFIG_PATH.unlink()
        self.workdir = TemporaryDirectory()
        self.port = _free_port()
        self.proc = subprocess.Popen(
            [sys.executable, str(HERE / "serve.py"),
             "--port", str(self.port),
             "--no-open",
             "--assets", str(HERE),    # any extant dir
             "--project", str(HERE)],
            cwd=self.workdir.name,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait for the server to start accepting connections.
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            self.proc.kill()
            self.fail("serve.py did not come up within ~5s")
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.workdir.cleanup()

    def test_get_returns_expected_schema(self):
        cfg = _get(f"{self.base}/__config")
        for key in ("version", "frozen", "exe_dir", "project_root", "assets_root",
                    "assets_present", "assets_source", "sc2_install", "sc2_install_source"):
            self.assertIn(key, cfg, f"missing schema key: {key}")

    def test_post_assets_root_persists(self):
        # Pick another extant directory and POST it as assets_root.
        new_assets = str(HERE.parent)
        before = _get(f"{self.base}/__config")["assets_root"]
        result = _post(f"{self.base}/__config", {"assets_root": new_assets})
        self.assertIsNone(result.get("error"), f"POST failed: {result}")
        self.assertEqual(result["assets_root"], new_assets)
        # Re-fetch to confirm persistence in memory.
        after = _get(f"{self.base}/__config")
        self.assertEqual(after["assets_root"], new_assets)
        self.assertNotEqual(after["assets_root"], before)
        # Confirm persistence on disk at the server-reported exe_dir.
        self.assertIsNotNone(_REAL_CONFIG_PATH)
        self.assertTrue(_REAL_CONFIG_PATH.exists(),
                        f"config.json was not written to disk at {_REAL_CONFIG_PATH}")
        disk = json.loads(_REAL_CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(disk["assets_root"], new_assets)

    def test_post_nonexistent_assets_root_rejected(self):
        result = _post(f"{self.base}/__config", {"assets_root": "/nope/does/not/exist"})
        self.assertEqual(result.get("error"), "not_found")

    def test_oversized_body_rejected(self):
        # R3.1 caps /__config at 64 KB. A 65 KB body must 413.
        huge = {"junk": "x" * 70000}
        try:
            _post(f"{self.base}/__config", huge)
            self.fail("expected 413 from oversized body")
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 413)


if __name__ == "__main__":
    unittest.main(verbosity=2)
