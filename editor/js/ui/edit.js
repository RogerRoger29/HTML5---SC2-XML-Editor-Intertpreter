// Drag-to-edit: selection overlay with resize handles + body drag.
//
// Resize handles (corners and edge midpoints) sit on a separate overlay layer
// above the canvas; the SELECTED frame itself is what receives body drags
// (via a pointerdown handler the renderer installs). This means children of
// a selected frame remain clickable - the overlay body doesn't intercept them.
//
// Each drag captures starting anchor offsets and Width/Height ONCE so the
// applied delta is always measured from the drag's origin, not from the
// frame's already-moved current state.

import { setAttr } from '../xml/serializer.js';

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export class SelectionOverlay {
    constructor(stage, opts) {
        this.stage = stage;
        this.onEdit = opts.onEdit || (() => {});
        this.onBeforeEdit = opts.onBeforeEdit || (() => {});
        this.zoomFn = opts.zoomFn || (() => 1);
        // Snap function returns the grid size in canvas pixels, or 0/falsy
        // if snapping is off. Re-read on every drag so toggling in the UI
        // takes effect immediately.
        this.snapFn = opts.snapFn || (() => 0);
        this.node = null;
        this.root = document.createElement('div');
        this.root.className = 'selection-overlay';
        this.root.style.display = 'none';
        this.stage.appendChild(this.root);

        this.handles = {};
        for (const dir of HANDLE_DIRS) {
            const h = document.createElement('div');
            h.className = 'sel-handle sel-' + dir;
            h.dataset.dir = dir;
            this.root.appendChild(h);
            this.handles[dir] = h;
            h.addEventListener('pointerdown', (ev) => this._beginDrag(ev, dir, h));
        }
    }

    hide() {
        this.node = null;
        this.root.style.display = 'none';
    }

    show(node) {
        if (!node) return this.hide();
        this.node = node;
        this.root.style.display = '';
        this.position();
    }

    /** Reposition the overlay over the current selection (e.g. after re-render). */
    position() {
        if (!this.node) return;
        const n = this.node;
        Object.assign(this.root.style, {
            left: n.x + 'px',
            top: n.y + 'px',
            width: n.w + 'px',
            height: n.h + 'px',
        });
    }

    /** Begin a body drag from outside (e.g. the renderer's pointerdown on the
     *  selected frame's own DOM element). Equivalent to a 'body' handle drag. */
    beginBodyDrag(node, ev, captureTarget) {
        if (this.node !== node) this.show(node);
        this._beginDrag(ev, 'body', captureTarget || ev.currentTarget || ev.target);
    }

    _beginDrag(ev, dir, captureTarget) {
        if (!this.node) return;
        if (!this.node.origin || this.node.origin !== 'mod') return;
        const node = this.node;
        const source = node._modSource;
        if (!source) return;
        ev.preventDefault();
        ev.stopPropagation();
        try { captureTarget.setPointerCapture(ev.pointerId); } catch {}

        // Capture start state ONCE. All subsequent pointermove deltas are
        // measured from this snapshot so we don't compound drift.
        const startX = ev.clientX, startY = ev.clientY;
        const z = this.zoomFn() || 1;
        const start = captureStart(source, node);

        this.onBeforeEdit(node);

        const onMove = (e) => {
            const dx = (e.clientX - startX) / z;
            const dy = (e.clientY - startY) / z;
            const snap = this.snapFn() || 0;
            applyDrag(source, dir, dx, dy, start, snap);
            this.onEdit(node, /*live=*/true);
        };
        const onUp = (e) => {
            try { captureTarget.releasePointerCapture(ev.pointerId); } catch {}
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            this.onEdit(node, /*live=*/false);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        // pointercancel fires when the OS interrupts the gesture - without
        // this listener the move/up pair would leak permanently.
        document.addEventListener('pointercancel', onUp);
    }
}

// --- start snapshot ----------------------------------------------------------

function captureStart(source, node) {
    const anchors = readAnchors(source);
    const widthEl = findChild(source, 'Width');
    const heightEl = findChild(source, 'Height');
    return {
        startBox: { x: node.x, y: node.y, w: node.w, h: node.h },
        baseOff: {
            top: anchors.Top ? num(attrVal(anchors.Top, 'offset')) : null,
            bottom: anchors.Bottom ? num(attrVal(anchors.Bottom, 'offset')) : null,
            left: anchors.Left ? num(attrVal(anchors.Left, 'offset')) : null,
            right: anchors.Right ? num(attrVal(anchors.Right, 'offset')) : null,
        },
        hasAnchor: {
            top: !!anchors.Top, bottom: !!anchors.Bottom,
            left: !!anchors.Left, right: !!anchors.Right,
        },
        baseW: widthEl ? (parseFloat(attrVal(widthEl, 'val')) || node.w) : node.w,
        baseH: heightEl ? (parseFloat(attrVal(heightEl, 'val')) || node.h) : node.h,
    };
}

// --- apply --------------------------------------------------------------------

function applyDrag(source, dir, dx, dy, start, snap) {
    const affects = AFFECTS[dir];
    if (!affects) return;
    // q() snaps a target value to the nearest grid multiple. The grid is
    // applied to the FINAL value (baseOff + delta) so successive drags don't
    // accumulate sub-pixel drift. snap=0 means snapping disabled.
    const q = snap > 0 ? (v) => Math.round(v / snap) * snap : (v) => v;

    // Horizontal axis.
    if (affects.move) {
        if (start.hasAnchor.left) writeAnchor(source, 'Left', q(start.baseOff.left + dx));
        if (start.hasAnchor.right) writeAnchor(source, 'Right', q(start.baseOff.right + dx));
    } else if (affects.left) {
        if (start.hasAnchor.left) writeAnchor(source, 'Left', q(start.baseOff.left + dx));
        else if (start.hasAnchor.right) writeSized(source, 'Width', Math.max(1, q(start.baseW - dx)));
        else writeSized(source, 'Width', Math.max(1, q(start.baseW - dx)));
    } else if (affects.right) {
        if (start.hasAnchor.right) writeAnchor(source, 'Right', q(start.baseOff.right + dx));
        else writeSized(source, 'Width', Math.max(1, q(start.baseW + dx)));
    }

    // Vertical axis.
    if (affects.move) {
        if (start.hasAnchor.top) writeAnchor(source, 'Top', q(start.baseOff.top + dy));
        if (start.hasAnchor.bottom) writeAnchor(source, 'Bottom', q(start.baseOff.bottom + dy));
    } else if (affects.top) {
        if (start.hasAnchor.top) writeAnchor(source, 'Top', q(start.baseOff.top + dy));
        else if (start.hasAnchor.bottom) writeSized(source, 'Height', Math.max(1, q(start.baseH - dy)));
        else writeSized(source, 'Height', Math.max(1, q(start.baseH - dy)));
    } else if (affects.bottom) {
        if (start.hasAnchor.bottom) writeAnchor(source, 'Bottom', q(start.baseOff.bottom + dy));
        else writeSized(source, 'Height', Math.max(1, q(start.baseH + dy)));
    }
}

const AFFECTS = {
    nw:   { top: true,  left: true,  bottom: false, right: false, move: false },
    n:    { top: true,  left: false, bottom: false, right: false, move: false },
    ne:   { top: true,  left: false, bottom: false, right: true,  move: false },
    e:    { top: false, left: false, bottom: false, right: true,  move: false },
    se:   { top: false, left: false, bottom: true,  right: true,  move: false },
    s:    { top: false, left: false, bottom: true,  right: false, move: false },
    sw:   { top: false, left: true,  bottom: true,  right: false, move: false },
    w:    { top: false, left: true,  bottom: false, right: false, move: false },
    body: { top: true,  left: true,  bottom: true,  right: true,  move: true },
};

// --- helpers -----------------------------------------------------------------

function readAnchors(el) {
    const out = { Top: null, Bottom: null, Left: null, Right: null };
    for (const c of el.children) {
        if (c.type !== 'element' || c.tag !== 'Anchor') continue;
        const side = attrVal(c, 'side');
        if (side && side in out) out[side] = c;
    }
    return out;
}

function attrVal(el, name) {
    const a = el.attrs && el.attrs.find(x => x.name === name);
    return a ? a.value : undefined;
}

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
}

