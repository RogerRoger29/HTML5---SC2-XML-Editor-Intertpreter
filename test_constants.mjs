// v0.6.0: a mod's own <Constant> definitions must register so the layout
// engine resolves the mod's `#MyConst` references (Width/Height/offset/etc.).
// Previously only stock constants were in the table, so a mod constant stayed
// unresolved and its frame got no size. Self-contained — no server.

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
    <Constant name="MyW" val="42"/>
    <Constant name="AliasW" val="#MyW"/>
    <Frame type="Frame" name="Panel">
        <Width val="#MyW"/>
        <Height val="#AliasW"/>
    </Frame>
</Desc>`;

const reg = new StockRegistry();
const doc = parseXml(layout);
const n = reg.addModConstants(doc.root);
check('addModConstants registered 2 constants', n === 2);

// Direct resolution.
check('resolveValue("#MyW") === "42"', reg.resolveValue('#MyW') === '42');
check('chained resolveValue("#AliasW") === "42"', reg.resolveValue('#AliasW') === '42');
check('unknown constant left verbatim', reg.resolveValue('#Nope') === '#Nope');

// End-to-end: the frame's Width="#MyW" materializes to a numeric 42.
const tree = new MergedTree(reg);
tree.mergeMod(doc.root);
const frames = tree.asFrameList({ includeStock: true });
const panel = frames.find(f => f.name === 'Panel');
check('Panel materialized', !!panel);
if (panel) {
    check('Width "#MyW" resolved to 42', panel.width === 42);
    check('Height "#AliasW" chained-resolved to 42', panel.height === 42);
}

// Mod constants land in the separate modConstants map, not stock.
check('mod constants stored separately from stock', reg.modConstants.has('MyW') && !reg.constants.has('MyW'));

// Mod overrides stock on name collision (mod is the active document).
const reg2 = new StockRegistry();
reg2.constants.set('Shared', '10');     // simulate a stock constant
reg2.addModConstants(parseXml('<Desc><Constant name="Shared" val="99"/></Desc>').root);
check('mod constant overrides stock on collision', reg2.resolveValue('#Shared') === '99');

// Opening a DIFFERENT file replaces the mod constants - no stale leak from the
// previously-open file (the bug the audit caught).
reg.addModConstants(parseXml('<Desc><Constant name="Other" val="5"/></Desc>').root);
check('reopening drops prior file mod constants', reg.resolveValue('#MyW') === '#MyW');
check('reopening keeps new file mod constants', reg.resolveValue('#Other') === '5');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
