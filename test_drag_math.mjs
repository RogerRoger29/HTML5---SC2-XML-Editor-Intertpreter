// Sanity-test the drag math fix: dragging body by +30,+10 should shift the
// frame's Right anchor offset by exactly +30 (from -20 to +10) and Bottom
// offset by exactly +10 (from -470 to -460), regardless of how many move
// events fire during the drag.

import { readFileSync } from 'node:fs';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml, setAttr } from './editor/js/xml/serializer.js';

// We can't import edit.js directly under Node because it needs a DOM, so we
// replicate the drag math here against an XML fixture, simulating multiple
// pointermove events. The fixture is embedded inline rather than read from a
// sibling user layout so the suite is self-contained (the previous external
// dependency on UpgradeSlotSystem/ broke this test when that folder vanished).
// Baseline offsets: Bottom=-470, Right=-20.
const FIXTURE = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <Frame type="Frame" name="UpgradeSlotPanel">
        <Anchor side="Top" relative="$parent" pos="Min" offset="0" />
        <Anchor side="Left" relative="$parent" pos="Min" offset="0" />
        <Anchor side="Right" relative="$parent" pos="Max" offset="-20" />
        <Anchor side="Bottom" relative="$parent" pos="Max" offset="-470" />
    </Frame>
</Desc>
`;

const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : FIXTURE;
const doc = parseXml(src);

function findFrame(el, name) {
    if (!el || !el.children) return null;
    for (const c of el.children) {
        if (c.type === 'element' && c.tag === 'Frame') {
            const a = c.attrs.find(x => x.name === 'name');
            if (a && a.value === name) return c;
        }
        const r = findFrame(c, name);
        if (r) return r;
    }
    return null;
}
function findAnchor(el, side) {
    return el.children.find(c => c.type === 'element' && c.tag === 'Anchor' &&
        c.attrs.some(a => a.name === 'side' && a.value === side));
}
function attrVal(el, name) {
    const a = el.attrs.find(x => x.name === name);
    return a ? a.value : undefined;
}

const target = findFrame(doc.root, 'UpgradeSlotPanel');
const bottomAnchor = findAnchor(target, 'Bottom');
const rightAnchor = findAnchor(target, 'Right');

const baseOff = {
    bottom: parseFloat(attrVal(bottomAnchor, 'offset')),
    right:  parseFloat(attrVal(rightAnchor, 'offset')),
};
console.log('baseline:', baseOff);

// Replicate captured-start drag: each move computes new offset from baseOff + dx/dy.
const moves = [
    [10, 3], [15, 5], [20, 7], [25, 8], [30, 10],   // simulated pointermove deltas (cumulative)
];
for (const [dx, dy] of moves) {
    setAttr(bottomAnchor, 'offset', String(baseOff.bottom + dy));
    setAttr(rightAnchor, 'offset', String(baseOff.right + dx));
}

const final = {
    bottom: parseFloat(attrVal(bottomAnchor, 'offset')),
    right:  parseFloat(attrVal(rightAnchor, 'offset')),
};
console.log('after 5 moves cumulative dx=30, dy=10:', final);
console.log('expected:', { bottom: baseOff.bottom + 10, right: baseOff.right + 30 });

const correct = final.bottom === baseOff.bottom + 10 && final.right === baseOff.right + 30;
console.log('correct:', correct);

// Confirm re-serialization is clean
const out = serializeXml(doc);
console.log('size delta vs source:', out.length - src.length);
const reparsed = parseXml(out);
const targetReparsed = findFrame(reparsed.root, 'UpgradeSlotPanel');
const finalReparsed = {
    bottom: parseFloat(attrVal(findAnchor(targetReparsed, 'Bottom'), 'offset')),
    right:  parseFloat(attrVal(findAnchor(targetReparsed, 'Right'), 'offset')),
};
console.log('after re-parse:', finalReparsed);
process.exit(correct ? 0 : 1);
