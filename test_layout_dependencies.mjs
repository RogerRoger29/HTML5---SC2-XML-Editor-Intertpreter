import assert from 'node:assert/strict';
import { layoutFrames } from './editor/js/render/layout.js';

function frame(name, anchors, width = 10, height = 10, children = []) {
    const node = { name, path: name, anchors, width, height, children, parent: null };
    for (const child of children) child.parent = node;
    return node;
}

// A is declared before B but anchored to B's right edge.
const a = frame('A', [
    { side: 'Left', relative: '$parent/B', pos: 'Max', offset: 5 },
    { side: 'Top', relative: '$parent', pos: 'Min', offset: 0 },
]);
const b = frame('B', [
    { side: 'Left', relative: '$parent', pos: 'Min', offset: 100 },
    { side: 'Top', relative: '$parent', pos: 'Min', offset: 0 },
], 20, 20);
const result = layoutFrames([a, b], 1920, 1080);
assert.equal(b.x, 100);
assert.equal(a.x, 125, 'forward sibling anchor should resolve independently of declaration order');
assert.ok(Number.isFinite(a.x));
assert.equal(result.cycles.length, 0);

// Cycles should never emit NaN. They fall back deterministically and report.
const c = frame('C', [{ side: 'Left', relative: '$parent/D', pos: 'Max', offset: 0 }]);
const d = frame('D', [{ side: 'Left', relative: '$parent/C', pos: 'Max', offset: 0 }]);
const cyclic = layoutFrames([c, d], 100, 100);
assert.ok(cyclic.cycles.length > 0);
assert.ok(Number.isFinite(c.x) && Number.isFinite(d.x));

console.log('ALL PASS');
