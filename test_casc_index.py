"""Tests for casc.CascIndex.

CascIndex loads casc-index.json (filename -> CASC archive path) and
provides lookup() which returns the exact path for a given filename,
falling back to collision entries. Case sensitivity matters: CASC files
have inconsistent casing but the editor requests paths with mixed casing.

Run:
    python test_casc_index.py
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from casc import CascIndex  # noqa: E402


# Synthetic index fixture - small enough to embed.
FIXTURE = {
    "version": "test",
    "files": {
        "ui_heroicons_frame_normalpressed_terran.dds":
            r"Mods\Core.SC2Mod\Base.SC2Assets\Assets\Textures\ui_heroicons_frame_normalpressed_terran.dds",
        "bl.ttf":
            r"Mods\Core.SC2Mod\Base.SC2Data\UI\Fonts\bl.ttf",
        "sc2_ui_glues_bluebuttons_taskbarbuttonover.dds":
            r"Mods\Liberty.SC2Mod\Base.SC2Assets\Assets\Textures\sc2_ui_glues_bluebuttons_taskbarbuttonover.dds",
    },
    "collisions": {
        "common.dds": [
            r"Mods\Core.SC2Mod\Base.SC2Assets\Assets\Textures\common.dds",
            r"Mods\Liberty.SC2Mod\Base.SC2Assets\Assets\Textures\common.dds",
        ],
    },
}


class CascIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False, encoding="utf-8")
        json.dump(FIXTURE, self.tmp)
        self.tmp.close()
        self.idx = CascIndex()
        n = self.idx.load(Path(self.tmp.name))
        self.assertEqual(n, 3)

    def tearDown(self):
        Path(self.tmp.name).unlink(missing_ok=True)

    # ---- basic lookups ----------------------------------------------------
    def test_lookup_exact_case(self):
        result = self.idx.lookup("ui_heroicons_frame_normalpressed_terran.dds")
        self.assertEqual(len(result), 1)
        self.assertIn("Core.SC2Mod", result[0])

    def test_lookup_lowercase(self):
        # Index keys are lowered; lookup of mixed-case must still hit.
        result = self.idx.lookup("UI_HEROICONS_FRAME_NORMALPRESSED_TERRAN.DDS")
        self.assertEqual(len(result), 1)

    def test_lookup_with_directory_prefix(self):
        # lookup() should accept "foo/bar/file.dds" and strip to the leaf.
        result = self.idx.lookup(r"some\path\bl.ttf")
        self.assertEqual(len(result), 1)
        self.assertTrue(result[0].endswith("bl.ttf"))

    def test_lookup_forward_slash_prefix(self):
        result = self.idx.lookup("some/path/bl.ttf")
        self.assertEqual(len(result), 1)

    def test_lookup_missing(self):
        self.assertEqual(self.idx.lookup("does-not-exist.dds"), [])

    # ---- collisions -------------------------------------------------------
    def test_lookup_returns_primary_and_collisions(self):
        result = self.idx.lookup("common.dds")
        # Two entries: the primary plus the collision sibling.
        self.assertEqual(len(result), 2)

    # ---- file loading ----------------------------------------------------
    def test_load_missing_file(self):
        idx = CascIndex()
        self.assertEqual(idx.load(Path("/nonexistent.json")), 0)
        self.assertEqual(idx.files, {})

    def test_load_invalid_json(self):
        bad = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        bad.write("{not valid json")
        bad.close()
        idx = CascIndex()
        self.assertEqual(idx.load(Path(bad.name)), 0)
        Path(bad.name).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
