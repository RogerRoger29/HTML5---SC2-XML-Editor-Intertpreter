// Texture loader: SC2 texture refs -> HTMLCanvasElement (decoded DDS bitmap).
//
// Refs look like:
//   Assets\Textures\foo.dds
//   @UI_ActionButtonSelect                  - texture alias (not yet resolved)
//   @@@UI/HeroPanelButtonNormal             - asset reference (resolved against assets root)
//   #SomeConstant                           - constant reference (resolved upstream)
//
// We look the referenced path up under /assets/{mod}/Base.SC2Assets/ first,
// then under each known mod folder. Misses return null and the renderer paints
// a magenta placeholder rectangle.

import { ddsToCanvas } from './dds.js';

export class TextureLoader {
    constructor(assetsBase = '/assets/') {
        this.assetsBase = assetsBase.endsWith('/') ? assetsBase : assetsBase + '/';
        this.cache = new Map();        // ref -> Promise<HTMLCanvasElement | null>
        // Folder names inside the assets root to search, in priority order.
        // Mirrors a CASCExplorer-style flat extraction. Includes campaign
        // folders + .stormmod packs so textures from Nova, Void, WC3 crossover
        // etc. resolve correctly.
        this.modOrder = [
            // Core SC2 mods (UI lives mostly here)
            'core.sc2mod', 'liberty.sc2mod', 'swarm.sc2mod', 'void.sc2mod',
            'novastoryassets.sc2mod', 'libertystory.sc2mod',
            'swarmstory.sc2mod', 'voidstory.sc2mod', 'voidprologue.sc2mod',
            'libertymulti.sc2mod', 'swarmmulti.sc2mod', 'voidmulti.sc2mod',
            'balancemulti.sc2mod', 'alliedcommanders.sc2mod',
            'war3.sc2mod', 'frontiers.sc2mod', 'challenges.sc2mod', 'mutators.sc2mod',
            // Campaign packs (textures like ui_void_mission_* live here)
            'liberty.sc2campaign', 'swarm.sc2campaign', 'void.sc2campaign',
            'libertystory.sc2campaign', 'swarmstory.sc2campaign', 'voidstory.sc2campaign',
            // Heroes of the Storm shared assets
            'core.stormmod', 'heroes.stormmod', 'heroesdata.stormmod',
        ];
        // Texture aliases populated from each mod's Base.SC2Data/GameData/Assets.txt.
        // SC2 references textures as "@@UI/Foo" or "@@@UI/Foo"; we strip the @s and
        // look up the remainder in this map. Later mods override earlier ones
        // (mirrors SC2's mod load order).
        this.aliases = new Map();
        this.aliasesLoaded = false;
        // Currently-loaded file's mod folder. We search it FIRST so a mod's
        // own Base.SC2Assets/Assets/Textures/foo.dds takes precedence over a
        // stock file with the same name. E.g. when the user opens
        // /project/Shepherd/ShepardMod.SC2Mod/Base.SC2Data/UI/Layout/foo.SC2Layout
        // their custom textures live at ShepardMod.SC2Mod/Base.SC2Assets/.
        this.modRoot = null;
    }

    /** Set the URL prefix of the mod folder whose textures should be tried
     *  before the stock fallbacks. Pass null to clear. */
    setModRoot(url) {
        if (this.modRoot === url) return;
        this.modRoot = url;
        this.cache.clear();
    }

    setModOrder(mods) {
        this.modOrder = mods.slice();
    }

    addAlias(name, path) {
        this.aliases.set(name, path);
    }

