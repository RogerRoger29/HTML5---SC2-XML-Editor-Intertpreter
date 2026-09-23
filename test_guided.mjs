import assert from 'node:assert/strict';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml } from './editor/js/xml/serializer.js';
import { attrVal } from './editor/js/xml/helpers.js';
import {
    addMatchingButton,
    analyzeButtonRow,
    buildReadinessSummary,
    duplicateFrameBeside,
    extendMengskTopBar,
    growFrameToChildren,
    nudgeFrame,
    nextSequentialName,
    resizeFrame,
    setFrameVisibility,
} from './editor/js/guided.js';

const xml = `<?xml version="1.0"?>
<Desc>
    <Frame type="Frame" name="MengskTopBar">
        <Frame type="Image" name="Background">
            <Anchor side="Left" relative="$parent" pos="Mid" offset="0"/>
            <Anchor side="Right" relative="$parent" pos="Mid" offset="0"/>
            <Width val="744"/>
            <Height val="176"/>
        </Frame>
        <Frame type="Frame" name="MengskGlobalCommandPanel">
            <Frame type="CommandButton" name="CommandButton00" template="Coop_TopBar_Mengsk/MengskCommandButtonTemplate">
                <Anchor side="Left" relative="$parent" pos="Mid" offset="-265"/>
                <Anchor side="Right" relative="$parent" pos="Mid" offset="-265"/>
                <HotkeyUse val="CommanderAbility0"/>
            </Frame>
            <Frame type="CommandButton" name="CommandButton01" template="Coop_TopBar_Mengsk/MengskCommandButtonTemplate">
                <Anchor side="Left" relative="$parent" pos="Mid" offset="-188"/>
                <Anchor side="Right" relative="$parent" pos="Mid" offset="-188"/>
                <HotkeyUse val="CommanderAbility1"/>
            </Frame>
            <Frame type="CommandButton" name="CommandButton02" template="Coop_TopBar_Mengsk/MengskCommandButtonTemplate">
                <Anchor side="Left" relative="$parent" pos="Mid" offset="188"/>
                <Anchor side="Right" relative="$parent" pos="Mid" offset="188"/>
                <HotkeyUse val="CommanderAbility2"/>
            </Frame>
            <Frame type="CommandButton" name="CommandButton03" template="Coop_TopBar_Mengsk/MengskCommandButtonTemplate">
                <Anchor side="Left" relative="$parent" pos="Mid" offset="265"/>
                <Anchor side="Right" relative="$parent" pos="Mid" offset="265"/>
                <HotkeyUse val="CommanderAbility3"/>
            </Frame>
            <Frame type="CommandButton" name="CommandButton04" template="CommandButton/CommandButtonTemplate">
                <Visible val="false"/>
            </Frame>
        </Frame>
    </Frame>
</Desc>
`;

function setParents(node, parent = null) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'element' && parent) node._parent = parent;
    for (const child of node.children || []) setParents(child, node.type === 'element' ? node : parent);
}

const doc = parseXml(xml);
setParents(doc);
const topSource = doc.root.children.find(node => node.type === 'element');
const panelSource = topSource.children.find(node => node.type === 'element' && attrVal(node, 'name') === 'MengskGlobalCommandPanel');
const buttonSources = panelSource.children.filter(node => node.type === 'element');
const top = { type: 'Frame', name: 'MengskTopBar', path: 'MengskTopBar', x: 588, y: 0, w: 744, h: 176, _modSource: topSource, children: [], parent: null };
const panel = { type: 'Frame', name: 'MengskGlobalCommandPanel', path: 'MengskTopBar/MengskGlobalCommandPanel', x: 588, y: 0, w: 744, h: 176, _modSource: panelSource, children: [], parent: top };
top.children.push({ type: 'Image', name: 'Background', path: 'MengskTopBar/Background', x: 588, y: 0, w: 744, h: 176, children: [], parent: top });
top.children.push(panel);
const centers = [695, 772, 1148, 1225, 0];
for (let i = 0; i < buttonSources.length; i++) {
    panel.children.push({
        type: 'CommandButton',
        name: `CommandButton0${i}`,
        path: `MengskTopBar/MengskGlobalCommandPanel/CommandButton0${i}`,
        x: centers[i] - 38, y: 4, w: 76, h: 76,
        _modSource: buttonSources[i], children: [], parent: panel,
    });
}

