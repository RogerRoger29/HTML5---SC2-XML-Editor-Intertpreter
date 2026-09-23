import assert from 'node:assert/strict';
import { parseXml } from './editor/js/xml/parser.js';
import { hasHoverPreviewAnimation } from './editor/js/render/frames.js';

function rootFrame(source) {
    const doc = parseXml(source);
    return doc.root.children.find(node => node.type === 'element' && node.tag === 'Frame');
}

const hover = rootFrame(`<Desc><Frame type="Image" name="Glow">
  <Animation name="Hover">
    <Event event="OnMouseEnter" action="Reset,Play"/>
    <Event event="OnMouseExit" action="Reset"/>
  </Animation>
</Frame></Desc>`);
assert.equal(hasHoverPreviewAnimation(hover), true);

const shown = rootFrame(`<Desc><Frame type="Image" name="Glow">
  <Animation name="Shown"><Event event="OnShown" action="Reset,Play"/></Animation>
</Frame></Desc>`);
assert.equal(hasHoverPreviewAnimation(shown), false);

const plain = rootFrame('<Desc><Frame type="Image" name="Plain"/></Desc>');
assert.equal(hasHoverPreviewAnimation(plain), false);

console.log('Hover interaction preview tests passed.');
