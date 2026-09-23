// v0.6.2: validator flags unresolved #constant references (typo'd / undefined
// constants), gated on stock being loaded to avoid false positives during the
// async stock-load window. validate(modDoc, registry) is pure.

import { validate } from './editor/js/validate.js';
import { StockRegistry } from './editor/js/stock.js';
import { parseXml } from './editor/js/xml/parser.js';

let failures = 0;
function check(label, cond) {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const layout = (val) => parseXml(
    `<?xml version="1.0"?>\n<Desc><Frame type="Frame" name="P"><Width val="${val}"/></Frame></Desc>\n`);

function regWith(consts, stockLoaded = true) {
    const r = new StockRegistry();
    for (const [k, v] of Object.entries(consts)) r.modConstants.set(k, v);
    if (stockLoaded) r.loadedFiles.add('core'); // mark stock as loaded (gate)
    return r;
}

const hasConstError = (results) =>
    results.some(w => w.severity === 'error' && /references constant/.test(w.message));

// 1. Unresolved #ref -> error.
{
    const out = validate(layout('#Missing'), regWith({}));
    check('unresolved #Missing flagged as error', hasConstError(out));
}

// 2. Resolvable #ref -> no const error.
{
    const out = validate(layout('#Defined'), regWith({ Defined: '42' }));
    check('resolvable #Defined: no const error', !hasConstError(out));
}

// 3. Chained #ref that ultimately resolves -> no error.
{
    const out = validate(layout('#A'), regWith({ A: '#B', B: '7' }));
    check('chained #A->#B->7: no const error', !hasConstError(out));
}

// 4. Gate: stock not loaded -> suppressed (no false positive during load).
{
    const out = validate(layout('#Missing'), regWith({}, /*stockLoaded=*/false));
    check('unresolved ref suppressed while stock not loaded', !hasConstError(out));
}

// 5. Plain numeric value -> no const error.
{
    const out = validate(layout('50'), regWith({}));
    check('numeric value: no const error', !hasConstError(out));
}

// 6. A copied layout whose filename no longer matches its self-template
// namespace gets a document-level warning.
{
    const doc = parseXml(`<?xml version="1.0"?>
<Desc>
    <Frame type="Button" name="ButtonTemplate"/>
    <Frame type="Frame" name="Screen">
        <Frame type="Button" name="UseIt" template="OriginalUI/ButtonTemplate"/>
    </Frame>
</Desc>
`);
    const out = validate(doc, regWith({}), { fileName: 'Renamed.SC2Layout' });
    check('renamed self-template namespace is warned',
        out.some(w => w.severity === 'warning' && /OriginalUI\.SC2Layout/.test(w.message)));
    const matching = validate(doc, regWith({}), { fileName: 'OriginalUI.SC2Layout' });
    check('matching self-template namespace is accepted',
        !matching.some(w => /namespaces templates/.test(w.message)));
}

// 7. A same-name child override inherits structural properties from the
// parent frame's template and must not be reported as an empty image.
{
    const doc = parseXml(`<?xml version="1.0"?>
<Desc>
    <Frame type="Frame" name="Base">
        <Frame type="Image" name="Glow"><Texture val="glow.dds"/></Frame>
    </Frame>
    <Frame type="Frame" name="Derived" template="Inherited/Base">
        <Frame type="Image" name="Glow"><TextureCoords top="0" left="1" bottom="1" right="0"/></Frame>
    </Frame>
</Desc>
`);
    const reg = regWith({});
    reg.addModTemplates(doc.root, 'Inherited');
    const out = validate(doc, reg, { fileName: 'Inherited.SC2Layout' });
    check('inherited child override is not flagged as missing Texture',
        !out.some(w => w.severity === 'warning' && w.framePath === 'Derived/Glow' && /no <Texture/.test(w.message)));
}

// 8. SC2 only defines CommanderAbility0 through CommanderAbility3. A fifth
// button may exist, but CommanderAbility4 makes the layout parser reject it.
{
    const invalid = parseXml(`<?xml version="1.0"?><Desc><Frame type="CommandButton" name="Fifth"><HotkeyUse val="CommanderAbility4"/></Frame></Desc>`);
    const invalidOut = validate(invalid, null);
    check('CommanderAbility4 is rejected',
        invalidOut.some(w => w.severity === 'error' && /Use CommandButton04/.test(w.message)));

    const valid = parseXml(`<?xml version="1.0"?><Desc><Frame type="CommandButton" name="Fourth"><HotkeyUse val="CommanderAbility3"/></Frame></Desc>`);
    const validOut = validate(valid, null);
    check('CommanderAbility3 remains valid',
        !validOut.some(w => /only defines CommanderAbility0/.test(w.message)));
}

// 9. General HotkeyUse validation catches parser-breaking IDs, empty values,
// slot mismatches, and accidental duplicates while accepting known IDs.
{
    const doc = parseXml(`<?xml version="1.0"?><Desc>
        <Frame type="Frame" name="Panel">
            <Frame type="CommandButton" name="CommandButton04"><HotkeyUse val="CommandButton05"/></Frame>
            <Frame type="CommandButton" name="Other"><HotkeyUse val="CommandButton05"/></Frame>
            <Frame type="CommandButton" name="Broken"><HotkeyUse val="MadeUpHotkey"/></Frame>
            <Frame type="CommandButton" name="Empty"><HotkeyUse/></Frame>
        </Frame>
    </Desc>`);
    const out = validate(doc, null);
    check('unknown HotkeyUse is rejected',
        out.some(w => w.severity === 'error' && /MadeUpHotkey.*not a recognized/.test(w.message)));
    check('empty HotkeyUse is rejected',
        out.some(w => w.severity === 'error' && /has no value/.test(w.message)));
    check('command-card slot mismatch is warned',
        out.some(w => w.severity === 'warning' && /belongs to command-card slot 6/.test(w.message)));
    check('duplicate sibling hotkeys are warned',
        out.some(w => w.severity === 'warning' && /both use HotkeyUse/.test(w.message)));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
