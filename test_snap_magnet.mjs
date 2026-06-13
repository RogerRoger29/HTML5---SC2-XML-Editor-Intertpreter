// Unit-test the snap-to-guide magnetism (v0.5.5). magnetizeBodyMove nudges a
// whole-frame move delta so the nearest edge/center aligns with a candidate
// coordinate within tolerance. Pure function — no DOM needed.

import { magnetizeBodyMove } from './editor/js/ui/edit.js';

let failures = 0;
function eq(label, got, want) {
    const ok = got === want;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
    if (!ok) failures++;
}

const box = { x: 100, y: 200, w: 50, h: 40 };   // edges x:100/150/125, y:200/240/220
const TOL = 4;

// 1. No targets -> delta unchanged.
{
    const m = magnetizeBodyMove(box, 7, -3, { xs: [], ys: [] }, TOL);
    eq('no targets: dx', m.dx, 7);
    eq('no targets: dy', m.dy, -3);
}

// 2. Left edge snaps to a target within tolerance.
//    left edge after dx=7 is 107; target 110 is 3 away -> adjust +3 -> dx=10.
{
    const m = magnetizeBodyMove(box, 7, 0, { xs: [110], ys: [] }, TOL);
    eq('left-edge snap: dx', m.dx, 10);
}

// 3. Closest edge wins: right edge (150) is nearer than left.
//    dx=2 -> right=152; target 150 -> adjust -2 -> dx=0 (right lands on 150).
{
    const m = magnetizeBodyMove(box, 2, 0, { xs: [150], ys: [] }, TOL);
    eq('closest-edge wins: dx', m.dx, 0);
}

// 4. Out of tolerance -> no snap.
{
    const m = magnetizeBodyMove(box, 0, 0, { xs: [120], ys: [] }, TOL);  // center 125 is 5 away
    eq('out of tol: dx unchanged', m.dx, 0);
}

// 5. Center snap: center x after dx is 125; target 127 within tol -> +2.
{
    const m = magnetizeBodyMove(box, 0, 0, { xs: [127], ys: [] }, TOL);
    eq('center snap: dx', m.dx, 2);
}

// 6. Y axis independent: top edge 200 + dy=1 = 201; target 240 (bottom) ...
//    bottom edge after dy=1 is 241; target 240 -> adjust -1 -> dy=0.
{
    const m = magnetizeBodyMove(box, 0, 1, { xs: [], ys: [240] }, TOL);
    eq('y bottom snap: dy', m.dy, 0);
    eq('y bottom snap: dx untouched', m.dx, 0);
}

// 7. Both axes snap simultaneously and independently.
{
    const m = magnetizeBodyMove(box, 7, 1, { xs: [110], ys: [240] }, TOL);
    eq('both axes: dx', m.dx, 10);
    eq('both axes: dy', m.dy, 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
