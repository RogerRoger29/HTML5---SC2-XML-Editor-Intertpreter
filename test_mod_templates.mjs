// Verify that mod-defined templates resolve after addModTemplates(),
// and that template inheritance recurses into nested grandchildren.

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
await reg.loadStockFrameOverrides('data/stock-frames.json');
console.log(`Stock loaded. Templates by name: ${reg.templatesByName.size}`);

// Open UpgradeSlotPanel and register its mod templates.
const modText = await fetch(BASE + '/project/UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout').then(r => r.text());
const modDoc = parseXml(modText);
const added = reg.addModTemplates(modDoc.root, 'UpgradeSlotPanel');
console.log(`Registered ${added} mod templates as "UpgradeSlotPanel/*"`);

const probes = [
    'UpgradeSlotPanel/SlotButtonTemplate',
    'UpgradeSlotPanel/SelectionButtonTemplate',
    'UpgradeSlotPanel/UpgradeOpenerButtonTemplate',
    'SlotButtonTemplate',
    'StandardTemplates/StandardButtonTemplate',
];
for (const p of probes) {
    const t = reg.findTemplate(p);
    console.log(`  ${p.padEnd(50)} ${t ? 'YES' : 'NO '}`);
}

// Merge and inspect Choice0 (which uses SelectionButtonTemplate).
const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: false });

function findByPath(nodes, path) {
    for (const n of nodes) {
        if (n.path === path) return n;
        const r = findByPath(n.children, path);
        if (r) return r;
    }
    return null;
}

// Check what happens for Choice0 inside UpgradeSelectionPanel.
const choice0 = findByPath(list, 'UpgradeSelectionPanel/Choice0');
if (choice0) {
    console.log('\nUpgradeSelectionPanel/Choice0:');
    console.log('  template:', choice0._template || 'n/a');
    console.log('  children before materialize:', choice0.children.map(c => c.name));
}

// Materialize the tree (asFrameList does this for us).
console.log('\nMaterialized Choice0 children:');
function findMat(nodes, path) {
    for (const n of nodes) {
        if (n.path === path) return n;
        const r = findMat(n.children || [], path);
        if (r) return r;
    }
    return null;
}
const matChoice0 = findMat(list, 'UpgradeSelectionPanel/Choice0');
if (matChoice0) {
    for (const c of matChoice0.children) {
        console.log(`  ${c.type}:${c.name} (kids=${c.children.length}, props=${(c.xml && c.xml.children ? c.xml.children.length : 0)})`);
        for (const gc of c.children) {
            console.log(`    ${gc.type}:${gc.name} (kids=${gc.children.length})`);
        }
    }
} else {
    console.log('  Choice0 not found in materialized tree');
}

// Check Button0 inside UpgradeSlotPanel (uses SlotButtonTemplate).
console.log('\nButton0 inside UpgradeSlotPanel:');
const button0 = findMat(list, 'UpgradeSlotPanel/Button0');
if (button0) {
    console.log(`  ${button0.type}:${button0.name} w=${button0.width} h=${button0.height} anchors=${button0.anchors.length}`);
    for (const c of button0.children) {
        console.log(`    ${c.type}:${c.name} w=${c.width} h=${c.height} kids=${c.children.length}`);
    }
}
