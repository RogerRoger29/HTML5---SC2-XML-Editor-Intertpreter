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

// Side-less fill anchors use their declared relative target, not always the
// direct parent. StandardCheckBoxLabelTemplate depends on this shape.
const button = frame('Button', [
    { side: 'Left', relative: '$parent', pos: 'Min', offset: 20 },
    { side: 'Top', relative: '$parent', pos: 'Min', offset: 15 },
], 45, 38);
const mark = frame('CheckImage', [
    { side: null, relative: '$parent/Button', pos: 'Min', offset: 0 },
]);
const checkbox = frame('CheckBox', [
    { side: 'Left', relative: '$parent', pos: 'Min', offset: 100 },
    { side: 'Top', relative: '$parent', pos: 'Min', offset: 80 },
], 160, 50, [button, mark]);
layoutFrames([checkbox], 1920, 1080);
assert.deepEqual(
    { x: mark.x, y: mark.y, w: mark.w, h: mark.h },
    { x: button.x, y: button.y, w: button.w, h: button.h },
    'fill anchor should match its sibling relative target',
);

// Stock SC2 layouts commonly point opposing anchors at the same midpoint
// and provide an explicit size. The size is honoured and centred on that
// collapsed extent instead of producing a zero-size frame.
const centered = frame('Centered', [
    { side: 'Left', relative: '$parent', pos: 'Mid', offset: 120 },
    { side: 'Right', relative: '$parent', pos: 'Mid', offset: 120 },
    { side: 'Top', relative: '$parent', pos: 'Mid', offset: -40 },
    { side: 'Bottom', relative: '$parent', pos: 'Mid', offset: -40 },
], 76, 50);
layoutFrames([centered], 1920, 1080);
assert.deepEqual(
    { x: centered.x, y: centered.y, w: centered.w, h: centered.h },
    { x: 1042, y: 475, w: 76, h: 50 },
    'explicit size should be centred between opposing anchor positions',
);

// Without a declared size, opposing anchors still fill their extent.
const filled = frame('Filled', [
    { side: 'Left', relative: '$parent', pos: 'Min', offset: 10 },
    { side: 'Right', relative: '$parent', pos: 'Min', offset: 90 },
], null, 10);
layoutFrames([filled], 200, 100);
assert.deepEqual(
    { x: filled.x, w: filled.w },
    { x: 10, w: 80 },
    'opposing anchors should fill their extent when Width is absent',
);

console.log('ALL PASS');
