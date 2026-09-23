// Triggers XML export for layouts authored by the SC2 UI Editor.
//
// The generated library follows patterns verified against working SC2 5.0.15
// Triggers files and their generated Galaxy:
//   PreloadLayout(path, false)
//   DialogControlHookupStandard(controlType, runtimePath)
//   variable = DialogControlLastCreated()
//   TriggerAddEventDialogControl(AnyPlayer, invalidControl, Clicked)
//   EventDialogControl() == variable
//
// The click event deliberately listens for any clicked control and filters in
// a condition. That is how current SC2 trigger data targets a control variable;
// the older string/bang-name event form does not bind a generated variable.

import { attrVal, findChild } from '../xml/helpers.js';

// Native IDs verified against working trigger data. Keep the IDs beside their
// Galaxy meaning because opaque trigger IDs are very easy to misidentify.
const NT = Object.freeze({
    MAP_INIT_EVENT: '00000120',
    PRELOAD_LAYOUT: 'D7E01477',
    PRELOAD_WAIT_PARAM: 'D1D868EF',
    PRELOAD_WAIT_FALSE: '6B259A53',
    PRELOAD_PATH_PARAM: '2A7DE667',

    HOOKUP_STANDARD: 'CC29332F',
    HOOKUP_TYPE_PARAM: '06C1424C',
    HOOKUP_PATH_PARAM: 'AEF92396',
    LAST_CREATED_CONTROL: '4AB42F83',

    SET_VARIABLE: '00000136',
    SET_VARIABLE_TARGET_PARAM: '00000219',
    SET_VARIABLE_VALUE_PARAM: '00000220',
    INVALID_CONTROL: 'FAC49C47',

    DIALOG_CONTROL_EVENT: 'B5222B7D',
    EVENT_PLAYER_PARAM: '47F2C8FB',
    EVENT_ANY_PLAYER: '2999701E',
    EVENT_CONTROL_PARAM: '01D07B8F',
    EVENT_INVALID_CONTROL: 'F13E3BA1',
    EVENT_TYPE_PARAM: 'B371ABF2',
    EVENT_CLICKED: '9D6C743C',

    COMPARE: 'C439C375',
    COMPARE_LEFT_PARAM: 'ABB380C4',
    COMPARE_OPERATOR_PARAM: '51567265',
    COMPARE_EQUALS: '1E7A4625',
    COMPARE_RIGHT_PARAM: '4A15EC5F',
    EVENT_DIALOG_CONTROL: '305EC1D4',
});

// Preset IDs used by DialogControlHookup(Standard). These were cross-checked
// against the emitted Galaxy constants in shipped and user-created mods.
const CONTROL_PRESETS = Object.freeze({
    Panel: '67A829E2',
    Button: '74C50A96',
    Image: '79B4987E',
    Label: 'C4F1C285',
    EditBox: 'C9CE1C26',
    Portrait: '24F29C4B',
    ProgressBar: 'AF8D75E2',
    CheckBox: 'F4330888',
    Pulldown: 'B00C6C43',
    ListBox: '24F885F0',
    Slider: 'CADAC0CE',
});

/** Return the trigger control kind SC2 expects for a layout frame type. */
export function controlKindForType(type) {
    const value = String(type || 'Frame');
    if (/CheckBox/i.test(value)) return 'CheckBox';
    if (/Button/i.test(value)) return 'Button';
    if (/EditBox/i.test(value)) return 'EditBox';
    if (/ListBox/i.test(value)) return 'ListBox';
    if (/Pulldown|ComboBox/i.test(value)) return 'Pulldown';
    if (/Slider|ScrollBar/i.test(value)) return 'Slider';
    if (/ProgressBar|StatusBar/i.test(value)) return 'ProgressBar';
    if (/Portrait/i.test(value)) return 'Portrait';
    if (/Label|Text/i.test(value)) return 'Label';
    if (/Image/i.test(value)) return 'Image';
    return 'Panel';
}

