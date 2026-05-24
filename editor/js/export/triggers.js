// Triggers XML export — generates a SC2-Editor-importable Triggers fragment
// that loads the currently-open layout at map init and binds each opted-in
// named frame to a Variable via SetVariable + layoutframerel path param.
//
// Output mirrors the pattern observed in ShepardMod.SC2Mod/Triggers:
//   - <Library Id="<modLibId>"> wrapper
//   - One Category for the generated content
//   - One Variable per opted-in frame (Identifier = gv_<FrameName>)
//   - One "Initialize <LayoutName>" Trigger with:
//       * Event = TriggerAddEventMapInit  (Ntve 00000120)
//       * Action 1 = UI Add Layout File   (Ntve 7DE42B33, param filepath)
//       * Action 2..N = SetVariable       (Ntve 00000136, var + path layoutframerel)
//
// Validated natives (from ref_sc2_trigger_xml_workflow.md + Shepherd Triggers):
//   00000120 = TriggerAddEventMapInit (no params)
//   00000136 = SetVariable            (params: 00000219 var, 00000220 val)
//   7DE42B33 = UI Add Layout File     (param: 2A7DE667 layout filepath)
//   2147B27F = ParamDef for layoutframerel value type
//
// Inputs:
//   modLibId       - 8-char hex library id of the user's mod (e.g. "555B09F0")
//   idPrefix       - 4-char hex prefix the user wants minted IDs to share
//   layoutPath     - layout file path inside the mod, e.g. "UI\\Layout\\MyPanel.SC2Layout"
//   layoutName     - the leaf name without extension, used to prefix frame paths
//   frames         - array of { name, path, isButton } objects already filtered
//                    to the user's opt-in selection.
//
// Per the workflow notes:
//   - Every Element gets a unique 8-char hex Id.
//   - Map-local refs use Type+Id, no Library= attribute.
//   - Cross-library refs (Ntve, the user's mod) use Library= attribute.
//   - Variable identifiers go in <Identifier>; their on-disk Galaxy name
//     becomes gv_<identifier> automatically when the editor codegens.

/** Generate the complete Triggers XML fragment as a string.
 *
 *  When `includeClickHandlers` is true, every frame with `isButton=true`
 *  also gets a click-event Trigger ready for the user to fill in:
 *      Event = TriggerAddEventDialogControl(AnyPlayer, Clicked, "!gv_<Name>")
 *      Action = Comment placeholder ("TODO: handle click")
 *  Comment Actions are required (not just convenience) — memory file rule #5
 *  says an event-bearing trigger with zero actions will crash the SC2 Editor
 *  on save, so the Comment doubles as both human note and stability guard.
 *
 *  Validated natives for click handling (from Shepherd Triggers):
 *      Ntve 00000121 = TriggerAddEventDialogControl
 *        ParamDef 00000191 = playergroup (preset 2999701E = Any Player)
 *        ParamDef 00000193 = event type (preset 00000073 = Clicked)
 *        ParamDef 00000192 = control id (string; "!<VariableIdentifier>" form)
 */
