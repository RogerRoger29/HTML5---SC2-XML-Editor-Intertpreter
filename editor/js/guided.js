// Beginner-facing authoring helpers.
//
// These functions keep the risky pattern-detection and XML mutation out of
// main.js. They operate on materialized frames plus their `_modSource` XML
// elements, so the same logic is usable by the UI and by Node tests.

import { attrVal, findChild } from './xml/helpers.js';
import { setAttr } from './xml/serializer.js';
import {
    appendChildPreservingIndent, deepCloneElement, makeElement, textNode,
    inferChildIndent, removeChildAndWhitespace,
} from './xml/mutate.js';
import { oneIndentDeeper } from './authoring.js';

const BUTTON_TYPE = /button/i;

export function isButtonFrame(frame) {
    return !!frame && BUTTON_TYPE.test(String(frame.type || ''));
}

export function nextSequentialName(existingNames, sourceName) {
    const names = new Set(existingNames || []);
    const match = String(sourceName || 'Button0').match(/^(.*?)(\d+)$/);
    const prefix = match ? match[1] : String(sourceName || 'Button');
    const width = match ? match[2].length : 0;
    let highest = match ? Number(match[2]) : -1;
    for (const name of names) {
        const candidate = String(name).match(new RegExp(`^${escapeRegex(prefix)}(\\d+)$`, 'i'));
        if (candidate) highest = Math.max(highest, Number(candidate[1]));
    }
    let number = highest + 1;
    let result;
    do {
        const suffix = width ? String(number).padStart(width, '0') : String(number);
        result = `${prefix}${suffix}`;
        number++;
    } while (names.has(result));
    return result;
}

/** Inspect the selected button and its siblings without changing XML. */
export function analyzeButtonRow(selected) {
    if (!isButtonFrame(selected)) {
        return { ok: false, reason: 'Select an existing button first.' };
    }
    if (!selected._modSource || !selected._modSource._parent) {
        return { ok: false, reason: 'The selected button is inherited or stock-only. Re-open it in this layout before duplicating it.' };
    }
    const parent = selected.parent;
    if (!parent) return { ok: false, reason: 'The selected button has no visible parent frame.' };

    const template = attrVal(selected._modSource, 'template') || '';
    let siblings = (parent.children || []).filter(frame => {
        if (!isButtonFrame(frame) || !frame._modSource) return false;
        const otherTemplate = attrVal(frame._modSource, 'template') || '';
        return template ? otherTemplate === template : frame.type === selected.type;
    });
    if (!siblings.includes(selected)) siblings.push(selected);

    const xRange = spread(siblings.map(frame => center(frame, 'x')));
    const yRange = spread(siblings.map(frame => center(frame, 'y')));
    const axis = xRange >= yRange ? 'x' : 'y';
    siblings = siblings.slice().sort((a, b) => center(a, axis) - center(b, axis));
    const edge = siblings[siblings.length - 1];
    const centers = siblings.map(frame => center(frame, axis)).filter(Number.isFinite);
    const deltas = [];
    for (let i = 1; i < centers.length; i++) {
        const delta = centers[i] - centers[i - 1];
        if (delta > 0.5) deltas.push(delta);
    }
    const fallbackSize = axis === 'x' ? Number(edge.w) : Number(edge.h);
    const step = Math.round(median(deltas) || (Number.isFinite(fallbackSize) ? fallbackSize + 4 : 80));
    // Sequence within the matching visual row. A number may already belong to
    // a hidden placeholder that uses a different template; addMatchingButton
    // safely replaces that placeholder instead of skipping all the way past it.
    const names = siblings.map(frame => frame.name).filter(Boolean);
    const name = nextSequentialName(names, edge.name);
    return {
        ok: true,
        selected,
        parent,
        siblings,
        edge,
        axis,
        step,
        name,
        template,
        currentCenter: center(edge, axis),
        nextCenter: center(edge, axis) + step,
    };
}

/** Clone the final button in the detected row and append a correctly-named,
 *  correctly-spaced sibling to the same XML parent. */
export function addMatchingButton(selected) {
    const plan = analyzeButtonRow(selected);
    if (!plan.ok) throw new Error(plan.reason);

    const source = plan.edge._modSource;
    const parentSource = source?._parent;
    if (!source || !parentSource) throw new Error('The detected source button cannot be edited in this layout.');
    const clone = deepCloneElement(source);
    setAttr(clone, 'name', plan.name);
    shiftAxisAnchors(clone, plan.axis, plan.step, plan.edge.name);
    const hotkeyResult = updateSequentialHotkey(clone, plan.name);
    const existing = findNamedFrame(parentSource, plan.name);
    let reusedExisting = false;
    if (existing && existing !== source) {
        const index = parentSource.children.indexOf(existing);
        clone._parent = parentSource;
        parentSource.children[index] = clone;
        parentSource.dirty = true;
        reusedExisting = true;
    } else {
        appendChildPreservingIndent(parentSource, clone);
    }

    return {
        ...plan,
        clone,
        parentSource,
        hotkey: hotkeyResult.value,
        hotkeyOmitted: hotkeyResult.omitted,
        hotkeyFallback: hotkeyResult.fallback,
        reusedExisting,
        newPath: plan.parent.path ? `${plan.parent.path}/${plan.name}` : plan.name,
    };
}

