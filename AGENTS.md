# AGENTS.md — code-assistant orientation

You're working on the **SC2 UI Editor**, a visual authoring tool for SC2
`.SC2Layout` files. Read this top-to-bottom before making changes — there
are several non-obvious invariants and a couple of bugs we already burned
hours on that you don't want to re-introduce.

Current version: **0.9.1** (frontend source: `editor/js/version.js`; backend mirror: `version.py`).

For user-facing docs, see [README.md](README.md). For deferred features and
open threads, see [SESSION_STATE.md](SESSION_STATE.md).

---

## High-level architecture

```
       ┌───────────────────────────────────────────────────┐
       │            SC2UIEditor.exe (PyInstaller)          │
       │                                                   │
       │   serve.py ─── HTTP server on 127.0.0.1:8765-75   │
       │       │                                           │
       │       ├── /            → editor/ (HTML/JS/CSS)    │
       │       ├── /project/    → user's mod folders       │
       │       ├── /assets/     → extracted SC2 mods       │
       │       ├── /__config    → GET state / POST set     │
       │       ├── /__cascextract → extract from SC2 install│
       │       └── /__download  → fetch from Mapster repo  │
       │                                                   │
       │   casc.py ── CascLib.dll bindings (ANSI strings!) │
       │   casc_index.py ─ one-time CASC enumeration       │
       │                                                   │
       └────────────────────┬──────────────────────────────┘
                            │ HTTP
                            ▼
       Browser (Chrome/Edge preferred, Firefox/Safari OK):
         editor/js/main.js orchestrates:
           xml/        — comment-preserving parser + serializer
           render/     — DDS decoder, frame renderer, texture loader,
                         fontstyle parser, alignment guides
           ui/         — tree, inspector, edit overlay, autocomplete,
                         color picker, find palette, menubar, welcome
           merge.js    — stock + mod layouts → materialized tree
           stock.js    — stock layout / Assets.txt / mod templates registry
           state-groups.js — StateGroup preview application
           validate.js — layout validator
```

**Data flow on every edit:**

```
   user action (drag / inspector spinner / hierarchy reorder)
      ↓
   mutate the mod's parsed XML element directly (setAttr / append child)
      ↓
   rerender({ positionsOnly: true, keepSelection: true })
      ↓ during live edits: skip DOM teardown
      ↓
   MergedTree builds merged stock+mod tree → materialize()
      ↓
   layoutFrames() resolves anchors → node.x/y/w/h
      ↓
   applyStateActions()  ← StateGroup preview overrides visibility/color
      ↓
   renderer.render()  OR  renderer.updatePositions()
      ↓
   On drag/edit end (live=false): tree.render + inspector.show + xmlText.value = serializeXml
```

---

## Module map (where things live)

### Editor frontend (`editor/`)

| File | Responsibility |
|---|---|
| `js/main.js` | Wires everything; defines `state`, `rerender()`, file ops, hotkeys |
| `js/version.js` | Version constant + per-milestone changelog comments |
| `js/xml/parser.js` | Comment-preserving XML parser — preserves byte ranges, dirty flags |
| `js/xml/serializer.js` | Round-trips parsed doc; reuses original source spans for clean nodes |
| `js/stock.js` | StockRegistry (loadCore, addModTemplates, loadAssetsTxt) |
| `js/merge.js` | MergedTree.mergeStock + mergeMod + asFrameList + materialize |
| `js/state-groups.js` | parseStateGroupsOnFrame, applyStateActions |
| `js/validate.js` | validate(doc, registry) returns warning array |
| `js/render/layout.js` | layoutFrames — anchor resolution on the merged-frame shape |
| `js/render/dds.js` | DXT1/3/5 + uncompressed RGBA decoder |
| `js/render/fontstyle.js` | FontStyleSheet — parses fontstyles.sc2style, injects @font-face |
| `js/render/textures.js` | TextureLoader — Assets.txt alias resolution, mod-root lookup, cache |
| `js/render/frames.js` | FrameRenderer — paints sc2-frame divs, updatePositions for fast path |
| `js/render/guides.js` | AlignmentGuides — pink snap lines during drag |
| `js/ui/tree.js` | Hierarchy tree + drag-to-reorder |
| `js/ui/inspector.js` | Property editor; live-number wiring; state-group dropdowns |
| `js/ui/edit.js` | SelectionOverlay + drag math (anchor offsets + Width/Height) |
| `js/ui/autocomplete.js` | Texture/Style/template completion dropdown |
| `js/ui/colorpicker.js` | LayerColor / textcolor swatch + native picker |
| `js/ui/findpalette.js` | Ctrl+P fuzzy frame finder |
| `js/ui/menubar.js` | Top bar File/Edit/Insert/View/Help menus |
| `js/ui/welcome.js` | First-launch tour overlay |
| `data/stock-frames.json` | Hand-curated stock frame paths + default anchors |
| `data/casc-index.json` | Generated CASC filename→path index (47k entries) |

