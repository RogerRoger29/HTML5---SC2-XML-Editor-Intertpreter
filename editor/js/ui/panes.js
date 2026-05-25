// Pane layout controller: collapse/expand + drag-to-resize for Hierarchy,
// Inspector, and XML panes. Sizes drive CSS custom properties on <html>;
// collapse adds body classes the stylesheet keys off.
//
// Layout state persists to localStorage so the editor opens with the same
// pane widths/heights you left it at.

const STORAGE_KEY = 'sc2editor.panes';
const MIN_W = 120;     // minimum side-pane width when expanded
const MIN_H = 80;      // minimum bottom-pane height when expanded
const COLLAPSED = 28;  // matches --collapsed in CSS; just a sanity floor

const DEFAULTS = { tree: 260, inspector: 320, xml: 240, collapsed: {} };

export class PaneController {
    constructor(opts = {}) {
        this.state = loadState();
        this.onLayoutChange = opts.onLayoutChange || (() => {});
        this.apply();
        this._wire();
    }

    apply() {
        const root = document.documentElement.style;
        root.setProperty('--tree-w', this.state.tree + 'px');
        root.setProperty('--inspector-w', this.state.inspector + 'px');
        root.setProperty('--xml-h', this.state.xml + 'px');
        const body = document.body.classList;
        for (const key of ['tree', 'inspector', 'xml']) {
            body.toggle(`${key}-collapsed`, !!this.state.collapsed[key]);
        }
    }

    save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch {}
        this.onLayoutChange(this.state);
    }

    toggleCollapse(target) {
        this.state.collapsed[target] = !this.state.collapsed[target];
        this.apply();
        this.save();
    }

    resetLayout() {
        this.state = JSON.parse(JSON.stringify(DEFAULTS));
        this.apply();
        this.save();
    }

    _wire() {
        // Collapse buttons in the pane header.
        document.querySelectorAll('.pane-collapse').forEach((btn) => {
            btn.addEventListener('click', () => this.toggleCollapse(btn.dataset.target));
        });
        // Expand buttons that show only when the pane is collapsed.
        document.querySelectorAll('.pane-expand').forEach((btn) => {
            btn.addEventListener('click', () => this.toggleCollapse(btn.dataset.target));
        });
        // Resize gutters - vertical (col-resize) for tree+inspector, horizontal
        // (row-resize) for XML.
        document.querySelectorAll('.resize-gutter').forEach((g) => {
            g.addEventListener('pointerdown', (ev) => this._beginResize(ev, g));
        });
    }

    _beginResize(ev, gutter) {
        const target = gutter.dataset.target;
        if (this.state.collapsed[target]) return;
        ev.preventDefault();
        gutter.setPointerCapture(ev.pointerId);
        gutter.classList.add('dragging');
        const isVertical = gutter.classList.contains('resize-gutter-x');
        const startMouse = isVertical ? ev.clientX : ev.clientY;
        const startSize = this.state[target];
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;

        const onMove = (e) => {
            const cur = isVertical ? e.clientX : e.clientY;
            const delta = cur - startMouse;
            let next;
            if (target === 'tree') {
                // gutter sits to the RIGHT of the tree pane -> drag right grows it
                next = startSize + delta;
                next = clamp(next, MIN_W, viewportW - 200);
            } else if (target === 'inspector') {
                // gutter sits to the LEFT of inspector -> drag right shrinks it
                next = startSize - delta;
                next = clamp(next, MIN_W, viewportW - 200);
            } else { // xml
                // gutter sits ABOVE xml pane -> drag down shrinks it
                next = startSize - delta;
                next = clamp(next, MIN_H, viewportH - 200);
            }
            this.state[target] = Math.round(next);
            this.apply();
            this.onLayoutChange(this.state);
        };
        const onUp = () => {
            gutter.releasePointerCapture(ev.pointerId);
            gutter.classList.remove('dragging');
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            this.save();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
    }
}

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
        const parsed = JSON.parse(raw);
        return {
            tree: clamp(parsed.tree || DEFAULTS.tree, MIN_W, 800),
            inspector: clamp(parsed.inspector || DEFAULTS.inspector, MIN_W, 800),
            xml: clamp(parsed.xml || DEFAULTS.xml, MIN_H, 800),
            collapsed: parsed.collapsed || {},
        };
    } catch {
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
