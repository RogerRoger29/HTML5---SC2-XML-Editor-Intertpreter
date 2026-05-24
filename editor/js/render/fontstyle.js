// Parse fontstyles.sc2style and expose a resolved style lookup.
//
// SC2 style files contain:
//   - <Constant name="X" val="..."/>        - reusable string values; "#X" refs another constant.
//   - <FontGroup name="X"> <CodepointRange font="..."/>... </FontGroup>
//     The first <CodepointRange> is the primary glyph source; the rest are fallbacks.
//   - <Style name="X" font="..." height="..." textcolor="..." styleflags="..."
//            template="OtherStyle" ... />
//
// We resolve to a flat dict per style:
//   {
//     fontFamily: 'sc2-{slug}',     // @font-face name we'll inject
//     fontFile:   'UI/Fonts/...ttf',
//     height:     28,
//     hjustify:   'Left'|'Center'|'Right',
//     vjustify:   'Top'|'Middle'|'Bottom',
//     textColor:  '#RRGGBBAA',
//     styleflags: ['Shadow','Bold',...],
//     outlinewidth: number,
//     outlinecolor: '#RRGGBBAA',
//     shadowoffset: number,
//   }

import { parseXml } from '../xml/parser.js';

const COLOR_NAMED = {
    // SC2 lists a number of named gradient colors as constants in the file
    // (#ColorWhite, #ColorTerranLabel, etc.); resolved at lookup time.
};

export class FontStyleSheet {
    constructor() {
        this.constants = new Map();
        this.fontGroups = new Map();
        this.rawStyles = new Map();    // name -> raw attribute dict
        this.resolved = new Map();     // name -> resolved style
        this.fontFamilyByPath = new Map();
        this.fontsLoaded = new Set();
    }

    static async load(url) {
        const sheet = new FontStyleSheet();
        const text = await fetch(url).then(r => {
            if (!r.ok) throw new Error(`failed to fetch ${url}: ${r.status}`);
            return r.text();
        });
        sheet.ingest(text);
        return sheet;
    }

    ingest(text) {
        const doc = parseXml(text);
        const root = doc.children.find(c => c.type === 'element');
        if (!root) return;
        // Style files use <StyleFile> as root.
        const walk = (el) => {
            for (const child of el.children) {
                if (child.type !== 'element') continue;
                this._ingestNode(child);
            }
        };
        walk(root);
    }

    _ingestNode(el) {
        const a = attrMap(el);
        switch (el.tag) {
            case 'Constant':
                if (a.name) this.constants.set(a.name, a.val ?? '');
                break;
            case 'FontGroup': {
                const ranges = [];
                for (const c of el.children) {
                    if (c.type === 'element' && c.tag === 'CodepointRange') {
                        const cm = attrMap(c);
                        if (cm.font) ranges.push(cm.font);
                    }
                }
                if (a.name) this.fontGroups.set(a.name, ranges);
                break;
            }
            case 'Style':
                if (a.name) this.rawStyles.set(a.name, a);
                break;
            default:
                // Walk into containers we don't recognise so we don't miss
                // nested <Constant>/<Style>.
                if (el.children) {
                    for (const c of el.children) {
                        if (c.type === 'element') this._ingestNode(c);
                    }
                }
        }
    }

    // Resolve "#Foo" -> value of constant Foo, recursively.
    resolveValue(v) {
        if (v == null) return v;
        const seen = new Set();
        while (typeof v === 'string' && v.startsWith('#') && !seen.has(v)) {
            seen.add(v);
            const next = this.constants.get(v.slice(1));
            if (next === undefined) return v;
            v = next;
        }
        return v;
    }

    resolveFontPath(fontRef) {
        let v = this.resolveValue(fontRef);
        // If it resolves to a FontGroup name, take the first CodepointRange.
        if (this.fontGroups.has(v)) {
            const ranges = this.fontGroups.get(v);
            if (ranges.length) v = this.resolveValue(ranges[0]);
        }
        return v;
    }

    getStyle(name) {
        if (!name) return null;
        if (this.resolved.has(name)) return this.resolved.get(name);
        const raw = this.rawStyles.get(name);
        if (!raw) return null;
        let base = {};
        if (raw.template) {
            base = this.getStyle(raw.template) || {};
        }
        const merged = {
            ...base,
            ...(raw.font ? { fontFile: this.resolveFontPath(raw.font) } : {}),
            ...(raw.height ? { height: parseInt(raw.height, 10) } : {}),
            ...(raw.hjustify ? { hjustify: raw.hjustify } : {}),
            ...(raw.vjustify ? { vjustify: raw.vjustify } : {}),
            ...(raw.textcolor ? { textColor: parseSc2Color(this.resolveValue(raw.textcolor)) } : {}),
            ...(raw.styleflags ? { styleflags: raw.styleflags.split('|').map(s => s.trim()) } : {}),
            ...(raw.shadowoffset ? { shadowoffset: parseInt(this.resolveValue(raw.shadowoffset), 10) } : {}),
            ...(raw.outlinewidth ? { outlinewidth: parseInt(this.resolveValue(raw.outlinewidth), 10) } : {}),
            ...(raw.outlinecolor ? { outlinecolor: parseSc2Color(this.resolveValue(raw.outlinecolor)) } : {}),
        };
        if (merged.fontFile) merged.fontFamily = this.registerFontFamily(merged.fontFile);
        this.resolved.set(name, merged);
        return merged;
    }

