// Verify SC2 asset-catalog alias resolution end-to-end:
//   1. Load Assets.txt and AssetsProduct.txt from each mod
//   2. Resolve the @@@/@@/@ refs UpgradeSlotPanel.SC2Layout uses
//   3. HEAD each resolved URL through the live server and report which 200/404

import assert from 'node:assert/strict';
import { TextureLoader } from './editor/js/render/textures.js';

const BASE = process.env.SC2UI_TEST_BASE || 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    return origFetch(url, opts);
};

const tex = new TextureLoader('/assets/');
const n = await tex.loadAssetsTxt();
assert.ok(n > 0, 'expected at least one Assets.txt alias from the configured assets root');
console.log(`Loaded ${n} aliases total across all mods\n`);

const refs = [
    '@@@UI/HeroPanelButtonNormal',
    '@@@UI/HeroPanelButtonHover',
    '@@UI/HeroPanelShieldBar',
    '@@UI/HeroPanelHealthBar',
    '@@UI/StandardButtonNormal',
    '@@UI/StandardTechBorderButton',
    '@UI_ActionButtonSelect',
    'Assets\\Textures\\btn-ability-zerg-dehaka-levelup.dds',
    'Assets\\Textures\\sc2_ui_glues_bluebuttons_taskbarbuttonover.dds',
    'Assets\\Textures\\ui_void_mission_soa_frame_passive_lock.dds',
    'Assets\\Textures\\ui_nova_storymode_missionlaunch_breakingnews_border.dds',
];
let hits = 0;
const resolved = new Set();
for (const ref of refs) {
    const urls = tex.candidateUrls(ref);
    let hit = null;
    for (const url of urls) {
        const r = await origFetch(BASE + url, { method: 'HEAD' });
        if (r.ok) { hit = url; break; }
    }
    if (hit) { hits++; resolved.add(ref); console.log(`OK   ${ref}\n     -> ${hit.replace(BASE, '')}`); }
    else      console.log(`MISS ${ref}\n     tried ${urls.length} candidates`);
}
assert.ok(hits > 0, 'none of the known texture references resolved through the live server');
assert.ok(resolved.has('@@UI/StandardTechBorderButton'),
    'AssetsProduct.txt standard EditBox border alias did not resolve');
console.log(`\nALL PASS (${hits}/${refs.length} known texture references resolved)`);
