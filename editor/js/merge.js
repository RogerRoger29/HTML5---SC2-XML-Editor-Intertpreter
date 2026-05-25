// Frame tree merger.
//
// SC2 layout files contribute to a single conceptual frame hierarchy rooted at
// GameUI. Each <Frame> can:
//   - Define a new frame at a path
//   - Re-open an existing frame at a path and add/override children
//   - Reference a template= which provides a base set of children/attributes
//
// This module merges:
//   - Stock files in DescIndex order (via StockRegistry)
//   - One user-authored mod layout on top
// into a single virtual frame tree that the anchor resolver + renderer walk.

import { parseXml } from './xml/parser.js';

// Tags we treat as frame containers (same heuristic as anchor.js).
const FRAME_TAG = /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip)$/;

export class MergedTree {
    constructor(registry) {
        this.registry = registry;
        // Each merged node:
        //   { type, name, path, attrs, childTags: Element[], children: MergedNode[],
        //     sources: Element[], origin: 'stock'|'mod' }
        this.root = makeNode('GameUI', 'GameUI', 'GameUI', 'stock');
        this.byPath = new Map();
        this.byPath.set('GameUI', this.root);
    }

    /** Merge stock frames into the tree.
     *  Only frames with deep paths (name="A/B/C") are merged as visible UI.
     *  Bare-named top-level frames in stock files are treated as templates
     *  only - they remain available via registry.findTemplate() but don't
     *  clutter the rendered tree. */
    mergeStock() {
        const entries = [...this.registry.framesByPath.entries()]
            .filter(([path]) => path.includes('/'))
            .sort((a, b) => depthOf(a[0]) - depthOf(b[0]));
        for (const [path, info] of entries) {
            for (const src of info.sources) {
                this._mergeFrame(src.el, path, 'stock');
            }
        }
    }

    /** Apply a user mod layout's root <Desc> on top of the stock tree. */
    mergeMod(docRoot) {
        if (!docRoot) return;
        // First pass: collect every name referenced via template="..." so we
        // know which frames are "templates" (blueprints) vs actual UI placements.
        // A bare name like "SlotButtonTemplate" or a qualified "File/Name" both
        // contribute the final segment to this set.
        this.templateReferences = this.templateReferences || new Set();
        collectTemplateRefs(docRoot, this.templateReferences);
        for (const child of docRoot.children) {
            if (child.type !== 'element') continue;
            if (child.tag !== 'Frame' && !FRAME_TAG.test(child.tag)) continue;
            const a = attrMap(child);
            const path = a.name || '(unnamed)';
            this._mergeFrame(child, path, 'mod');
        }
    }

    _mergeFrame(el, path, origin) {
        const segments = path.split('/');
        // Ensure parent chain exists (synthetic Frames for any missing ancestors).
        let cur = this.root;
        let curPath = '';
        for (let i = 0; i < segments.length - 1; i++) {
            const seg = segments[i];
            curPath = curPath ? `${curPath}/${seg}` : seg;
            if (seg === 'GameUI' && cur === this.root) continue; // already at root
            let next = cur.children.find(c => c.name === seg);
            if (!next) {
                next = makeNode('Frame', seg, curPath, origin);
                next.synthetic = true;
                cur.children.push(next);
                next.parent = cur;
                this.byPath.set(curPath, next);
            }
            cur = next;
        }
        const leafName = segments[segments.length - 1];
        const leafPath = path;
        let node = cur.children.find(c => c.name === leafName);
        const attrs = attrMap(el);
        const type = el.tag === 'Frame' ? (attrs.type || 'Frame') : el.tag;
        if (!node) {
            node = makeNode(type, leafName, leafPath, origin);
            cur.children.push(node);
            node.parent = cur;
            this.byPath.set(leafPath, node);
        } else {
            // Re-opening: origin upgrades to 'mod' when a mod layer touches
            // a stock-origin node. ALSO let the mod's declared type override
            // the stock's - modders sometimes re-open a frame with a more
            // specific type (e.g. stock declares `Frame`, mod re-opens as
            // `Button`). Previously the first-defined type was sticky.
            if (origin === 'mod') {
                node.origin = 'mod';
                if (el.tag === 'Frame' && attrs.type) node.type = attrs.type;
                else if (el.tag !== 'Frame') node.type = el.tag;
            }
        }
        node.sources.push(el);

        // Template lookup: load the template's tag list as virtual children.
        const tmplRef = attrs.template;
        if (tmplRef) node.template = tmplRef;

        // Walk the source's children and push them in. Nested <Frame> children
        // get merged recursively under this node's path.
        for (const child of el.children) {
            if (child.type !== 'element') continue;
            if (child.tag === 'Frame' || FRAME_TAG.test(child.tag)) {
                const childAttrs = attrMap(child);
                const childName = childAttrs.name || '(unnamed)';
                // Child's effective path is parent/child (unless child name is
                // itself a slash-path, which would be unusual but legal).
                const childPath = childName.includes('/') ? childName : `${leafPath}/${childName}`;
                this._mergeFrame(child, childPath, origin);
            } else {
                // Stash attribute-like children (Width, Height, Anchor, Visible,
                // Texture, Style, Text, ...) directly on the node so the layout
                // engine and renderer can read them. Later layers append (mod
                // anchors override stock anchors, etc.).
                node.props.push(child);
            }
        }
    }

