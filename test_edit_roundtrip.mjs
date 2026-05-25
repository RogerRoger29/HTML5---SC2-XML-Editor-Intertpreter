// Verify that mutating a single anchor offset round-trips cleanly: the only
// difference between the original source and the re-serialized output should
// be exactly the offset value we changed.

import { readFileSync } from 'node:fs';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml, setAttr } from './editor/js/xml/serializer.js';

const FILE = process.argv[2] || '../UpgradeSlotSystem/UpgradeSlotSystem.SC2Mod/Base.SC2Data/UI/Layout/UpgradeSlotPanel.SC2Layout';
const src = readFileSync(FILE, 'utf8');
const doc = parseXml(src);

// Find <Frame name="UpgradeSlotPanel"> in the doc.
const target = findFrame(doc.root, 'UpgradeSlotPanel');
if (!target) { console.error('UpgradeSlotPanel frame not found'); process.exit(1); }

// Find its Right anchor.
const rightAnchor = target.children.find(c =>
    c.type === 'element' && c.tag === 'Anchor' &&
    c.attrs.some(a => a.name === 'side' && a.value === 'Right'));
if (!rightAnchor) { console.error('Right anchor missing'); process.exit(1); }

const before = rightAnchor.attrs.find(a => a.name === 'offset').value;
setAttr(rightAnchor, 'offset', '-10');     // drag right by 10px
const after = rightAnchor.attrs.find(a => a.name === 'offset').value;

const out = serializeXml(doc);

// Count differences vs. original.
let diffs = 0, first = -1;
const n = Math.max(src.length, out.length);
for (let i = 0; i < n; i++) {
    if (src.charCodeAt(i) !== out.charCodeAt(i)) {
        if (first === -1) first = i;
        diffs++;
    }
}

console.log(`offset changed: "${before}" -> "${after}"`);
console.log(`source length:  ${src.length}`);
console.log(`output length:  ${out.length}`);
console.log(`size delta:     ${out.length - src.length}`);
console.log(`first diff at:  ${first}`);
console.log(`context around diff:`);
console.log('  source: ' + JSON.stringify(src.slice(Math.max(0, first - 40), first + 40)));
console.log('  output: ' + JSON.stringify(out.slice(Math.max(0, first - 40), first + 40)));

// Now re-parse the output and confirm it parses identically.
const doc2 = parseXml(out);
const target2 = findFrame(doc2.root, 'UpgradeSlotPanel');
const right2 = target2.children.find(c => c.type === 'element' && c.tag === 'Anchor' && c.attrs.some(a => a.name === 'side' && a.value === 'Right'));
const after2 = right2.attrs.find(a => a.name === 'offset').value;
console.log(`re-parse confirms offset: ${after2}`);

// Final: serialize again, should be byte-equal to first output (idempotent).
const out2 = serializeXml(doc2);
console.log(`idempotent re-serialize: ${out2 === out ? 'YES' : 'NO'}`);

function findFrame(el, name) {
    if (!el || !el.children) return null;
    for (const c of el.children) {
        if (c.type !== 'element') continue;
        if (c.tag === 'Frame') {
            const a = c.attrs.find(x => x.name === 'name');
            if (a && a.value === name) return c;
        }
        const r = findFrame(c, name);
        if (r) return r;
    }
    return null;
}
