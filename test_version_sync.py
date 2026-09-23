"""Keep the release version consistent across Python, browser, and index data."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from version import VERSION


HERE = Path(__file__).resolve().parent


class VersionSyncTests(unittest.TestCase):
    def test_browser_version_matches_python(self):
        source = (HERE / "editor/js/version.js").read_text(encoding="utf-8")
        match = re.search(r"export const VERSION = ['\"]([^'\"]+)['\"]", source)
        self.assertIsNotNone(match, "editor/js/version.js has no exported VERSION")
        self.assertEqual(match.group(1), VERSION)

    def test_casc_index_metadata_matches_python(self):
        with (HERE / "editor/data/casc-index.json").open(encoding="utf-8") as stream:
            metadata = json.load(stream)
        self.assertEqual(metadata.get("version"), VERSION)


if __name__ == "__main__":
    unittest.main(verbosity=2)