    /** Build a flat array of root-level frames for the layout engine.
     *  With includeStock=false, stock-origin nodes are kept only if they
     *  contain a mod-origin descendant (so the parent chain leading to a
     *  mod override stays in the tree). */
    asFrameList(opts = { includeStock: true }) {
        const keep = (n) => {
            if (opts.includeStock) return true;
            if (n.origin === 'mod') return true;
            return n.children.some(c => keep(c));
        };
        const materializeOpts = {
            ...opts,
            templateReferences: this.templateReferences || new Set(),
        };
        const out = [];
        for (const child of this.root.children) {
            if (!keep(child)) continue;
            out.push(materialize(child, this.registry, materializeOpts));
        }
        return out;
    }
}

// Convert an XML <Frame> element into a freshly-allocated MergedNode subtree
// (used when expanding template-inherited children). Recurses so a Button
// inside a template brings along its NormalImage/HoverImage grandchildren etc.
function elementToNode(el, path, origin) {
    const attrs = {};
    for (const a of el.attrs) attrs[a.name] = a.value;
    const type = el.tag === 'Frame' ? (attrs.type || 'Frame') : el.tag;
    const node = makeNode(type, attrs.name || '(unnamed)', path, origin);
    node.sources.push(el);
    node.template = attrs.template || null;
    for (const c of el.children) {
        if (c.type !== 'element') continue;
        if (FRAME_TAG.test(c.tag) || c.tag === 'Frame') {
            const cName = (c.attrs.find(a => a.name === 'name') || {}).value;
            if (!cName) continue;
            const child = elementToNode(c, path + '/' + cName, origin);
            child.parent = node;
            node.children.push(child);
        } else {
            node.props.push(c);
        }
    }
    return node;
}

function makeNode(type, name, path, origin) {
    return {
        type, name, path, origin,
        attrs: {},
        props: [],          // non-Frame children (Width, Anchor, Texture, ...)
        sources: [],        // original XML <Frame> elements contributing to this node
        children: [],       // child MergedNodes
        parent: null,
        template: null,
        synthetic: false,   // true if we made this up to anchor a deeper child
    };
}

function depthOf(path) {
    return path.split('/').length;
}

// Walk the document collecting names referenced via template="..." attributes.
// "UpgradeSlotPanel/SlotButtonTemplate" contributes "SlotButtonTemplate"; bare
// "StandardButton" contributes "StandardButton". This set lets us detect which
// bare-named frames are templates (blueprints) vs actual placed UI.
function collectTemplateRefs(el, into) {
    if (!el || !el.children) return;
    for (const c of el.children) {
        if (c.type !== 'element') continue;
        if (c.attrs) {
            const tmpl = c.attrs.find(a => a.name === 'template');
            if (tmpl && tmpl.value) {
                const last = tmpl.value.split('/').pop();
                into.add(tmpl.value);
                into.add(last);
            }
        }
        collectTemplateRefs(c, into);
    }
}

function attrMap(el) {
    const out = {};
    if (!el.attrs) return out;
    for (const a of el.attrs) out[a.name] = a.value;
    return out;
}

