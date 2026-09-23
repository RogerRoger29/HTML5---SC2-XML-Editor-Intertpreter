import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml } from './editor/js/xml/serializer.js';
import { makeElement } from './editor/js/xml/mutate.js';
import { appendFrameAtSelection, oneIndentDeeper } from './editor/js/authoring.js';

let failures = 0;
function check(label, condition) {
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
}

const skeleton = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
</Desc>
`;

check('indent helper preserves 2-space documents', oneIndentDeeper('\n  ') === '\n    ');
check('indent helper preserves tab documents', oneIndentDeeper('\n\t') === '\n\t\t');
check('indent helper does not double deep 4-space indentation',
    oneIndentDeeper('\n        ') === '\n            ');

{
    const doc = parseXml(skeleton);
    const button = makeElement('Frame', [['type', 'Button'], ['name', 'TopBarButton']], true);
    const result = appendFrameAtSelection(doc, {
        type: 'Frame',
        path: 'GameUI/UIContainer/FullscreenUpperContainer',
        synthetic: false,
        _modSource: null,
    }, button);
    const xml = serializeXml(doc);
    check('stock target creates a deep-path override', result.createdOverride);
    check('override targets the selected stock path',
        xml.includes('name="GameUI/UIContainer/FullscreenUpperContainer"'));
    check('new frame is nested inside the override',
        /FullscreenUpperContainer">[\s\S]*<Frame type="Button" name="TopBarButton"\/>[\s\S]*<\/Frame>/.test(xml));
    check('root override is indented', /\n    <Frame type="Frame"/.test(xml));
    check('override child is indented one level deeper', /\n        <Frame type="Button"/.test(xml));
    check('generated override is parse/serialize stable', serializeXml(parseXml(xml)) === xml);
}

{
    const doc = parseXml(`<?xml version="1.0"?><Desc>\n    <Frame type="Frame" name="Panel">\n    </Frame>\n</Desc>\n`);
    const panel = doc.root.children.find(node => node.type === 'element');
    const child = makeElement('Frame', [['type', 'Label'], ['name', 'Caption']], true);
    const result = appendFrameAtSelection(doc, {
        path: 'Panel', synthetic: false, _modSource: panel,
    }, child);
    const xml = serializeXml(doc);
    check('mod-backed target appends directly', !result.createdOverride);
    check('direct append does not create a path override', !xml.includes('name="Panel/'));
    check('direct child was inserted', xml.includes('name="Caption"'));
}

process.exitCode = failures ? 1 : 0;