/** Mengsk-specific artwork extension. The stock art's rightmost 21.5% is a
 *  flat button bay plus end cap. Reusing that crop avoids stretching the
 *  central crest. The extension grows by 80 px for each button after four. */
export function extendMengskTopBar(buttonFrame, buttonCount) {
    const topBar = findAncestor(buttonFrame, frame => /MengskTopBar/i.test(frame.name || ''));
    if (!topBar?._modSource) {
        return { applied: false, reason: 'A mod-backed MengskTopBar ancestor was not found.' };
    }
    const extraCount = Math.max(0, Number(buttonCount) - 4);
    if (!extraCount) return { applied: false, reason: 'The stock four-button Mengsk bar does not need an extension.' };
    const source = topBar._modSource;
    let extension = findNamedFrame(source, 'BackgroundRightExtension');
    const right = 372 + extraCount * 80;
    const width = 80 + extraCount * 80;
    if (!extension) {
        const close = inferChildIndent(source);
        const i = oneIndentDeeper(close);
        extension = makeElement('Frame', [
            ['type', 'Image'], ['name', 'BackgroundRightExtension'],
        ], false, [
            textNode(i), makeElement('Anchor', [['side','Top'],['relative','$parent'],['pos','Min'],['offset','0']], true),
            textNode(i), makeElement('Anchor', [['side','Left'],['relative','$parent'],['pos','Mid'],['offset','292']], true),
            textNode(i), makeElement('Anchor', [['side','Right'],['relative','$parent'],['pos','Mid'],['offset',String(right)]], true),
            textNode(i), makeElement('Width', [['val',String(width)]], true),
            textNode(i), makeElement('Height', [['val','176']], true),
            textNode(i), makeElement('Texture', [['val','Assets/Textures/ui_ingame_coop_topbar_mengsk_mainbar.dds']], true),
            textNode(i), makeElement('TextureCoords', [['top','0'],['left','0.784946'],['bottom','1'],['right','1']], true),
            textNode(i), makeElement('Color', [['val','255,255,255']], true),
            textNode(close),
        ]);
        appendChildPreservingIndent(source, extension);
    } else {
        setChildValue(extension, 'Width', String(width));
        const rightAnchor = (extension.children || []).find(child =>
            child.type === 'element' && child.tag === 'Anchor' && attrVal(child, 'side') === 'Right');
        if (rightAnchor) setAttr(rightAnchor, 'offset', String(right));
    }
    return { applied: true, extraCount, width, right, extension };
}

export function isMengskCommandButton(frame) {
    if (!isButtonFrame(frame) || !frame._modSource) return false;
    const template = attrVal(frame._modSource, 'template') || '';
    return /MengskCommandButtonTemplate/i.test(template)
        || /MengskGlobalCommandPanel/i.test(frame.parent?.name || '');
}

/** Duplicate any mod-backed frame beside itself. Position anchors move by the
 *  requested delta and the name advances without colliding with siblings. */
export function duplicateFrameBeside(selected, delta = 16) {
    const source = selected?._modSource;
    const parentSource = source?._parent;
    if (!source || !parentSource) throw new Error('Select a frame defined by this layout first.');
    const siblingNames = (parentSource.children || [])
        .filter(child => child.type === 'element')
        .map(child => attrVal(child, 'name'))
        .filter(Boolean);
    const name = nextSequentialName(siblingNames, selected.name || attrVal(source, 'name') || 'Frame0');
    const clone = deepCloneElement(source);
    setAttr(clone, 'name', name);
    nudgeSource(clone, delta, delta);
    appendChildPreservingIndent(parentSource, clone);
    return {
        clone,
        name,
        newPath: selected.parent?.path ? `${selected.parent.path}/${name}` : name,
        delta,
    };
}

export function nudgeFrame(selected, dx, dy) {
    const source = selected?._modSource;
    if (!source) throw new Error('Select a frame defined by this layout first.');
    const changed = nudgeSource(source, Number(dx) || 0, Number(dy) || 0);
    if (!changed) throw new Error('This frame has no numeric side anchors to move. Add or edit an anchor in the Inspector.');
    return { changed, dx: Number(dx) || 0, dy: Number(dy) || 0 };
}