// Convert a MergedNode into the shape the existing anchor.js / frames.js code
// expects (a frame node with .xml, .anchors, .width, .height, .visible, .children).
// We synthesize a virtual XML element that combines props from all source
// elements plus the resolved template.
function materialize(node, registry, opts) {
    // Resolve template inheritance: extract template's non-frame props directly,
    // and clone its child frames into our subtree (full depth recursion).
    const props = [];
    if (node.template) {
        const tmpl = registry.findTemplate(node.template);
        if (tmpl) {
            for (const c of tmpl.children) {
                if (c.type !== 'element') continue;
                if (FRAME_TAG.test(c.tag) || c.tag === 'Frame') {
                    const childName = (c.attrs.find(a => a.name === 'name') || {}).value;
                    if (!childName) continue;
                    // Only add the template's child if we don't already have one with
                    // that name (local children win). The full subtree of the template
                    // child gets cloned via elementToNode so deep nested grandchildren
                    // (NormalImage / HoverImage inside a Button) come along.
                    if (!node.children.find(ch => ch.name === childName)) {
                        const subPath = node.path + '/' + childName;
                        const child = elementToNode(c, subPath, node.origin);
                        child.parent = node;
                        node.children.push(child);
                    }
                } else {
                    props.push(c);
                }
            }
        }
    }
    // Local props (later sources override earlier; mod overrides stock).
    for (const p of node.props) props.push(p);

    const anchors = [];
    let width = null;
    let height = null;
    let visible = true;
    const otherProps = [];
    for (const p of props) {
        switch (p.tag) {
            case 'Anchor': anchors.push(parseAnchor(p, registry)); break;
            case 'Width':  width = parseFloatVal(p, registry); break;
            case 'Height': height = parseFloatVal(p, registry); break;
            case 'Visible': {
                const v = (attrMap(p).val || '').toLowerCase();
                visible = !(v === 'false' || v === '0');
                break;
            }
            default: otherProps.push(p);
        }
    }
    // Construct a synthetic XML-ish object so existing renderer code keeps
    // working. The renderer only reads .attrs and .children for prop lookup.
    const syntheticXml = {
        type: 'element',
        tag: 'Frame',
        attrs: [
            { name: 'type', value: node.type },
            { name: 'name', value: node.name },
        ],
        children: props,
    };

    // If this is a synthetic chain wrapper, try to inherit anchors/size from a
    // bare-name template with the same leaf name (e.g. synthetic
    // GameUI/UIContainer/.../HeroPanel borrows the stock "HeroPanel" template's
    // size). This makes overrides land in approximately the right place even
    // without SC2's hardcoded GameUI knowledge.
    if (node.synthetic && anchors.length === 0 && width == null && height == null) {
        const tmpl = registry.templatesByName.get(node.name);
        if (tmpl) {
            for (const c of tmpl.children) {
                if (c.type !== 'element') continue;
                if (c.tag === 'Anchor') anchors.push(parseAnchor(c, registry));
                else if (c.tag === 'Width') width = parseFloatVal(c, registry);
                else if (c.tag === 'Height') height = parseFloatVal(c, registry);
            }
        }
    }

    // Locate the mod XML source for this node so the edit overlay can mutate
    // the right element. Stock-only nodes have no mod source.
    let modSource = null;
    for (const src of node.sources) {
        // We don't currently tag sources with origin; in practice the mod's
        // mergeMod runs after mergeStock, so the LAST source pushed for any
        // node that was touched by the mod is the mod source.
        modSource = src;
    }
    // Diagnostic: when a mod-origin node has multiple sources, inspector
    // edits / drag math will silently land on the LAST one. Surface that so
    // the user can tell why a given edit went to "the wrong" definition.
    // Common cause: a re-opened frame defined in two places in the same file.
    if (node.origin === 'mod' && node.sources.length > 1) {
        console.warn(
            `[merge] ${node.path}: ${node.sources.length} sources; edits will target the last one`);
    }

    // Classify as a template if this name is the target of any template="..."
    // reference, OR its name ends in the conventional "Template" suffix.
    // Templates are blueprints that other frames instantiate via template=,
    // so they shouldn't clutter the canvas in "in-game preview" mode.
    const refs = (opts && opts.templateReferences) || null;
    const isTemplate = !node.path.includes('/') && (
        node.name.endsWith('Template') ||
        (refs && refs.has(node.name))
    );

    const matNode = {
        type: node.type,
        name: node.name,
        path: node.path,
        origin: node.origin,
        synthetic: node.synthetic,
        isTemplate,
        xml: syntheticXml,
        anchors,
        width,
        height,
        visible,
        _modSource: node.origin === 'mod' ? modSource : null,
        children: node.children.map(c => materialize(c, registry, opts)),
        parent: null,
    };
    for (const c of matNode.children) c.parent = matNode;
    return matNode;
}

function parseAnchor(el, registry) {
    const a = attrMap(el);
    return {
        side: a.side || null,
        relative: a.relative || '$parent',
        pos: a.pos || (a.side ? ((a.side === 'Top' || a.side === 'Left') ? 'Min' : 'Max') : null),
        offset: a.offset != null ? parseFloat(registry.resolveValue(a.offset)) || 0 : 0,
    };
}

function parseFloatVal(el, registry) {
    const v = registry.resolveValue((attrMap(el).val) || '');
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
}