### Python backend

| File | Responsibility |
|---|---|
| `serve.py` | HTTP server, routing, config persistence, port fallback, /__cascextract handler |
| `casc.py` | CascLib ctypes bindings; CascStorage (persistent handle); CascIndex |
| `casc_index.py` | One-shot CASC enumeration tool — produces `data/casc-index.json` |
| `build.py` | PyInstaller one-shot build with CascLib bundling |

---

## Non-obvious invariants

### XML round-trip (HARD requirement)

The parser keeps the original byte range of every node. Serializer re-uses
the original source slice for any unmodified element, only regenerating dirty
ones. Result: parsing a file then serializing it without edits produces a
**byte-exact copy**.

**Don't break this.** Every test in `test_roundtrip.mjs` depends on it.

Specifically:
- Comments, whitespace, attribute order, quote style (`'` vs `"`), and
  self-closing tag form must survive untouched.
- When mutating, set `el.dirty = true` so the serializer regenerates just
  that element. Use `setAttr(el, name, value)` from `xml/serializer.js`.
- New elements get `dirty: true` by construction; see `makeElement()` in
  `ui/edit.js` for the canonical creation pattern.

### Drag/edit fast path (DO NOT regress)

Live drags and live spinner inputs use `rerender({ positionsOnly: true })`.
This **must not** call `renderer.clear()` or `renderer.render()` because
that tears down and recreates every `<canvas>` (textures included) and
produces magenta flicker. Two specific bugs we already fixed:

1. The original code recreated DOM on every pointermove → textures flickered
   through the magenta placeholder. Fix: `positionsOnly` reuses `_el`
   references by matching node.path.
2. `renderer.clear()` originally used `stage.replaceChildren()` which also
   wiped the selection overlay and backdrop image. Fix: clear only elements
   with the `.sc2-frame` class.

On drag/edit END (`live: false`), do a full `rerender({ keepSelection })`
and sync tree / inspector / XML pane / round-trip status.

### CascLib path encoding

The bundled `native/CascLib.dll` is built with `_USRDLL` but **without**
`UNICODE` — i.e. ANSI strings. All path arguments to `CascOpenStorage` /
`CascOpenFile` etc. **must** be `ctypes.c_char_p` (or bytes), not
`wintypes.LPCWSTR` (wstr). Passing wstr returns `ERROR_FILE_NOT_FOUND`
silently — we wasted hours on this.

```python
# WRONG: ok = dll.CascOpenStorage(str(install), 0, byref(handle))
# RIGHT:
ok = dll.CascOpenStorage(str(install).encode("mbcs"), 0, byref(handle))
```

### Mod source identification

Every `MergedNode` materialized as `_modSource` carries the actual mod XML
element it derives from (or `null` for stock-origin nodes). Inspector +
drag-edit mutate via `_modSource` directly so the live XML stays the
ground truth. Template-inherited children get a synthetic source pointing
to the template element — be cautious about editing those, since the
mutation propagates to every instantiator of that template.

### Stock layout merge semantics

- Stock files: only frames with deep paths (`name="A/B/C"`) become visible
  UI in the merged tree. Bare-named stock frames are templates only.
- Mod files: bare-named top-level frames ARE rendered (modders write their
  own UI panels with simple names like `UpgradeSlotPanel`).
