"""Tests for casc._strip_casc_namespace.

The function strips a leading "Mods\\" or "Campaigns\\" component from
CASC paths so extracted files land flat under assets-root/<mod>/... -
matching CASCExplorer's layout, which is what the editor's URL routing
expects. Regressing this silently breaks every texture extraction (files
end up at assets-root/Mods/<mod>/... and the editor's /assets/<mod>/...
URLs 404).

Run:
    python test_strip_namespace.py
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from casc import _strip_casc_namespace  # noqa: E402


class StripNamespaceTests(unittest.TestCase):
    def test_mods_prefix(self):
        self.assertEqual(
            _strip_casc_namespace(r"Mods\Core.SC2Mod\Base.SC2Assets\foo.dds"),
            r"Core.SC2Mod\Base.SC2Assets\foo.dds",
        )

    def test_campaigns_prefix(self):
        self.assertEqual(
            _strip_casc_namespace(r"Campaigns\Void.SC2Campaign\Base.SC2Assets\foo.dds"),
            r"Void.SC2Campaign\Base.SC2Assets\foo.dds",
        )

    def test_lowercase_mods(self):
        # Case-insensitive prefix matching - CASC paths have inconsistent casing.
        self.assertEqual(
            _strip_casc_namespace(r"mods\foo\bar"),
            r"foo\bar",
        )

    def test_mixed_case_campaigns(self):
        self.assertEqual(
            _strip_casc_namespace(r"CAMPAIGNS\Foo\bar.dds"),
            r"Foo\bar.dds",
        )

    def test_unprefixed_passes_through(self):
        # Paths that don't start with a known namespace stay unchanged.
        self.assertEqual(
            _strip_casc_namespace(r"foo\bar\baz.dds"),
            r"foo\bar\baz.dds",
        )

    def test_only_first_prefix_stripped(self):
        # If a file path coincidentally has "Mods\" deeper in it, that
        # nested occurrence must NOT be stripped (we'd lose path structure).
        self.assertEqual(
            _strip_casc_namespace(r"Mods\Foo\Mods\bar.dds"),
            r"Foo\Mods\bar.dds",
        )

    def test_empty_string(self):
        self.assertEqual(_strip_casc_namespace(""), "")

    def test_just_mods_prefix(self):
        # The literal "Mods\" with nothing after - degenerate but legal.
        self.assertEqual(_strip_casc_namespace("Mods\\"), "")

    def test_neither_namespace(self):
        # An unrelated prefix like "Maps\" stays.
        self.assertEqual(_strip_casc_namespace(r"Maps\foo.s2ma"), r"Maps\foo.s2ma")


if __name__ == "__main__":
    unittest.main(verbosity=2)