export function resizeFrame(selected, width, height) {
    const source = selected?._modSource;
    if (!source) throw new Error('Select a frame defined by this layout first.');
    const w = Math.max(1, Math.round(Number(width) || Number(selected.w) || 1));
    const h = Math.max(1, Math.round(Number(height) || Number(selected.h) || 1));
    setChildValue(source, 'Width', String(w));
    setChildValue(source, 'Height', String(h));
    return { width: w, height: h };
}

export function setFrameVisibility(selected, visible) {
    const source = selected?._modSource;
    if (!source) throw new Error('Select a frame defined by this layout first.');
    setChildValue(source, 'Visible', visible ? 'true' : 'false');
    return { visible: !!visible };
}

/** Grow a selected container enough to cover its direct visible children.
 *  This never shrinks it and never moves children, making it safe for a
 *  beginner action even when some content intentionally overlaps. */
export function growFrameToChildren(selected, padding = 8) {
    const source = selected?._modSource;
    if (!source) throw new Error('Select a container defined by this layout first.');
    const children = (selected.children || []).filter(child =>
        child.visible !== false && [child.x, child.y, child.w, child.h].every(Number.isFinite));
    if (!children.length) throw new Error('The selected frame has no visible direct children to fit.');
    const pad = Math.max(0, Number(padding) || 0);
    const currentW = Math.max(0, Number(selected.w) || 0);
    const currentH = Math.max(0, Number(selected.h) || 0);
    const requiredW = Math.max(...children.map(child => child.x + child.w - selected.x + pad));
    const requiredH = Math.max(...children.map(child => child.y + child.h - selected.y + pad));
    return resizeFrame(selected, Math.max(currentW, requiredW), Math.max(currentH, requiredH));
}

/** Build the plain-English SC2 readiness model used by the dialog and support
 *  bundle. This is intentionally pure and contains no DOM references. */
export function buildReadinessSummary({ warnings = [], frames = [], cycles = [], assetsConfigured = false } = {}) {
    const flat = flattenFrames(frames);
    const buttons = flat.filter(isButtonFrame)
        .filter(frame => !frame.isTemplate && frame.visible !== false);
    const runtimeReady = buttons.filter(frame => frame.path && !frame.synthetic);
    const nonFinite = flat.filter(frame =>
        ![frame.x, frame.y, frame.w, frame.h].every(Number.isFinite));
    const visualWarnings = findBackgroundOverflow(buttons);
    const counts = { error: 0, warning: 0, info: 0 };
    for (const warning of warnings) {
        const severity = warning.severity in counts ? warning.severity : 'info';
        counts[severity]++;
    }
    counts.warning += visualWarnings.length;
    if (nonFinite.length) counts.error += nonFinite.length;
    if (cycles.length) counts.error += cycles.length;
    const checks = [
        {
            id: 'layout',
            ok: counts.error === 0,
            level: counts.error ? 'error' : counts.warning ? 'warning' : 'ok',
            text: counts.error
                ? `${counts.error} blocking layout problem${counts.error === 1 ? '' : 's'} found.`
                : counts.warning
                    ? `No blocking problems. ${counts.warning} item${counts.warning === 1 ? '' : 's'} should be reviewed.`
                    : 'No structural layout problems found.',
        },
        {
            id: 'runtime-paths',
            ok: runtimeReady.length === buttons.length,
            level: runtimeReady.length === buttons.length ? 'ok' : 'warning',
            text: `${runtimeReady.length}/${buttons.length} visible button${buttons.length === 1 ? '' : 's'} have stable runtime hookup paths.`,
        },
        {
            id: 'triggers',
            ok: buttons.length === 0,
            level: buttons.length ? 'action' : 'ok',
            text: buttons.length
                ? `${buttons.length} button${buttons.length === 1 ? '' : 's'} may need trigger hookup or existing Galaxy array updates.`
                : 'No button trigger hookups are required.',
        },
        {
            id: 'assets',
            ok: !!assetsConfigured,
            level: assetsConfigured ? 'ok' : 'warning',
            text: assetsConfigured
                ? 'SC2 assets are configured for texture and template checks.'
                : 'A global SC2 assets folder is not configured; project-local assets may still preview.',
        },
    ];
    return {
        ready: counts.error === 0,
        counts,
        checks,
        buttonCount: buttons.length,
        runtimeReadyCount: runtimeReady.length,
        nonFinitePaths: nonFinite.map(frame => frame.path),
        cycles: cycles.slice(),
        visualWarnings,
    };
}

