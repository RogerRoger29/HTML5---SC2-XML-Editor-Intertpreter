// Anchor resolution / layout engine for SC2 frames.
//
// Each frame has up to four <Anchor side="Top|Bottom|Left|Right" .../> children.
// An anchor pins a specific side of the frame to a position on a relative frame:
//
//     <Anchor side="Top"    relative="$parent" pos="Min" offset="5"/>
//
// means: my Top edge sits at parent.Top + 5 (Min == Top for vertical).
//
// Rules:
//   - Anchored sides are pinned. Unanchored sides are derived from Width/Height.
//   - If both Top and Bottom are anchored, vertical size comes from anchors and
//     Height is ignored. Same for Left/Right with Width.
//   - With no anchors at all, a frame defaults to top-left of parent (offset 0)
//     with its declared Width/Height. (SC2 templates supply real defaults; we
//     match the most-common implicit behaviour for frames written from scratch.)
//   - The shorthand <Anchor relative="$parent" offset="N"/> (no side/pos) is
//     treated as "anchor all four sides to parent with this offset on each".
//
// Relative reference forms handled:
//   - $parent
//   - $this
//   - bare name      -> sibling lookup (search parent's children)
//   - path/name      -> path relative to current parent (slash-separated)
//   - $parent/name   -> explicit parent-relative path
//   - $root / $ancestor[...]  -> recognised but resolved to the canvas root
//                                in v1 (placeholder semantics).
//
// Output (per frame): { x, y, w, h }  - all in stage pixels, top-left origin.

const POS_MIN = 'Min';
const POS_MID = 'Mid';
const POS_MAX = 'Max';

export function resolveLayout(rootFrame, stageW, stageH) {
    // Build the frame tree from the parsed XML root: walk <Frame> elements.
    const tree = buildFrameTree(rootFrame);
    const stage = { x: 0, y: 0, w: stageW, h: stageH, frame: null, children: tree };
    for (const node of tree) node.parent = stage;
    walk(tree, stage);
    return tree;
}

function buildFrameTree(xmlRoot) {
    // SC2 layouts use <Desc> as the doc root. Direct children are top-level frames.
    const out = [];
    for (const child of xmlRoot.children) {
        if (child.type !== 'element') continue;
        if (child.tag === 'Frame' || isKnownFrameTag(child.tag)) {
            out.push(makeFrameNode(child));
        }
    }
    return out;
}

function isKnownFrameTag(tag) {
    // Some layouts use <Frame type="..."> exclusively but a few use shorthand
    // tags. Treat anything ending in "Frame", "Panel", "Image", "Label",
    // "Button", "Bar", "Box" as a frame-like container so we don't lose them.
    return /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip|Animation|Controller|Key)$/.test(tag);
}

function makeFrameNode(el) {
    const attrs = attrMap(el);
    const type = el.tag === 'Frame' ? (attrs.type || 'Frame') : el.tag;
    const name = attrs.name || '(unnamed)';
    const node = {
        type,
        name,
        xml: el,
        attrs,
        anchors: [],
        width: null,
        height: null,
        visible: true,
        children: [],
        parent: null,
    };
    for (const child of el.children) {
        if (child.type !== 'element') continue;
        switch (child.tag) {
            case 'Anchor': node.anchors.push(parseAnchor(child)); break;
            case 'Width':  node.width  = parseFloat(attrMap(child).val); break;
            case 'Height': node.height = parseFloat(attrMap(child).val); break;
            case 'Visible': node.visible = attrMap(child).val !== 'false' && attrMap(child).val !== 'False'; break;
            case 'Frame': {
                const sub = makeFrameNode(child);
                sub.parent = node;
                node.children.push(sub);
                break;
            }
            default:
                if (isKnownFrameTag(child.tag)) {
                    const sub = makeFrameNode(child);
                    sub.parent = node;
                    node.children.push(sub);
                }
        }
    }
    return node;
}

function parseAnchor(el) {
    const a = attrMap(el);
    return {
        side: a.side || null,                 // null = full-fill shorthand
        relative: a.relative || '$parent',
        pos: a.pos || (a.side ? sideToDefaultPos(a.side) : null),
        offset: a.offset != null ? parseFloat(a.offset) : 0,
    };
}

function sideToDefaultPos(side) {
    return (side === 'Top' || side === 'Left') ? POS_MIN : POS_MAX;
}

