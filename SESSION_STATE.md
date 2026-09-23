# SESSION_STATE.md

Snapshot of where the SC2 UI Editor stands as of **v0.9.1**, what's
deferred, what's a known rough edge, and what to do next.

Read [AGENTS.md](AGENTS.md) for architecture / invariants first; this
file is the "what we haven't done yet + why" companion.

---

## Release status

- **Version:** 0.9.1 - see `editor/js/version.js` for full per-milestone
  changelog comments.
- **Distribution:** unsigned single-file `.exe` (13.2 MB) built via
  `python build.py`. Lives at `sc2-ui-editor/dist/SC2UIEditor.exe`.
- **Repo:** Posted to GitHub. README.md is the user-facing landing page.
  Tester feedback is the next signal.
- The user's stance: ready to circulate for community testing, willing
  to iterate on real-world bug reports.

The authoritative working source is
`E:/Users/Nicholas/Desktop/Projects/sc2-ui-editor/`. Tests use embedded
fixtures and do not depend on the former `UpgradeSlotSystem/` folder.

## What's intentionally deferred

These came up during planning but were explicitly skipped, with the
reason recorded so future sessions don't re-relitigate them.

### Animation playback
- `<Animation>` / `<Controller>` / `<Event>` blocks parse and round-trip
  cleanly, but the renderer does not play them back as animations.
- `<StateGroup>` states DO render (the inspector "Visual state preview"
  dropdown applies a state's `SetProperty` actions to the live tree —
  see `state-groups.js`).
- Implementing real timeline playback would need a per-frame keyframe
  interpolator + timeline scrubber UI. Easily a whole milestone of work.
- **Position:** worth doing eventually as a dedicated milestone.

### Multi-file tabs
- Editor handles one open `.SC2Layout` file at a time.
- Real mods are usually multi-file (DescIndex.SC2Layout + many siblings),
  so tabs would be a meaningful workflow upgrade.
- Requires: tab-bar UI, per-file state (modDoc / pristineSource / fileHandle /
  undo stack), shared registry, "open the file this template lives in" navigation.
- **Position:** big quality-of-life win once a user has tester feedback
  saying they hit it.

### In-game preview launcher
- "Launch SC2 with my mod loaded" button. Would shell out to
  `StarCraft II.exe -mappath ...`.
- Useful for closing the iteration loop, but tester-blocked: we'd want
  real workflow input on what arguments / map to launch first.

### Code signing
- The `.exe` is unsigned → Windows SmartScreen warns every tester on
  first run. README documents the workaround.
- Real fix: buy a code-signing cert ($200–400/yr) from Sectigo /
  DigiCert. **Position:** worth doing if community uptake is real.

### Per-locale FontStyles
- FontStyles.SC2Style ships in `Base.SC2Data/UI/FontStyles.SC2Style`
  (default) and `<locale>.sc2data/LocalizedData/UI/FontStyles.SC2Style`
  per-locale variants. We only load the Base copy.
- Locales might override Eurostile with locale-specific fonts (CJK etc.).
- Worth handling if a non-English tester reports wrong typography.

### Full DocController extraction (R4.8 follow-up)
- R4.8 hoisted the clean self-contained slice (UndoStack + round-trip diff)
  into `editor/js/doc-controller.js`, but the open/save/createNewLayout
  functions (`openFromText`, `openByUrl`, `openFile`, `saveCurrent`,
  `saveAs`, `saveAsDownload`, `createNewLayout`) still live in main.js.
- They touch too many subsystems (registry, textures, fileHandle, status
  bar, rerender) to extract safely in a single pass. The mechanical move
  is straightforward; the careful part is deciding the boundary between
  DocController (lifecycle) and main.js (orchestration).
- Worth doing if/when main.js grows another major slice. Suggested first
  pass: move the functions as-is into a class that takes `state, els,
  registry, textures` in the constructor and mutates them directly.

### Constants editor
- `<Constant>` definitions appear in stock layouts; we read them but don't
  edit them. Could surface a "constants" panel showing `#HeroButtonGap = -5`
  and let the user edit.
- Niche; deferred until requested.