export function generateTriggersXml(opts) {
    const {
        modLibId,
        idPrefix,
        layoutPath,
        layoutName,
        frames,
        categoryName = 'UI Initialization (generated)',
        includeClickHandlers = true,
    } = opts;
    if (!/^[0-9A-Fa-f]{8}$/.test(modLibId)) {
        throw new Error(`modLibId must be 8 hex chars; got "${modLibId}"`);
    }
    if (!/^[0-9A-Fa-f]{1,6}$/.test(idPrefix)) {
        throw new Error(`idPrefix must be 1-6 hex chars; got "${idPrefix}"`);
    }
    const minter = makeIdMinter(idPrefix);

    // Mint top-level element IDs.
    const idCategory = minter.next();
    const idInitTrigger = minter.next();
    const idInitEvent = minter.next();
    const idLoadLayoutCall = minter.next();
    const idLoadLayoutParam = minter.next();

    // Per-frame: one Variable + one SetVariable FunctionCall (+ param children).
    // Buttons additionally get a click-event trigger + its 3 params + a
    // Comment placeholder action when includeClickHandlers is on.
    const frameRecords = frames.map((f) => {
        const rec = {
            ...f,
            ident: toIdent(f.name),
            idVariable: minter.next(),
            idSetCall: minter.next(),
            idVarParam: minter.next(),
            idPathParam: minter.next(),
        };
        if (includeClickHandlers && f.isButton) {
            rec.idClickTrigger = minter.next();
            rec.idClickEvent = minter.next();
            rec.idClickPlayerParam = minter.next();
            rec.idClickTypeParam = minter.next();
            rec.idClickControlParam = minter.next();
            rec.idClickStubComment = minter.next();
        }
        return rec;
    });

    const enc = (s) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const lines = [];
    lines.push(`<?xml version="1.0" encoding="utf-8"?>`);
    lines.push(`<TriggerData>`);
    lines.push(`    <Library Id="${modLibId.toUpperCase()}">`);
    lines.push(`        <Root>`);
    lines.push(`            <Item Type="Category" Library="${modLibId.toUpperCase()}" Id="${idCategory}"/>`);
    lines.push(`        </Root>`);
    lines.push('');

    // Category — contains the Init trigger, all Variables, and (when on)
    // every click-handler stub trigger.
    lines.push(`        <Element Type="Category" Id="${idCategory}">`);
    lines.push(`            <Identifier>${enc(categoryName)}</Identifier>`);
    lines.push(`            <Item Type="Trigger" Library="${modLibId.toUpperCase()}" Id="${idInitTrigger}"/>`);
    for (const f of frameRecords) {
        lines.push(`            <Item Type="Variable" Library="${modLibId.toUpperCase()}" Id="${f.idVariable}"/>`);
    }
    for (const f of frameRecords) {
        if (f.idClickTrigger) {
            lines.push(`            <Item Type="Trigger" Library="${modLibId.toUpperCase()}" Id="${f.idClickTrigger}"/>`);
        }
    }
    lines.push(`        </Element>`);
    lines.push('');

    // Variables — one per opted-in frame. Type is `string` since SC2 stores
    // frame paths as strings; SetVariable then assigns the layoutframerel param.
    // (Some workflows use a frame-handle type; string is the simplest and the
    // value can be passed anywhere Galaxy expects a frame path.)
    for (const f of frameRecords) {
        lines.push(`        <Element Type="Variable" Id="${f.idVariable}">`);
        lines.push(`            <Identifier>${enc(toIdent(f.name))}</Identifier>`);
        lines.push(`            <VariableType>`);
        lines.push(`                <Type Value="string"/>`);
        lines.push(`            </VariableType>`);
        lines.push(`        </Element>`);
        lines.push('');
    }

    // Init trigger — Event = Map Init; Actions = LoadLayout + SetVariable per frame.
    lines.push(`        <Element Type="Trigger" Id="${idInitTrigger}">`);
    lines.push(`            <Identifier>Initialize ${enc(layoutName)}</Identifier>`);
    lines.push(`            <Event Type="FunctionCall" Library="${modLibId.toUpperCase()}" Id="${idInitEvent}"/>`);
    lines.push(`            <Action Type="FunctionCall" Library="${modLibId.toUpperCase()}" Id="${idLoadLayoutCall}"/>`);
    for (const f of frameRecords) {
        lines.push(`            <Action Type="FunctionCall" Library="${modLibId.toUpperCase()}" Id="${f.idSetCall}"/>`);
    }
    lines.push(`        </Element>`);
    lines.push('');

    // Map Init event.
    lines.push(`        <Element Type="FunctionCall" Id="${idInitEvent}">`);
    lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="00000120"/>`);
    lines.push(`        </Element>`);
    lines.push('');

    // UI Add Layout File call.
    lines.push(`        <Element Type="FunctionCall" Id="${idLoadLayoutCall}">`);
    lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="7DE42B33"/>`);
    lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${idLoadLayoutParam}"/>`);
    lines.push(`        </Element>`);
    lines.push(`        <Element Type="Param" Id="${idLoadLayoutParam}">`);
    lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="2A7DE667"/>`);
    lines.push(`            <Value>${enc(layoutPath)}</Value>`);
    lines.push(`            <ValueType Type="filepath"/>`);
    lines.push(`            <ValueTypeInfo Value="6"/>`);
    lines.push(`        </Element>`);
    lines.push('');

    // SetVariable + path Param per frame.
    for (const f of frameRecords) {
        lines.push(`        <Element Type="FunctionCall" Id="${f.idSetCall}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="00000136"/>`);
        lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${f.idVarParam}"/>`);
        lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${f.idPathParam}"/>`);
        lines.push(`        </Element>`);
        // Variable target param.
        lines.push(`        <Element Type="Param" Id="${f.idVarParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="00000219"/>`);
        lines.push(`            <Variable Type="Variable" Library="${modLibId.toUpperCase()}" Id="${f.idVariable}"/>`);
        lines.push(`        </Element>`);
        // Value param: frame path string. Use layoutframerel value type which
        // the SC2 editor renders as a frame-path field.
        const framePath = `${layoutName}/${f.path}`;
        lines.push(`        <Element Type="Param" Id="${f.idPathParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="00000220"/>`);
        lines.push(`            <Value>${enc(framePath)}</Value>`);
        lines.push(`            <ValueType Type="layoutframerel"/>`);
        lines.push(`        </Element>`);
        lines.push('');
    }

    // Click-handler stubs for each opted-in Button.
    for (const f of frameRecords) {
        if (!f.idClickTrigger) continue;
        lines.push(`        <Element Type="Trigger" Id="${f.idClickTrigger}">`);
        lines.push(`            <Identifier>On ${enc(f.ident)} Clicked</Identifier>`);
        lines.push(`            <Event Type="FunctionCall" Library="${modLibId.toUpperCase()}" Id="${f.idClickEvent}"/>`);
        // Comment Action satisfies the "no zero-action trigger" rule from
        // ref_sc2_trigger_xml_workflow.md (#5). User replaces it with real logic.
        lines.push(`            <Action Type="Comment" Library="${modLibId.toUpperCase()}" Id="${f.idClickStubComment}"/>`);
        lines.push(`        </Element>`);
        lines.push('');

        // The event: TriggerAddEventDialogControl(AnyPlayer, Clicked, "!gv_<Name>")
        lines.push(`        <Element Type="FunctionCall" Id="${f.idClickEvent}">`);
        lines.push(`            <FunctionDef Type="FunctionDef" Library="Ntve" Id="00000121"/>`);
        lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${f.idClickPlayerParam}"/>`);
        lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${f.idClickTypeParam}"/>`);
        lines.push(`            <Parameter Type="Param" Library="${modLibId.toUpperCase()}" Id="${f.idClickControlParam}"/>`);
        lines.push(`        </Element>`);
        // Player param: Any Player preset.
        lines.push(`        <Element Type="Param" Id="${f.idClickPlayerParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="00000191"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="2999701E"/>`);
        lines.push(`        </Element>`);
        // Event-type param: Clicked.
        lines.push(`        <Element Type="Param" Id="${f.idClickTypeParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="00000193"/>`);
        lines.push(`            <Preset Type="PresetValue" Library="Ntve" Id="00000073"/>`);
        lines.push(`        </Element>`);
        // Control id param: "!<VariableIdentifier>" string. SC2's editor
        // resolves the leading "!" to a Variable lookup at codegen time.
        lines.push(`        <Element Type="Param" Id="${f.idClickControlParam}">`);
        lines.push(`            <ParameterDef Type="ParamDef" Library="Ntve" Id="00000192"/>`);
        lines.push(`            <Value>!${enc(f.ident)}</Value>`);
        lines.push(`            <ValueType Type="string"/>`);
        lines.push(`        </Element>`);
        // Comment placeholder — satisfies the zero-action crash guard and
        // gives the user a marker to find when filling in the handler.
        lines.push(`        <Element Type="Comment" Id="${f.idClickStubComment}">`);
        lines.push(`            <Comment>TODO: implement ${enc(f.name)} click handler.</Comment>`);
        lines.push(`        </Element>`);
        lines.push('');
    }

    lines.push(`    </Library>`);
    lines.push(`</TriggerData>`);
    return lines.join('\n');
}

