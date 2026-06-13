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
import { attrVal, findChild } from '../xml/helpers.js';
import { makeElement, appendChildPreservingIndent } from '../xml/mutate.js';

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// Magnetism tolerance for snap-to-guide, in canvas pixels. Slightly larger
// than guides.js DEFAULT_TOLERANCE (3) so a snap engages right as the guide
// line would appear.
const GUIDE_TOL = 4;

/** Nudge a drag delta so the dragged frame's active edge(s) / center snap
 *  onto a candidate alignment coordinate. Works for both whole-frame moves
 *  (dir 'body': every edge + center translates 1:1) and resize handles
 *  (only the handle's edges move). For a resize, the moving edge tracks the
 *  cursor 1:1 EXCEPT a left/top edge that's "pinned" — i.e. the frame has no
 *  anchor on that axis, so applyDrag resizes from the opposite side and the
 *  edge doesn't actually follow the cursor. We skip snapping those so the
 *  magnetism never fights the real geometry. The smallest-magnitude
 *  adjustment within tolerance wins per axis; axes are independent.
 *  Pure function — exported for unit testing.
 *  @param {string} dir      handle id ('body','n','e','se',...)
 *  @param {{x,y,w,h}} box    start box in canvas space
 *  @param {number} dx,dy     raw cursor delta in canvas space
 *  @param {{xs:number[], ys:number[]}} targets candidate edge coords
 *  @param {number} tol       magnetism tolerance
 *  @param {{top,bottom,left,right}} [hasAnchor] which sides are anchored
 *  @returns {{dx:number, dy:number}}
 */
export function magnetizeMove(dir, box, dx, dy, targets, tol, hasAnchor = null) {
    const A = AFFECTS[dir];
    if (!A) return { dx, dy };
    const pick = (edges, delta, vals) => {
        let best = null;
        for (const e of edges) {
            const cur = e + delta;
            for (const t of (vals || [])) {
                const adj = t - cur;
                if (Math.abs(adj) <= tol && (best === null || Math.abs(adj) < Math.abs(best))) {
                    best = adj;
                }
            }
        }
        return best || 0;
    };
    let xEdges, yEdges;
    if (A.move) {
        xEdges = [box.x, box.x + box.w, box.x + box.w / 2];
        yEdges = [box.y, box.y + box.h, box.y + box.h / 2];
    } else {
        xEdges = [];
        yEdges = [];
        // A left/top edge only tracks the cursor if the frame is anchored on
        // that axis (else it's pinned and the opposite side resizes). With no
        // hasAnchor info, optimistically include it. Right/bottom always track.
        const xAnchored = !hasAnchor || hasAnchor.left || hasAnchor.right;
        const yAnchored = !hasAnchor || hasAnchor.top || hasAnchor.bottom;
        if (A.left && xAnchored) xEdges.push(box.x);
        if (A.right) xEdges.push(box.x + box.w);
        if (A.top && yAnchored) yEdges.push(box.y);
        if (A.bottom) yEdges.push(box.y + box.h);
    }
    return {
        dx: dx + pick(xEdges, dx, targets && targets.xs),
        dy: dy + pick(yEdges, dy, targets && targets.ys),
    };
}

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
        // Snap-targets function returns { xs:[...], ys:[...] } of candidate
        // alignment edge coordinates (canvas space) for a node's siblings /
        // parent. Used to magnetize body moves to nearby edges when grid
        // snap is off. Returns null/empty to disable.
        this.snapTargetsFn = opts.snapTargetsFn || (() => null);
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
        // Capture static alignment targets once at drag start (sibling edges
        // don't move while we drag). Used for body moves AND resize handles —
        // magnetizeMove picks the right edges per handle direction.
        const snapTargets = this.snapTargetsFn(node);

        this.onBeforeEdit(node);

        const onMove = (e) => {
            const dx = (e.clientX - startX) / z;
            const dy = (e.clientY - startY) / z;
            const snap = this.snapFn() || 0;
            // Guide magnetism: when grid snap is OFF, nudge the delta so a
            // moving edge aligns exactly with a nearby sibling/parent edge.
            // Grid snap takes precedence when enabled (single source of
            // truth for quantisation), so the two never fight.
            let mdx = dx, mdy = dy;
            if (!snap && snapTargets) {
                const m = magnetizeMove(dir, start.startBox, dx, dy, snapTargets, GUIDE_TOL, start.hasAnchor);
                mdx = m.dx; mdy = m.dy;
            }
            applyDrag(source, dir, mdx, mdy, start, snap);
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

// attrVal / findChild moved to xml/helpers.js in R4.1.

function num(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
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
        // Use the shared, indent-correct helper. The old local copy here
        // placed the new <Width>/<Height> at the closing-tag indent (one
        // level too shallow), producing a noisy round-trip diff when a
        // resize first created a size element. Deduped in the Round 5 audit.
        appendChildPreservingIndent(el, makeElement(tag, [['val', out]], true));
    }
    el.dirty = true;
}