## Known rough edges (not bugs, but watch for tester reports)

1. **CASC first-open delay (~30s)** is alarming if the user doesn't expect
   it. Tour mentions it but a progress bar inside the Assets dialog would
   help. Could surface CascLib's enumeration progress via a thread + SSE.

2. **3 current texture probes remain unresolved** in the configured extracted
   assets: `@UI_ActionButtonSelect`,
   `ui_void_mission_soa_frame_passive_lock.dds`, and
   `ui_nova_storymode_missionlaunch_breakingnews_border.dds`. They likely live
   in campaign-specific packs that have not been extracted. The integration
   suite reports these misses while still requiring at least one real asset
   to resolve through the server.

3. **HTML Export with textures inlined** can produce 10+ MB output for
   layouts with many large DDS files (each gets base64'd). Currently we
   wait for all textures to load before serializing. Consider:
   - "Slim export" option that links textures rather than inlining
   - Streaming export with progress feedback

4. **Find-frame palette** doesn't search inside template definitions.
   A frame referenced via `template="X"` won't surface "X" as a hit
   unless the user opens the file that defines X. Probably fine.

5. **Validator** only knows a handful of rules (dangling templates,
   missing children for specific types, anchor + Width conflicts).
   Easy to add more rules to `validate.js` as we learn what breaks in-game.

6. **Save-back relies on File System Access API** which is Chromium-only.
   Firefox/Safari fall back to download dialogs. The fallback works but
   tester confusion is plausible — they'll think "Save doesn't work."
   README addresses this; in-product messaging could be better.

7. **Welcome tour spotlight selector for the File menu** uses
   `[data-menu="file"] > .menu-button`. If the menu structure changes,
   spotlight breaks gracefully (hides itself) but the user loses the
   visual cue. Selector lives in `editor/js/ui/welcome.js`.

8. **Port fallback iterates 8765→8774** but doesn't update any
   browser-side state about which port won. The browser sees the URL the
   server printed to its window.open call, so this works in practice, but
   if the user manually navigates to http://127.0.0.1:8765 after the
   server bound to 8766 they'll get nothing.

## Things to verify before each new release

(Same as the checklist at the bottom of AGENTS.md, repeated here for
quick reference.)

```bash
# Self-contained JavaScript and Python suite
python run_tests.py

# Live local server, stock layouts, and asset aliases
python run_tests.py --integration

# Byte-exact round trips for real mod layouts
python run_tests.py --layouts path/to/mod path/to/another/mod
```

Plus manual smoke-test:

- [ ] Launch the .exe; SmartScreen lets you through after "More info"
- [ ] Welcome tour appears on first launch only
- [ ] Open UpgradeSlotPanel.SC2Layout; canvas populates
- [ ] Drag a frame; no magenta flicker during or after
- [ ] Resize a corner; XML updates on release
- [ ] Ctrl+P opens the find palette; typing filters; Enter selects
- [ ] Inspector spinner held down → frame moves live
- [ ] Visual state preview dropdown switches Normal/Hover
- [ ] Ctrl+S writes the file (or downloads on Firefox)
- [ ] Warnings button only appears when there are real warnings

## How to bring up a new session up to speed

If you're a Claude session starting fresh:

1. Read this file + `AGENTS.md` + `README.md`. About 10 minutes of reading.
2. Skim `editor/js/version.js` for the per-milestone changelog.
3. Open whatever file you're being asked about; comments are dense.
4. If the user asks for a new feature, check if it's listed under
   "intentionally deferred" above — there may already be a reason and
   half a design.
5. If you make changes, follow the testing checklist before declaring done.

## How to update this file going forward

Treat it as a working document. When you finish a milestone:

1. Bump `editor/js/version.js`, `version.py`, the `casc_index.py` example,
   and the `casc-index.json` metadata to the new version.
2. Append the milestone to version.js's changelog comment.
3. Move whatever you completed from "deferred" out of that section
   (delete the entry or move to a "completed in vN" section if you want
   to keep the history).
4. Add any new rough edges discovered.
5. Refresh the testing checklist if you added a new test file.