/** GUID minter producing sequential 8-char hex IDs sharing a user prefix.
 *  prefix="7C0D" → "7C0D0001", "7C0D0002", ..., "7C0D000F", "7C0D0010", ... */
function makeIdMinter(prefix) {
    const padLen = 8 - prefix.length;
    const max = Math.pow(16, padLen) - 1;
    let n = 0;
    return {
        next() {
            n++;
            if (n > max) throw new Error(`ran out of ${padLen}-digit IDs under prefix "${prefix}"`);
            const suffix = n.toString(16).toUpperCase().padStart(padLen, '0');
            return prefix.toUpperCase() + suffix;
        },
    };
}

/** SC2 variable identifiers can't contain slashes or spaces; sanitise. */
function toIdent(name) {
    return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Walk a layout's parsed XML doc and return every named frame, flagged with
 *  type info so the caller can apply default-opt-in heuristics. */
export function listNamedFrames(modDoc) {
    const out = [];
    if (!modDoc || !modDoc.root) return out;
    const walk = (el, parentPath) => {
        for (const c of el.children || []) {
            if (c.type !== 'element') continue;
            if (!isFrameTag(c.tag)) { walk(c, parentPath); continue; }
            const name = attrVal(c, 'name');
            const type = c.tag === 'Frame' ? (attrVal(c, 'type') || 'Frame') : c.tag;
            // Skip unnamed / template-named frames.
            const isTemplate = name && name.endsWith('Template');
            // Path: explicit if name contains "/", else parent/name.
            const path = !name ? null
                : name.includes('/') ? name
                : (parentPath ? `${parentPath}/${name}` : name);
            if (name && path && !isTemplate) {
                out.push({
                    name,
                    path,
                    type,
                    isButton: /Button|CheckBox|EditBox|ListBox/.test(type),
                });
            }
            walk(c, path || parentPath);
        }
    };
    walk(modDoc.root, '');
    return out;
}

function isFrameTag(tag) {
    return tag === 'Frame'
        || /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip)$/.test(tag);
}

function attrVal(el, name) {
    if (!el || !el.attrs) return undefined;
    const a = el.attrs.find(x => x.name === name);
    return a ? a.value : undefined;
}

/** Default opt-in heuristic: include interactive controls + named top-level
 *  frames; skip purely visual children (Images, Labels, Tooltips unless they
 *  are themselves a top-level frame). */
export function defaultOptIn(frame) {
    if (frame.isButton) return true;
    // Top-level frames (no slash in path) are usually worth including.
    if (!frame.path.includes('/')) return true;
    return false;
}
