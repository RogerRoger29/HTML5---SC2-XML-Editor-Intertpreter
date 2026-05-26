// Layout validator. Walks the open mod doc and surfaces problems that
// would either silently break the layout in-game OR signal common author
// mistakes. Output is a list of:
//
//   {
//     severity: 'error' | 'warning' | 'info',
//     message:  string,
//     framePath: string,            // human-readable path for display
//     element:  XmlElement,         // the underlying <Frame> source node;
//                                    // used to scroll-to / select the frame
//   }
//
// Pure function, no DOM. Run on every rerender; cheap for typical layouts.

import { attrMap, attrVal, findChild as findElementChild } from './xml/helpers.js';

const FRAME_TAGS = /^(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip|HeroPanel|HeroFrame|CommandPanel|MinimapPanel|ResourcePanel|CheckBox|EditBox|ListBox|ProgressBar|StatusBar|ScrollBar|Slider|TextureSelectFrame|InfoPanel)$/;

export function validate(modDoc, registry) {
    const out = [];
    if (!modDoc || !modDoc.root) return out;
    walk(modDoc.root, [], out, registry);
    return out;
}

function walk(el, ancestors, out, registry) {
    if (!el || el.type !== 'element') return;
    const isFrame = el.tag === 'Frame' || FRAME_TAGS.test(el.tag);
    if (isFrame) checkFrame(el, ancestors, out, registry);
    const newAncestors = isFrame ? [...ancestors, el] : ancestors;
    if (el.children) {
        for (const c of el.children) walk(c, newAncestors, out, registry);
    }
}

function checkFrame(el, ancestors, out, registry) {
    const attrs = attrMap(el);
    const type = el.tag === 'Frame' ? (attrs.type || 'Frame') : el.tag;
    const name = attrs.name || '(unnamed)';
    const framePath = ancestors.map(a => {
        const an = attrMap(a);
        return an.name || '?';
    }).concat(name).join('/') || name;

    const add = (severity, message) => out.push({ severity, message, framePath, element: el });

    // 1. Dangling template reference.
    if (attrs.template && registry) {
        const tpl = attrs.template;
        const last = tpl.split('/').pop();
        const found =
            (registry.templatesByPath && registry.templatesByPath.has(tpl)) ||
            (registry.templatesByName && registry.templatesByName.has(tpl)) ||
            (registry.templatesByName && registry.templatesByName.has(last));
        if (!found) {
            add('error', `Template "${tpl}" not found in any loaded layout. Frame will lack template-inherited children.`);
        }
    }

    // 2. Type-specific structural checks. We skip these when the frame uses
    //    a template= since the template likely provides what's missing.
    const hasTemplate = !!attrs.template;
    const hasOwn = (tag) => findElementChild(el, tag);
    const hasOwnFrame = (childName) => findFrameChildByName(el, childName);
    if (!hasTemplate) {
        if (type === 'Image' && !hasOwn('Texture')) {
            add('warning', `Image has no <Texture/> child. Will render as the magenta placeholder.`);
        }
        if (type === 'Label' && !hasOwn('Text')) {
            add('info', `Label has no <Text/> child. Will render blank in-game.`);
        }
        if (type === 'Button' && !hasOwnFrame('NormalImage')) {
            add('warning', `Button has no NormalImage child. Button will be invisible in its default state.`);
        }
    }

    // 3. Anchor checks: duplicate sides, malformed values.
    const anchorsBySide = {};
    let anchorCount = 0;
    for (const c of el.children || []) {
        if (c.type !== 'element' || c.tag !== 'Anchor') continue;
        anchorCount++;
        const side = attrVal(c, 'side');
        if (side) {
            if (anchorsBySide[side]) {
                add('error', `Duplicate <Anchor side="${side}"/>. SC2 keeps the last one; the others are dead code.`);
            }
            anchorsBySide[side] = c;
        }
        const off = attrVal(c, 'offset');
        if (off != null && off !== '' && !off.startsWith('#') && !Number.isFinite(parseFloat(off))) {
            add('warning', `<Anchor side="${side || '?'}" offset="${off}"/>: offset is not a number or constant reference.`);
        }
    }

    // 4. Width / Height ignored due to anchor double-pinning.
    const widthEl = findElementChild(el, 'Width');
    const heightEl = findElementChild(el, 'Height');
    if (widthEl && anchorsBySide.Left && anchorsBySide.Right) {
        add('info', `Width is ignored: frame is pinned on Left + Right, so anchor positions determine width.`);
    }
    if (heightEl && anchorsBySide.Top && anchorsBySide.Bottom) {
        add('info', `Height is ignored: frame is pinned on Top + Bottom, so anchor positions determine height.`);
    }
    for (const tag of ['Width', 'Height']) {
        const child = findElementChild(el, tag);
        if (!child) continue;
        const v = attrVal(child, 'val');
        if (v && !v.startsWith('#') && !Number.isFinite(parseFloat(v))) {
            add('warning', `<${tag} val="${v}"/>: value is not a number or constant reference.`);
        }
    }

    // 5b. TextureType: warn on unrecognized values so typos surface in
    // the warnings pane. Documented values per the SC2Mapster wiki.
    // None and Circular are documented as "purpose unknown" so we accept
    // them silently rather than warn.
    const ttEl = findElementChild(el, 'TextureType');
    if (ttEl) {
        const tt = attrVal(ttEl, 'val');
        const KNOWN = new Set(['Normal', 'Border', 'HorizontalBorder', 'EndCap',
                               'NineSlice', 'None', 'Circular']);
        if (tt && !KNOWN.has(tt)) {
            add('warning', `<TextureType val="${tt}"/>: not one of the documented values (Normal, Border, HorizontalBorder, EndCap, NineSlice).`);
        }
    }

    // 5. HAlign / VAlign are NOT real SC2 layout-XML elements (issue #4).
    // Text alignment is dictated by the assigned FontStyle, not a per-frame
    // override. SC2 will at best ignore these and at worst abort layout
    // rendering. Flag any presence (regardless of value).
    if (findElementChild(el, 'HAlign')) {
        add('error', `<HAlign> is not a valid SC2 layout element. Move the alignment into the FontStyle this frame uses (Style="..."), or pick a different FontStyle.`);
    }
    if (findElementChild(el, 'VAlign')) {
        add('error', `<VAlign> is not a valid SC2 layout element. Move the alignment into the FontStyle this frame uses (Style="..."), or pick a different FontStyle.`);
    }

    // 6. Duplicate sibling frame names (within this frame).
    const childNames = new Map();
    for (const c of el.children || []) {
        if (c.type !== 'element') continue;
        if (c.tag !== 'Frame' && !FRAME_TAGS.test(c.tag)) continue;
        const cn = attrMap(c).name;
        if (!cn) continue;
        if (childNames.has(cn)) {
            add('error', `Duplicate child name "${cn}" inside ${framePath}. SC2 expects sibling frames to be uniquely named.`);
        }
        childNames.set(cn, c);
    }
}

// ---- helpers --------------------------------------------------------------
//
// attrMap / attrVal / findElementChild moved to xml/helpers.js in R4.1.
// findFrameChildByName stays local — it knows about FRAME_TAGS, which is
// validate.js's own concern.

function findFrameChildByName(el, childName) {
    if (!el || !el.children) return null;
    for (const c of el.children) {
        if (c.type !== 'element') continue;
        if (c.tag !== 'Frame' && !FRAME_TAGS.test(c.tag)) continue;
        if ((attrMap(c).name) === childName) return c;
    }
    return null;
}
// childVal removed in issue #4 cleanup (was only used by the now-deleted
// HAlign/VAlign value check).
