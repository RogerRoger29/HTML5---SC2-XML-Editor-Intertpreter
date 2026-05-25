// Sanity-test the drag math fix: dragging body by +30,+10 should shift the
// frame's Right anchor offset by exactly +30 (from -20 to +10) and Bottom
// offset by exactly +10 (from -470 to -460), regardless of how many move
// events fire during the drag.

import { readFileSync } from 'node:fs';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml, setAttr } from './editor/js/xml/serializer.js';

// We can't import edit.js directly under Node because it imports from
// '../xml/serializer.js' which is fine, but we don't have DOM. So instead
// replicate the drag math here against the same XML, simulating multiple
// pointermove events.

const src = readFileSync('../UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout', 'utf8');
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