    /** Load Assets.txt from every known mod and merge into the alias map.
     *  Lines look like:   UI/HeroPanelButtonNormal=Assets\Textures\foo.dds
     *  Blank lines and lines starting with '//' or ';' are ignored. */
    async loadAssetsTxt() {
        if (this.aliasesLoaded) return this.aliases.size;
        let total = 0;
        for (const mod of this.modOrder) {
            const url = `${this.assetsBase}${mod}/Base.SC2Data/GameData/Assets.txt`;
            try {
                const text = await fetch(url).then(r => r.ok ? r.text() : null);
                if (!text) continue;
                let n = 0;
                for (const rawLine of text.split(/\r?\n/)) {
                    const line = rawLine.trim();
                    if (!line || line.startsWith('//') || line.startsWith(';')) continue;
                    const eq = line.indexOf('=');
                    if (eq < 0) continue;
                    const key = line.slice(0, eq).trim();
                    const val = line.slice(eq + 1).trim();
                    if (!key) continue;
                    this.aliases.set(key, val);
                    n++;
                }
                total += n;
                console.info(`[textures] loaded ${n} aliases from ${mod}`);
            } catch (err) {
                // Mod doesn't ship Assets.txt; that's fine.
            }
        }
        this.aliasesLoaded = true;
        return total;
    }

    // Resolve any SC2 texture reference to a list of candidate URLs to fetch.
    candidateUrls(ref) {
        if (!ref) return [];
        let r = ref.trim();
        // All @-prefixes (@, @@, @@@) are Assets.txt aliases. The number of @s
        // signals how the engine renders the texture (normal/border/asset-bundle)
        // but for fetching we just look up the key.
        if (r.startsWith('@')) {
            const key = r.replace(/^@+/, '');
            const resolved = this.aliases.get(key);
            if (resolved) r = resolved;
            else {
                // Unknown alias - fall back to treating the remainder as a path.
                r = key;
            }
        }
        // Now treat as a literal path. Normalise slashes, strip leading /.
        r = r.replace(/\\/g, '/').replace(/^\/+/, '');
        const out = [];
        // The opened file's own mod folder wins (custom textures override
        // stock textures of the same name).
        if (this.modRoot) {
            const base = this.modRoot.endsWith('/') ? this.modRoot : this.modRoot + '/';
            out.push(`${base}Base.SC2Assets/${r}`);
            out.push(`${base}Base.SC2Data/${r}`);
        }
        // Stock SC2 mods.
        for (const mod of this.modOrder) {
            out.push(`${this.assetsBase}${mod}/Base.SC2Assets/${r}`);
            out.push(`${this.assetsBase}${mod}/Base.SC2Data/${r}`);
        }
        return out;
    }

    load(ref) {
        if (!ref) return Promise.resolve(null);
        if (this.cache.has(ref)) return this.cache.get(ref);
        const p = this._load(ref);
        this.cache.set(ref, p);
        return p;
    }

    async _load(ref) {
        const urls = this.candidateUrls(ref);
        const decodeErrors = [];
        for (const url of urls) {
            let resp;
            try { resp = await fetch(url); }
            catch (err) { continue; }
            if (!resp.ok) continue;
            // The HTTP request succeeded; from here a failure means the file
            // is on disk but the decoder couldn't handle it. Record + report.
            try {
                const buf = await resp.arrayBuffer();
                if (url.toLowerCase().endsWith('.dds')) {
                    const canvas = ddsToCanvas(buf);
                    console.info(`[textures] OK  ${ref}  (${canvas.width}x${canvas.height})  <- ${url.replace(/^\/assets\//, '')}`);
                    return canvas;
                }
                const canvas = await loadImageBlob(buf);
                console.info(`[textures] OK  ${ref}  (${canvas.width}x${canvas.height})  <- ${url.replace(/^\/assets\//, '')}`);
                return canvas;
            } catch (err) {
                decodeErrors.push({ url, error: err.message || String(err) });
            }
        }
        if (decodeErrors.length) {
            console.warn(`[textures] decode FAILED for ${ref}:`, decodeErrors);
        } else {
            console.warn('[textures] not found:', ref);
        }
        return null;
    }
}

async function loadImageBlob(buf) {
    const blob = new Blob([buf]);
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = url;
        });
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}
