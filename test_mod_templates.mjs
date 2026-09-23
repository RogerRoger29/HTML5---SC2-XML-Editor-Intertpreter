import assert from 'node:assert/strict';
import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';
import { MOD_LAYOUT, findByPath } from './fixture_layouts.mjs';

const reg = new StockRegistry();
const modDoc = parseXml(MOD_LAYOUT);
const added = reg.addModTemplates(modDoc.root, 'FixtureLayout');
reg.addModConstants(modDoc.root);

assert.equal(added, 4);
assert.ok(reg.findTemplate('FixtureLayout/SlotButtonTemplate'));
assert.ok(reg.findTemplate('SlotButtonTemplate'));

const merged = new MergedTree(reg);
merged.mergeMod(modDoc.root);
const list = merged.asFrameList({ includeStock: false });
const choice = findByPath(list, 'UpgradeSelectionPanel/Choice0');
assert.ok(choice, 'Choice0 should materialize');
assert.equal(choice.width, 48, 'mod constant should resolve through template');
assert.ok(choice.children.some(c => c.name === 'NormalImage'), 'base template child should inherit');
assert.ok(choice.children.some(c => c.name === 'Label'), 'derived template child should inherit');

// Opening another file replaces the mod-template overlay completely.
const second = parseXml('<Desc><Frame type="Frame" name="OnlySecond"/></Desc>');
reg.addModTemplates(second.root, 'Second');
assert.equal(reg.findTemplate('FixtureLayout/SlotButtonTemplate'), null);
assert.equal(reg.findTemplate('SlotButtonTemplate'), null);
assert.ok(reg.findTemplate('Second/OnlySecond'));

console.log('ALL PASS');