    // Register a font file for @font-face injection. Returns the family name.
    registerFontFamily(fontFile) {
        const norm = fontFile.replace(/\\/g, '/').toLowerCase();
        if (this.fontFamilyByPath.has(norm)) return this.fontFamilyByPath.get(norm);
        const family = 'sc2-' + slugify(norm);
        this.fontFamilyByPath.set(norm, family);
        return family;
    }

    // Inject @font-face declarations for every font referenced so far.
    // `urlFor(path)` maps a "UI/Fonts/foo.ttf"-style path to a fetchable URL.
    injectFontFaces(styleSheet, urlFor) {
        for (const [path, family] of this.fontFamilyByPath) {
            if (this.fontsLoaded.has(family)) continue;
            const url = urlFor(path);
            if (!url) continue;
            const rule = `@font-face { font-family: "${family}"; src: url("${url}"); font-display: block; }`;
            try {
                styleSheet.insertRule(rule, styleSheet.cssRules.length);
                this.fontsLoaded.add(family);
            } catch (err) {
                console.warn('[fontstyle] could not inject @font-face for', path, err);
            }
        }
    }
}

function attrMap(el) {
    const out = {};
    for (const a of el.attrs) out[a.name] = a.value;
    return out;
}

// SC2 colors come in a bunch of forms:
//   "RRGGBB"           - hex
//   "AARRGGBB"         - hex with alpha (note: ARGB order, not RGBA!)
//   "r,g,b"            - decimal triple 0-255
//   "r,g,b,a"          - decimal quad
//   gradient: "color1|color2|color3|color4"  - we take the first stop
//   "#NamedColor"      - constant lookup (caller should pre-resolve)
function parseSc2Color(v) {
    if (!v || typeof v !== 'string') return undefined;
    if (v.includes('|')) v = v.split('|')[0];
    v = v.trim();
    if (v.includes(',')) {
        const parts = v.split(',').map(s => parseInt(s.trim(), 10) & 0xFF);
        const [r, g, b, a = 255] = parts;
        return rgbaHex(r, g, b, a);
    }
    if (/^[0-9a-fA-F]{6}$/.test(v)) return '#' + v.toLowerCase() + 'ff';
    if (/^[0-9a-fA-F]{8}$/.test(v)) {
        // AARRGGBB -> #RRGGBBAA
        const aa = v.slice(0, 2);
        const rr = v.slice(2, 4);
        const gg = v.slice(4, 6);
        const bb = v.slice(6, 8);
        return '#' + (rr + gg + bb + aa).toLowerCase();
    }
    return undefined;
}

function rgbaHex(r, g, b, a) {
    const h = (n) => n.toString(16).padStart(2, '0');
    return '#' + h(r) + h(g) + h(b) + h(a);
}

function slugify(s) {
    return s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Convert a resolved style dict to a CSS rule object usable on a label element.
export function styleToCss(style, opts = {}) {
    if (!style) return {};
    const out = {};
    // Always fall back through Saira (our bundled Eurostile-alike) before the
    // system stack, so labels look reasonably SC2-ish even when no .ttf file
    // is available from the user's extracted assets.
    if (style.fontFamily) out.fontFamily = `"${style.fontFamily}", "Saira", system-ui, sans-serif`;
    else out.fontFamily = '"Saira", system-ui, sans-serif';
    if (style.height) out.fontSize = (style.height * (opts.scale || 1)) + 'px';
    if (style.textColor) out.color = style.textColor;
    const flags = style.styleflags || [];
    if (flags.includes('Bold')) out.fontWeight = 'bold';
    if (flags.includes('Italic')) out.fontStyle = 'italic';
    if (flags.includes('Uppercase')) out.textTransform = 'uppercase';
    if (flags.includes('Shadow')) {
        const off = style.shadowoffset || 1;
        out.textShadow = `${off}px ${off}px 0 rgba(0,0,0,0.75)`;
    }
    if (flags.includes('Outline') && style.outlinewidth) {
        const w = style.outlinewidth;
        const c = style.outlinecolor || '#000000ff';
        const stack = [];
        for (let x = -w; x <= w; x++) for (let y = -w; y <= w; y++) {
            if (x === 0 && y === 0) continue;
            stack.push(`${x}px ${y}px 0 ${c}`);
        }
        out.textShadow = (out.textShadow ? out.textShadow + ',' : '') + stack.join(',');
    }
    if (style.hjustify === 'Center') out.justifyContent = 'center';
    else if (style.hjustify === 'Right') out.justifyContent = 'flex-end';
    else out.justifyContent = 'flex-start';
    if (style.vjustify === 'Middle') out.alignItems = 'center';
    else if (style.vjustify === 'Bottom') out.alignItems = 'flex-end';
    else out.alignItems = 'flex-start';
    return out;
}
