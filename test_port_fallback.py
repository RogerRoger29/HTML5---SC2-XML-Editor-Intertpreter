"""Test that serve.py's port-fallback (8765 -> 8766 -> ... -> 8774) works.

Pre-binds the requested port, launches serve.py asking for that same port,
and verifies the server comes up on the NEXT available port instead of
failing. Round 2's polish R3.x changes touched the bind loop; this catches
any regression that silently breaks the fallback (which would manifest
as "editor doesn't open" with no clear cause for testers).

Run:
    python test_port_fallback.py
"""
from __future__ import annotations

import socket
import subprocess
import sys
import time
import unittest
import urllib.request
import json
from pathlib import Path
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent


def _bind(port: int) -> socket.socket:
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
    s.bind(("127.0.0.1", port))
    s.listen(1)
    return s


def _pick_blockable_port() -> int:
    """Find a free port we can occupy to force the fallback."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class PortFallbackTest(unittest.TestCase):
    def test_falls_back_when_requested_port_taken(self):
        port = _pick_blockable_port()
        blocker = _bind(port)
        workdir = TemporaryDirectory()
        proc = subprocess.Popen(
            [sys.executable, str(HERE / "serve.py"),
             "--port", str(port),
             "--no-open",
             "--assets", str(HERE),
             "--project", str(HERE)],
            cwd=workdir.name,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            # The server walks port..port+9 looking for one it can bind.
            # Try connecting to each candidate to find where it actually came up.
            bound_port = None
            deadline = time.time() + 5
            while time.time() < deadline and bound_port is None:
                for candidate in range(port + 1, port + 10):
                    try:
                        with socket.create_connection(("127.0.0.1", candidate), timeout=0.1):
                            bound_port = candidate
                            break
                    except OSError:
                        continue
                if bound_port is None:
                    time.sleep(0.1)
            self.assertIsNotNone(bound_port,
                                 f"server didn't fall back from {port} to any port in {port+1}..{port+9}")
            # Sanity: /__config responds at the fallback port.
            with urllib.request.urlopen(f"http://127.0.0.1:{bound_port}/__config", timeout=2) as resp:
                cfg = json.loads(resp.read())
            self.assertIn("version", cfg)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
            blocker.close()
            workdir.cleanup()


if __name__ == "__main__":
    unittest.main(verbosity=2)
