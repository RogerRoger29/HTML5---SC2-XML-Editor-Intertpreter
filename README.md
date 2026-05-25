# SC2 UI Editor

Visual editor for StarCraft 2 `.SC2Layout` files. Open existing layouts, edit
them in a browser, save them back. Windows only; ships as a single 10 MB exe.

## Get it

Grab `SC2UIEditor.exe` from the [latest release](https://github.com/RogerRoger29/HTML5---SC2-XML-Editor-Intertpreter/releases).
Double-click it. A browser tab opens — that's the editor.

The first time you run it, Windows SmartScreen will warn that the file is
unsigned. Click **More info → Run anyway** to get past it. One-time prompt per
machine. (Code signing costs a few hundred a year, so the exe stays unsigned
until that's worth doing.)

The editor walks you through a short tour the first time. You can re-open it
from the Help menu later.

## Where the assets come from

The editor wants to see your real SC2 textures and fonts so layouts preview
correctly. Two ways to get them in:

**If you have SC2 installed**, hit Assets… → Extract textures + fonts from
SC2. It reads straight from the game's CASC archive via CascLib. The first
extract takes about thirty seconds while CascLib indexes the archive; after
that everything's instant.

**If you don't have SC2 installed** (or just want something small to test
with), use Download stock essentials instead. That pulls roughly 2 MB of
layout XML from the [SC2Mapster game data mirror](https://github.com/SC2Mapster/SC2GameData).
You get templates and styles but no actual textures — magenta placeholders
where images would be.

If you already have a mods folder extracted manually somewhere, point the
editor at it via Assets… → Set assets folder.

## What you can do

Open a layout. Click frames on the canvas to select them, drag the body to
move, drag corner handles to resize. The Inspector on the right edits
everything — Width, Height, all four anchor offsets, Text, Style, Texture
references, LayerColor, HAlign / VAlign. Hold a spinner arrow on a number
field and the canvas tracks it live.

Type into the Texture or Style fields and you get autocomplete from your
real loaded Assets.txt (~1,500 entries on a normal install). Same for
templates.

The hierarchy on the left supports drag-and-drop — pull a frame onto another
to reparent it, drop above or below for sibling reordering. The Insert menu
adds new frames (Frame, Image, Label, Button, Tooltip, CheckBox, EditBox,
ListBox, ProgressBar, StatusBar) with sensible defaults wired up.

Save writes the original file back in place on Chrome and Edge via the File
System Access API. Firefox and Safari haven't implemented that API yet, so
they fall back to a download dialog.

There's a validator that flags dangling template references, missing
required children for specific frame types, and anchor / size conflicts. The
Warnings button only appears in the top bar when there's actually something
to warn about, so it doesn't sit there nagging.

Buttons that define a `<StateGroup>` get a "Visual state preview" dropdown in
the Inspector — switch between Normal / Hover / Pressed and see the actual
child-visibility swaps without launching the game.

You can also export an HTML snapshot of the current canvas with textures
inlined as base64. Useful for showing layouts to someone who doesn't have
the editor installed.

## Triggers export

If you want the layout wired up in-game, File → Export Triggers XML
generates a fragment you can paste into your mod's Triggers file. Pick which
frames you want bound to Galaxy variables, optionally include click-handler
stubs for buttons, and you get the variable declarations, the init trigger
that loads the layout and binds them, and (per opted-in button) a
TriggerAddEventDialogControl event handler with a comment placeholder for
your logic.

You still have to do the SC2 Editor "poke any trigger and save" dance to
force MapScript to regenerate — that's a quirk of how Galaxy codegen works,
not something this tool can fix.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+N | New blank layout |
| Ctrl+O | Open file |
| Ctrl+S | Save (in-place on Chromium, download elsewhere) |
| Ctrl+Shift+S | Save As |
| Ctrl+Shift+E | Export HTML preview |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+P | Find frame by name |
| G | Toggle grid snap |
| O | Toggle frame outlines |
| B | Toggle backdrop image |
| F | Fit canvas to window |
| Esc | Deselect |
| Delete | Delete selected frame |

## Heads up

The exe is unsigned, so SmartScreen and some antivirus tools will flag it
on first launch. Workaround is the SmartScreen "Run anyway" path described
above; some AV engines might need a whitelist add.

If you're on Firefox or Safari, the save-to-disk shortcut falls back to a
browser download instead of overwriting the file in place. Everything else
works.

`<Animation>` and `<Controller>` blocks parse and round-trip without
damage but don't preview as animations — that's a separate engine layer
that hasn't been built yet. `<StateGroup>` previews do work (see above).

A handful of campaign-specific textures aren't in the mod-prefix list the
extractor tries. If you hit a magenta placeholder for something that should
exist in your local SC2 install, file an issue with the texture name and
I'll widen the search.

## Bug reports

If something misbehaves, F12 → Console in the editor's browser tab usually
has the diagnostic. Most subsystems log with a tag (`[stock]`, `[textures]`,
`[cascextract]`, `[paint]`) so it's easy to grep. Open an issue with the
relevant lines, what you were doing, and a copy of the layout file if you
can share it.

## Building from source

```
python serve.py            # dev mode at http://127.0.0.1:8765/
python build.py            # build dist/SC2UIEditor.exe
python build.py --clean    # wipe build cache first
```

Dev mode reads files straight from `editor/` on disk, so HTML / CSS / JS
changes hot-reload on browser refresh. You only need to rebuild the exe if
you change `serve.py` itself or want to test the bundle.

To regenerate the CASC filename index against a newer SC2 patch:

```
python casc_index.py "C:\Program Files (x86)\StarCraft II"
```

Output lands at `editor/data/casc-index.json` and gets baked into the next
build.

Round-trip tests live alongside the source:

```
node test_roundtrip.mjs <file.SC2Layout>...
node test_drag_math.mjs
node test_mod_templates.mjs
```

## Credits

- [CascLib](https://github.com/ladislav-zezula/CascLib) for SC2 archive
  reading (MIT-licensed, bundled as `native/CascLib.dll`)
- [SC2Mapster/SC2GameData](https://github.com/SC2Mapster/SC2GameData) — the
  optional stock-data download pulls from this mirror
- [Saira font](https://fonts.google.com/specimen/Saira) — bundled SIL
  Open Font License fallback for when SC2's real fonts aren't available

No Blizzard binary assets ship with the editor. Textures and fonts are only
ever read from your own SC2 install via CascLib, or from a mods folder you
point the editor at yourself.