assert.equal(nextSequentialName(['Button00', 'Button01', 'Button03'], 'Button03'), 'Button04');
const plan = analyzeButtonRow(panel.children[3]);
assert.equal(plan.ok, true);
assert.equal(plan.axis, 'x');
assert.equal(plan.step, 77);
assert.equal(plan.name, 'CommandButton04');

const added = addMatchingButton(panel.children[3]);
assert.equal(added.name, 'CommandButton04');
assert.equal(added.hotkey, null);
assert.equal(added.hotkeyOmitted, true);
assert.equal(added.reusedExisting, true, 'hidden placeholder should be rebuilt instead of duplicated');
const addedAnchors = added.clone.children.filter(node => node.type === 'element' && node.tag === 'Anchor');
assert.deepEqual(addedAnchors.map(anchor => attrVal(anchor, 'offset')), ['342', '342']);

const art = extendMengskTopBar(panel.children[3], 5);
assert.equal(art.applied, true);
assert.equal(art.width, 160);
assert.equal(art.right, 452);
const out = serializeXml(doc);
assert.match(out, /name="CommandButton04"/);
assert.doesNotMatch(out, /CommanderAbility4/);
assert.match(out, /name="BackgroundRightExtension"/);
assert.match(out, /<Width val="160"\/>/);
assert.equal(serializeXml(parseXml(out)), out, 'guided edit should be parse/serialize stable');

const overflowButton = { type: 'Button', name: 'Outside', path: 'Panel/Outside', x: 140, y: 0, w: 40, h: 40, synthetic: false, isTemplate: false, children: [], parent: null };
const background = { type: 'Image', name: 'Background', path: 'Panel/Background', x: 0, y: 0, w: 100, h: 60, children: [], parent: null };
const readinessParent = { type: 'Frame', name: 'Panel', path: 'Panel', x: 0, y: 0, w: 200, h: 100, children: [background, overflowButton], parent: null };
background.parent = readinessParent;
overflowButton.parent = readinessParent;
const readiness = buildReadinessSummary({ frames: [readinessParent], assetsConfigured: true });
assert.equal(readiness.ready, true);
assert.equal(readiness.visualWarnings.length, 1);
assert.equal(readiness.runtimeReadyCount, 1);

const genericDoc = parseXml(`<?xml version="1.0"?><Desc>\n    <Frame type="Frame" name="Panel0">\n        <Anchor side="Top" relative="$parent" pos="Min" offset="10"/>\n        <Anchor side="Left" relative="$parent" pos="Min" offset="20"/>\n        <Width val="100"/>\n        <Height val="80"/>\n    </Frame>\n</Desc>\n`);
setParents(genericDoc);
const genericSource = genericDoc.root.children.find(node => node.type === 'element');
const genericParentFrame = { path: '', children: [] };
const genericFrame = {
    type: 'Frame', name: 'Panel0', path: 'Panel0', x: 20, y: 10, w: 100, h: 80,
    _modSource: genericSource, parent: genericParentFrame,
    children: [{ x: 30, y: 20, w: 140, h: 90, visible: true }],
};
const duplicate = duplicateFrameBeside(genericFrame);
assert.equal(duplicate.name, 'Panel1');
assert.match(serializeXml(genericDoc), /name="Panel1"/);
nudgeFrame(genericFrame, 8, -8);
assert.match(serializeXml(genericDoc), /side="Top"[^>]*offset="2"/);
assert.match(serializeXml(genericDoc), /side="Left"[^>]*offset="28"/);
resizeFrame(genericFrame, 120, 90);
assert.match(serializeXml(genericDoc), /<Width val="120"\/>/);
setFrameVisibility(genericFrame, false);
assert.match(serializeXml(genericDoc), /<Visible val="false"\/>/);
const grown = growFrameToChildren(genericFrame, 8);
assert.equal(grown.width, 158);
assert.equal(grown.height, 108);

console.log('ALL PASS');
