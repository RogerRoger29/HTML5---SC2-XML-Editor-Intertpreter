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
    const kids = parent.children;
    // Prefer the indent of the whitespace text node immediately before the
    // LAST element child - that's the real sibling indent. The trailing
    // whitespace before the closing tag is usually one level shallower
    // (it indents </Parent>, not a child), so taking the very last
    // trailing-ws match would insert new children at the closing-tag
    // indent and read as mis-nested.
    for (let i = kids.length - 1; i >= 0; i--) {
        if (kids[i].type === 'element') {
            for (let j = i - 1; j >= 0; j--) {
                if (kids[j].type !== 'text') break;
                const m = kids[j].raw.match(/\n([ \t]*)$/);
                if (m) return '\n' + m[1];
            }
            break;
        }
    }
    // Fallback: any trailing-ws text node (covers element-less parents).
    for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
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

/** Remove one indentation level from a "\n<whitespace>" indent string, so a
 *  child indent becomes its parent's (closing-tag) indent. Handles tabs and
 *  arbitrary space widths, not just 4 spaces. For ambiguous space counts it
 *  prefers a 4- then 2-space unit. This only feeds the rare un-collapse /
 *  single-line-parent branch, and the result still round-trips idempotently. */
function dedentOne(indent) {
    const m = /^\n([ \t]*)$/.exec(indent);
    if (!m) return indent || '\n';
    const ws = m[1];
    if (ws.endsWith('\t')) return '\n' + ws.slice(0, -1);     // strip one tab
    const unit = ws.length % 4 === 0 ? 4 : ws.length % 2 === 0 ? 2 : 1;
    return '\n' + ws.slice(0, Math.max(0, ws.length - unit));
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

/** Append a child element to `parent` as a properly-indented last sibling.
 *  The new child is inserted BEFORE the trailing whitespace that indents
 *  the closing tag, so the close tag keeps its own line. Marks the parent
 *  dirty.
 */
export function appendChildPreservingIndent(parent, child) {
    // A self-closing parent can't hold children; un-collapse it first so the
    // serializer emits <Parent>...</Parent> instead of dropping the child.
    if (parent.selfClosing) parent.selfClosing = false;
    const kids = parent.children;
    const indent = inferChildIndent(parent);
    // Step back over the trailing whitespace-only text node(s) that indent
    // the closing tag, so we insert the new child *before* them.
    let idx = kids.length;
    while (idx > 0 && kids[idx - 1].type === 'text' && /^\s*$/.test(kids[idx - 1].raw)) {
        idx--;
    }
    kids.splice(idx, 0, textNode(indent), child);
    // If there was no trailing whitespace (e.g. previously self-closing or a
    // single-line parent), add a newline so the closing tag lands on its own
    // line at the parent's own indent (one level shallower than the child).
    const afterChildIdx = idx + 2;
    if (afterChildIdx >= kids.length) {
        kids.push(textNode(dedentOne(indent)));
    }
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
