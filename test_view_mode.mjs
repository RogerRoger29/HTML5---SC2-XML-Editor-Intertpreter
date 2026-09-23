import assert from 'node:assert/strict';
import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';
import { MOD_LAYOUT } from './fixture_layouts.mjs';

const reg = new StockRegistry();
const modDoc = parseXml(MOD_LAYOUT);
reg.addModTemplates(modDoc.root, 'FixtureLayout');
const merged = new MergedTree(reg);
merged.mergeMod(modDoc.root);
const placed = merged.asFrameList({ includeStock: false });
const game = placed.filter(n => !n.isTemplate);

assert.ok(placed.some(n => n.name === 'SlotButtonTemplate' && n.isTemplate));
assert.ok(placed.some(n => n.name === 'SelectionButtonTemplate' && n.isTemplate));
assert.ok(game.some(n => n.name === 'UpgradeSlotPanel'));
assert.ok(!game.some(n => n.isTemplate));

console.log('ALL PASS');
