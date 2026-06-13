// Round 6 audit: verify CHAINED template inheritance.
// A frame using template "Derived", where Derived itself derives from "Base"
// (template="Base"), must inherit Base's children AND props, not just
// Derived's. Self-contained — no server needed.

import { StockRegistry } from './editor/js/stock.js';
import { MergedTree } from './editor/js/merge.js';
import { parseXml } from './editor/js/xml/parser.js';

let failures = 0;
function check(label, cond) {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const layout = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <Frame type="Frame" name="BaseTemplate">
        <Width val="50"/>
        <Frame type="Image" name="BaseImage">
            <Texture val="@@@base"/>
        </Frame>
    </Frame>
    <Frame type="Frame" name="DerivedTemplate" template="BaseTemplate">
        <Height val="30"/>
        <Frame type="Image" name="DerivedImage">
            <Texture val="@@@derived"/>
        </Frame>
    </Frame>
    <Frame type="Frame" name="Instance" template="DerivedTemplate"/>
</Desc>`;

const reg = new StockRegistry();
const doc = parseXml(layout);
reg.addModTemplates(doc.root, 'TestFile');

const tree = new MergedTree(reg);
tree.mergeMod(doc.root);
const frames = tree.asFrameList({ includeStock: true });

function findByName(nodes, name) {
    for (const n of nodes) {
        if (n.name === name) return n;
        const r = findByName(n.children || [], name);
        if (r) return r;
    }
    return null;
}

const inst = findByName(frames, 'Instance');
check('Instance materialized', !!inst);
if (inst) {
    const childNames = (inst.children || []).map(c => c.name);
    // From the directly-referenced (derived) template:
    check('inherits DerivedImage (direct template)', childNames.includes('DerivedImage'));
    // From the BASE template, reached via the chain — this is the fix:
    check('inherits BaseImage (chained base template)', childNames.includes('BaseImage'));
    // Props from both levels: Width from base, Height from derived.
    check('inherits Width=50 from base template', inst.width === 50);
    check('inherits Height=30 from derived template', inst.height === 30);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
