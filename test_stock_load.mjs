// Live test against a running serve.py. Loads core's descindex, walks includes,
// then verifies the registry knows about templates the mod files actually use.
//
// Usage:  python serve.py --no-open &   then   node test_stock_load.mjs

import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';

const BASE = 'http://127.0.0.1:8765';

// stock.js fetches absolute URL paths; intercept to prepend the local server.
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    return origFetch(url, opts);
};

const reg = new StockRegistry();
console.log('Loading stock layouts…');
const t0 = Date.now();
const result = await reg.loadCore(({ done, total }) => {
    if (done % 20 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total} files`);
    }
});
process.stdout.write('\n');
console.log(`Loaded ${result.fileCount} files in ${Date.now() - t0}ms; ${result.errorCount} errors.`);
console.log(`Constants: ${reg.constants.size}`);
console.log(`Templates (by path): ${reg.templatesByPath.size}`);
console.log(`Templates (by bare name): ${reg.templatesByName.size}`);
console.log(`Frames by path: ${reg.framesByPath.size}`);

// Sanity-check: lookups we know modders rely on.
const probes = [
    'StandardTemplates/StandardButtonTemplate',
    'StandardButtonTemplate',
    'HeroPanel/HeroFrameTemplate',
    'HeroFrameTemplate',
    'GameUI/UIContainer/FullscreenUpperContainer/HeroPanel',
];
console.log('\nTemplate / frame probes:');
for (const p of probes) {
    const tmpl = reg.findTemplate(p);
    const frame = reg.framesByPath.get(p);
    console.log(`  ${p.padEnd(60)} template=${tmpl ? 'yes' : 'no '}  frame=${frame ? 'yes' : 'no'}`);
}

// Constant probes.
console.log('\nConstant probes:');
for (const c of ['HeroButtonGap', 'BlizzardGlobal', 'ColorWhite']) {
    console.log(`  ${c.padEnd(20)} = ${JSON.stringify(reg.constants.get(c))}`);
}

// Merger test: parse UpgradeSlotPanel, merge stock then mod, count resulting roots.
console.log('\nMerging UpgradeSlotPanel.SC2Layout on top of stock…');
const modText = await fetch(BASE + '/project/UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout').then(r => r.text());
const modDoc = parseXml(modText);

const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);

const list = merged.asFrameList({ includeStock: true });
console.log(`Top-level merged frames: ${list.length}`);
const summarize = (nodes, depth = 0, max = 40) => {
    for (const n of nodes) {
        if (max-- <= 0) { console.log('  '.repeat(depth) + '...'); return; }
        console.log('  '.repeat(depth) + `[${n.origin}] ${n.type}:${n.name} (${n.children.length} kids, ${n.anchors.length} anchors, w=${n.width} h=${n.height})`);
        if (n.children.length && depth < 2) summarize(n.children, depth + 1, max);
    }
};
summarize(list);

// Specifically: did our mod's UpgradeSlotPanel land under a known parent? And
// did the HeroPanel override merge in?
const upgradeSlotPanel = list.find(n => n.name === 'UpgradeSlotPanel');
console.log('\nUpgradeSlotPanel root present:', !!upgradeSlotPanel);
if (upgradeSlotPanel) {
    console.log('  origin:', upgradeSlotPanel.origin, 'children:', upgradeSlotPanel.children.length);
}

const gameui = list.find(n => n.name === 'GameUI');
console.log('GameUI root present:', !!gameui);
if (gameui) {
    const uic = gameui.children.find(c => c.name === 'UIContainer');
    console.log('  has UIContainer:', !!uic);
    if (uic) {
        const fsu = uic.children.find(c => c.name === 'FullscreenUpperContainer');
        console.log('  has FullscreenUpperContainer:', !!fsu);
        if (fsu) {
            const hp = fsu.children.find(c => c.name === 'HeroPanel');
            console.log('  has HeroPanel:', !!hp, 'origin:', hp && hp.origin, 'children:', hp && hp.children.length);
        }
    }
}