function attrMap(el) {
    const out = {};
    if (!el.attrs) return out;
    for (const a of el.attrs) out[a.name] = a.value;
    return out;
}

function walk(nodes, parentBox) {
    for (const node of nodes) {
        resolveBox(node, parentBox);
        if (node.children.length) walk(node.children, node);
    }
}

function resolveBox(node, parentBox) {
    // Compute axis-by-axis. For each axis we figure out:
    //   - left (or top):  number | null
    //   - right (or bot): number | null
    // Then we derive width/height from the pair plus optional Width/Height.
    const hor = { min: null, max: null };
    const ver = { min: null, max: null };

    let fullFillOffset = null;

    for (const a of node.anchors) {
        if (!a.side) {
            // Shorthand: all four sides.
            fullFillOffset = a.offset || 0;
            continue;
        }
        const ref = resolveRelative(node, a.relative);
        const refBox = ref || parentBox;
        if (a.side === 'Top' || a.side === 'Bottom') {
            const y = refY(refBox, a.pos) + a.offset;
            if (a.side === 'Top')    ver.min = y;
            else                     ver.max = y;
        } else if (a.side === 'Left' || a.side === 'Right') {
            const x = refX(refBox, a.pos) + a.offset;
            if (a.side === 'Left')   hor.min = x;
            else                     hor.max = x;
        }
    }

    if (fullFillOffset != null) {
        if (hor.min == null) hor.min = parentBox.x + fullFillOffset;
        if (hor.max == null) hor.max = parentBox.x + parentBox.w - fullFillOffset;
        if (ver.min == null) ver.min = parentBox.y + fullFillOffset;
        if (ver.max == null) ver.max = parentBox.y + parentBox.h - fullFillOffset;
    }

    // Fall back to top-left of parent if no anchors at all.
    if (node.anchors.length === 0) {
        hor.min = parentBox.x;
        ver.min = parentBox.y;
    }

    // Resolve width.
    let x, w;
    if (hor.min != null && hor.max != null) {
        x = hor.min;
        w = hor.max - hor.min;
    } else if (hor.min != null) {
        x = hor.min;
        w = node.width != null ? node.width : 0;
    } else if (hor.max != null) {
        w = node.width != null ? node.width : 0;
        x = hor.max - w;
    } else {
        x = parentBox.x;
        w = node.width != null ? node.width : parentBox.w;
    }

    let y, h;
    if (ver.min != null && ver.max != null) {
        y = ver.min;
        h = ver.max - ver.min;
    } else if (ver.min != null) {
        y = ver.min;
        h = node.height != null ? node.height : 0;
    } else if (ver.max != null) {
        h = node.height != null ? node.height : 0;
        y = ver.max - h;
    } else {
        y = parentBox.y;
        h = node.height != null ? node.height : parentBox.h;
    }

    node.x = x;
    node.y = y;
    node.w = w;
    node.h = h;
}

function refX(box, pos) {
    if (pos === POS_MIN) return box.x;
    if (pos === POS_MAX) return box.x + box.w;
    return box.x + box.w / 2;
}
function refY(box, pos) {
    if (pos === POS_MIN) return box.y;
    if (pos === POS_MAX) return box.y + box.h;
    return box.y + box.h / 2;
}

function resolveRelative(node, ref) {
    if (!ref || ref === '$parent') return node.parent;
    if (ref === '$this') return node;
    if (ref === '$root') return findRoot(node);
    if (ref.startsWith('$ancestor')) {
        // $ancestor[type=Foo] in v1: bubble to nearest typed ancestor; if not
        // resolvable, fall back to parent.
        const m = /type=([A-Za-z0-9_]+)/.exec(ref);
        if (m) {
            for (let p = node.parent; p; p = p.parent) {
                if (p.type === m[1]) return p;
            }
        }
        return findRoot(node);
    }
    // Path lookup. "$parent/Foo/Bar" or "Foo/Bar" or "Foo".
    let cur = ref.startsWith('$parent/') ? node.parent : node.parent;
    const path = ref.replace(/^\$parent\//, '').split('/');
    for (const segment of path) {
        if (!cur || !cur.children) return null;
        const next = cur.children.find(c => c.name === segment);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

function findRoot(node) {
    let n = node;
    while (n.parent && n.parent.frame !== null) n = n.parent;
    return n.parent || n;
}
