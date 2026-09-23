"""Concurrency regression tests for the persistent CascStorage handle."""
from __future__ import annotations

import threading
import unittest
from tempfile import TemporaryDirectory
from unittest.mock import patch

from casc import CascStorage


class _FakeDll:
    def __init__(self):
        self.closed = 0

    def CascCloseStorage(self, _handle):
        self.closed += 1


class CascStorageLockTests(unittest.TestCase):
    def test_close_waits_for_whole_extract_batch(self):
        storage = CascStorage("unused")
        storage._handle = object()  # Treat storage as already open.
        extract_started = threading.Event()
        allow_extract_to_finish = threading.Event()
        close_finished = threading.Event()
        fake_dll = _FakeDll()

        def fake_extract(_dll, _handle, _casc_name, local):
            extract_started.set()
            self.assertTrue(allow_extract_to_finish.wait(timeout=2))
            local.write_bytes(b"asset")

        with TemporaryDirectory() as out_dir, \
                patch("casc._load_dll", return_value=fake_dll), \
                patch("casc._extract_one", side_effect=fake_extract):
            batch = threading.Thread(
                target=storage.extract_batch,
                args=([r"Mods\Core.SC2Mod\Base.SC2Assets\asset.dds"], out_dir),
            )
            batch.start()
            self.assertTrue(extract_started.wait(timeout=2))

            closer = threading.Thread(
                target=lambda: (storage.close(), close_finished.set()),
            )
            closer.start()
            self.assertFalse(
                close_finished.wait(timeout=0.1),
                "close() retired the handle while extract_batch() was using it",
            )

            allow_extract_to_finish.set()
            batch.join(timeout=2)
            closer.join(timeout=2)

        self.assertFalse(batch.is_alive())
        self.assertFalse(closer.is_alive())
        self.assertTrue(close_finished.is_set())
        self.assertEqual(fake_dll.closed, 1)
        self.assertIsNone(storage._handle)


if __name__ == "__main__":
    unittest.main(verbosity=2)
