import assert from 'node:assert/strict';
import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';
import { MOD_LAYOUT, findByPath } from './fixture_layouts.mjs';

const BASE = process.env.SC2UI_TEST_BASE || 'http://127.0.0.1:8765';
const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
    if (typeof url === 'string' && url.startsWith('/')) url = BASE + url;
    if (typeof url === 'string' && url.startsWith('data/')) url = BASE + '/' + url;
    return origFetch(url, opts);
};

const reg = new StockRegistry();
await reg.loadCore();
const seeded = await reg.loadStockFrameOverrides('data/stock-frames.json');
assert.ok(seeded > 0, 'curated stock-frame positions should load');
assert.ok(reg.framesByPath.has('GameUI/UIContainer/FullscreenUpperContainer/HeroPanel'));

const modDoc = parseXml(MOD_LAYOUT);
const merged = new MergedTree(reg);
merged.mergeStock();
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: false });
const hero = findByPath(list, 'GameUI/UIContainer/FullscreenUpperContainer/HeroPanel');
assert.ok(hero, 'deep mod override should retain its stock parent chain');
assert.ok(hero.children.some(c => c.name === 'FixtureLabel'));

console.log('ALL PASS');