function findChild(el, tag) {
    if (!el || !el.children) return null;
    for (const c of el.children) if (c.type === 'element' && c.tag === tag) return c;
    return null;
}

function writeAnchor(el, side, newOffset) {
    for (const c of el.children) {
        if (c.type !== 'element' || c.tag !== 'Anchor') continue;
        if (attrVal(c, 'side') !== side) continue;
        const rounded = Math.round(newOffset * 10) / 10;
        setAttr(c, 'offset', String(rounded));
        el.dirty = true;
        return;
    }
}

function writeSized(el, tag, newVal) {
    const child = findChild(el, tag);
    const rounded = Math.round(newVal * 10) / 10;
    const out = String(rounded);
    if (child) {
        setAttr(child, 'val', out);
    } else {
        const created = makeElement(tag, [{ name: 'val', value: out }], true);
        appendNewChild(el, created);
    }
    el.dirty = true;
}

function makeElement(tag, attrs, selfClosing) {
    return {
        type: 'element',
        tag,
        attrs: attrs.map(a => ({
            name: a.name, value: a.value, quote: '"',
            rawBetween: ' ', rawEq: '=', rawAfter: '',
        })),
        selfClosing: !!selfClosing,
        children: [],
        opening: null, closing: null,
        source: null,
        start: 0, end: 0,
        dirty: true,
    };
}

function appendNewChild(parent, child) {
    const kids = parent.children;
    let indent = '\n    ';
    for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.type === 'text' && /\n[ \t]*$/.test(k.raw)) {
            const m = k.raw.match(/\n([ \t]*)$/);
            if (m) indent = '\n' + m[1];
            break;
        }
    }
    const lastTrailing = kids[kids.length - 1];
    if (!lastTrailing || lastTrailing.type !== 'text' || !/\s$/.test(lastTrailing.raw)) {
        kids.push({ type: 'text', raw: indent, start: 0, end: 0, dirty: true });
    }
    kids.push(child);
    parent.dirty = true;
}
