// Serializer that pairs with parser.js. Three rules:
//   1. If a document/element/node is not dirty AND its source span is
//      available, emit the original raw text verbatim.
//   2. If dirty, regenerate from the structured fields, preserving as much
//      original formatting as possible (attribute order, quote style,
//      whitespace between attributes).
//   3. Children are always concatenated; their individual raw spans are
//      reused when clean.

export function serializeXml(doc) {
    return doc.children.map(serializeNode).join('');
}

export function serializeNode(node) {
    switch (node.type) {
        case 'text':
        case 'comment':
        case 'cdata':
        case 'pi':
        case 'doctype':
            return node.raw;
        case 'element':
            return serializeElement(node);
        default:
            return '';
    }
}

function serializeElement(el) {
    // Fast path: clean element with intact source.
    if (!el.dirty && el.source && !anyChildDirty(el)) {
        return el.source;
    }

    const opening = el.dirty || !el.opening ? buildOpening(el) : el.opening.raw;
    if (el.selfClosing) return opening;

    let body = '';
    for (const child of el.children) body += serializeNode(child);

    const closing = el.dirty || !el.closing ? `</${el.tag}>` : el.closing.raw;
    return opening + body + closing;
}

function anyChildDirty(el) {
    for (const c of el.children) {
        if (c.type === 'element') {
            if (c.dirty) return true;
            if (anyChildDirty(c)) return true;
        } else if (c.dirty) {
            return true;
        }
    }
    return false;
}

function buildOpening(el) {
    let out = '<' + el.tag;
    for (const a of el.attrs) {
        // rawBetween captures the whitespace that originally preceded this
        // attribute (typically " "). If missing (e.g. new attribute), default
        // to a single space.
        out += a.rawBetween != null ? a.rawBetween : ' ';
        out += a.name;
        out += a.rawEq != null ? a.rawEq : '=';
        const q = a.quote || '"';
        out += q + encodeAttrValue(a.value, q) + q;
        if (a.rawAfter) out += a.rawAfter;
    }
    if (el.attrs._trailer) out += el.attrs._trailer;
    out += el.selfClosing ? '/>' : '>';
    return out;
}

function encodeAttrValue(v, quote) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c === 38) out += '&amp;';        // &
        else if (c === 60) out += '&lt;';    // <
        else if (c === 62) out += '&gt;';    // >
        else if (c === 34 && quote === '"') out += '&quot;';
        else if (c === 39 && quote === "'") out += '&apos;';
        else out += v[i];
    }
    return out;
}

// Mutation helpers that mark dirty bits correctly.
export function setAttr(el, name, value) {
    const existing = el.attrs.find(a => a.name === name);
    if (existing) {
        if (existing.value === value) return false;
        existing.value = value;
        delete existing.rawValue;
    } else {
        // Adding a NEW attribute: clear the original-source trailer
        // whitespace cached on attrs._trailer. The trailer was the
        // whitespace between the last attr (or the tag name when no attrs
        // existed) and `>` / `/>`. Now that we're inserting a real
        // attribute, the trailer would end up in the wrong place ("<Tag
        // foo="bar"      newattr="..."/>") and produce malformed spacing.
        if (el.attrs._trailer) delete el.attrs._trailer;
        el.attrs.push({
            name,
            value,
            quote: '"',
            rawBetween: ' ',
            rawEq: '=',
            rawAfter: '',
        });
    }
    el.dirty = true;
    return true;
}

export function removeAttr(el, name) {
    const idx = el.attrs.findIndex(a => a.name === name);
    if (idx === -1) return false;
    el.attrs.splice(idx, 1);
    el.dirty = true;
    return true;
}

export function getAttr(el, name) {
    const a = el.attrs && el.attrs.find(a => a.name === name);
    return a ? a.value : undefined;
}
