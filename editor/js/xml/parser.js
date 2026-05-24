// Comment-preserving XML parser for SC2 .SC2Layout / .SC2Style files.
//
// Goals:
//   - Round-trip byte-exact on unedited input.
//   - Preserve comments, whitespace, attribute order, quote style (' vs "),
//     self-closing form, the XML declaration, and any CDATA / processing
//     instructions encountered.
//   - When a node is mutated, only that node's text is regenerated; the
//     surrounding raw spans of unchanged siblings are spliced in verbatim.
//
// Out of scope (intentionally): DTD/entity resolution beyond the five
// XML built-ins. SC2 layouts don't use entities meaningfully.
//
// Node types:
//   - 'element'  : { type, tag, attrs:[{name,value,quote,rawBetween,rawAfter}],
//                    selfClosing, children, opening:{raw,start,end},
//                    closing:{raw,start,end}|null, source, start, end, dirty }
//   - 'text'     : raw whitespace/text between tags (preserved verbatim)
//   - 'comment'  : { raw, start, end }
//   - 'cdata'    : { raw, start, end }
//   - 'pi'       : processing instruction (<?...?>) including <?xml...?>
//   - 'doctype'  : <!DOCTYPE ...>

const RE_NAME = /[A-Za-z_:][A-Za-z0-9_:.\-]*/y;
const RE_S = /[ \t\r\n]+/y;

export class XmlParseError extends Error {
    constructor(msg, pos, source) {
        const { line, col } = lineCol(source, pos);
        super(`${msg} at line ${line}, col ${col}`);
        this.pos = pos;
        this.line = line;
        this.col = col;
    }
}

function lineCol(source, pos) {
    let line = 1, col = 1;
    for (let i = 0; i < pos && i < source.length; i++) {
        if (source.charCodeAt(i) === 10) { line++; col = 1; } else { col++; }
    }
    return { line, col };
}

export function parseXml(source) {
    const ctx = { source, pos: 0 };
    const children = [];
    while (ctx.pos < source.length) {
        const node = parseNode(ctx);
        if (node) children.push(node);
        else break;
    }
    return {
        type: 'document',
        source,
        children,
        get root() { return children.find(c => c.type === 'element') || null; },
    };
}

function parseNode(ctx) {
    const start = ctx.pos;
    const s = ctx.source;
    if (ctx.pos >= s.length) return null;

    const ch = s.charCodeAt(ctx.pos);
    if (ch !== 60 /* < */) {
        // Text node: read up to next '<'.
        const next = s.indexOf('<', ctx.pos);
        const end = next === -1 ? s.length : next;
        const raw = s.slice(ctx.pos, end);
        ctx.pos = end;
        return { type: 'text', raw, start, end, dirty: false };
    }

    // We're on '<'. Disambiguate by what follows.
    const next1 = s.charCodeAt(ctx.pos + 1);
    if (next1 === 33 /* ! */) {
        // <!-- comment -->, <![CDATA[ ... ]]>, or <!DOCTYPE ...>
        if (s.startsWith('<!--', ctx.pos)) return parseComment(ctx);
        if (s.startsWith('<![CDATA[', ctx.pos)) return parseCData(ctx);
        return parseDoctype(ctx);
    }
    if (next1 === 63 /* ? */) {
        return parseProcessingInstruction(ctx);
    }
    if (next1 === 47 /* / */) {
        // Stray close tag - bubble up so the parent loop can handle it.
        return null;
    }
    return parseElement(ctx);
}

function parseComment(ctx) {
    const start = ctx.pos;
    const end = ctx.source.indexOf('-->', start + 4);
    if (end === -1) throw new XmlParseError('unterminated comment', start, ctx.source);
    const finish = end + 3;
    const raw = ctx.source.slice(start, finish);
    ctx.pos = finish;
    return { type: 'comment', raw, start, end: finish, dirty: false };
}

function parseCData(ctx) {
    const start = ctx.pos;
    const end = ctx.source.indexOf(']]>', start + 9);
    if (end === -1) throw new XmlParseError('unterminated CDATA', start, ctx.source);
    const finish = end + 3;
    const raw = ctx.source.slice(start, finish);
    ctx.pos = finish;
    return { type: 'cdata', raw, start, end: finish, dirty: false };
}

function parseDoctype(ctx) {
    const start = ctx.pos;
    let i = ctx.pos;
    let depth = 0;
    while (i < ctx.source.length) {
        const c = ctx.source.charCodeAt(i);
        if (c === 91) depth++;           // [
        else if (c === 93) depth--;      // ]
        else if (c === 62 && depth <= 0) { i++; break; } // >
        i++;
    }
    const raw = ctx.source.slice(start, i);
    ctx.pos = i;
    return { type: 'doctype', raw, start, end: i, dirty: false };
}

function parseProcessingInstruction(ctx) {
    const start = ctx.pos;
    const end = ctx.source.indexOf('?>', start + 2);
    if (end === -1) throw new XmlParseError('unterminated processing instruction', start, ctx.source);
    const finish = end + 2;
    const raw = ctx.source.slice(start, finish);
    ctx.pos = finish;
    return { type: 'pi', raw, start, end: finish, dirty: false };
}

