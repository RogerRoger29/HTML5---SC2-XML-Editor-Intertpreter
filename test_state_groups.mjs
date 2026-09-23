import assert from 'node:assert/strict';
import { parseXml } from './editor/js/xml/parser.js';
import { MergedTree } from './editor/js/merge.js';
import { StockRegistry } from './editor/js/stock.js';
import { applyStateActions } from './editor/js/state-groups.js';

const doc = parseXml(`<Desc>
  <Frame type="Button" name="Button">
    <Frame type="Image" name="Normal"><Visible val="true"/></Frame>
    <Frame type="Image" name="Hover"><Visible val="false"/></Frame>
    <StateGroup name="ButtonState">
      <DefaultState val="Normal"/>
      <State name="Normal">
        <Action type="SetProperty" frame="$this/Normal" visible="true"/>
        <Action type="SetProperty" frame="$this/Hover" visible="false"/>
      </State>
      <State name="Hover">
        <Action type="SetProperty" frame="$this/Normal" visible="false"/>
        <Action type="SetProperty" frame="$this/Hover" visible="true"/>
      </State>
    </StateGroup>
  </Frame>
</Desc>`);
const merged = new MergedTree(new StockRegistry());
merged.mergeMod(doc.root);
const [button] = merged.asFrameList({ includeStock: false });
const active = new Map();
applyStateActions([button], active);
assert.equal(button.children.find(c => c.name === 'Normal').visible, true);
assert.equal(button.children.find(c => c.name === 'Hover').visible, false);
active.set('Button#ButtonState', 'Hover');
applyStateActions([button], active);
assert.equal(button.children.find(c => c.name === 'Normal').visible, false);
assert.equal(button.children.find(c => c.name === 'Hover').visible, true);

console.log('ALL PASS');