- Synthetic parents (created when a mod targets `GameUI/X/Y/Z` and the
  intermediate `GameUI/X` doesn't exist as stock) inherit anchors/size
  from any bare-name stock template with the same leaf name. See
  `materialize()` in `merge.js`.
- View modes filter the visible tree:
  - `game` (default) — hides template-named frames; cleanest preview
  - `placed` — shows everything `asFrameList` returns (templates + frames)
  - `all` — shows synthetic wrappers too

### Path namespacing for CASC extracts

SC2's CASC archive paths begin with `Mods\` or `Campaigns\`. When extracting,
we strip those prefixes so files land flat under `assets-root/<modname>.sc2mod/...`
matching CASCExplorer-style extractions. See `_strip_casc_namespace()` in
`casc.py`. If you don't strip, you get `assets-root/Mods/<modname>.sc2mod/...`
and the editor's URL routing breaks.

### TextureLoader mod-root precedence

The TextureLoader's `setModRoot(url)` lets the editor search the
currently-open mod's `Base.SC2Assets` folder FIRST before falling back to
the stock assets. Required for layouts that reference custom textures
(e.g. ShepardMod's units). The mod root is derived from `state.currentPath`
in `openByUrl()` by matching `/^(.*?\.SC2(Mod|Map))\//i`.

---

## Common pitfalls (bugs we've already fixed)

1. **Dialog with `display: flex` (no `[open]` qualifier)** — overrides
   browser default `display: none` for unopened `<dialog>`s, making them
   always visible. `.close()` becomes a no-op. CSS must use
   `dialog[open] { display: flex; }`.

2. **Drive-letter scan** for SC2 install must iterate A→Z, not just C/D/E.
   We had this hardcoded and missed the user's `F:\StarCraft II`.

3. **Anchor `.offset` is not a property** on parsed XML elements — they
   store attrs as `el.attrs[]` array. Use `attrVal(el, 'offset')`, never
   `el.offset`.

4. **Drag-start state must be captured ONCE.** If `_applyDrag` re-reads
   the anchor's current offset on every pointermove, deltas compound and
   the frame teleports off-screen.

5. **`stopPropagation` on pointerdown for nested frames.** Without it,
   parent .sc2-frame's pointerdown also fires → parent and child both
   start drag tracking → both move when the user drags one.

6. **Selection overlay must be created OUTSIDE `renderer.clear()`'s scope**
   — it's a child of the stage but not a `.sc2-frame`. `clear()` only
   removes elements with that class.

7. **Mod templates aren't auto-registered.** When the editor opens a mod
   file, call `registry.addModTemplates(modDoc.root, fileBase)` so
   `template="FileBase/Name"` references resolve. Without this, every
   frame that uses a same-file template renders empty.

8. **The `_extract_one` path must include `Mods\` / `Campaigns\` prefix**
   in the CascLib lookup. But when saving the extracted file to disk,
   STRIP that prefix. (See `_strip_casc_namespace`.)

---

## Running and building

```
# Dev mode (reads editor/ directly, hot-reload on browser refresh):
python serve.py
# → http://127.0.0.1:8765/

# Bundle .exe (run from sc2-ui-editor/ folder):
python build.py
# → dist/SC2UIEditor.exe  (~10 MB)
python build.py --clean    # wipe build cache first

# Rebuild CASC filename index against a fresh SC2 patch:
python casc_index.py "C:\Program Files (x86)\StarCraft II"
# → editor/data/casc-index.json
```

**To rebuild the .exe, kill any running instance first** — PyInstaller
can't overwrite a locked file:

```
taskkill /F /IM SC2UIEditor.exe
python build.py
```

---

## Testing checklist before shipping changes

1. `python run_tests.py` - all self-contained JavaScript and Python tests.
2. `python run_tests.py --integration` - live server, stock, and asset tests.
3. `python run_tests.py --layouts <mod-folder> [...]` - every discovered
   `.SC2Layout` must round-trip byte-exact.
4. Manual: open `UpgradeSlotPanel.SC2Layout`, drag a frame, release -
   no magenta flicker on either drag or release.
5. Manual: open the editor; the Warnings button only appears when there
   are actual errors/warnings.
6. Manual: Ctrl+S in Chromium writes the open file directly to disk.

---

## When you don't know something

The codebase is heavily commented — read the file you're modifying before
making changes. Top-of-file comments describe each module's purpose and
key invariants.

If a question is architectural, check this file first, then `SESSION_STATE.md`
for the "why we deferred X" context. If both come up empty, ask the user.
