// Verify Assets.txt alias resolution end-to-end:
//   1. Load Assets.txt from each mod
//   2. Resolve the @@@/@@/@ refs UpgradeSlotPanel.SC2Layout uses
//   3. HEAD each resolved URL through the live server and report which 200/404

import { TextureLoader } from './editor/js/render/textures.js';

const BASE = 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    return origFetch(url, opts);
};

const tex = new TextureLoader('/assets/');
const n = await tex.loadAssetsTxt();
console.log(`Loaded ${n} aliases total across all mods\n`);

const refs = [
    '@@@UI/HeroPanelButtonNormal',
    '@@@UI/HeroPanelButtonHover',
    '@@UI/HeroPanelShieldBar',
    '@@UI/HeroPanelHealthBar',
    '@@UI/StandardButtonNormal',
    '@UI_ActionButtonSelect',
    'Assets\\Textures\\btn-ability-zerg-dehaka-levelup.dds',
    'Assets\\Textures\\sc2_ui_glues_bluebuttons_taskbarbuttonover.dds',
    'Assets\\Textures\\ui_void_mission_soa_frame_passive_lock.dds',
    'Assets\\Textures\\ui_nova_storymode_missionlaunch_breakingnews_border.dds',
];
for (const ref of refs) {
    const urls = tex.candidateUrls(ref);
    let hit = null;
    for (const url of urls) {
        const r = await origFetch(BASE + url, { method: 'HEAD' });
        if (r.ok) { hit = url; break; }
    }
    if (hit) console.log(`OK   ${ref}\n     -> ${hit.replace(BASE, '')}`);
    else      console.log(`MISS ${ref}\n     tried ${urls.length} candidates`);
}
