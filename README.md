# SC2 UI Editor

A visual editor for StarCraft 2 `.SC2Layout` files. Open existing layouts,
edit visually, save back to disk, and preview against your real SC2 install.

**Current version:** 0.5.0
**Platform:** Windows
**Distribution:** single-file `.exe` (~10 MB)

---

## Quick start (for testers)

1. **Download** `SC2UIEditor.exe` from the release.
2. **Double-click** it. Your default web browser opens to the editor automatically.

   ⚠️ **Windows SmartScreen warning** ("Windows protected your PC") will probably
   appear the first time because the `.exe` is unsigned. Click **More info**
   → **Run anyway**. This is a one-time hurdle per machine.
3. The editor walks you through first-launch setup in a brief tour.
4. Press **Ctrl+S** to save edits back to the original file (on Chromium browsers).

That's it. No Python, Node, or other install required — everything is bundled.

---

## What it does

### Authoring
- Drag-to-move and corner-drag-to-resize on the canvas.
- Editable property inspector — Width, Height, all four anchor offsets,
  HAlign / VAlign, Text, Style, Texture, LayerColor.
- Live updates: hold a spinner arrow and the frame tracks every step in real time.
- Hierarchy drag-and-drop to reparent / reorder frames.
- Add new frames (Frame, Image, Label, Button, Tooltip, CheckBox, EditBox,
  ListBox, ProgressBar, StatusBar) via the **Insert** menu.
- Visual state preview: switch a button between Normal / Hover / Pressed
  via the inspector to see how the StateGroup actions will render in-game.
- Undo/redo (Ctrl+Z / Ctrl+Y) across all edits.

### Asset awareness
- **Texture autocomplete** — type into the Texture field, see a searchable
  dropdown of every alias loaded from your SC2 `Assets.txt` files
  (1,500+ entries on a typical install).
- **Style autocomplete** — same for FontStyles entries (Eurostile / Blizzard
  fonts at their real sizes / colors / outlines).
- **CASC extraction** — reads textures and fonts directly from your local
  SC2 install via CascLib (no manual extraction tool needed). Auto-fetches
  any missing assets when you open a file.

### Editor support
- **Validator pane** flags dangling template references, missing required
  children (e.g. Button without NormalImage), invalid anchor combinations,
  and malformed numeric values. Click any warning to jump to the offending
  frame.
- **Find frame** (Ctrl+P) — fuzzy palette searches by name or path.
- **Smart alignment guides** appear while dragging when a frame's edge
  aligns with another frame's edge or center.
- **Grid snap** (G to toggle) with configurable size and a visible grid overlay.

### Workflow
- **File menu**: New / Open / Save / Save As / Export HTML.
- **Save to disk** via File System Access API on Chromium browsers — Ctrl+S
  writes the original file directly with no download dialog.
- **Export HTML** produces a standalone `.html` preview with textures
  embedded as base64 data URIs (useful for sharing with people who don't
  have the editor).
- **Stage backdrop**: load a vanilla SC2 screenshot to visually verify your
  mod frames land in the right spots relative to the stock HUD.
- **Resizable + collapsible panes** (Hierarchy / Inspector / XML) with
  persistent layout via localStorage.

---

## First-launch flow in detail

When the `.exe` starts it does the following before opening your browser:

1. **Detects SC2 install location.** Scans every drive letter (A–Z) for
   a folder containing `StarCraft II.exe`. Also checks the registry.
