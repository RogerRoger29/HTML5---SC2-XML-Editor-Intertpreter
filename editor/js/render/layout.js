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
    walk(nodes);
}

function walk(nodes) {
    for (const node of nodes) {
        resolveBox(node);
        if (node.children.length) walk(node.children);
    }
}

function resolveBox(node) {
    const parentBox = node.parent;
    const hor = { min: null, max: null };
    const ver = { min: null, max: null };
    let fillOff = null;
    for (const a of node.anchors) {
        if (!a.side) { fillOff = a.offset || 0; continue; }
        const ref = resolveRelative(node, a.relative) || parentBox;
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

function resolveRelative(node, ref) {
    if (!ref || ref === '$parent') return node.parent;
    if (ref === '$this') return node;
    if (ref === '$root' || ref.startsWith('$ancestor')) {
        let n = node;
        while (n.parent && n.parent.children) n = n.parent;
        return n;
    }
    let cur = ref.startsWith('$parent/') ? node.parent : node.parent;
    const path = ref.replace(/^\$parent\//, '').split('/');
    for (const seg of path) {
        if (!cur || !cur.children) return null;
        const next = cur.children.find(c => c.name === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}