function shiftAxisAnchors(el, axis, step, previousName) {
    const sides = axis === 'x' ? new Set(['Left', 'Right']) : new Set(['Top', 'Bottom']);
    const anchors = (el.children || []).filter(child =>
        child.type === 'element' && child.tag === 'Anchor' && sides.has(attrVal(child, 'side')));
    let shifted = false;
    for (const anchor of anchors) {
        const raw = attrVal(anchor, 'offset');
        const value = Number(raw);
        if (Number.isFinite(value)) {
            setAttr(anchor, 'offset', String(value + step));
            shifted = true;
        }
    }
    if (shifted) return;

    // Relative-chain rows are common too. Point the copied leading edge at
    // the previous button's trailing edge and preserve a small visual gap.
    const side = axis === 'x' ? 'Left' : 'Top';
    const pos = 'Max';
    const close = inferChildIndent(el);
    appendChildPreservingIndent(el, makeElement('Anchor', [
        ['side', side], ['relative', `$parent/${previousName}`], ['pos', pos], ['offset', '4'],
    ], true));
    // appendChildPreservingIndent inferred the right indentation itself; the
    // local variable documents that this intentionally follows sibling style.
    void close;
}

function nudgeSource(source, dx, dy) {
    let changed = 0;
    for (const anchor of source.children || []) {
        if (anchor.type !== 'element' || anchor.tag !== 'Anchor') continue;
        const side = attrVal(anchor, 'side');
        const delta = side === 'Left' || side === 'Right' ? dx
            : side === 'Top' || side === 'Bottom' ? dy
            : 0;
        if (!delta) continue;
        const raw = attrVal(anchor, 'offset');
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        setAttr(anchor, 'offset', String(value + delta));
        changed++;
    }
    return changed;
}

function updateSequentialHotkey(el, newName) {
    const hotkey = findChild(el, 'HotkeyUse');
    if (!hotkey) return { value: null, omitted: false, fallback: false };
    const current = attrVal(hotkey, 'val') || '';
    const currentMatch = current.match(/^(.*?)(\d+)$/);
    const nameMatch = String(newName).match(/(\d+)$/);
    if (!currentMatch || !nameMatch) return { value: current || null, omitted: false, fallback: false };
    const nextIndex = Number(nameMatch[1]);
    if (currentMatch[1] === 'CommanderAbility' && nextIndex > 3) {
        if (nextIndex <= 14) {
            const fallback = `CommandButton${String(nextIndex).padStart(2, '0')}`;
            setAttr(hotkey, 'val', fallback);
            return { value: fallback, omitted: false, fallback: true };
        }
        removeChildAndWhitespace(el, hotkey);
        return { value: null, omitted: true, fallback: false };
    }
    const next = currentMatch[1] + String(nextIndex);
    setAttr(hotkey, 'val', next);
    return { value: next, omitted: false, fallback: false };
}

function setChildValue(parent, tag, value) {
    let child = findChild(parent, tag);
    if (!child) {
        child = makeElement(tag, [['val', value]], true);
        appendChildPreservingIndent(parent, child);
    } else {
        setAttr(child, 'val', value);
    }
    return child;
}

function findNamedFrame(parent, name) {
    return (parent.children || []).find(child =>
        child.type === 'element'
        && (child.tag === 'Frame' || /(?:Frame|Panel|Image|Button|Label)$/.test(child.tag))
        && attrVal(child, 'name') === name) || null;
}

function findAncestor(frame, predicate) {
    for (let current = frame; current; current = current.parent) {
        if (predicate(current)) return current;
    }
    return null;
}

function flattenFrames(frames) {
    const result = [];
    const visit = (items) => {
        for (const frame of items || []) {
            result.push(frame);
            visit(frame.children);
        }
    };
    visit(frames);
    return result;
}

function findBackgroundOverflow(buttons) {
    const result = [];
    for (const button of buttons) {
        if (![button.x, button.y, button.w, button.h].every(Number.isFinite)) continue;
        let ancestor = button.parent;
        let candidates = [];
        for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parent) {
            candidates.push(...(ancestor.children || []).filter(frame =>
                /image/i.test(String(frame.type || ''))
                && /background/i.test(String(frame.name || ''))
                && [frame.x, frame.y, frame.w, frame.h].every(Number.isFinite)));
        }
        if (!candidates.length) continue;
        const verticallyRelated = candidates.filter(bg =>
            button.y < bg.y + bg.h && button.y + button.h > bg.y);
        if (!verticallyRelated.length) continue;
        const contained = verticallyRelated.some(bg =>
            button.x >= bg.x - 1 && button.x + button.w <= bg.x + bg.w + 1);
        if (!contained) {
            result.push({
                framePath: button.path,
                message: `${button.name} extends beyond every nearby background. Extend the artwork or move the button before testing in SC2.`,
            });
        }
    }
    return result;
}

function center(frame, axis) {
    const start = Number(frame?.[axis]);
    const size = Number(frame?.[axis === 'x' ? 'w' : 'h']);
    return Number.isFinite(start) && Number.isFinite(size) ? start + size / 2 : 0;
}

function spread(values) {
    const finite = values.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
}

function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
