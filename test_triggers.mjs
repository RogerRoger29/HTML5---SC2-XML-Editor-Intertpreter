import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml } from './editor/js/xml/serializer.js';
import {
    controlKindForType,
    defaultOptIn,
    generateTriggersXml,
    listNamedFrames,
    listRuntimeFrames,
    runtimeFramePath,
} from './editor/js/export/triggers.js';

let failures = 0;
function check(label, condition) {
    console.log(`${condition ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!condition) failures++;
}

const frames = [
    {
        name: 'Top Bar Button',
        path: 'GameUI/UIContainer/FullscreenUpperContainer/MyPanel/TopBarButton',
        type: 'Button',
        isButton: true,
    },
    {
        name: 'Top Bar Button',
        path: 'GameUI/UIContainer/FullscreenUpperContainer/MyPanel/OtherButton',
        type: 'Button',
        isButton: true,
    },
    {
        name: 'StatusImage',
        path: 'GameUI/UIContainer/FullscreenUpperContainer/MyPanel/StatusImage',
        type: 'Image',
        isButton: false,
    },
];

const xml = generateTriggersXml({
    modLibId: 'A1B2C3D4',
    idPrefix: 'C0DE',
    layoutPath: 'UI\\Layout\\My&Panel.SC2Layout',
    layoutName: '1 My Panel',
    frames,
    includePreload: true,
    includeClickHandlers: true,
});

check('generated trigger XML parses', !!parseXml(xml).root);
check('generated trigger XML round-trips unchanged', serializeXml(parseXml(xml)) === xml);
check('uses the verified PreloadLayout native', xml.includes('Library="Ntve" Id="D7E01477"'));
check('does not call a private Shepard function as a native', !xml.includes('Library="Ntve" Id="7DE42B33"'));
check('preload path is XML escaped', xml.includes('UI\\Layout\\My&amp;Panel.SC2Layout'));
check('creates control variables', /<VariableType>\s*<Type Value="control"\/>\s*<\/VariableType>/.test(xml));
check('initializes controls to invalid control', xml.includes('Library="Ntve" Id="FAC49C47"'));
check('hooks controls with HookupStandard', xml.includes('Library="Ntve" Id="CC29332F"'));
check('stores DialogControlLastCreated', xml.includes('Library="Ntve" Id="4AB42F83"'));
check('uses the current dialog-control event', xml.includes('Library="Ntve" Id="B5222B7D"'));
check('filters click events through EventDialogControl', xml.includes('Library="Ntve" Id="305EC1D4"'));
check('adds a condition to each button trigger', (xml.match(/<Condition Type="FunctionCall"/g) || []).length === 2);
check('uses the Button hookup preset', (xml.match(/Library="Ntve" Id="74C50A96"/g) || []).length === 2);
check('uses the Image hookup preset', (xml.match(/Library="Ntve" Id="79B4987E"/g) || []).length === 1);
check('removes the GameUI segment from runtime paths',
    xml.includes('<Value>UIContainer/FullscreenUpperContainer/MyPanel/TopBarButton</Value>'));
check('does not prefix runtime paths with the layout filename', !xml.includes('My Panel/GameUI/'));
check('deduplicates variable identifiers',
    xml.includes('<Identifier>Top_Bar_Button</Identifier>')
    && xml.includes('<Identifier>Top_Bar_Button_2</Identifier>'));
check('generated identifiers never start with a digit', xml.includes('<Identifier>Initialize_1_My_Panel</Identifier>'));

const elementIds = [...xml.matchAll(/<Element Type="[^"]+" Id="([0-9A-F]{8})"/g)].map(m => m[1]);
const idSet = new Set(elementIds);
const localRefs = [...xml.matchAll(/Library="A1B2C3D4" Id="([0-9A-F]{8})"/g)].map(m => m[1]);
check('every generated element ID is unique', elementIds.length === idSet.size);
check('every generated same-library reference resolves', localRefs.every(id => idSet.has(id)));

const noPreload = generateTriggersXml({
    modLibId: '10203040',
    idPrefix: 'BEEF',
    layoutPath: '',
    layoutName: 'AlreadyLoaded',
    frames: [frames[0]],
    includePreload: false,
    includeClickHandlers: false,
});
check('DescIndex mode omits PreloadLayout', !noPreload.includes('Library="Ntve" Id="D7E01477"'));
check('click-handler option can be disabled', !noPreload.includes('Library="Ntve" Id="B5222B7D"'));

check('runtime path normalizes slashes', runtimeFramePath('\\GameUI\\UIContainer//Panel') === 'UIContainer/Panel');
check('CheckBox uses its own control kind', controlKindForType('CheckBox') === 'CheckBox');
check('ProgressBar uses its own control kind', controlKindForType('ProgressBar') === 'ProgressBar');
check('unknown frame types safely use Panel hookup', controlKindForType('SomeCustomFrame') === 'Panel');

const layout = parseXml(`<?xml version="1.0"?>
<Desc>
    <Frame type="Frame" name="GameUI/UIContainer/FullscreenUpperContainer/MyPanel">
        <Frame type="Button" name="AddMe">
            <Frame type="Label" name="Label"/>
        </Frame>
        <Frame type="Button" name="HiddenButton">
            <Visible val="false"/>
        </Frame>
    </Frame>
    <Frame type="Frame" name="UnusedTemplate">
        <Frame type="Button" name="TemplateButton"/>
    </Frame>
    <Frame type="CheckBox" name="ConsentBox">
        <Frame type="Button" name="Button"/>
        <Frame type="Image" name="CheckImage"/>
    </Frame>
</Desc>`);
const listed = listNamedFrames(layout);
const addMe = listed.find(frame => frame.name === 'AddMe');
check('frame listing keeps complete deep paths',
    addMe?.path === 'GameUI/UIContainer/FullscreenUpperContainer/MyPanel/AddMe');
check('frame listing recognizes buttons', addMe?.isButton === true);
check('frame listing skips template frames', !listed.some(frame => frame.name === 'UnusedTemplate'));
check('buttons opt in by default', defaultOptIn(addMe) === true);
check('hidden placeholder buttons stay opt-out by default',
    defaultOptIn(listed.find(frame => frame.name === 'HiddenButton')) === false);
check('nested labels do not opt in by default',
    defaultOptIn(listed.find(frame => frame.name === 'Label')) === false);
check('composite CheckBox opts in by default',
    defaultOptIn(listed.find(frame => frame.name === 'ConsentBox')) === true);
check('internal CheckBox button stays opt-out by default',
    defaultOptIn(listed.find(frame => frame.path === 'ConsentBox/Button')) === false);

const runtimeListed = listRuntimeFrames([{
    type: 'Frame', name: 'TopBar', path: 'GameUI/TopBar', visible: true, children: [{
        type: 'CommandPanel', name: 'Panel', path: 'GameUI/TopBar/Panel', visible: true, children: [{
            type: 'CommandButton', name: 'InheritedButton',
            path: 'GameUI/TopBar/Panel/InheritedButton', visible: true, children: [],
        }, {
            type: 'CommandButton', name: 'HiddenPlaceholder',
            path: 'GameUI/TopBar/Panel/HiddenPlaceholder', visible: false, children: [],
        }],
    }],
}]);
check('runtime listing includes template-inherited controls at instantiated paths',
    runtimeListed.some(frame => frame.path === 'GameUI/TopBar/Panel/InheritedButton'));
check('runtime listing keeps hidden placeholders opt-out',
    defaultOptIn(runtimeListed.find(frame => frame.name === 'HiddenPlaceholder')) === false);

for (const bad of [
    { ...frames[0], path: '' },
]) {
    let threw = false;
    try {
        generateTriggersXml({
            modLibId: 'A1B2C3D4', idPrefix: 'C0DE', layoutPath: 'x', layoutName: 'x', frames: [bad],
        });
    } catch { threw = true; }
    check('rejects a selected frame without a runtime path', threw);
}

let emptyThrew = false;
try {
    generateTriggersXml({
        modLibId: 'A1B2C3D4', idPrefix: 'C0DE', layoutPath: 'x', layoutName: 'x', frames: [],
    });
} catch { emptyThrew = true; }
check('rejects an export with no selected frames', emptyThrew);

process.exitCode = failures ? 1 : 0;
