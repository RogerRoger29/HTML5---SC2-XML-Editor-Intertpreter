// Self-contained fixtures shared by the stock/merge tests. Keeping these
// in-repo avoids coupling the editor test suite to a separate mod directory.

export const MOD_LAYOUT = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<Desc>
    <Constant name="FixtureWidth" val="48"/>
    <Frame type="Button" name="SlotButtonTemplate">
        <Width val="#FixtureWidth"/>
        <Height val="32"/>
        <Frame type="Image" name="NormalImage">
            <Anchor relative="$parent" offset="0"/>
            <Texture val="@@@UI/HeroPanelButtonNormal"/>
        </Frame>
    </Frame>
    <Frame type="Button" name="SelectionButtonTemplate" template="SlotButtonTemplate">
        <Frame type="Label" name="Label">
            <Anchor relative="$parent" offset="0"/>
            <Text val="Choice"/>
        </Frame>
    </Frame>
    <Frame type="Frame" name="UpgradeSelectionPanel">
        <Frame type="Button" name="Choice0" template="FixtureLayout/SelectionButtonTemplate"/>
    </Frame>
    <Frame type="Frame" name="UpgradeSlotPanel">
        <Frame type="Button" name="Button0" template="FixtureLayout/SlotButtonTemplate"/>
    </Frame>
    <Frame type="Frame" name="GameUI/UIContainer/FullscreenUpperContainer/HeroPanel">
        <Frame type="Label" name="FixtureLabel">
            <Width val="100"/>
            <Height val="20"/>
            <Text val="Fixture"/>
        </Frame>
    </Frame>
</Desc>
`;

export function findByPath(nodes, wanted) {
    for (const node of nodes) {
        if (node.path === wanted) return node;
        const found = findByPath(node.children || [], wanted);
        if (found) return found;
    }
    return null;
}