2. **Resolves an assets folder** in this order:
   - `--assets PATH` command-line argument
   - `SC2_ASSETS` environment variable
   - `assets_root` from `sc2-ui-editor-config.json` next to the exe
   - `./mods/` next to the exe (if you've extracted stock data there)
   - `./extracted/mods/` or `./data/mods/`
   - Common Windows install paths
3. **Binds an HTTP port.** Starts at 8765 and walks forward to 8775 if
   8765 is in use.
4. **Opens your default browser** to `http://127.0.0.1:<port>/`.

If no assets folder is found, the editor shows an in-browser banner with
two recovery actions:

- **Extract textures + fonts from SC2** — uses the bundled CascLib to read
  your local SC2 install. First extraction takes about 30 seconds while
  CascLib indexes the archive; subsequent operations are instant. Writes
  extracted files to `./stock-data/` next to the exe and uses that as the
  new assets folder.
- **Download stock essentials** — fetches about 30 layout/style files
  (~2 MB) from
  [SC2Mapster/SC2GameData](https://github.com/SC2Mapster/SC2GameData) over
  HTTPS. Includes XML, Assets.txt, and DescIndex — but NOT binary `.dds`
  textures (those have to come from a local SC2 install).

You can run the editor without either; you'll just see magenta placeholders
where textures should be, and template-based frames may look bare. Editing
still works.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| **Ctrl+N** | New blank layout |
| **Ctrl+O** | Open file |
| **Ctrl+S** | Save (in-place on Chromium; download elsewhere) |
| **Ctrl+Shift+S** | Save As |
| **Ctrl+Shift+E** | Export HTML |
| **Ctrl+Z** | Undo |
| **Ctrl+Y** / **Ctrl+Shift+Z** | Redo |
| **Ctrl+P** | Find frame by name |
| **G** | Toggle grid snap |
| **O** | Toggle frame outlines |
| **B** | Toggle backdrop image |
| **F** | Fit canvas to window |
| **Esc** | Deselect / close palette |
| **Delete** | Delete selected mod-origin frame |

---

## Known issues / gotchas

- **Unsigned executable.** Windows SmartScreen and some antivirus engines will
  flag the file. There's no fix short of paying a CA for code signing
  ($200–400/yr). Workaround: **More info** → **Run anyway** on SmartScreen.
- **Firefox / Safari**: Save-to-disk via File System Access API is unsupported.
  Save and Save As fall back to download dialogs. Everything else works.
- **Port 8765–8775 all in use**: rare but the editor won't start. Close
  whatever else is using those ports.
- **CascLib first open is slow** (~30 seconds). It's indexing the SC2 archive.
  Subsequent extracts are sub-second.
- **No animation playback.** `<Animation>` and `<Controller>` blocks parse
  and round-trip cleanly but don't preview as animations. `<StateGroup>`
  states DO preview (you can manually pick Hover / Pressed / etc. in the
  inspector to see how those states would render).

---

## Reporting bugs

If something breaks, please include:
- What you were trying to do
- The contents of the browser's **Console** tab (F12 → Console) — many of
  the editor's diagnostics log there with `[stock]`, `[textures]`,
  `[paint]`, `[cascextract]` prefixes
- The version string from **Help → About** (or the badge in the top-left)
- A copy of the `.SC2Layout` file you were editing if possible

---

## Building from source

You only need this if you're modifying the editor itself.

Requirements: Python 3.10+, PyInstaller (`pip install pyinstaller`).

```
git clone <repo>
cd sc2-ui-editor
python serve.py            # runs in dev mode at http://127.0.0.1:8765/
python build.py            # produces dist/SC2UIEditor.exe
python build.py --clean    # wipe build cache first
```

The dev server reads files directly from `editor/` so JS / CSS / HTML
changes hot-reload on browser refresh — no rebuild needed unless you
change `serve.py` itself or want to test the bundled `.exe`.

To rebuild the CascLib filename index against a newer SC2 patch:

```
python casc_index.py "C:\Program Files (x86)\StarCraft II"
```

Output lands at `editor/data/casc-index.json` and gets baked into the next
exe build.

---

## License & credits

Editor code: your repo's license.

Bundled third-party:
- **CascLib** by Ladislav Zezula, MIT licensed.
- **SC2 layout XML samples** from
  [SC2Mapster/SC2GameData](https://github.com/SC2Mapster/SC2GameData)
  (for the optional "Download stock essentials" feature only — files are
  fetched at runtime, not bundled).

No Blizzard binary assets (textures, fonts) are bundled. The editor only
ever reads them from the user's own SC2 install via CascLib or from the
user's own extracted asset folder.
