// Subtree-edit helpers for the parser's DOM shape. These manipulate
// children arrays while preserving the original indentation pattern
// the parser captured as text nodes between elements - the #1 source
// of round-trip diffs.
//
// Before R4.2 these primitives were copy-pasted across main.js (the
// moveFrame/inferIndent/appendChildElement/elementNode/textNode block)
// and inspector.js (makeElement/appendNewChild/removeChild/
// duplicateSibling/deepCloneElement). The indent-inferring regex
// /\n([ \t]*)$/ appeared four times; the "remove element + its
// preceding whitespace text node" pattern appeared twice. Drift here
// meant byte-exact round-trip silently broke depending on which call
// site you went through.

/** Walk back from the end of a parent's children list to find the
 *  trailing-whitespace indentation pattern siblings use. Returns
 *  a string starting with '\n' suitable for inserting before a new
 *  child. Defaults to '\n    ' if no pattern can be inferred.
 */
export function inferChildIndent(parent) {
    if (!parent || !parent.children) return '\n    ';
    for (let i = parent.children.length - 1; i >= 0; i--) {
        const k = parent.children[i];
        if (k.type === 'text' && /\n[ \t]*$/.test(k.raw)) {
            const m = k.raw.match(/\n([ \t]*)$/);
            if (m) return '\n' + m[1];
        }
    }
    return '\n    ';
}

/** Same idea but scans backward from a starting index instead of the end
 *  - used by duplicateSibling where we want to copy the indentation of
 *  the source sibling specifically.
 */
export function inferIndentBefore(parent, idx) {
    if (!parent || !parent.children) return '\n    ';
    for (let i = idx; i >= 0; i--) {
        const k = parent.children[i];
        if (k.type === 'text' && /\n[ \t]*$/.test(k.raw)) {
            const m = k.raw.match(/\n([ \t]*)$/);
            if (m) return '\n' + m[1];
        }
    }
    return '\n    ';
}

/** Build a fresh dirty text node from a raw string. */
export function textNode(raw) {
    return { type: 'text', raw, start: 0, end: 0, dirty: true };
}

/** Build a fresh dirty element node. `attrs` is a list of [name, value]
 *  pairs. `children` defaults to []. The serializer-required cosmetic
 *  fields (quote, rawBetween, rawEq, rawAfter, opening, closing, source)
 *  are seeded with sensible defaults.
 */
export function makeElement(tag, attrs, selfClosing, children = []) {
    return {
        type: 'element',
        tag,
        attrs: attrs.map(([name, value]) => ({
            name, value: String(value), quote: '"',
            rawBetween: ' ', rawEq: '=', rawAfter: '',
        })),
        selfClosing: !!selfClosing,
        children,
        opening: null, closing: null,
        source: null,
        start: 0, end: 0,
        dirty: true,
    };
}

/** Append a child element to `parent`, inserting a leading whitespace
 *  text node that matches the parent's existing indentation pattern.
 *  Marks the parent dirty.
 */
export function appendChildPreservingIndent(parent, child) {
    const kids = parent.children;
    const indent = inferChildIndent(parent);
    const last = kids[kids.length - 1];
    if (!last || last.type !== 'text' || !/\s$/.test(last.raw)) {
        kids.push(textNode(indent));
    }
    kids.push(child);
    parent.dirty = true;
}

/** Remove `child` from `parent.children`, also stripping any immediately-
 *  preceding whitespace-only text node so we don't leave double blank
 *  lines behind. Returns true if the child was found and removed.
 */
export function removeChildAndWhitespace(parent, child) {
    const idx = parent.children.indexOf(child);
    if (idx === -1) return false;
    if (idx > 0
        && parent.children[idx - 1].type === 'text'
        && /^\s+$/.test(parent.children[idx - 1].raw)) {
        parent.children.splice(idx - 1, 2);
    } else {
        parent.children.splice(idx, 1);
    }
    parent.dirty = true;
    return true;
}

/** Deep-clone an element subtree, marking every node dirty so the
 *  serializer regenerates them from structure (the source spans of the
 *  original wouldn't match the new position anyway).
 */
export function deepCloneElement(el) {
    if (el.type !== 'element') {
        return { ...el, dirty: true };
    }
    return {
        type: 'element',
        tag: el.tag,
        attrs: (el.attrs || []).map(a => ({ ...a })),
        selfClosing: el.selfClosing,
        children: (el.children || []).map(c => c.type === 'element'
            ? deepCloneElement(c)
            : { ...c, dirty: true }),
        opening: null, closing: null,
        source: null,
        start: 0, end: 0,
        dirty: true,
    };
}