function parseElement(ctx) {
    const start = ctx.pos;
    const s = ctx.source;
    ctx.pos++; // skip '<'

    const tag = readName(ctx);
    if (!tag) throw new XmlParseError('expected element name', ctx.pos, s);

    const attrs = [];
    // Read attributes.
    while (ctx.pos < s.length) {
        const wsStart = ctx.pos;
        skipWhitespace(ctx);
        const ws = s.slice(wsStart, ctx.pos);
        if (ctx.pos >= s.length) throw new XmlParseError('unterminated start tag', start, s);
        const c = s.charCodeAt(ctx.pos);
        if (c === 62 /* > */) {
            // End of opening tag (non self-closing).
            ctx.pos++;
            // Track trailing whitespace before '>' on the last attribute (none here)
            // by attaching `ws` to a synthetic trailer slot? We instead store on the
            // last attr's rawAfter for round-trip.
            if (attrs.length && ws) attrs[attrs.length - 1].rawAfter = ws;
            else if (!attrs.length) {
                // No attrs; whitespace between tag and '>' is unusual but legal.
                // Stash it on a hidden "trailer" attr-like marker.
                if (ws) attrs._trailer = ws;
            }
            return finishElement(ctx, start, tag, attrs, false);
        }
        if (c === 47 /* / */ && s.charCodeAt(ctx.pos + 1) === 62 /* > */) {
            ctx.pos += 2;
            if (attrs.length && ws) attrs[attrs.length - 1].rawAfter = ws;
            else if (!attrs.length && ws) attrs._trailer = ws;
            return finishElement(ctx, start, tag, attrs, true);
        }
        // Otherwise must be an attribute name.
        if (!ws) throw new XmlParseError('expected whitespace before attribute', ctx.pos, s);
        const name = readName(ctx);
        if (!name) throw new XmlParseError('expected attribute name or > or />', ctx.pos, s);
        // Optional whitespace, =, optional whitespace.
        const eqStart = ctx.pos;
        skipWhitespace(ctx);
        if (s.charCodeAt(ctx.pos) !== 61 /* = */) {
            // Bare attribute (XML technically doesn't allow this; tolerate).
            attrs.push({ name, value: '', quote: '"', rawBetween: ws, rawEq: s.slice(eqStart, ctx.pos), rawAfter: '' });
            continue;
        }
        ctx.pos++; // '='
        const afterEq = ctx.pos;
        skipWhitespace(ctx);
        const rawEq = s.slice(eqStart, ctx.pos);
        const q = s.charCodeAt(ctx.pos);
        if (q !== 34 && q !== 39) throw new XmlParseError('expected quoted attribute value', ctx.pos, s);
        const quote = String.fromCharCode(q);
        ctx.pos++;
        const valStart = ctx.pos;
        const valEnd = s.indexOf(quote, valStart);
        if (valEnd === -1) throw new XmlParseError('unterminated attribute value', valStart, s);
        const rawValue = s.slice(valStart, valEnd);
        ctx.pos = valEnd + 1;
        attrs.push({
            name,
            value: decodeEntities(rawValue),
            rawValue,
            quote,
            rawBetween: ws,
            rawEq,
            rawAfter: '',
        });
    }
    throw new XmlParseError('unterminated start tag', start, s);
}

function finishElement(ctx, start, tag, attrs, selfClosing) {
    const s = ctx.source;
    const openingEnd = ctx.pos;
    const openingRaw = s.slice(start, openingEnd);

    if (selfClosing) {
        return {
            type: 'element',
            tag,
            attrs,
            selfClosing: true,
            children: [],
            opening: { raw: openingRaw, start, end: openingEnd },
            closing: null,
            source: openingRaw,
            start,
            end: openingEnd,
            dirty: false,
        };
    }

    // Parse children until we hit </tag>.
    const children = [];
    while (ctx.pos < s.length) {
        // Detect close tag.
        if (s.charCodeAt(ctx.pos) === 60 /* < */ && s.charCodeAt(ctx.pos + 1) === 47 /* / */) {
            const closeStart = ctx.pos;
            ctx.pos += 2;
            const closeName = readName(ctx);
            skipWhitespace(ctx);
            if (s.charCodeAt(ctx.pos) !== 62) throw new XmlParseError('expected > on close tag', ctx.pos, s);
            ctx.pos++;
            const closeEnd = ctx.pos;
            if (closeName !== tag) {
                throw new XmlParseError(`mismatched close tag </${closeName}> for <${tag}>`, closeStart, s);
            }
            const closingRaw = s.slice(closeStart, closeEnd);
            return {
                type: 'element',
                tag,
                attrs,
                selfClosing: false,
                children,
                opening: { raw: openingRaw, start, end: openingEnd },
                closing: { raw: closingRaw, start: closeStart, end: closeEnd },
                source: s.slice(start, closeEnd),
                start,
                end: closeEnd,
                dirty: false,
            };
        }
        const child = parseNode(ctx);
        if (!child) throw new XmlParseError(`unterminated element <${tag}>`, start, s);
        children.push(child);
    }
    throw new XmlParseError(`unterminated element <${tag}>`, start, s);
}

function readName(ctx) {
    RE_NAME.lastIndex = ctx.pos;
    const m = RE_NAME.exec(ctx.source);
    if (!m || m.index !== ctx.pos) return null;
    ctx.pos = RE_NAME.lastIndex;
    return m[0];
}

function skipWhitespace(ctx) {
    RE_S.lastIndex = ctx.pos;
    const m = RE_S.exec(ctx.source);
    if (m && m.index === ctx.pos) ctx.pos = RE_S.lastIndex;
}

// Five built-in entities. Others fall through unchanged because SC2 layouts
// don't use them and we want round-trip fidelity rather than aggressive decoding.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
    return s.replace(/&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));/g,
        (m, name, dec, hex) => {
            if (name) return ENTITIES[name];
            if (dec) return String.fromCodePoint(parseInt(dec, 10));
            return String.fromCodePoint(parseInt(hex, 16));
        });
}
