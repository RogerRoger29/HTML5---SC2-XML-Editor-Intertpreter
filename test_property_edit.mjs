// Guards the inspector's property-edit code paths (v0.5.4 Appearance + image
// properties). The inspector rows write through xml/mutate.js helpers +
// serializer setAttr; this test drives those helpers directly (no DOM needed)
// and asserts byte-clean, idempotent round-trips and minimal diffs — the same
// invariants the live inspector relies on.

import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml, setAttr } from './editor/js/xml/serializer.js';
import {
    makeElement, appendChildPreservingIndent, removeChildAndWhitespace,
} from './editor/js/xml/mutate.js';
import { findChild, attrVal } from './editor/js/xml/helpers.js';

const FIXTURE = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <Frame type="Image" name="Icon">
        <Anchor relative="$parent" offset="0"/>
        <Texture val="@@@UI/HeroPanelButtonNormal"/>
    </Frame>
</Desc>
`;

let failures = 0;
function check(label, cond) {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

function getFrame(doc) {
    return doc.root.children.find(c => c.type === 'element' && c.tag === 'Frame');
}

// --- 1. Add a self-closing property child (Alpha), as _writeSizedChild does.
{
    const doc = parseXml(FIXTURE);
    const frame = getFrame(doc);
    appendChildPreservingIndent(frame, makeElement('Alpha', [['val', '128']], true));
    const out = serializeXml(doc);
    check('Alpha element added', out.includes('<Alpha val="128"/>'));
    // Indentation: the new child should sit at the same 8-space indent as
    // its siblings (inferred from the Texture line above it).
    check('Alpha indented like siblings', /\n        <Alpha val="128"\/>/.test(out));
    // Idempotent: parse + re-serialize is stable.
    check('Alpha add idempotent', serializeXml(parseXml(out)) === out);
    // Re-parse sees the value.
    check('Alpha re-parses', attrVal(findChild(getFrame(parseXml(out)), 'Alpha'), 'val') === '128');
}

// --- 2. Add a multi-attribute child (TextureCoords), as _textureCoordsRow does.
{
    const doc = parseXml(FIXTURE);
    const frame = getFrame(doc);
    appendChildPreservingIndent(frame, makeElement('TextureCoords',
        [['left', '0.25'], ['top', '0.25'], ['right', '0.75'], ['bottom', '0.75']], true));
    const out = serializeXml(doc);
    check('TextureCoords added with all 4 attrs',
        out.includes('<TextureCoords left="0.25" top="0.25" right="0.75" bottom="0.75"/>'));
    check('TextureCoords add idempotent', serializeXml(parseXml(out)) === out);
}

// --- 3. Update an existing attribute (setAttr) = minimal diff.
{
    const doc = parseXml(FIXTURE);
    const frame = getFrame(doc);
    const tex = findChild(frame, 'Texture');
    setAttr(tex, 'val', '@@@UI/HeroPanelButtonHover');
    const out = serializeXml(doc);
    check('Texture value updated', out.includes('val="@@@UI/HeroPanelButtonHover"'));
    // Only the value changed: the rest of the doc is identical length-wise
    // apart from the value substitution.
    const expected = FIXTURE.replace('@@@UI/HeroPanelButtonNormal', '@@@UI/HeroPanelButtonHover');
    check('Texture update is a minimal diff', out === expected);
}

// --- 4. Remove a child (removeChildAndWhitespace) leaves no double blank line.
{
    const doc = parseXml(FIXTURE);
    const frame = getFrame(doc);
    // Add then remove Alpha; result must equal the original fixture exactly.
    appendChildPreservingIndent(frame, makeElement('Alpha', [['val', '128']], true));
    const withAlpha = serializeXml(doc);
    const frame2 = getFrame(doc);
    removeChildAndWhitespace(frame2, findChild(frame2, 'Alpha'));
    const out = serializeXml(doc);
    check('Add-then-remove restores original byte-for-byte', out === FIXTURE);
    check('removed Alpha is gone', !out.includes('Alpha'));
    check('intermediate had Alpha', withAlpha.includes('Alpha'));
}

// --- 5. Boolean default-elision: writing the implicit default removes element.
//        (_boolRow removes <Visible> when set back to true.)
{
    const doc = parseXml(FIXTURE);
    const frame = getFrame(doc);
    appendChildPreservingIndent(frame, makeElement('Visible', [['val', 'false']], true));
    let out = serializeXml(doc);
    check('Visible=false written', out.includes('<Visible val="false"/>'));
    const frame2 = getFrame(doc);
    removeChildAndWhitespace(frame2, findChild(frame2, 'Visible'));
    out = serializeXml(doc);
    check('Visible removed on return-to-default', out === FIXTURE);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
