// Stock layout loader + global registries.
//
// SC2 builds its in-game UI by merging many .SC2Layout files together. Each
// file can:
//   - <Include path="..."/> additional files
//   - Define <Constant name="..." val="..."/>
//   - Define top-level <Frame name="X"> templates and overrides
//   - Re-open frames at a deep path: <Frame name="GameUI/UIContainer/.../X">
//
// We build three registries:
//   - constants:  name -> string value  (deduped across all files; first wins)
//   - templates:  "FileBase/FrameName" -> element  (file-qualified path)
//                 + "FrameName" -> element (bare; last write wins for now)
//   - tree:       a virtual root containing the merged frame hierarchy
//                 (used when "show stock UI" is on)

import { parseXml } from './xml/parser.js';
import { attrMap } from './xml/helpers.js';
import { STOCK_ASSETS_BASE } from './constants.js';

const DESC_INDEX_URL = STOCK_ASSETS_BASE + 'UI/Layout/descindex.sc2layout';
const LAYOUT_BASE = STOCK_ASSETS_BASE;

export class StockRegistry {
    constructor() {
        this.constants = new Map();
        this.templatesByPath = new Map();  // "StandardTemplates/StandardButtonTemplate" -> el
        this.templatesByName = new Map();  // "StandardButtonTemplate" -> el (last write wins)
        this.framesByPath = new Map();     // "GameUI/UIContainer/.../HeroPanel" -> { el, sources: [] }
        this.loadedFiles = new Set();
        this.errors = [];
    }

    // Load everything reachable from descindex.sc2layout under core.sc2mod.
    // Returns { fileCount, errorCount } when done.
    async loadCore(onProgress) {
        let queue = [DESC_INDEX_URL];
        let total = 1;
        let done = 0;
        while (queue.length) {
            const next = queue.shift();
            if (this.loadedFiles.has(next)) { done++; continue; }
            this.loadedFiles.add(next);
            try {
                const txt = await fetch(next).then(r => r.ok ? r.text() : null);
                if (!txt) { this.errors.push({ url: next, error: 'fetch failed' }); done++; continue; }
                const doc = parseXml(txt);
                const root = doc.root;
                if (!root) { done++; continue; }
                const newIncludes = this.ingest(root, next);
                for (const inc of newIncludes) {
                    if (!this.loadedFiles.has(inc)) { queue.push(inc); total++; }
                }
            } catch (err) {
                this.errors.push({ url: next, error: err.message });
            }
            done++;
            if (onProgress) onProgress({ done, total, url: next });
        }
        return { fileCount: this.loadedFiles.size, errorCount: this.errors.length };
    }

    // Read a single layout's <Desc> root into the registries. Returns the list
    // of URLs that its <Include> children point at.
    ingest(rootEl, sourceUrl) {
        const fileBase = baseNameNoExt(sourceUrl);
        const includes = [];
        for (const child of rootEl.children) {
            if (child.type !== 'element') continue;
            switch (child.tag) {
                case 'Include': {
                    const a = attrMap(child);
                    if (a.path) includes.push(this.resolveIncludePath(a.path));
                    break;
                }
                case 'Constant': {
                    const a = attrMap(child);
                    if (a.name && !this.constants.has(a.name)) this.constants.set(a.name, a.val ?? '');
                    break;
                }
                case 'Frame':
                    this._ingestFrame(child, fileBase);
                    break;
                default:
                    // Some files wrap content in <StyleFile> or other roots;
                    // walk into them so we don't miss nested <Frame>/<Constant>.
                    if (child.children && child.children.length) {
                        this.ingest(child, sourceUrl);
                    }
            }
        }
        return includes;
    }

    _ingestFrame(el, fileBase) {
        const a = attrMap(el);
        const name = a.name || '';
        if (!name) return;
        if (name.includes('/')) {
            // Path-based re-opening of an existing frame. Store under that
            // path; merger will fold these into the live tree.
            const existing = this.framesByPath.get(name);
            if (existing) existing.sources.push({ el, fileBase });
            else this.framesByPath.set(name, { sources: [{ el, fileBase }] });
        } else {
            // Treat as a template (file-qualified) plus a bare-name lookup.
            this.templatesByPath.set(`${fileBase}/${name}`, el);
            this.templatesByName.set(name, el);
            // Also expose as a top-level frame for the merged tree.
            const path = name;
            const existing = this.framesByPath.get(path);
            if (existing) existing.sources.push({ el, fileBase });
            else this.framesByPath.set(path, { sources: [{ el, fileBase }] });
        }
    }

