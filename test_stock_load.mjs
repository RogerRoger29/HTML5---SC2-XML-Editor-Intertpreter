import assert from 'node:assert/strict';
import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';
import { MOD_LAYOUT, findByPath } from './fixture_layouts.mjs';

const BASE = process.env.SC2UI_TEST_BASE || 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    return origFetch(url, opts);
};

const reg = new StockRegistry();
const result = await reg.loadCore();
assert.ok(result.fileCount > 1, 'stock DescIndex should load includes');
assert.ok(reg.templatesByName.size > 0, 'stock templates should be registered');
assert.ok(reg.findTemplate('StandardTemplates/StandardButtonTemplate'),
    'known stock template should resolve');

const modDoc = parseXml(MOD_LAYOUT);
reg.addModTemplates(modDoc.root, 'FixtureLayout');
reg.addModConstants(modDoc.root);
const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: true });
assert.ok(findByPath(list, 'UpgradeSlotPanel/Button0'));
assert.ok(findByPath(list, 'GameUI/UIContainer/FullscreenUpperContainer/HeroPanel'));

console.log(`ALL PASS (${result.fileCount} stock files, ${result.errorCount} unavailable includes)`);
