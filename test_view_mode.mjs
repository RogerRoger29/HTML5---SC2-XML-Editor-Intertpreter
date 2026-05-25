// Verify "in-game preview" view mode hides templates from the top level,
// leaving only actual placed UI frames.

import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';

const BASE = 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    if (typeof url === 'string' && url.startsWith('data/')) url = BASE + '/' + url;
    return origFetch(url);
};

const reg = new StockRegistry();
await reg.loadCore();
await reg.loadStockFrameOverrides('data/stock-frames.json');

const modText = await fetch(BASE + '/project/UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout').then(r => r.text());
const modDoc = parseXml(modText);
reg.addModTemplates(modDoc.root, 'UpgradeSlotPanel');

const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: false });

console.log(`All top-level frames (${list.length}):`);
for (const n of list) {
    console.log(`  ${n.isTemplate ? '[TMPL] ' : '       '}${n.origin.padEnd(5)} ${n.type}:${n.name}  (${n.children.length} kids)`);
}

const inGameView = list.filter(n => !n.isTemplate);
console.log(`\nIn-game preview view (${inGameView.length}):`);
for (const n of inGameView) {
    console.log(`  ${n.origin.padEnd(5)} ${n.type}:${n.name}  at (${n.x ?? '?'},${n.y ?? '?'}) size ${n.width ?? '?'}x${n.height ?? '?'}`);
}

console.log(`\ntemplateReferences set (${merged.templateReferences.size}):`);
console.log('  ', [...merged.templateReferences].slice(0, 10).join(', '), '...');