    resolveIncludePath(path) {
        // Includes are written like "UI/Layout/Common/StandardTemplates.SC2Layout"
        // and resolve relative to the mod's Base.SC2Data root.
        return LAYOUT_BASE + path.replace(/\\/g, '/');
    }

    // Register mod-defined templates so other frames (in the same file or
     // elsewhere) can resolve template="FileBase/Name" or template="Name".
     // Pass the mod doc's <Desc> root and the file's basename (no extension).
    addModTemplates(docRoot, fileBase) {
        if (!docRoot || !docRoot.children) return 0;
        let count = 0;
        const FRAME_LIKE = /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip)$/;
        for (const child of docRoot.children) {
            if (child.type !== 'element') continue;
            if (child.tag !== 'Frame' && !FRAME_LIKE.test(child.tag)) continue;
            const nameAttr = child.attrs.find(a => a.name === 'name');
            if (!nameAttr) continue;
            const name = nameAttr.value;
            // Skip path-named overrides (`name="GameUI/.../X"`); those go through
            // the merger as frame placements, not templates.
            if (name.includes('/')) continue;
            this.templatesByPath.set(`${fileBase}/${name}`, child);
            this.templatesByName.set(name, child);
            count++;
        }
        return count;
    }

    // Load the editor's hand-maintained stock-frame position table (data/stock-frames.json).
    // Each entry becomes a synthetic <Frame> element registered under framesByPath, so when
    // a mod targets that path we can pre-populate anchors/size that stock XML lacks.
    async loadStockFrameOverrides(url = 'data/stock-frames.json') {
        try {
            const data = await fetch(url).then(r => r.ok ? r.json() : null);
            if (!data || !Array.isArray(data.frames)) return 0;
            let added = 0;
            for (const entry of data.frames) {
                if (!entry.path) continue;
                const el = buildVirtualFrame(entry);
                const existing = this.framesByPath.get(entry.path);
                if (existing) existing.sources.push({ el, fileBase: 'stock-frames.json' });
                else this.framesByPath.set(entry.path, { sources: [{ el, fileBase: 'stock-frames.json' }] });
                added++;
            }
            return added;
        } catch (err) {
            console.warn('[stock-frames.json] load failed:', err);
            return 0;
        }
    }

    // Resolve "#Foo" through the constants table.
    resolveValue(v) {
        if (typeof v !== 'string') return v;
        const seen = new Set();
        while (v.startsWith('#') && !seen.has(v)) {
            seen.add(v);
            const next = this.constants.get(v.slice(1));
            if (next == null) return v;
            v = next;
        }
        return v;
    }

    // Look up a template element by "File/Name", "Name", or "Path/Sub" within
    // a known file.
    findTemplate(ref) {
        if (!ref) return null;
        if (this.templatesByPath.has(ref)) return this.templatesByPath.get(ref);
        if (this.templatesByName.has(ref)) return this.templatesByName.get(ref);
        // Path like "FileName/SubName" where FileName may not be in our path map:
        // try the bare last segment.
        const last = ref.split('/').pop();
        if (this.templatesByName.has(last)) return this.templatesByName.get(last);
        return null;
    }
}

// attrMap moved to xml/helpers.js in R4.1.

function baseNameNoExt(url) {
    const file = url.split('/').pop();
    return file.replace(/\.(sc2layout|xml)$/i, '');
}

// Construct a fake <Frame> element matching the shape parser.js emits, so the
// merger can treat virtual stock-frames.json entries identically to real XML.
function buildVirtualFrame(entry) {
    const children = [];
    if (entry.width != null) children.push(virtElement('Width', { val: String(entry.width) }, true));
    if (entry.height != null) children.push(virtElement('Height', { val: String(entry.height) }, true));
    for (const a of entry.anchors || []) {
        children.push(virtElement('Anchor', {
            side: a.side, relative: a.relative, pos: a.pos, offset: String(a.offset),
        }, true));
    }
    return virtElement('Frame', { type: entry.type || 'Frame', name: entry.path }, false, children);
}

function virtElement(tag, attrs, selfClosing, children = []) {
    return {
        type: 'element',
        tag,
        attrs: Object.entries(attrs).filter(([_, v]) => v != null).map(([k, v]) => ({
            name: k, value: String(v), quote: '"', rawBetween: ' ', rawEq: '=', rawAfter: '',
        })),
        selfClosing,
        children,
        opening: null,
        closing: null,
        source: null,
        start: 0, end: 0,
        dirty: false,
    };
}
