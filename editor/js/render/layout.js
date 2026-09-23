// Anchor-resolution layout walker for the MERGED frame tree shape
// produced by merge.js#materialize: nodes with .anchors, .width, .height,
// .children, and a .parent field this module sets while walking.
//
// Each node ends up with .x/.y/.w/.h in stage coordinates suitable for
// CSS positioning (the renderer in frames.js consumes them directly).
//
// SC2 anchor semantics (one anchor per side):
//   <Anchor side="Left|Right|Top|Bottom" relative="$parent/Foo" pos="Min|Mid|Max" offset="N"/>
// An anchor with NO side and just an offset is the "fill" form - inset
// from the parent by `offset` on all sides.
//
// Before R4.7 there were two implementations: the original render/anchor.js
// (which operated on raw XML) and an inlined copy in main.js (which
// operated on the merged shape). Only the merged-shape one was actually
// called; the XML-shape one was 252 lines of misleading dead code.

/** Lay out a forest of merged nodes inside a stageW x stageH canvas.
 *  Mutates each node in place, attaching .parent, .x, .y, .w, .h.
 */
export function layoutFrames(nodes, stageW, stageH) {
    const stage = { x: 0, y: 0, w: stageW, h: stageH, parent: null, children: nodes };
    for (const n of nodes) n.parent = stage;
    const resolved = new Set([stage]);
    const resolving = [];
    const cycles = [];

    // Resolve anchor dependencies on demand instead of relying on XML order.
    // SC2 layouts routinely anchor a frame to a sibling declared later. A
    // single depth-first pass reads that sibling before it has a box and
    // produces NaN coordinates. DFS gives us a topological order while the
    // resolving stack provides deterministic cycle detection.
    const ensureResolved = (node) => {
        if (!node || resolved.has(node)) return true;
        const cycleAt = resolving.indexOf(node);
        if (cycleAt !== -1) {
            const cycle = resolving.slice(cycleAt).concat(node).map(n => n.path || n.name);
            cycles.push(cycle);
            return false;
        }
        resolving.push(node);
        if (node.parent && node.parent !== stage) ensureResolved(node.parent);
        for (const a of node.anchors || []) {
            const ref = resolveRelative(node, a.relative);
            if (ref && ref !== node && ref !== node.parent && ref !== stage) {
                ensureResolved(ref);
            }
        }
        resolveBox(node);
        resolved.add(node);
        resolving.pop();
        return true;
    };

    const visit = (list) => {
        for (const node of list) {
            ensureResolved(node);
            if (node.children && node.children.length) visit(node.children);
        }
    };
    visit(nodes);
    if (cycles.length) {
        const unique = [...new Set(cycles.map(c => c.join(' -> ')))];
        console.warn('[layout] cyclic anchor dependencies; parent-relative fallback used:', unique);
    }
    return { cycles };
}

function resolveBox(node) {
    const parentBox = node.parent;
    const hor = { min: null, max: null };
    const ver = { min: null, max: null };
    let fillOff = null;
    for (const a of node.anchors) {
        if (!a.side) { fillOff = a.offset || 0; continue; }
        const candidate = resolveRelative(node, a.relative);
        // Cycles and dangling references fall back to the parent box. This is
        // preferable to emitting NaNpx, which makes the browser retain stale
        // CSS positioning and obscures the real problem.
        const ref = isFiniteBox(candidate) ? candidate : parentBox;
        if (a.side === 'Top' || a.side === 'Bottom') {
            const y = refPos(ref, a.pos, 'v') + a.offset;
            if (a.side === 'Top') ver.min = y; else ver.max = y;
        } else {
            const x = refPos(ref, a.pos, 'h') + a.offset;
            if (a.side === 'Left') hor.min = x; else hor.max = x;
        }
    }
    if (fillOff != null) {
        if (hor.min == null) hor.min = parentBox.x + fillOff;
        if (hor.max == null) hor.max = parentBox.x + parentBox.w - fillOff;
        if (ver.min == null) ver.min = parentBox.y + fillOff;
        if (ver.max == null) ver.max = parentBox.y + parentBox.h - fillOff;
    }
    if (!node.anchors.length) {
        hor.min = parentBox.x;
        ver.min = parentBox.y;
    }
    let x, w;
    if (hor.min != null && hor.max != null) { x = hor.min; w = hor.max - hor.min; }
    else if (hor.min != null) { x = hor.min; w = node.width != null ? node.width : 0; }
    else if (hor.max != null) { w = node.width != null ? node.width : 0; x = hor.max - w; }
    else { x = parentBox.x; w = node.width != null ? node.width : parentBox.w; }
    let y, h;
    if (ver.min != null && ver.max != null) { y = ver.min; h = ver.max - ver.min; }
    else if (ver.min != null) { y = ver.min; h = node.height != null ? node.height : 0; }
    else if (ver.max != null) { h = node.height != null ? node.height : 0; y = ver.max - h; }
    else { y = parentBox.y; h = node.height != null ? node.height : parentBox.h; }
    node.x = x; node.y = y; node.w = w; node.h = h;
}

function refPos(ref, pos, axis) {
    if (axis === 'h') {
        if (pos === 'Min') return ref.x;
        if (pos === 'Max') return ref.x + ref.w;
        return ref.x + ref.w / 2;
    }
    if (pos === 'Min') return ref.y;
    if (pos === 'Max') return ref.y + ref.h;
    return ref.y + ref.h / 2;
}

function isFiniteBox(box) {
    return !!box
        && Number.isFinite(box.x)
        && Number.isFinite(box.y)
        && Number.isFinite(box.w)
        && Number.isFinite(box.h);
}

function resolveRelative(node, ref) {
    if (!ref || ref === '$parent') return node.parent;
    if (ref === '$this') return node;
    if (ref === '$root') {
        let n = node;
        while (n.parent && n.parent.children) n = n.parent;
        return n;
    }
    if (ref.startsWith('$ancestor')) {
        const typeMatch = /(?:@?type)=([A-Za-z0-9_]+)/.exec(ref);
        const nameMatch = /(?:@?name)=([A-Za-z0-9_.-]+)/.exec(ref);
        let top = node.parent;
        for (let n = node.parent; n; n = n.parent) {
            top = n;
            if ((!typeMatch || n.type === typeMatch[1])
                && (!nameMatch || n.name === nameMatch[1])) return n;
        }
        return top;
    }
    // A path ref (`$parent/Foo/Bar` or a bare `Sibling`) resolves relative to
    // the parent's children. (Both forms start from node.parent; the leading
    // `$parent/` is just stripped below.)
    let cur = node.parent;
    const path = ref.replace(/^\$parent\//, '').split('/');
    for (const seg of path) {
        if (!cur || !cur.children) return null;
        const next = cur.children.find(c => c.name === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}
