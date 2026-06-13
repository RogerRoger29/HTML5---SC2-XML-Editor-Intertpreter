// Unit-test the snap-to-guide magnetism. magnetizeMove nudges a drag delta so
// the dragged frame's active edge(s)/center align with a candidate coordinate
// within tolerance — for both body moves (every edge) and resize handles (the
// handle's edges only, gated on anchoring). Pure function — no DOM needed.

import { magnetizeMove } from './editor/js/ui/edit.js';

let failures = 0;
function eq(label, got, want) {
    const ok = got === want;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
    if (!ok) failures++;
}

const box = { x: 100, y: 200, w: 50, h: 40 };   // edges x:100/150/125, y:200/240/220
const TOL = 4;

// ---- body move (every edge + center translates) ----
{
    const m = magnetizeMove('body', box, 7, -3, { xs: [], ys: [] }, TOL);
    eq('body no targets: dx', m.dx, 7);
    eq('body no targets: dy', m.dy, -3);
}
{   // left edge 107 -> target 110 (adjust +3)
    const m = magnetizeMove('body', box, 7, 0, { xs: [110], ys: [] }, TOL);
    eq('body left-edge snap: dx', m.dx, 10);
}
{   // closest edge wins: right 152 -> target 150 (adjust -2)
    const m = magnetizeMove('body', box, 2, 0, { xs: [150], ys: [] }, TOL);
    eq('body closest-edge wins: dx', m.dx, 0);
}
{   // out of tolerance
    const m = magnetizeMove('body', box, 0, 0, { xs: [120], ys: [] }, TOL);  // center 125 is 5 away
    eq('body out-of-tol: dx unchanged', m.dx, 0);
}
{   // center snap: center 125 -> target 127 (+2)
    const m = magnetizeMove('body', box, 0, 0, { xs: [127], ys: [] }, TOL);
    eq('body center snap: dx', m.dx, 2);
}
{   // both axes independent
    const m = magnetizeMove('body', box, 7, 1, { xs: [110], ys: [240] }, TOL);
    eq('body both axes: dx', m.dx, 10);
    eq('body both axes: dy', m.dy, 0);
}

// ---- resize handles (only the handle's edges) ----
{   // 'e' (right edge): right 152 -> target 150 (-2). Left/center must NOT snap.
    const m = magnetizeMove('e', box, 2, 0, { xs: [150, 100], ys: [] }, TOL, { left: true, right: false });
    eq('resize e: right edge snaps, dx', m.dx, 0);
}
{   // 'e' must ignore a target near the LEFT edge (left isn't a handle edge).
    const m = magnetizeMove('e', box, 0, 0, { xs: [101], ys: [] }, TOL, { left: true });
    eq('resize e: left-edge target ignored, dx', m.dx, 0);
}
{   // 's' (bottom edge): bottom 241 -> target 240 (-1).
    const m = magnetizeMove('s', box, 0, 1, { xs: [], ys: [240] }, TOL, { top: true });
    eq('resize s: bottom edge snaps, dy', m.dy, 0);
}
{   // 'w' (left edge) WITH a left anchor: left 103 -> target 100 (-3).
    const m = magnetizeMove('w', box, 3, 0, { xs: [100], ys: [] }, TOL, { left: true });
    eq('resize w anchored: left edge snaps, dx', m.dx, 0);
}
{   // 'w' (left edge) with NO horizontal anchor: edge is pinned -> no snap.
    const m = magnetizeMove('w', box, 3, 0, { xs: [100], ys: [] }, TOL, { left: false, right: false });
    eq('resize w pinned: no snap, dx unchanged', m.dx, 3);
}
{   // 'se' corner: right + bottom both snap, independently.
    const m = magnetizeMove('se', box, 2, 1, { xs: [150], ys: [240] }, TOL, { left: true, top: true });
    eq('resize se: right dx', m.dx, 0);
    eq('resize se: bottom dy', m.dy, 0);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
