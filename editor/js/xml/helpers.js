// Shared read-only helpers for the parser's DOM shape (the one parser.js
// emits: nodes have `type`, elements have `tag`, `attrs`, `children`).
//
// Before R4.1 these helpers were re-defined in ten different files and had
// started drifting (validate.js had two find-child variants, edit.js and
// inspector.js had near-identical attrVal forks). Centralising them here
// means the next bug fix lands in one place. Pure reads only — anything
// that mutates the tree belongs in serializer.js (setAttr/removeAttr) or
// xml/mutate.js (subtree edits).

/** Build a plain-object {name: value} map from an element's attribute list. */
export function attrMap(el) {
    const out = {};
    if (!el || !el.attrs) return out;
    for (const a of el.attrs) out[a.name] = a.value;
    return out;
}

/** Look up one attribute by name; undefined if missing. */
export function attrVal(el, name) {
    if (!el || !el.attrs) return undefined;
    const a = el.attrs.find(x => x.name === name);
    return a ? a.value : undefined;
}

/** First element child with the given tag, or null. */
export function findChild(el, tag) {
    if (!el || !el.children) return null;
    for (const c of el.children) if (c.type === 'element' && c.tag === tag) return c;
    return null;
}

/** True iff `el` has at least one element child with the given tag. */
export function hasChild(el, tag) {
    return !!findChild(el, tag);
}

/** Convenience: read findChild(el, tag)'s `val` attribute, or undefined. */
export function findChildVal(el, tag) {
    const c = findChild(el, tag);
    return c ? attrVal(c, 'val') : undefined;
}

/** Convenience: attrMap(findChild(el, tag)) or undefined when missing. */
export function findChildAttrs(el, tag) {
    const c = findChild(el, tag);
    return c ? attrMap(c) : undefined;
}

/** First <Anchor side="X"/> child with the matching side, or null. */
export function findAnchorChild(el, side) {
    if (!el || !el.children) return null;
    for (const c of el.children) {
        if (c.type !== 'element' || c.tag !== 'Anchor') continue;
        if (attrVal(c, 'side') === side) return c;
    }
    return null;
}
