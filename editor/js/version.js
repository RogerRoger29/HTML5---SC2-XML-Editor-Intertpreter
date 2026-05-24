// Single source of truth for the editor's version.
// Bumped on every meaningful change set.
//
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
export const VERSION = '0.5.0';
