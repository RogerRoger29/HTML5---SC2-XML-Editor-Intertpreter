// Confirm the seeded stock-frames.json paths flow into the registry and that
// a mod targeting GameUI/UIContainer/.../HeroPanel inherits the curated
// position/size.

import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';

const BASE = 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    if (typeof url === 'string' && url.startsWith('data/')) url = BASE + '/' + url;
    return origFetch(url, opts);
};

const reg = new StockRegistry();
await reg.loadCore();
const seeded = await reg.loadStockFrameOverrides('data/stock-frames.json');
console.log(`Stock loaded; ${seeded} curated frames added`);

const probes = [
    'GameUI',
    'GameUI/UIContainer',
    'GameUI/UIContainer/FullscreenUpperContainer/HeroPanel',
    'GameUI/UIContainer/FullscreenUpperContainer/ResourcePanel',
];
for (const p of probes) {
    const info = reg.framesByPath.get(p);
    console.log(`  ${p.padEnd(60)} ${info ? `found (${info.sources.length} source(s))` : 'MISSING'}`);
}

// Merge UpgradeSlotPanel on top and check the HeroPanel override box.
const modText = await fetch(BASE + '/project/UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout').then(r => r.text());
const modDoc = parseXml(modText);
const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: false });

// Find the HeroPanel override in the resulting tree.
function findByPath(nodes, path) {
    for (const n of nodes) {
        if (n.path === path) return n;
        const r = findByPath(n.children, path);
        if (r) return r;
    }
    return null;
}
const hero = findByPath(list, 'GameUI/UIContainer/FullscreenUpperContainer/HeroPanel');
console.log('\nHeroPanel override node:');
if (hero) {
    console.log('  path:', hero.path);
    console.log('  origin:', hero.origin, '(synthetic:', hero.synthetic, ')');
    console.log('  anchors:', hero.anchors.length, hero.anchors);
    console.log('  size: w=', hero.width, 'h=', hero.height);
    console.log('  children:', hero.children.map(c => c.name));
} else {
    console.log('  NOT FOUND');
}
