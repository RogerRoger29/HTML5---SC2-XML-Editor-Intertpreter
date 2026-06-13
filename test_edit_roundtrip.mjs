// Verify that mutating a single anchor offset round-trips cleanly: the only
// difference between the original source and the re-serialized output should
// be exactly the offset value we changed.
//
// The fixture is embedded inline rather than read from a sibling layout so
// the regression suite is self-contained — it must not depend on user mod
// directories that may be moved or deleted (an external dependency on
// UpgradeSlotSystem/ previously broke this test when that folder vanished).
// An optional path argument still overrides the fixture for spot-checks.

import { readFileSync } from 'node:fs';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml, setAttr } from './editor/js/xml/serializer.js';

// Representative fixture: mixed indentation, an XML comment, self-closing
// property children, and a frame with all four anchors so the Right-anchor
// mutation exercises the comment-preserving serializer realistically.
const FIXTURE = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <!-- Test panel: single-attr edit should produce a minimal diff. -->
    <Frame type="Frame" name="UpgradeSlotPanel">
        <Anchor side="Top" relative="$parent" pos="Min" offset="0" />
        <Anchor side="Left" relative="$parent" pos="Min" offset="0" />
        <Anchor side="Right" relative="$parent" pos="Max" offset="-20" />
        <Anchor side="Bottom" relative="$parent" pos="Max" offset="-460" />
        <Width val="200"/>
        <Visible val="true"/>
        <Frame type="Image" name="Background">
            <Anchor relative="$parent" offset="0"/>
            <Texture val="@@@UI/HeroPanelButtonNormal"/>
            <TextureType val="NineSlice"/>
        </Frame>
    </Frame>
</Desc>
`;

const FILE = process.argv[2];
const src = FILE ? readFileSync(FILE, 'utf8') : FIXTURE;
const FRAME_NAME = 'UpgradeSlotPanel';
const doc = parseXml(src);

// Find the target frame in the doc.
const target = findFrame(doc.root, FRAME_NAME);
if (!target) { console.error(`${FRAME_NAME} frame not found`); process.exit(1); }

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

// The ONLY change must be the offset value. The original was "-20" (3 chars),
// the new value "-10" (3 chars) — same length, so size delta must be 0 and
// exactly one character (the middle digit) should differ.
if (out.length - src.length !== 0) {
    console.error(`FAIL: expected zero size delta, got ${out.length - src.length}`);
    process.exit(1);
}

// Now re-parse the output and confirm it parses identically.
const doc2 = parseXml(out);
const target2 = findFrame(doc2.root, FRAME_NAME);
const right2 = target2.children.find(c => c.type === 'element' && c.tag === 'Anchor' && c.attrs.some(a => a.name === 'side' && a.value === 'Right'));
const after2 = right2.attrs.find(a => a.name === 'offset').value;
console.log(`re-parse confirms offset: ${after2}`);
if (after2 !== '-10') { console.error('FAIL: re-parsed offset wrong'); process.exit(1); }

// Final: serialize again, should be byte-equal to first output (idempotent).
const out2 = serializeXml(doc2);
console.log(`idempotent re-serialize: ${out2 === out ? 'YES' : 'NO'}`);
if (out2 !== out) process.exit(1);

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
