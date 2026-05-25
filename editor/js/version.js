// Single source of truth for the editor's version.
// Bumped on every meaningful change set.
//
// 0.5.2 - Tester feedback round 1 (issues #1-#4):
//   * #4: Stop emitting <HAlign>/<VAlign> children - not valid SC2
//          layout XML. Inspector loses those dropdowns; validator
//          now flags any presence as an error.
//   * #3: Fix children double-displacing on parent drag. Renderer
//          was writing stage-absolute coords into CSS `left`, but
//          the parent .sc2-frame is `position: absolute` so child
//          left was added on top of parent left. Subtract parent
//          origin so CSS positioning matches.
//   * #2: Allow Width/Height edits when both opposing anchors are
//          set. SC2 centers the frame between anchors when both
//          are present + Width/Height explicit. Inspector now shows
//          an informational note instead of soft-disabling.
//   * #1: Add Frame palette now seeds the SC2-expected default
//          sub-children for CheckBox / EditBox / ListBox, and adds
//          a Label child to Buttons. (Reference: Talv's frame-type
//          page on mapster.talv.space.)
// 0.5.1 - Audit rounds 1-4 (zero new features; correctness + structure):
//   * R1: 7 critical bug fixes (CASC encoding, path traversal, handle
//          leaks, state-group reset, texture race, file-handle leak,
//          escapeHtml duplicate)
//   * R2: 11 correctness/perf fixes (server locking, per-file lock
//          granularity, autocomplete leak, tree collapse persistence,
//          select-by-path, fontstyle cycle guard, pointercancel cleanup,
//          merge mod-source warning, findFrameByName fix, mod type
//          override, download/cascextract path traversal)
//   * R3: 7 polish items (body-size cap, casc_index collision case,
//          webbrowser fallback, version single source of truth,
//          parser _trailer clear on setAttr, inspector blur-on-show)
//          + 5 Python smoke tests
//   * R4: 8 refactors (xml/helpers.js, constants.js, xml/mutate.js,
//          resetAssetDependentCaches, deleted dead anchor.js, render/
//          layout.js, ui/assets-dialog.js, serve.py route table,
//          doc-controller.js for UndoStack + round-trip)
// 0.5.0 - Polish + accuracy milestone:
//   * Topbar reorganised into File/Edit/Insert/View menus
//   * Save to disk via File System Access API (Chromium)
//   * Find-frame palette (Ctrl+P) with fuzzy ranked matches
//   * Color picker for LayerColor (and any color-typed field)
//   * StateGroup preview: switch Hover/Pressed/Checked in inspector
// 0.4.0 - From-scratch authoring track:
//   * Editable property inspector (Width/Height/anchors/text/style/alignment)
//   * Delete key, Add Frame palette, New blank layout, Save As
//   * Standalone HTML Export
//   * Resizable + collapsible panes with localStorage persistence
//   * Grid snap with visual overlay
//   * Hierarchy drag-to-reorder
//   * Live spinner updates (input event)
//   * Width/Height anchor-override hints
//   * Keyboard shortcuts (G/O/B/F/Esc + Ctrl+N/O/S/Shift+S)
// 0.3.0 - Stock layout + CASC integration:
//   * CascLib bundling for in-editor texture extraction
//   * CASC filename index + on-demand auto-extract
//   * Persistent assets dialog, drag-edit flicker fix
export const VERSION = '0.5.2';