/** Runtime paths are rooted at GameUI, but HookupStandard omits that segment. */
export function runtimeFramePath(path) {
    return String(path || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^GameUI\//i, '')
        .replace(/\/{2,}/g, '/');
}

/** Generate a complete TriggerData document containing one library. */
export function generateTriggersXml(opts) {
    const {
        modLibId,
        idPrefix,
        layoutPath,
        layoutName,
        frames,
        categoryName = 'UI Initialization generated',
        includePreload = true,
        includeClickHandlers = true,
    } = opts;
    if (!/^[0-9A-Fa-f]{8}$/.test(modLibId)) {
        throw new Error(`modLibId must be 8 hex chars; got "${modLibId}"`);
    }
    if (!/^[0-9A-Fa-f]{1,6}$/.test(idPrefix)) {
        throw new Error(`idPrefix must be 1-6 hex chars; got "${idPrefix}"`);
    }
    if (includePreload && !String(layoutPath || '').trim()) throw new Error('layoutPath is required');
    if (!Array.isArray(frames) || frames.length === 0) {
        throw new Error('select at least one frame to export');
    }

    const lib = modLibId.toUpperCase();
    const minter = makeIdMinter(idPrefix);
    const idCategory = minter.next();
    const idInitTrigger = minter.next();
    const idInitEvent = minter.next();
    const idPreloadCall = minter.next();
    const idPreloadWaitParam = minter.next();
    const idPreloadPathParam = minter.next();

    const usedIdents = new Set();
    const uniqueIdent = (name) => {
        const base = toIdent(name);
        let ident = base;
        let n = 2;
        while (usedIdents.has(ident.toLowerCase())) ident = `${base}_${n++}`;
        usedIdents.add(ident.toLowerCase());
        return ident;
    };

    const frameRecords = frames.map((frame) => {
        const controlKind = controlKindForType(frame.type);
        const rec = {
            ...frame,
            ident: uniqueIdent(frame.name),
            runtimePath: runtimeFramePath(frame.path),
            controlKind,
            controlPreset: CONTROL_PRESETS[controlKind],
            idVariable: minter.next(),
            idVariableDefault: minter.next(),
            idHookCall: minter.next(),
            idHookTypeParam: minter.next(),
            idHookPathParam: minter.next(),
            idSetCall: minter.next(),
            idSetVarParam: minter.next(),
            idSetValueParam: minter.next(),
            idLastCreatedCall: minter.next(),
        };
        if (!rec.runtimePath) throw new Error(`frame "${frame.name}" has no runtime path`);
        if (includeClickHandlers && frame.isButton) {
            Object.assign(rec, {
                idClickTrigger: minter.next(),
                idClickEvent: minter.next(),
                idClickPlayerParam: minter.next(),
                idClickControlParam: minter.next(),
                idClickTypeParam: minter.next(),
                idClickCondition: minter.next(),
                idConditionLeftParam: minter.next(),
                idConditionOperatorParam: minter.next(),
                idConditionRightParam: minter.next(),
                idEventControlCall: minter.next(),
                idClickStubComment: minter.next(),
            });
        }
        return rec;
    });

    const enc = (value) => String(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const ref = (type, id) => `Type="${type}" Library="${lib}" Id="${id}"`;
    const lines = [];

    lines.push('<?xml version="1.0" encoding="utf-8"?>');
    lines.push('<TriggerData>');
    lines.push(`    <Library Id="${lib}">`);
    lines.push('        <Root>');
    lines.push(`            <Item ${ref('Category', idCategory)}/>`);
    lines.push('        </Root>');
    lines.push('');

    lines.push(`        <Element Type="Category" Id="${idCategory}">`);
    lines.push(`            <Identifier>${enc(toIdent(categoryName))}</Identifier>`);
    lines.push(`            <Item ${ref('Trigger', idInitTrigger)}/>`);
    for (const frame of frameRecords) lines.push(`            <Item ${ref('Variable', frame.idVariable)}/>`);
    for (const frame of frameRecords) {
        if (frame.idClickTrigger) lines.push(`            <Item ${ref('Trigger', frame.idClickTrigger)}/>`);
    }
    lines.push('        </Element>');
    lines.push('');

    // Global dialog-control variables start at c_invalidDialogControlId.
    for (const frame of frameRecords) {
        lines.push(`        <Element Type="Variable" Id="${frame.idVariable}">`);
        lines.push(`            <Identifier>${enc(frame.ident)}</Identifier>`);
        lines.push('            <VariableType>');
        lines.push('                <Type Value="control"/>');
        lines.push('            </VariableType>');
        lines.push(`            <Value ${ref('Param', frame.idVariableDefault)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idVariableDefault}">`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.INVALID_CONTROL}"/>`);
        lines.push('        </Element>');
        lines.push('');
    }

    // Map init preloads the layout, hooks each runtime frame, and stores the
    // resulting control returned by DialogControlLastCreated().
    lines.push(`        <Element Type="Trigger" Id="${idInitTrigger}">`);
    lines.push(`            <Identifier>${enc(toIdent(`Initialize_${layoutName}`))}</Identifier>`);
    lines.push(`            <Event ${ref('FunctionCall', idInitEvent)}/>`);
    if (includePreload) lines.push(`            <Action ${ref('FunctionCall', idPreloadCall)}/>`);
    for (const frame of frameRecords) {
        lines.push(`            <Action ${ref('FunctionCall', frame.idHookCall)}/>`);
        lines.push(`            <Action ${ref('FunctionCall', frame.idSetCall)}/>`);
    }
    lines.push('        </Element>');
    lines.push('');

    lines.push(`        <Element Type="FunctionCall" Id="${idInitEvent}">`);
    lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.MAP_INIT_EVENT}"/>`);
    lines.push('        </Element>');
    lines.push('');

    if (includePreload) {
        lines.push(`        <Element Type="FunctionCall" Id="${idPreloadCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.PRELOAD_LAYOUT}"/>`);
        lines.push(`            <Parameter ${ref('Param', idPreloadWaitParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', idPreloadPathParam)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${idPreloadWaitParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.PRELOAD_WAIT_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.PRELOAD_WAIT_FALSE}"/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${idPreloadPathParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.PRELOAD_PATH_PARAM}"/>`);
        lines.push(`            <Value>${enc(layoutPath)}</Value>`);
        lines.push('            <ValueType Type="filepath"/>');
        lines.push('            <ValueTypeInfo Value="6"/>');
        lines.push('        </Element>');
        lines.push('');
    }

    for (const frame of frameRecords) {
        lines.push(`        <Element Type="FunctionCall" Id="${frame.idHookCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.HOOKUP_STANDARD}"/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idHookTypeParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idHookPathParam)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idHookTypeParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.HOOKUP_TYPE_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${frame.controlPreset}"/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idHookPathParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.HOOKUP_PATH_PARAM}"/>`);
        lines.push(`            <Value>${enc(frame.runtimePath)}</Value>`);
        lines.push('            <ValueType Type="string"/>');
        lines.push('        </Element>');

        lines.push(`        <Element Type="FunctionCall" Id="${frame.idSetCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.SET_VARIABLE}"/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idSetVarParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idSetValueParam)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idSetVarParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.SET_VARIABLE_TARGET_PARAM}"/>`);
        lines.push(`            <Variable ${ref('Variable', frame.idVariable)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idSetValueParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.SET_VARIABLE_VALUE_PARAM}"/>`);
        lines.push(`            <FunctionCall ${ref('FunctionCall', frame.idLastCreatedCall)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="FunctionCall" Id="${frame.idLastCreatedCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.LAST_CREATED_CONTROL}"/>`);
        lines.push('        </Element>');
        lines.push('');
    }

    for (const frame of frameRecords) {
        if (!frame.idClickTrigger) continue;
        lines.push(`        <Element Type="Trigger" Id="${frame.idClickTrigger}">`);
        lines.push(`            <Identifier>${enc(toIdent(`On_${frame.ident}_Clicked`))}</Identifier>`);
        lines.push(`            <Event ${ref('FunctionCall', frame.idClickEvent)}/>`);
        lines.push(`            <Condition ${ref('FunctionCall', frame.idClickCondition)}/>`);
        lines.push(`            <Action ${ref('Comment', frame.idClickStubComment)}/>`);
        lines.push('        </Element>');
        lines.push('');

        lines.push(`        <Element Type="FunctionCall" Id="${frame.idClickEvent}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.DIALOG_CONTROL_EVENT}"/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idClickPlayerParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idClickControlParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idClickTypeParam)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idClickPlayerParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.EVENT_PLAYER_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.EVENT_ANY_PLAYER}"/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idClickControlParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.EVENT_CONTROL_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.EVENT_INVALID_CONTROL}"/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idClickTypeParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.EVENT_TYPE_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.EVENT_CLICKED}"/>`);
        lines.push('        </Element>');

        // EventDialogControl() == generated control variable.
        lines.push(`        <Element Type="FunctionCall" Id="${frame.idClickCondition}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.COMPARE}"/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idConditionLeftParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idConditionOperatorParam)}/>`);
        lines.push(`            <Parameter ${ref('Param', frame.idConditionRightParam)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idConditionLeftParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.COMPARE_LEFT_PARAM}"/>`);
        lines.push(`            <FunctionCall ${ref('FunctionCall', frame.idEventControlCall)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idConditionOperatorParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.COMPARE_OPERATOR_PARAM}"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="${NT.COMPARE_EQUALS}"/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="Param" Id="${frame.idConditionRightParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="${NT.COMPARE_RIGHT_PARAM}"/>`);
        lines.push(`            <Variable ${ref('Variable', frame.idVariable)}/>`);
        lines.push('        </Element>');
        lines.push(`        <Element Type="FunctionCall" Id="${frame.idEventControlCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="${NT.EVENT_DIALOG_CONTROL}"/>`);
        lines.push('        </Element>');

        lines.push(`        <Element Type="Comment" Id="${frame.idClickStubComment}">`);
        lines.push(`            <Comment>TODO: implement ${enc(frame.name)} click handler.</Comment>`);
        lines.push('        </Element>');
        lines.push('');
    }

    lines.push('    </Library>');
    lines.push('</TriggerData>');
    return lines.join('\n');
}

function makeIdMinter(prefix) {
    const padLen = 8 - prefix.length;
    const max = Math.pow(16, padLen) - 1;
    let n = 0;
    return {
        next() {
            n++;
            if (n > max) throw new Error(`ran out of ${padLen}-digit IDs under prefix "${prefix}"`);
            return prefix.toUpperCase() + n.toString(16).toUpperCase().padStart(padLen, '0');
        },
    };
}

function toIdent(value) {
    let ident = String(value || '').replace(/[^A-Za-z0-9_]/g, '_');
    if (!ident) ident = 'Generated';
    if (/^[0-9]/.test(ident)) ident = `_${ident}`;
    return ident;
}

/** Walk a layout document and list named frames with their full XML paths. */
export function listNamedFrames(modDoc) {
    const out = [];
    if (!modDoc || !modDoc.root) return out;
    const walk = (el, parentPath, parentFrameType = null) => {
        for (const child of el.children || []) {
            if (child.type !== 'element') continue;
            if (!isFrameTag(child.tag)) {
                walk(child, parentPath, parentFrameType);
                continue;
            }
            const name = attrVal(child, 'name');
            const type = child.tag === 'Frame' ? (attrVal(child, 'type') || 'Frame') : child.tag;
            const isTemplate = name && name.endsWith('Template');
            if (isTemplate) continue;
            const path = !name ? null
                : name.includes('/') ? name
                : (parentPath ? `${parentPath}/${name}` : name);
            if (name && path) {
                const visibleEl = findChild(child, 'Visible');
                const visibleValue = visibleEl ? String(attrVal(visibleEl, 'val') || '').toLowerCase() : '';
                out.push({
                    name,
                    path,
                    type,
                    controlKind: controlKindForType(type),
                    isButton: /Button|CheckBox/i.test(type),
                    isInternal: isStandardInternal(parentFrameType, name),
                    visible: visibleValue !== 'false' && visibleValue !== '0',
                });
            }
            walk(child, path || parentPath, type);
        }
    };
    walk(modDoc.root, '');
    return out;
}

/** List the materialized runtime tree used by the preview. Unlike a raw XML
 *  walk, this includes controls inherited from templates at the path where
 *  they are actually instantiated in-game. */
export function listRuntimeFrames(frames) {
    const out = [];
    const seen = new Set();
    const walk = (items, parentType = null, parentVisible = true) => {
        for (const frame of items || []) {
            if (!frame || frame.isTemplate) continue;
            const name = frame.name;
            const path = frame.path;
            const type = frame.type || 'Frame';
            const visible = parentVisible && frame.visible !== false;
            if (name && path && !frame.synthetic && !seen.has(path)) {
                seen.add(path);
                out.push({
                    name,
                    path,
                    type,
                    controlKind: controlKindForType(type),
                    isButton: /Button|CheckBox/i.test(type),
                    isInternal: isStandardInternal(parentType, name),
                    visible,
                });
            }
            walk(frame.children, type, visible);
        }
    };
    walk(frames);
    return out;
}

// Named descendants that implement a composite control are not normally
// controls the modder wants separate trigger variables for. Keep them in the
// list so an advanced user can explicitly select one, but do not opt them in.
function isStandardInternal(parentType, name) {
    const names = {
        Button: new Set(['NormalImage', 'HoverImage', 'PressedImage', 'DisabledImage', 'Label', 'HitTestFrame']),
        CheckBox: new Set(['Button', 'CheckImage', 'CheckMarkImage', 'Label']),
        EditBox: new Set(['Image', 'LabelContainerFrame', 'Label']),
        ListBox: new Set(['BackgroundImage', 'HoverImage', 'SelectedImage', 'ScrollBar']),
    };
    return names[parentType]?.has(name) || false;
}

function isFrameTag(tag) {
    return tag === 'Frame'
        || /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip|Portrait|Slider|Pulldown)$/.test(tag);
}

/** Buttons and named top-level controls are useful defaults; visual children are opt-in. */
export function defaultOptIn(frame) {
    if (frame.visible === false) return false;
    if (frame.isInternal) return false;
    if (frame.isButton) return true;
    return !frame.path.includes('/');
}
