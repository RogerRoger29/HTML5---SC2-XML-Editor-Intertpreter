// SC2 UI Editor - main entry. Wires parser, stock layout loader, tree merger,
// layout engine, renderer, font sheet, and texture loader into the shell.

import { parseXml } from './xml/parser.js';
import { serializeXml } from './xml/serializer.js';
import { FrameRenderer } from './render/frames.js';
import { TextureLoader } from './render/textures.js';
import { FontStyleSheet } from './render/fontstyle.js';
import { layoutFrames } from './render/layout.js';
import { TreeView } from './ui/tree.js';
import { Inspector } from './ui/inspector.js';
import { StockRegistry } from './stock.js';
import { MergedTree } from './merge.js';
import { SelectionOverlay } from './ui/edit.js';
import { PaneController } from './ui/panes.js';
import { computeGuides, renderGuides, clearGuides } from './ui/guides.js';
import { MenuBar } from './ui/menubar.js';
import { FindPalette } from './ui/findpalette.js';
import { WelcomeTour } from './ui/welcome.js';
import { AssetsUi } from './ui/assets-dialog.js';
import { UndoStack, checkRoundTrip } from './doc-controller.js';
import { generateTriggersXml, listRuntimeFrames, defaultOptIn } from './export/triggers.js';
import { validate } from './validate.js';
import { applyStateActions } from './state-groups.js';
import { VERSION } from './version.js';
import { STOCK_ASSETS_BASE } from './constants.js';
import { DiagnosticRecorder, buildDiagnosticReport, pathHint } from './diagnostics.js';
import { appendFrameAtSelection, oneIndentDeeper } from './authoring.js';
import {
    addMatchingButton, analyzeButtonRow, buildReadinessSummary,
    duplicateFrameBeside, extendMengskTopBar, growFrameToChildren,
    isMengskCommandButton, nudgeFrame, resizeFrame, setFrameVisibility,
} from './guided.js';
import {
    inferChildIndent, textNode, makeElement as elementNode,
    appendChildPreservingIndent, removeChildAndWhitespace,
} from './xml/mutate.js';

// Capture a bounded, redacted copy of console activity from the beginning of
// app startup. Original console output continues unchanged for F12 debugging.
const diagnosticRecorder = new DiagnosticRecorder();
diagnosticRecorder.installConsoleCapture();

const els = {
    menuBar: document.getElementById('menu-bar'),
    btnApplyXml: document.getElementById('btn-apply-xml'),
    btnAssets: document.getElementById('btn-assets'),
    btnGuided: document.getElementById('btn-guided'),
    assetsDialog: document.getElementById('assets-dialog'),
    assetsDialogBody: document.getElementById('assets-dialog-body'),
    btnWarnings: document.getElementById('btn-warnings'),
    warningsCount: document.getElementById('warnings-count'),
    warningsDialog: document.getElementById('warnings-dialog'),
    warningsDialogBody: document.getElementById('warnings-dialog-body'),
    warningsDialogCount: document.getElementById('warnings-dialog-count'),
    fileInput: document.getElementById('file-input'),
    backdropInput: document.getElementById('backdrop-input'),
    backdropImg: document.getElementById('backdrop-img'),
    toggleStockUi: document.getElementById('toggle-stock-ui'),
    toggleOutlines: document.getElementById('toggle-outlines'),
    toggleBackdrop: document.getElementById('toggle-backdrop'),
    toggleSimpleMode: document.getElementById('toggle-simple-mode'),
    toggleSnap: document.getElementById('toggle-snap'),
    snapSize: document.getElementById('snap-size'),
    viewMode: document.getElementById('view-mode'),
    emptyHint: document.getElementById('canvas-empty-hint'),
    hintClose: document.getElementById('hint-close'),
    status: document.getElementById('status'),
    xmlStatus: document.getElementById('xml-status'),
    xmlText: document.getElementById('xml-text'),
    stage: document.getElementById('canvas-stage'),
    viewport: document.getElementById('viewport-size'),
    zoom: document.getElementById('zoom'),
    zoomPct: document.getElementById('zoom-pct'),
    btnFit: document.getElementById('btn-fit'),
    canvasScroll: document.getElementById('canvas-scroll'),
    tree: document.getElementById('tree'),
    inspector: document.getElementById('inspector'),
    openDialog: document.getElementById('open-dialog'),
    openPath: document.getElementById('open-path'),
    constantsDialog: document.getElementById('constants-dialog'),
    constantsBody: document.getElementById('constants-dialog-body'),
    constantsCount: document.getElementById('constants-dialog-count'),
    constantsFilter: document.getElementById('constants-filter'),
    diagnosticsDialog: document.getElementById('diagnostics-dialog'),
    diagnosticsDescription: document.getElementById('diagnostics-description'),
    diagnosticsIncludeLayout: document.getElementById('diagnostics-include-layout'),
    diagnosticsIncludeLogs: document.getElementById('diagnostics-include-logs'),
    quickButtonDialog: document.getElementById('quick-button-dialog'),
    quickButtonTarget: document.getElementById('quick-button-target'),
    quickButtonName: document.getElementById('quick-button-name'),
    quickButtonText: document.getElementById('quick-button-text'),
    quickButtonWidth: document.getElementById('quick-button-width'),
    quickButtonHeight: document.getElementById('quick-button-height'),
    quickButtonTop: document.getElementById('quick-button-top'),
    quickButtonLeft: document.getElementById('quick-button-left'),
    beginnerBar: document.getElementById('beginner-bar'),
    beginnerAddMatching: document.getElementById('beginner-add-matching'),
    beginnerAddInside: document.getElementById('beginner-add-inside'),
    beginnerEdit: document.getElementById('beginner-edit'),
    beginnerCheck: document.getElementById('beginner-check'),
    beginnerExit: document.getElementById('beginner-exit'),
    guidedDialog: document.getElementById('guided-dialog'),
    guidedSelection: document.getElementById('guided-selection'),
    guidedAnalysis: document.getElementById('guided-analysis'),
    guidedExtendArt: document.getElementById('guided-extend-art'),
    guidedAddMatching: document.getElementById('guided-add-matching'),
    guidedDuplicate: document.getElementById('guided-duplicate'),
    guidedShow: document.getElementById('guided-show'),
    guidedHide: document.getElementById('guided-hide'),
    guidedGrow: document.getElementById('guided-grow'),
    guidedWidth: document.getElementById('guided-width'),
    guidedHeight: document.getElementById('guided-height'),
    guidedResize: document.getElementById('guided-resize'),
    guidedReadiness: document.getElementById('guided-readiness'),
    guidedTriggers: document.getElementById('guided-triggers'),
    guidedSupport: document.getElementById('guided-support'),
    guidedResult: document.getElementById('guided-result'),
    guidedUndo: document.getElementById('guided-undo'),
    readinessDialog: document.getElementById('readiness-dialog'),
    readinessSummary: document.getElementById('readiness-summary'),
    readinessTriggers: document.getElementById('readiness-triggers'),
    readinessExport: document.getElementById('readiness-export'),
    gameSetupDialog: document.getElementById('game-setup-dialog'),
};

const state = {
    config: null,
    modDoc: null,
    currentPath: null,
    currentFileName: null,
    frames: [],
    selected: null,
    pristineSource: '',
    stockLoaded: false,
    fileHandle: null,
    activeStates: new Map(),
};

const registry = new StockRegistry();
const fontstyles = new FontStyleSheet();
const textures = new TextureLoader('/assets/');

const renderer = new FrameRenderer({
    stage: els.stage,
    textures,
    fontstyles,
    onSelect: (node, hit) => handleCanvasClick(node, hit),
    onBodyPointerDown: (node, ev, captureTarget) => {
        // Drag the currently-selected frame, not the topmost frame at the
        // pointer. This is what lets the user cycle (click-click) to a frame
        // behind another, then click-drag from that area to move the BACK
        // frame instead of the top one. If nothing is selected yet we fall
        // back to the topmost (the frame whose pointerdown fired).
        const target = state.selected || node;
        if (state.selected !== target) selectFrame(target, true);
        selection.beginBodyDrag(target, ev, captureTarget);
    },
});

const tree = new TreeView(els.tree, (frame) => selectFrame(frame, false), {
    onReorder: (source, target, mode) => moveFrame(source, target, mode),
});

// Move `source` to a new position relative to `target` in the XML tree.
// mode: 'above' | 'below' | 'inside'
//   'above'/'below' insert source as a sibling of target in target's parent
//   'inside'        appends source as a last child of target
// Refuses to move stock-origin or synthetic frames. Preserves indentation.
function moveFrame(source, target, mode) {
    if (!source || !target || source === target) return;
    const sEl = source._modSource;
    const tEl = target._modSource;
    if (!sEl || !sEl._parent) { setStatus('Cannot move: source has no mod XML element.'); return; }
    if (!tEl) { setStatus('Cannot move: target is stock-only.'); return; }
    const targetParent = mode === 'inside' ? tEl : tEl._parent;
    if (!targetParent) { setStatus('Cannot move: target has no parent.'); return; }
    // Disallow moving an ancestor into its own descendant (would orphan
    // a subtree). The tree UI also prevents this, but defend in depth.
    if (isAncestor(sEl, targetParent)) {
        setStatus('Cannot move a frame into its own descendant.');
        return;
    }
    snapshotForUndo();

    // Remove from old position (also strips the preceding whitespace text
    // node so we don't leave double blank lines behind).
    const sParent = sEl._parent;
    if (!removeChildAndWhitespace(sParent, sEl)) return;

    // Compute insert index in the new parent.
    let insertIdx;
    if (mode === 'inside') {
        // As last child - before the trailing whitespace if any.
        insertIdx = targetParent.children.length;
        // Step back over trailing whitespace so the new node sits before the
        // close tag's leading newline.
        while (insertIdx > 0
            && targetParent.children[insertIdx - 1].type === 'text'
            && /^\s+$/.test(targetParent.children[insertIdx - 1].raw)) {
            insertIdx--;
        }
    } else {
        const tIdx = targetParent.children.indexOf(tEl);
        insertIdx = mode === 'above' ? tIdx : tIdx + 1;
    }

    // Indentation: copy whatever pattern the nearest sibling uses, or
    // derive from target's parent depth.
    const indent = inferChildIndent(targetParent);
    targetParent.children.splice(insertIdx, 0, textNode(indent), sEl);
    targetParent.dirty = true;

    // Re-link _parent refs since we just rearranged the tree.
    setParentRefs(state.modDoc);
    selectFrame(null, false);
    rerender();
    setStatus(`Moved ${source.type}:${source.name} ${mode} ${target.type}:${target.name}.`);
}

function isAncestor(maybeAncestor, node) {
    for (let n = node; n; n = n._parent) {
        if (n === maybeAncestor) return true;
    }
    return false;
}

// inferIndent moved to xml/mutate.js as inferChildIndent in R4.2.

const inspector = new Inspector(els.inspector, {
    activeStates: state.activeStates,
    onStateChange: () => {
        // State picks don't mutate the XML - skip snapshot, just re-paint.
        rerender({ keepSelection: true });
    },
    onBeforeChange: () => snapshotForUndo(),
    onChange: (frame, live) => {
        // Inspector mutated the mod XML. If the change deleted the selected
        // frame, frame is null - clear selection. live=true means the user
        // is still mid-edit (e.g. holding the spinner) - use the same
        // positions-only fast path the drag editing uses so the canvas
        // tracks every step without flicker. live=false on commit (blur /
        // Enter / change) does the full rerender + side pane refresh.
        if (!frame) {
            selectFrame(null, false);
            rerender();
            return;
        }
        if (live) rerender({ keepSelection: true, positionsOnly: true });
        else rerender({ keepSelection: true });
    },
    // Suggester functions feed the inspector's autocomplete dropdowns.
    // Each takes a query string and returns [{ value, label?, hint? }].
    suggesters: {
        texture: (q) => suggestTextures(q),
        style: (q) => suggestStyles(q),
    },
    // Resolve "#Constant" refs for read-only display in the inspector.
    resolveConstant: (v) => registry.resolveValue(v),
});

// --- autocomplete data sources --------------------------------------------

const SUGGESTION_LIMIT = 200;

// Texture aliases live in textures.aliases (loaded from each mod's
// Base.SC2Data/GameData/Assets*.txt). Keys look like "UI/HeroPanelButtonNormal"
// and SC2 references them as @UI/X / @@UI/X / @@@UI/X depending on render
// mode. We preserve whatever @-prefix the user typed and suggest the rest.
// If the user typed no prefix we default to @@@ (the most common form).
function suggestTextures(query) {
    if (!textures || !textures.aliases || !textures.aliases.size) return [];
    const q = query || '';
    const m = q.match(/^(@+)(.*)$/);
    const prefix = m ? m[1] : '@@@';
    const needle = (m ? m[2] : q).toLowerCase();
    const out = [];
    const exactMatches = [];
    const startsWithMatches = [];
    const substringMatches = [];
    for (const [key, val] of textures.aliases) {
        const lowerKey = key.toLowerCase();
        if (needle && !lowerKey.includes(needle)) continue;
        const entry = {
            value: prefix + key,
            label: prefix + key,
            hint: val.replace(/\\/g, '/'),
        };
        if (lowerKey === needle) exactMatches.push(entry);
        else if (lowerKey.startsWith(needle)) startsWithMatches.push(entry);
        else substringMatches.push(entry);
        if (exactMatches.length + startsWithMatches.length + substringMatches.length > SUGGESTION_LIMIT * 2) break;
    }
    // Rank: exact > starts-with > substring; alphabetical within each group.
    const sortByKey = (a, b) => a.label.localeCompare(b.label);
    out.push(...exactMatches.sort(sortByKey));
    out.push(...startsWithMatches.sort(sortByKey));
    out.push(...substringMatches.sort(sortByKey));
    return out.slice(0, SUGGESTION_LIMIT);
}

// Style names come from FontStyles.SC2Style entries we ingested into the
// fontstyles sheet's rawStyles map.
function suggestStyles(query) {
    if (!fontstyles || !fontstyles.rawStyles || !fontstyles.rawStyles.size) return [];
    const needle = (query || '').toLowerCase();
    const exact = [];
    const starts = [];
    const sub = [];
    for (const name of fontstyles.rawStyles.keys()) {
        const ln = name.toLowerCase();
        if (needle && !ln.includes(needle)) continue;
        // The resolved style might inherit from a template - the hint shows
        // the height + textcolor if available so the modder gets a feel for
        // what it'll render as.
        const raw = fontstyles.rawStyles.get(name) || {};
        const parts = [];
        if (raw.height) parts.push(`h=${raw.height}`);
        if (raw.textcolor) parts.push(raw.textcolor);
        if (raw.template) parts.push(`<- ${raw.template}`);
        const hint = parts.join('  ') || '(see FontStyles.SC2Style)';
        const entry = { value: name, label: name, hint };
        if (ln === needle) exact.push(entry);
        else if (ln.startsWith(needle)) starts.push(entry);
        else sub.push(entry);
    }
    const sortByLabel = (a, b) => a.label.localeCompare(b.label);
    return [
        ...exact.sort(sortByLabel),
        ...starts.sort(sortByLabel),
        ...sub.sort(sortByLabel),
    ].slice(0, SUGGESTION_LIMIT);
}

const selection = new SelectionOverlay(els.stage, {
    zoomFn: () => parseFloat(els.zoom.value) || 1,
    // Drag math reads this on every pointermove so toggling Snap mid-drag
    // takes effect instantly. Returns 0 when snap is off.
    snapFn: () => {
        if (!els.toggleSnap || !els.toggleSnap.checked) return 0;
        const v = parseFloat(els.snapSize && els.snapSize.value);
        return Number.isFinite(v) && v > 0 ? v : 0;
    },
    onBeforeEdit: snapshotForUndo,
    onEdit: handleEdit,
    // Candidate alignment edges for snap-to-guide on body moves. Gathers
    // every other frame's left/right/centerX (xs) and top/bottom/centerY
    // (ys) in canvas space, skipping the dragged frame + its descendants +
    // synthetic wrappers (same exclusions guides.js uses).
    snapTargetsFn: (dragged) => collectSnapTargets(dragged),
});

// Build the {xs, ys} alignment-edge lists used by the drag overlay's
// snap-to-guide. Walks state.frames once.
function collectSnapTargets(dragged) {
    const xs = [];
    const ys = [];
    const skip = new Set();
    (function collect(n) { skip.add(n); (n.children || []).forEach(collect); })(dragged);
    const visit = (nodes) => {
        for (const f of nodes) {
            if (!skip.has(f) && !f.synthetic && typeof f.x === 'number') {
                xs.push(f.x, f.x + f.w, f.x + f.w / 2);
                ys.push(f.y, f.y + f.h, f.y + f.h / 2);
            }
            if (f.children && f.children.length) visit(f.children);
        }
    };
    visit(state.frames);
    return { xs, ys };
}

// Undo stack: snapshots of the raw XML string from before each edit.
// Bounded to 100 entries to keep memory under control on long sessions.
// R4.8: hoisted into UndoStack (doc-controller.js).
const undoStack = new UndoStack();

// Track the last canvas click point so successive clicks at (approximately)
// the same spot cycle through frames stacked at that point.
state.lastClick = null;

// fileHandle and activeStates are initialized in the state object before the
// Inspector is constructed. The Inspector and renderer must hold the SAME
// activeStates Map or state-preview dropdown changes never reach the canvas.

// Debug global so issues can be probed from F12 console:
//   sc2.frames           - current resolved frame tree
//   sc2.textures         - TextureLoader (try sc2.textures.load('@@@UI/Foo'))
//   sc2.registry         - StockRegistry
//   sc2.testTexture(ref) - shorthand for quick texture probes
window.sc2 = {
    get state() { return state; },
    get frames() { return state.frames; },
    textures,
    registry,
    fontstyles,
    diagnosticRecorder,
    getDiagnostics: (options = {}) => createDiagnosticReport({
        includeLayoutSource: options.includeLayoutSource !== false,
        includeLogs: options.includeLogs !== false,
        description: options.description || '',
    }),
    async testTexture(ref) {
        console.log('candidate URLs:', textures.candidateUrls(ref));
        const c = await textures.load(ref);
        console.log('result:', c, c ? `(${c.width}x${c.height})` : 'null');
        if (c) document.body.appendChild(Object.assign(c, { style: 'position:fixed;top:8px;right:8px;z-index:9999;border:2px solid lime;background:#000' }));
        return c;
    },
};

// Set up resizable + collapsible panes BEFORE init so the canvas knows its
// final dimensions when we run the fit-to-window auto-zoom in wireEvents.
// Re-fit on every layout change so dragging the side panes also reflows the
// canvas zoom (when the user hasn't manually overridden zoom).
const panes = new PaneController({
    onLayoutChange: () => {
        // Reposition the selection overlay (its bounding box changed if the
        // canvas pane resized) and trigger a fit-zoom recompute if applicable.
        if (els.btnFit && !state.userAdjustedZoom) {
            // Use a microtask to wait for grid layout to settle first.
            queueMicrotask(() => els.btnFit.click());
        }
        if (state.selected) selection.position();
    },
});

init();

// AssetsUi handles startup banner + persistent dialog. Constructed lazily
// in init() since it needs the els.* DOM nodes to exist.
let assetsUi = null;

async function init() {
    const verEl = document.getElementById('app-version');
    if (verEl) verEl.textContent = 'v' + VERSION;
    document.title = `SC2 UI Editor v${VERSION}`;
    console.info(`SC2 UI Editor v${VERSION}`);
    setStatus('Loading server config…');
    try {
        const resp = await fetch('/__config');
        state.config = await resp.json();
    } catch (err) {
        setStatus('Could not contact serve.py. Did you start it?');
        return;
    }
    assetsUi = new AssetsUi({
        dialog: els.assetsDialog,
        dialogBody: els.assetsDialogBody,
        setStatus,
        refresh: () => resetAssetDependentCaches(),
        onConfigChanged: (cfg) => { state.config = cfg; },
        sessionToken: state.config.session_token,
    });
    if (!state.config.assets_present) {
        assetsUi.renderBanner(state.config);
    } else {
        setStatus(`Ready. Assets: ${state.config.assets_root}  [${state.config.assets_source || 'auto'}]`);
    }

    await loadFontStyles();
    wireEvents();
    // Background-load: stock layouts (templates/constants) + texture aliases.
    // Both feed the renderer; neither blocks startup.
    loadStockLayouts().catch(err => console.warn('[stock] background load failed:', err));
    textures.loadAssetsTxt().then((n) => {
        console.info(`[textures] alias table has ${n} entries`);
        // If a file is already open, retry any failed texture loads by
        // clearing the cache. Cheap; layouts hold few unique textures.
        if (state.modDoc) {
            textures.cache.clear();
            rerender();
        }
    }).catch(err => console.warn('[textures] asset catalog load failed:', err));
}

async function loadFontStyles({ reset = false } = {}) {
    try {
        if (reset) fontstyles.reset();
        const text = await fetch(STOCK_ASSETS_BASE + 'UI/fontstyles.sc2style')
            .then(r => r.ok ? r.text() : null);
        if (!text) return;
        fontstyles.ingest(text);
        for (const name of ['StandardTemplate', 'HeaderTemplate', 'DebugDisplay']) {
            fontstyles.getStyle(name);
        }
        const sheet = newDynamicStylesheet();
        fontstyles.injectFontFaces(sheet, (path) =>
            STOCK_ASSETS_BASE + path.replace(/\\/g, '/'));
    } catch (err) {
        console.warn('[fontstyles] could not load:', err);
    }
}

function newDynamicStylesheet() {
    const previous = document.getElementById('sc2-dynamic-styles');
    if (previous) previous.remove();
    const styleEl = document.createElement('style');
    styleEl.id = 'sc2-dynamic-styles';
    document.head.appendChild(styleEl);
    return styleEl.sheet;
}

// Menubar registry; populated in wireEvents(). Exposed at module scope so
// keyboard shortcuts can invoke the same actions the menu items do.
let menubar = null;

// VS Code-style Ctrl+P fuzzy frame finder. Lazily created the first time
// it's invoked.
const findPalette = new FindPalette({
    getFrames: () => state.frames || [],
    onSelect: (frame) => selectFrame(frame, false),
});

// First-run welcome overlay. Walks the user through the basics; dismissal
// is persisted to localStorage so it doesn't pester on every launch.
const welcomeTour = new WelcomeTour();

function wireEvents() {
    // -- File picker (native input is still used as a fallback when the
    // browser doesn't have File System Access API) --
    els.fileInput.addEventListener('change', async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            // Native picker doesn't give us a writable handle, so save-back
            // will go through Save-As (download). Clear every prior file
            // context so textures and Ctrl+S cannot target the old document.
            openFromText(text, file.name, {
                fileHandle: null,
                currentPath: null,
                modRoot: null,
            });
        } catch (err) {
            setStatus(`Failed to open ${file.name}: ${err.message}`);
        } finally {
            ev.target.value = '';
        }
    });

    els.openDialog.addEventListener('close', () => {
        if (els.openDialog.returnValue === 'confirm') {
            openByUrl(els.openPath.value.trim());
        }
    });

    // -- Menu bar --
    menubar = new MenuBar(els.menuBar);
    menubar.register('new',         () => createNewLayout());
    menubar.register('open',        () => openFile());
    menubar.register('open-path',   () => els.openDialog.showModal());
    menubar.register('save',        () => saveCurrent());
    menubar.register('save-as',     () => saveAs());
    menubar.register('export-html', () => exportHtml());
    menubar.register('undo',        () => doUndo());
    menubar.register('redo',        () => doRedo());
    menubar.register('deselect',    () => selectFrame(null, false));
    menubar.register('find',        () => findPalette.open());
    menubar.register('guided-tools', () => openGuidedDialog());
    menubar.register('add-matching-button', () => addMatchingButtonFromUi());
    menubar.register('quick-button', () => openQuickButtonDialog());
    menubar.register('add-frame',   (data) => addNewFrame(data.type));
    menubar.register('fit',         () => fitZoom());
    menubar.register('show-constants', () => openConstantsDialog());
    menubar.register('set-backdrop', () => els.backdropInput.click());
    menubar.register('welcome-tour', () => welcomeTour.open());
    menubar.register('game-setup-help', () => els.gameSetupDialog?.showModal());
    menubar.register('readiness-check', () => openReadinessDialog());
    menubar.register('export-diagnostics', () => openDiagnosticsDialog());
    menubar.register('export-support-bundle', () => exportSupportBundle());
    menubar.register('export-triggers', () => openTriggersExportDialog());
    menubar.register('about', () => {
        alert(`SC2 UI Editor v${VERSION}\n\n`
            + `Visual editor for StarCraft 2 .SC2Layout files.\n\n`
            + `Built with vanilla JavaScript + Python + CascLib.\n`
            + `Bug reports and feature requests welcome.`);
    });

    // First-launch welcome tour. Shown once; the user can re-open it from
    // the Help menu.
    if (WelcomeTour.shouldShow()) {
        // Defer one frame so the menu / panes are positioned before we
        // try to spotlight them.
        requestAnimationFrame(() => welcomeTour.open());
    }

    if (els.quickButtonDialog) {
        els.quickButtonDialog.addEventListener('close', () => {
            if (els.quickButtonDialog.returnValue === 'insert') addGuidedButton();
        });
    }

    if (els.btnGuided) els.btnGuided.addEventListener('click', openGuidedDialog);
    if (els.guidedAddMatching) els.guidedAddMatching.addEventListener('click', () => addMatchingButtonFromUi());
    for (const button of document.querySelectorAll('[data-guided-add]')) {
        button.addEventListener('click', () => {
            const type = button.dataset.guidedAdd;
            addNewFrame(type);
            showGuidedResult(`Added ${type} inside the selected target. It is selected now, so you can move or resize it below.`);
        });
    }
    if (els.guidedDuplicate) els.guidedDuplicate.addEventListener('click', () => {
        runGuidedMutation('Duplicate frame', () => duplicateFrameBeside(state.selected), result => ({
            message: `Created ${result.name} 16 pixels down and right from the original.`,
            selectPath: result.newPath,
        }));
    });
    if (els.guidedShow) els.guidedShow.addEventListener('click', () => {
        runGuidedMutation('Show frame', () => setFrameVisibility(state.selected, true), () => ({ message: 'The selected frame is visible.' }));
    });
    if (els.guidedHide) els.guidedHide.addEventListener('click', () => {
        runGuidedMutation('Hide frame', () => setFrameVisibility(state.selected, false), () => ({ message: 'The selected frame is hidden in SC2.' }));
    });
    if (els.guidedGrow) els.guidedGrow.addEventListener('click', () => {
        runGuidedMutation('Grow container', () => growFrameToChildren(state.selected, 8), result => ({
            message: `Grew the selected frame to ${result.width} × ${result.height} so its direct children fit with padding.`,
        }));
    });
    if (els.guidedResize) els.guidedResize.addEventListener('click', () => {
        runGuidedMutation('Resize frame', () => resizeFrame(
            state.selected, els.guidedWidth.value, els.guidedHeight.value), result => ({
            message: `Set the selected frame to ${result.width} × ${result.height}.`,
        }));
    });
    for (const button of document.querySelectorAll('[data-guided-nudge]')) {
        button.addEventListener('click', () => {
            const [dx, dy] = button.dataset.guidedNudge.split(',').map(Number);
            runGuidedMutation('Move frame', () => nudgeFrame(state.selected, dx, dy), () => ({
                message: `Moved the selected frame ${Math.abs(dx || dy)} pixels ${dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down'}.`,
            }));
        });
    }
    if (els.guidedReadiness) els.guidedReadiness.addEventListener('click', () => {
        els.guidedDialog?.close();
        openReadinessDialog();
    });
    if (els.guidedTriggers) els.guidedTriggers.addEventListener('click', () => {
        els.guidedDialog?.close();
        openTriggersExportDialog();
    });
    if (els.guidedSupport) els.guidedSupport.addEventListener('click', exportSupportBundle);
    if (els.guidedUndo) els.guidedUndo.addEventListener('click', () => {
        doUndo();
        els.guidedResult.hidden = false;
        els.guidedResult.className = 'guided-result';
        els.guidedResult.textContent = 'The guided change was undone.';
        els.guidedUndo.hidden = true;
        refreshGuidedDialog();
    });
    if (els.readinessTriggers) els.readinessTriggers.addEventListener('click', () => {
        els.readinessDialog?.close();
        openTriggersExportDialog();
    });
    if (els.readinessExport) els.readinessExport.addEventListener('click', exportSupportBundle);
    if (els.beginnerAddMatching) els.beginnerAddMatching.addEventListener('click', openGuidedDialog);
    if (els.beginnerAddInside) els.beginnerAddInside.addEventListener('click', openGuidedDialog);
    if (els.beginnerEdit) els.beginnerEdit.addEventListener('click', openGuidedDialog);
    if (els.beginnerCheck) els.beginnerCheck.addEventListener('click', openReadinessDialog);
    if (els.beginnerExit) els.beginnerExit.addEventListener('click', () => setSimpleMode(false));
    if (els.toggleSimpleMode) {
        els.toggleSimpleMode.addEventListener('change', () => setSimpleMode(els.toggleSimpleMode.checked));
        let savedSimpleMode = false;
        try { savedSimpleMode = localStorage.getItem('sc2editor.simpleMode') === '1'; } catch {}
        setSimpleMode(savedSimpleMode, { persist: false });
    }

    // Drag-drop on canvas.
    const drop = els.canvasScroll;
    let dragDepth = 0;
    drop.addEventListener('dragenter', (ev) => {
        if (!hasFiles(ev)) return;
        dragDepth++;
        drop.classList.add('drag-over');
        ev.preventDefault();
    });
    drop.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) drop.classList.remove('drag-over');
    });
    drop.addEventListener('dragover', (ev) => { if (hasFiles(ev)) ev.preventDefault(); });
    drop.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        dragDepth = 0;
        drop.classList.remove('drag-over');
        const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (!f) return;
        if (!confirmDiscardChanges()) return;
        try {
            const text = await f.text();
            openFromText(text, f.name, {
                fileHandle: null,
                currentPath: null,
                modRoot: null,
            });
        } catch (err) {
            setStatus(`Failed to open ${f.name}: ${err.message}`);
        }
    });

    // Toggles. Stock layouts are loaded in the background regardless; this
    // toggle only controls whether stock-origin frames render visually.
    els.toggleStockUi.addEventListener('change', () => rerender());
    els.viewMode.addEventListener('change', () => rerender());

    // Snap toggle: when on, the stage gets a CSS background-image showing
    // the grid so the user can SEE what they're snapping to. The grid
    // tracks the snap size live.
    const applyGridOverlay = () => {
        const on = els.toggleSnap.checked;
        const sz = parseFloat(els.snapSize.value) || 0;
        if (on && sz > 0) {
            els.stage.style.backgroundImage =
                `linear-gradient(to right, rgba(95,169,255,0.08) 1px, transparent 1px),`
                + ` linear-gradient(to bottom, rgba(95,169,255,0.08) 1px, transparent 1px)`;
            els.stage.style.backgroundSize = `${sz}px ${sz}px`;
        } else {
            els.stage.style.backgroundImage = '';
            els.stage.style.backgroundSize = '';
        }
    };
    els.toggleSnap.addEventListener('change', applyGridOverlay);
    els.snapSize.addEventListener('input', applyGridOverlay);
    applyGridOverlay();

    if (els.hintClose) {
        els.hintClose.addEventListener('click', () => {
            state.hintDismissed = true;
            try { localStorage.setItem('sc2editor.hintDismissed', '1'); } catch {}
            els.emptyHint.hidden = true;
        });
    }
    els.toggleOutlines.addEventListener('change', () => {
        document.body.classList.toggle('hide-outlines', !els.toggleOutlines.checked);
        rerender();
    });

    // Zoom and viewport.
    els.zoom.addEventListener('input', () => {
        const z = parseFloat(els.zoom.value);
        els.stage.style.transform = `scale(${z})`;
        els.zoomPct.textContent = Math.round(z * 100) + '%';
    });
    els.zoom.dispatchEvent(new Event('input'));

    // "Fit" button computes a zoom that makes the canvas fit the available
    // canvas-scroll area. Useful after resizing the window.
    function fitZoom() {
        const W = parseInt(els.stage.dataset.viewportW, 10) || 1920;
        const H = parseInt(els.stage.dataset.viewportH, 10) || 1080;
        const rect = els.canvasScroll.getBoundingClientRect();
        const pad = 48;   // canvas-root padding
        const z = Math.min(
            (rect.width - pad) / W,
            (rect.height - pad) / H,
        );
        const clamped = Math.max(0.1, Math.min(2, z));
        els.zoom.value = clamped;
        els.zoom.dispatchEvent(new Event('input'));
    }
    els.btnFit.addEventListener('click', fitZoom);
    // Auto-fit once at startup so the canvas fills whatever window size the
    // editor opens at, instead of always defaulting to 50%.
    requestAnimationFrame(fitZoom);
    // Re-fit when the window resizes IF the user hasn't manually adjusted
    // since (we treat any manual zoom-slider input as opting out). Exposed
    // on state so the PaneController can read the same flag.
    state.userAdjustedZoom = false;
    els.zoom.addEventListener('change', () => { state.userAdjustedZoom = true; });
    window.addEventListener('resize', () => {
        if (!state.userAdjustedZoom) fitZoom();
        // Reposition the selection overlay since the canvas may have moved.
        if (state.selected) selection.position();
    });

    els.viewport.addEventListener('change', () => {
        const [w, h] = els.viewport.value.split('x').map(Number);
        els.stage.style.width = w + 'px';
        els.stage.style.height = h + 'px';
        els.stage.dataset.viewportW = w;
        els.stage.dataset.viewportH = h;
        rerender();
    });

    // Backdrop image picker. Persist the picked image in localStorage so the
    // backdrop survives reloads. (The button moved into View menu as
    // "Set backdrop image..."; the file input handler stays here.)
    els.backdropInput.addEventListener('change', async (ev) => {
        const file = ev.target.files && ev.target.files[0];
        if (!file) return;
        const dataUrl = await fileToDataUrl(file);
        setBackdrop(dataUrl);
        try { localStorage.setItem('sc2editor.backdrop', dataUrl); } catch {}
        ev.target.value = '';
    });
    els.toggleBackdrop.addEventListener('change', () => {
        document.body.classList.toggle('hide-backdrop', !els.toggleBackdrop.checked);
    });
    const saved = localStorage.getItem('sc2editor.backdrop');
    if (saved) setBackdrop(saved);

    els.btnApplyXml.addEventListener('click', () => {
        try {
            applyXmlEditorText();
            setXmlStatus('Applied.');
        } catch (err) {
            setXmlStatus('Parse error: ' + err.message);
        }
    });
    // Text typed into the XML pane has not reached modDoc until Apply, but it
    // is still user work. Mark it dirty immediately so closing or opening a
    // different layout cannot discard it without a warning.
    els.xmlText.addEventListener('input', () => updateDirtyIndicator(true));
    // "Assets..." button - always-available access to SC2 install, stock data,
    // and texture extraction. Replaces the assets banner once it's dismissed.
    els.btnAssets.addEventListener('click', () => assetsUi && assetsUi.openDialog());

    // "Warnings" button opens the validator output dialog.
    if (els.btnWarnings) els.btnWarnings.addEventListener('click', openWarningsDialog);
    // Belt-and-braces: also bind an explicit close handler. Native
    // <form method="dialog"> + submit-button should close the dialog by
    // itself, but some browser / extension combos break that. This guarantees
    // the Close button always works.
    if (els.warningsDialog) {
        const closeBtn = els.warningsDialog.querySelector('button[value="close"]');
        if (closeBtn) closeBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            els.warningsDialog.close();
        });
    }

    // Click on empty canvas area (outside any frame) clears selection.
    els.stage.addEventListener('click', (ev) => {
        if (ev.target === els.stage || ev.target.id === 'backdrop-img') {
            selectFrame(null, false);
            state.lastClick = null;
        }
    });

    // Global keyboard shortcuts. Single-letter shortcuts only fire when
    // focus is NOT in an editable element (textarea/input/select) - we
    // don't want G to toggle snap while you're typing "gold" into a Texture
    // field. Ctrl+ shortcuts fire either way (they never conflict with
    // ordinary typing).
    window.addEventListener('keydown', (ev) => {
        const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
        const inEditable = tag === 'textarea' || tag === 'input' || tag === 'select';
        const ctrl = ev.ctrlKey || ev.metaKey;
        if (ctrl) {
            const key = ev.key.toLowerCase();
            if (inEditable && tag === 'textarea') {
                // Browser textarea owns ctrl+z/y, ctrl+a, etc.; only catch
                // commands that the textarea has no business handling.
                if (key === 's') { ev.preventDefault(); if (ev.shiftKey) saveAs(); else saveCurrent(); }
                else if (key === 'n') { ev.preventDefault(); createNewLayout(); }
                else if (key === 'o' && !ev.shiftKey) { ev.preventDefault(); openFile(); }
                return;
            }
            if (key === 'z' && !ev.shiftKey) { ev.preventDefault(); doUndo(); }
            else if (key === 'y' || (key === 'z' && ev.shiftKey)) { ev.preventDefault(); doRedo(); }
            else if (key === 's' && !ev.shiftKey) { ev.preventDefault(); saveCurrent(); }
            else if (key === 's' && ev.shiftKey) { ev.preventDefault(); saveAs(); }
            else if (key === 'n') { ev.preventDefault(); createNewLayout(); }
            else if (key === 'o' && !ev.shiftKey) { ev.preventDefault(); openFile(); }
            else if (key === 'e' && ev.shiftKey) { ev.preventDefault(); exportHtml(); }
            else if (key === 'p' && !ev.shiftKey) { ev.preventDefault(); findPalette.open(); }
            return;
        }
        // Single-letter shortcuts (canvas focus, no modifier).
        if (!inEditable) {
            switch (ev.key.toLowerCase()) {
                case 'g':                                       // snap toggle
                    ev.preventDefault();
                    els.toggleSnap.checked = !els.toggleSnap.checked;
                    els.toggleSnap.dispatchEvent(new Event('change'));
                    setStatus(`Snap: ${els.toggleSnap.checked ? 'on' : 'off'}`);
                    return;
                case 'o':                                       // outlines
                    ev.preventDefault();
                    els.toggleOutlines.checked = !els.toggleOutlines.checked;
                    els.toggleOutlines.dispatchEvent(new Event('change'));
                    return;
                case 'b':                                       // backdrop
                    ev.preventDefault();
                    els.toggleBackdrop.checked = !els.toggleBackdrop.checked;
                    els.toggleBackdrop.dispatchEvent(new Event('change'));
                    return;
                case 'f':                                       // fit-to-window zoom
                    ev.preventDefault();
                    els.btnFit.click();
                    return;
                case 'escape':                                  // deselect
                    if (state.selected) {
                        ev.preventDefault();
                        selectFrame(null, false);
                        state.lastClick = null;
                    }
                    return;
            }
        }
        // Delete key removes the selected mod-origin frame.
        if (!inEditable && (ev.key === 'Delete' || ev.key === 'Backspace')) {
            if (!state.selected) return;
            const frame = state.selected;
            if (frame.origin !== 'mod' || !frame._modSource) {
                setStatus(`Cannot delete ${frame.type}:${frame.name} - read-only.`);
                return;
            }
            ev.preventDefault();
            if (!confirm(`Delete frame "${frame.name}" and all its children?`)) return;
            snapshotForUndo();
            const parent = frame._modSource._parent;
            if (parent) {
                const idx = parent.children.indexOf(frame._modSource);
                if (idx >= 0) {
                    // Strip the preceding whitespace text node too so we don't
                    // leave double-blank-lines behind.
                    if (idx > 0 && parent.children[idx - 1].type === 'text'
                        && /^\s+$/.test(parent.children[idx - 1].raw)) {
                        parent.children.splice(idx - 1, 2);
                    } else {
                        parent.children.splice(idx, 1);
                    }
                    parent.dirty = true;
                }
            }
            selectFrame(null, false);
            rerender();
        }
    });
    window.addEventListener('beforeunload', (ev) => {
        if (!isDocumentDirty()) return;
        ev.preventDefault();
        ev.returnValue = '';
    });
    if (els.diagnosticsDialog) {
        els.diagnosticsDialog.addEventListener('close', () => {
            if (els.diagnosticsDialog.returnValue !== 'export') return;
            exportDiagnostics().catch((err) => {
                console.error('[diagnostics] export failed:', err);
                setStatus('Could not export diagnostics: ' + err.message);
            });
        });
    }
}

function hasFiles(ev) {
    if (!ev.dataTransfer) return false;
    for (const item of ev.dataTransfer.items || []) {
        if (item.kind === 'file') return true;
    }
    return false;
}

async function loadStockLayouts() {
    if (state.stockLoaded || state.stockLoading) return;
    state.stockLoading = true;
    setStatus('Loading stock templates…');
    console.info(`[stock] starting background load from ${STOCK_ASSETS_BASE}UI/Layout/descindex.sc2layout`);
    try {
        const result = await registry.loadCore(({ done, total }) => {
            setStatus(`Loading stock templates: ${done}/${total}`);
        });
        // Load the hand-maintained stock-frame positions table from /data.
        const seeded = await registry.loadStockFrameOverrides('data/stock-frames.json');
        state.stockLoaded = true;
        setStatus(`Stock templates ready: ${result.fileCount} files, ${registry.constants.size} constants, ${registry.templatesByName.size} templates, ${seeded} curated positions.`);
        console.info(`[stock] loaded ${result.fileCount} files; ${result.errorCount} errors; ${seeded} curated frame positions`);
        if (registry.errors.length) console.warn('[stock] first 5 errors:', registry.errors.slice(0, 5));
        if (state.modDoc) rerender();
    } catch (err) {
        setStatus('Stock load failed: ' + err.message);
        console.error('[stock] load failed:', err);
    } finally {
        state.stockLoading = false;
    }
}

async function openByUrl(path) {
    if (!path) return;
    if (!confirmDiscardChanges()) return;
    setStatus('Opening ' + path);
    try {
        // Layout files are edited outside the browser as well as inside it.
        // Bypass the HTTP cache so reopening a path always reads the current
        // file instead of silently restoring an older copy.
        const text = await fetch(path, { cache: 'no-store' }).then(r => {
            if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
            return r.text();
        });
        // Find the containing .SC2Mod folder (or .SC2Map) so the renderer
        // can resolve custom textures from that mod's Base.SC2Assets first.
        // e.g. /project/Shepherd/ShepardMod.SC2Mod/Base.SC2Data/UI/Layout/foo.SC2Layout
        //   -> /project/Shepherd/ShepardMod.SC2Mod
        const modRootMatch = path.match(/^(.*?\.SC2(Mod|Map))\//i);
        openFromText(text, path.split('/').pop(), {
            fileHandle: null,
            currentPath: path,
            modRoot: modRootMatch ? modRootMatch[1] : null,
        });
        setStatus('Opened ' + path);
    } catch (err) {
        setStatus('Failed to open: ' + err.message);
    }
}

function openFromText(text, fileName, context = {}) {
    // Parse before mutating ANY editor state. A malformed replacement must
    // leave the current document, writable handle, paths, and registries intact.
    const parsed = parseXml(text);
    state.pristineSource = text;
    state.modDoc = parsed;
    if (Object.prototype.hasOwnProperty.call(context, 'fileHandle')) {
        state.fileHandle = context.fileHandle;
    }
    if (Object.prototype.hasOwnProperty.call(context, 'currentPath')) {
        state.currentPath = context.currentPath;
    }
    if (Object.prototype.hasOwnProperty.call(context, 'modRoot')) {
        textures.setModRoot(context.modRoot);
    }
    // Tag every element with a _parent reference so the inspector's "Delete
    // frame" / "Duplicate" actions can walk to the containing element in O(1).
    const { fileBase, tmplCount, constCount } = rehydrateCurrentDocument(fileName);
    // Drop the previous document's undo/redo history. Without this, Ctrl+Z
    // after opening a new file would re-install a snapshot from the OLD file,
    // silently swapping the open document (cross-document undo). Covers every
    // entry point: Open, New, drag-drop, Apply-XML.
    undoStack.clear();
    state.currentFileName = fileName;
    state.activeStates.clear();
    // Enable menu items that need an open doc.
    if (menubar) {
        menubar.setEnabled('save', true);
        menubar.setEnabled('save-as', true);
        menubar.setEnabled('export-html', true);
    }
    // Register this file's bare-named top-level frames as templates so other
    // frames can resolve template="FileBase/Name" or template="Name".
    // Without this, frames inheriting from same-file templates render empty.
    console.info(`[open] ${fileName}: registered ${tmplCount} mod templates as "${fileBase}/*", ${constCount} constants`);
    els.xmlText.value = text;
    els.btnApplyXml.disabled = false;
    runRoundTripCheck();
    rerender();
    console.info(`[open] ${fileName}: ${state.frames.length} top-level frames; stockLoaded=${state.stockLoaded}`);
    if (state.frames.length === 0) {
        setStatus(`Opened ${fileName} but no renderable frames - check the XML pane for unrecognised structure.`);
    }
    // Kick off CASC auto-extract for this file's texture references. Server
    // silently skips files already on disk so the first open after a clean
    // install pulls textures while the canvas already renders box outlines.
    maybeAutoExtractTextures();
}

// Commit the XML pane as an edit of the current document. This deliberately
// differs from openFromText(): Apply must preserve the writable file handle,
// original pristine source, path/mod-root context, and existing undo history.
// Treating Apply as a new document used to make the edited text appear saved
// and made Ctrl+Z unable to recover the prior document state.
function applyXmlEditorText() {
    const text = els.xmlText.value;
    const parsed = parseXml(text); // Parse first so a syntax error changes nothing.
    snapshotForUndo();
    state.modDoc = parsed;
    rehydrateCurrentDocument();
    state.activeStates.clear();
    rerender({ keepSelection: true });
    maybeAutoExtractTextures();
}

// Save always includes the text currently visible in the XML pane. If it has
// not been applied yet, commit it first; invalid XML blocks the save instead
// of silently writing the older canvas model.
function applyPendingXmlBeforeSave() {
    if (!state.modDoc) return false;
    const serialized = serializeXml(state.modDoc);
    if (els.xmlText.value === serialized) return true;
    try {
        applyXmlEditorText();
        return true;
    } catch (err) {
        setXmlStatus('Parse error: ' + err.message);
        setStatus('Save blocked: fix or revert the invalid XML in the XML pane.');
        return false;
    }
}

// Restore all non-serialized links and registry overlays for the current
// parsed document. Undo/redo and ordinary opens both go through these helpers.
function rehydrateCurrentDocument(fileName = state.currentFileName) {
    setParentRefs(state.modDoc);
    return registerCurrentDocument(fileName);
}

function registerCurrentDocument(fileName = state.currentFileName) {
    const safeName = fileName || 'layout.SC2Layout';
    const fileBase = safeName.replace(/\.[^.]+$/, '').split(/[\\\/]/).pop();
    const tmplCount = registry.addModTemplates(state.modDoc && state.modDoc.root, fileBase);
    const constCount = registry.addModConstants(state.modDoc && state.modDoc.root);
    return { fileBase, tmplCount, constCount };
}

// Scan the currently-open mod doc for every asset reference (textures, the
// layout files referenced by template= attributes, <Include> paths, and the
// fontstyle/font dependencies of any <Style val="..."> references) and ask
// the server to pull anything missing from CASC. Idempotent: server skips
// files already on disk. No-op if SC2 install isn't known.
let autoExtractInFlight = false;
async function maybeAutoExtractTextures() {
    if (autoExtractInFlight) return;
    if (!state.modDoc || !state.modDoc.root) return;
    if (!state.config || !state.config.sc2_install) return;
    const refs = collectAssetRefs(state.modDoc.root);
    const total = refs.textures.length + refs.layouts.length + refs.includes.length;
    if (total === 0 && !refs.uses_styles) return;
    autoExtractInFlight = true;
    setStatus(`Auto-fetch: ${refs.textures.length} textures, ${refs.layouts.length} layouts, ${refs.includes.length} includes…`);
    try {
        const body = {
            texture_refs: refs.textures,
            layout_refs:  refs.layouts,
            include_refs: refs.includes,
            // Pull the FontStyles + a few common fonts the first time any
            // Style attribute appears, so labels render in real typography.
            include_fontstyles: refs.uses_styles,
        };
        const resp = await fetch('/__cascextract', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-SC2UI-Token': state.config.session_token || '',
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            setStatus(`Auto-fetch: server returned ${resp.status}`);
            return;
        }
        const r = await resp.json();
        if (r.error) {
            console.warn('[cascextract auto]', r);
            return;
        }
        if (r.extracted > 0) {
            console.info(`[cascextract auto] pulled ${r.extracted} files (${(r.bytes / 1024).toFixed(0)} KB); ${r.failed.length} not in CASC`);
            if (r.failed.length) console.debug('[cascextract auto] not found:', r.failed.slice(0, 10), '...');
            // Drop caches and reload templates so newly-extracted layouts
            // contribute their templates to the registry. (R4.4 unified
            // this block with refreshAfterAssetChange.)
            await resetAssetDependentCaches();
            setStatus(`Auto-fetched ${r.extracted} new files, ${r.skipped} already on disk.`);
        } else if (r.skipped > 0) {
            setStatus(`All ${r.skipped} referenced files already on disk.`);
        } else {
            setStatus(`Auto-fetch complete (${r.failed.length} not in CASC).`);
        }
    } catch (err) {
        console.warn('[cascextract auto] failed:', err);
    } finally {
        autoExtractInFlight = false;
    }
}

// Collect every kind of asset reference the open file makes.
// Returns { textures, layouts, includes, uses_styles }.
//   textures   - raw <Texture val="..."/> strings (alias or literal)
//   layouts    - filenames for layouts referenced via template="File/Name"
//                or "<Frame name='File/Name'>" (e.g. "StandardTemplates").
//                We resolve to "<filename>.SC2Layout" server-side.
//   includes   - <Include path="..."/> values, verbatim.
//   uses_styles - true if any <Style val="..."> appears anywhere.
function collectAssetRefs(root) {
    const textures = new Set();
    const layouts = new Set();
    const includes = new Set();
    let usesStyles = false;
    const walk = (el) => {
        if (!el || !el.children) return;
        for (const c of el.children) {
            if (c.type !== 'element') continue;
            // template="FileBase/Name" or template="Name" on any element.
            if (c.attrs) {
                for (const a of c.attrs) {
                    if (a.name === 'template' && a.value) {
                        const segs = a.value.split('/');
                        if (segs.length >= 2) layouts.add(segs[0]);   // file part
                    }
                }
            }
            if (c.tag === 'Texture') {
                const v = (c.attrs.find(a => a.name === 'val') || {}).value;
                if (v) textures.add(v);
            } else if (c.tag === 'Style') {
                usesStyles = true;
            } else if (c.tag === 'Include') {
                const v = (c.attrs.find(a => a.name === 'path') || {}).value;
                if (v) includes.add(v);
            }
            walk(c);
        }
    };
    walk(root);
    return {
        textures: [...textures],
        layouts: [...layouts],
        includes: [...includes],
        uses_styles: usesStyles,
    };
}

function rerender(opts = {}) {
    if (!state.modDoc || !state.modDoc.root) {
        renderer.clear();
        tree.render([]);
        selection.hide();
        return;
    }
    const W = parseInt(els.stage.dataset.viewportW, 10) || 1920;
    const H = parseInt(els.stage.dataset.viewportH, 10) || 1080;
    const includeStock = els.toggleStockUi.checked && state.stockLoaded;

    // Live-drag fast path: reuse the previous frame tree's DOM elements and
    // only update their layout-resolved positions/sizes. Avoids the magenta
    // texture flicker that a full DOM teardown causes on every pointermove.
    if (opts.positionsOnly && state.frames.length) {
        // We have to rebuild the merged tree to pick up the new XML offsets,
        // but DON'T recreate DOM - splice node._el references from the old
        // tree onto the new tree by matching frame paths.
        const merged = new MergedTree(registry);
        if (state.stockLoaded) merged.mergeStock();
        merged.mergeMod(state.modDoc.root);
        const newAll = merged.asFrameList({ includeStock });
        const viewMode = els.viewMode ? els.viewMode.value : 'game';
        const newFrames = filterByViewMode(newAll, viewMode);
        // Transfer _el from old to new by path.
        const oldByPath = new Map();
        const collect = (nodes) => { for (const n of nodes) { oldByPath.set(n.path, n); collect(n.children || []); } };
        collect(state.frames);
        const patch = (nodes) => {
            for (const n of nodes) {
                const prev = oldByPath.get(n.path);
                if (prev && prev._el) n._el = prev._el;
                if (n.children && n.children.length) patch(n.children);
            }
        };
        patch(newFrames);
        state.frames = newFrames;
        // Re-apply active StateGroup actions so a state-driven visibility /
        // color override survives the live fast path. Without this, a frame
        // hidden by the active Hover/Pressed preview (or its color override)
        // flickers back to its base appearance during a drag/spin and only
        // settles on commit, since the fast path rebuilds the tree fresh.
        applyStateActions(state.frames, state.activeStates);
        state.layoutDiagnostics = layoutFrames(state.frames, W, H);
        renderer.updatePositions(state.frames);
        if (opts.keepSelection && state.selected) {
            const found = findFrameByPath(state.frames, state.selected.path);
            if (found) {
                state.selected = found;
                selection.show(found);
            }
        }
        return;
    }

    const merged = new MergedTree(registry);
    if (state.stockLoaded) merged.mergeStock();
    merged.mergeMod(state.modDoc.root);

    const allFrames = merged.asFrameList({ includeStock });
    // View mode filter:
    //   "game"   - hide templates and pure-template subtrees from the canvas
    //   "placed" - show all top-level frames (templates included) but only those
    //              that actually got resolved positions; this is the legacy view
    //   "all"    - show everything (debug)
    const viewMode = els.viewMode ? els.viewMode.value : 'game';
    state.frames = filterByViewMode(allFrames, viewMode);
    updateEmptyHint(state.frames);
    state.layoutDiagnostics = layoutFrames(state.frames, W, H);
    // Apply user-selected state overrides (Hover / Pressed / Checked / etc.)
    // BEFORE the renderer paints, so state-driven visibility + color show.
    applyStateActions(state.frames, state.activeStates);
    renderer.render(state.frames);
    if (!opts.skipDecorate) decorate(state.frames);
    if (!opts.skipPaneUpdates) tree.render(state.frames);

    // Re-locate previously selected frame after a re-render. Path-only -
    // no name fallback. The previous fallback (findFrameByName) could swap
    // the selection silently when two frames share a name at different
    // paths (Button0/Button vs Button1/Button is common in SC2 layouts).
    // If the frame's path no longer exists after rerender it's gone, and
    // we'd rather lose the selection than pick a same-named cousin.
    if (opts.keepSelection && state.selected) {
        const found = findFrameByPath(state.frames, state.selected.path);
        if (found) {
            state.selected = found;
            if (found._el) found._el.classList.add('selected');
            selection.show(found);
            if (!opts.skipPaneUpdates) inspector.show(found);
        } else {
            // Selected frame is gone - clear so subsequent renders don't
            // try to operate on a dangling reference.
            state.selected = null;
            selection.hide();
        }
    } else if (state.selected) {
        const found = findFrameByPath(state.frames, state.selected.path);
        if (found) selectFrame(found, false);
        else { state.selected = null; selection.hide(); }
    }
    if (!opts.skipPaneUpdates) {
        els.xmlText.value = serializeXml(state.modDoc);
        runRoundTripCheck();
        updateDirtyIndicator();
        refreshWarnings();
    }
}

// --- validator wiring -----------------------------------------------------

let cachedWarnings = [];

function refreshWarnings() {
    cachedWarnings = state.modDoc
        ? validate(state.modDoc, registry, { fileName: state.currentFileName })
        : [];
    if (state.modDoc && state.frames.length) {
        const visual = buildReadinessSummary({ frames: state.frames }).visualWarnings;
        for (const warning of visual) {
            const frame = findFrameByPath(state.frames, warning.framePath);
            cachedWarnings.push({
                severity: 'warning',
                kind: 'visual',
                framePath: warning.framePath,
                message: warning.message,
                element: frame?._modSource || null,
            });
        }
    }
    const counts = countBySeverity(cachedWarnings);
    if (!els.btnWarnings) return;
    // Only show the button when there's something actionable to surface.
    // Info-only diagnostics aren't worth a topbar badge.
    const shouldShow = counts.error > 0 || counts.warning > 0;
    els.btnWarnings.hidden = !shouldShow;
    if (!shouldShow) return;
    els.warningsCount.textContent = String(counts.error + counts.warning);
    els.btnWarnings.disabled = false;
    els.btnWarnings.classList.toggle('has-errors', counts.error > 0);
    els.btnWarnings.classList.toggle('has-warnings', counts.error === 0 && counts.warning > 0);
    els.btnWarnings.title =
        `${counts.error} errors, ${counts.warning} warnings, ${counts.info} info. Click to view.`;
}

function countBySeverity(list) {
    const c = { error: 0, warning: 0, info: 0 };
    for (const w of list) {
        if (w.severity === 'error') c.error++;
        else if (w.severity === 'warning') c.warning++;
        else c.info++;
    }
    return c;
}

function openWarningsDialog() {
    if (!els.warningsDialog) return;
    const body = els.warningsDialogBody;
    body.replaceChildren();
    const c = countBySeverity(cachedWarnings);
    els.warningsDialogCount.textContent = cachedWarnings.length
        ? `(${c.error} errors, ${c.warning} warnings, ${c.info} info)`
        : '';
    if (!cachedWarnings.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'No warnings. Layout looks clean.';
        body.appendChild(p);
    } else {
        for (const w of cachedWarnings) {
            const row = document.createElement('div');
            row.className = 'warning-item';
            row.innerHTML = `
                <div><span class="warning-severity ${w.severity}">${w.severity}</span></div>
                <div>
                    <div class="warning-frame">${escapeHtml(w.framePath)}</div>
                    <div class="warning-message">${escapeHtml(w.message)}</div>
                </div>
            `;
            row.addEventListener('click', () => {
                if (!w.element) return;
                // Select the offending frame on the canvas. We match by the
                // underlying XML element pointer via _modSource.
                const target = findFrameByModSource(state.frames, w.element);
                if (target) {
                    selectFrame(target, false);
                    els.warningsDialog.close();
                }
            });
            body.appendChild(row);
        }
    }
    els.warningsDialog.showModal();
}

function findFrameByModSource(frames, source) {
    for (const f of frames) {
        if (f._modSource === source) return f;
        const r = findFrameByModSource(f.children || [], source);
        if (r) return r;
    }
    return null;
}

function filterByViewMode(frames, mode) {
    if (mode === 'all') return frames;
    if (mode === 'placed') {
        // Hide nothing extra beyond what asFrameList already did.
        return frames;
    }
    // "game": drop templates at the top level. Keep their children only if
    // those children are themselves not templates (rare; templates contain
    // sub-frames that only render when instantiated, so this is usually empty).
    const out = [];
    for (const n of frames) {
        if (n.isTemplate) continue;
        out.push(n);
    }
    return out;
}

function updateEmptyHint(frames) {
    // Show the "load a backdrop" hint when no backdrop AND user hasn't
    // dismissed it. Once dismissed it stays dismissed for the session
    // (persisted to localStorage so it doesn't nag on every reload).
    if (!els.emptyHint) return;
    const hasBackdrop = els.stage.classList.contains('has-backdrop');
    const dismissed = state.hintDismissed || localStorage.getItem('sc2editor.hintDismissed') === '1';
    els.emptyHint.hidden = hasBackdrop || !state.modDoc || dismissed;
}

// Recursively annotate every element node with a _parent reference so the
// inspector's removeFromParent / duplicate helpers can navigate upward.
// Called once per file open; the parent set is preserved across mutations
// because we mutate the existing parent's children array in place.
function setParentRefs(root) {
    const walk = (node, parent) => {
        if (!node) return;
        if (node.type === 'element' || node.type === 'document') {
            if (parent) node._parent = parent;
            if (node.children) {
                for (const c of node.children) walk(c, node);
            }
        }
    };
    walk(root, null);
}

function findFrameByPath(frames, path) {
    for (const f of frames) {
        if (f.path === path) return f;
        const r = findFrameByPath(f.children || [], path);
        if (r) return r;
    }
    return null;
}

// Layout walker moved to render/layout.js in R4.7.

// Apply origin/outline classes and add a name label to each frame for clarity.
function decorate(nodes) {
    for (const n of nodes) {
        if (!n._el) continue;
        if (n.origin === 'stock') n._el.classList.add('stock');
        n._el.dataset.origin = n.origin;
        if (n.isTemplate) n._el.dataset.template = 'true';
        if (els.toggleOutlines.checked && !n.synthetic) {
            n._el.classList.add('visible-outline');
            const lbl = document.createElement('span');
            lbl.className = 'frame-label';
            const suffix = n.isTemplate ? ' (template)' : '';
            lbl.textContent = `${n.type}:${n.name}${suffix}`;
            n._el.appendChild(lbl);
        }
        if (n.children && n.children.length) decorate(n.children);
    }
}

// (findFrameByName removed in the Round 5 audit — it was only self-recursive
// with no external caller. Selection is by path via findFrameByPath.)

function snapshotForUndo() {
    undoStack.snapshot(state.modDoc);
}

function doUndo() {
    const prev = undoStack.popForUndo(state.modDoc);
    if (prev == null) { setStatus('Nothing to undo.'); return; }
    // Re-parse the snapshot rather than mutating in place so all references
    // (sources, props arrays) are rebuilt cleanly.
    state.modDoc = parseXml(prev);
    rehydrateCurrentDocument();
    els.xmlText.value = prev;
    rerender({ keepSelection: true });
    setStatus(`Undo. ${undoStack.undo.length} more available.`);
}

function doRedo() {
    const next = undoStack.popForRedo(state.modDoc);
    if (next == null) { setStatus('Nothing to redo.'); return; }
    state.modDoc = parseXml(next);
    rehydrateCurrentDocument();
    els.xmlText.value = next;
    rerender({ keepSelection: true });
    setStatus(`Redo. ${undoStack.redo.length} more available.`);
}

// Click on a canvas frame. If repeated at ~same point, cycle through frames
// stacked at that point (topmost on first click, then next behind, etc.).
function handleCanvasClick(node, hit) {
    if (!hit) { selectFrame(node, true); return; }
    const SAME_POINT_TOLERANCE = 6;
    const same = state.lastClick
        && Math.abs(state.lastClick.x - hit.x) < SAME_POINT_TOLERANCE
        && Math.abs(state.lastClick.y - hit.y) < SAME_POINT_TOLERANCE;
    if (!same) {
        state.lastClick = { x: hit.x, y: hit.y, stack: null, index: 0 };
    }
    // Build the stack of frames at this point on the first click; reuse on cycles.
    if (!state.lastClick.stack) {
        const els = document.elementsFromPoint(hit.x, hit.y)
            .filter(e => e.classList && e.classList.contains('sc2-frame'));
        const stack = [];
        for (const el of els) {
            const n = renderer.nodesByEl.get(el);
            if (n) stack.push(n);
        }
        state.lastClick.stack = stack;
        state.lastClick.index = 0;
    } else {
        state.lastClick.index = (state.lastClick.index + 1) % Math.max(1, state.lastClick.stack.length);
    }
    const stack = state.lastClick.stack;
    const target = stack[state.lastClick.index] || node;
    selectFrame(target, true);
    if (stack.length > 1) {
        setStatus(`Cycled to ${state.lastClick.index + 1}/${stack.length}: ${target.type}:${target.name}`);
    }
}

function selectFrame(frame, fromCanvas) {
    state.selected = frame;
    if (!frame) {
        inspector.show(null);
        selection.hide();
        refreshGuidedDialog();
        return;
    }
    inspector.show(frame);
    tree.select(frame);
    for (const sel of els.stage.querySelectorAll('.sc2-frame.selected')) {
        sel.classList.remove('selected');
    }
    if (frame._el) frame._el.classList.add('selected');
    selection.show(frame);
    refreshGuidedDialog();
}

// Called from the SelectionOverlay after every pointermove and on pointerup.
// Both paths use positionsOnly so the canvas DOM is preserved (no texture
// flicker). On release we additionally sync the side panes (inspector +
// tree + XML pane + round-trip status) so they reflect the final state.
// During the drag we compute + render smart alignment guides; on release
// we clear them.
function handleEdit(node, live) {
    if (!state.modDoc) return;
    rerender({ keepSelection: true, positionsOnly: true });
    if (live) {
        // Recompute guides against the frame's just-updated position. Skipped
        // for inspector edits since this handler is only wired to the canvas
        // drag pipeline.
        if (state.selected) {
            const guides = computeGuides(state.selected, state.frames);
            renderGuides(els.stage, guides);
        }
    } else {
        clearGuides(els.stage);
        tree.render(state.frames);
        if (state.selected) inspector.show(state.selected);
        els.xmlText.value = serializeXml(state.modDoc);
        runRoundTripCheck();
        updateDirtyIndicator();
    }
}

// Export the rendered canvas as a standalone .html file. Walks the live DOM
// (every .sc2-frame element under the canvas-stage) and emits an HTML
// document with the same structure. Texture canvases get serialized via
// canvas.toDataURL() so the resulting .html is self-contained - no external
// asset fetches needed when opened elsewhere.
async function exportHtml() {
    if (!state.modDoc || !state.frames.length) {
        setStatus('Nothing to export. Open a layout first.');
        return;
    }
    setStatus('Exporting HTML: waiting for textures…');
    // Wait for every in-flight texture load before serializing the canvases.
    // textures.cache holds the Promise<HTMLCanvasElement|null> for every ref
    // currently fetched; if we serialize too early we get blank PNGs.
    try {
        await Promise.all([...textures.cache.values()].map(p => p.catch(() => null)));
    } catch {}
    // Allow one paint cycle so any just-completed canvas insertions render.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    setStatus('Exporting HTML: serializing…');
    const W = parseInt(els.stage.dataset.viewportW, 10) || 1920;
    const H = parseInt(els.stage.dataset.viewportH, 10) || 1080;

    // Clone the stage DOM so we can mutate without disturbing the editor.
    const stageClone = els.stage.cloneNode(true);
    // Drop editor-only elements: selection overlay, drop hints, etc.
    for (const sel of ['.selection-overlay', '#backdrop-img']) {
        for (const node of stageClone.querySelectorAll(sel)) node.remove();
    }
    // Drop editor decoration: outlines, labels.
    for (const node of stageClone.querySelectorAll('.frame-label')) node.remove();
    for (const node of stageClone.querySelectorAll('.sc2-frame')) {
        node.classList.remove('outline', 'visible-outline', 'selected', 'synthetic');
        node.removeAttribute('data-origin');
        node.removeAttribute('data-template');
        node.removeAttribute('data-name');
        node.removeAttribute('data-type');
        node.removeAttribute('title');
    }
    // Convert each <canvas> with rendered texture into an <img> with a
    // base64 data URI so the HTML is portable.
    for (const canvas of stageClone.querySelectorAll('canvas')) {
        try {
            const url = canvas.toDataURL('image/png');
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.display = 'block';
            canvas.replaceWith(img);
        } catch (err) {
            console.warn('[exportHtml] could not serialize canvas:', err);
        }
    }

    const fname = (state.currentFileName || 'layout.SC2Layout').replace(/\.[^.]+$/, '') + '.html';
    const title = state.currentFileName || 'SC2 Layout Preview';
    const css = `
:root { color-scheme: dark; }
body { margin:0; background:#0a0c10; color:#d6d8dc; font:13px "Segoe UI", system-ui, sans-serif; }
.preview-wrapper { padding: 24px; display: flex; justify-content: center; }
.sc2-stage {
    position: relative; background: #050608;
    width: ${W}px; height: ${H}px; flex: 0 0 auto;
    box-shadow: 0 0 0 1px #3a3d44, 0 0 30px rgba(0,0,0,0.6);
}
.sc2-frame { position: absolute; box-sizing: border-box; }
.sc2-image, .sc2-label, .sc2-button { position: absolute; inset: 0; }
.sc2-label { display: flex; align-items: center; overflow: hidden; }
.preview-meta { color:#8a8d94; font-size:12px; padding:0 24px 24px; text-align:center; }
.preview-meta code { color:#5fa9ff; }
`.trim();

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} - SC2 Layout Preview</title>
<style>${css}</style>
</head>
<body>
<div class="preview-wrapper">${stageClone.outerHTML.replace(/id="canvas-stage"/, 'class="sc2-stage"')}</div>
<p class="preview-meta">Exported from <code>SC2 UI Editor v${escapeHtml(VERSION)}</code> &middot; source: <code>${escapeHtml(state.currentFileName || '(unknown)')}</code></p>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    const sizeKb = (blob.size / 1024).toFixed(1);
    setStatus(`Exported ${fname} (${sizeKb} KB) - self-contained, opens in any browser.`);
}

// Constants browser (View -> Constants). Read-only list of every <Constant>
// visible to the layout - stock plus the open mod's own - with the raw value
// and the #-resolved final value. A filter narrows by name or value.
function openConstantsDialog() {
    const dlg = els.constantsDialog;
    if (!dlg) return;
    // Union of stock + the open mod's constants. Mod wins on a name collision
    // (matches resolveValue), so it's tagged "mod" and shows the mod value.
    const allNames = new Set([...registry.constants.keys(), ...registry.modConstants.keys()]);
    const rows = [];
    for (const name of allNames) {
        const isMod = registry.modConstants.has(name);
        const value = isMod ? registry.modConstants.get(name) : registry.constants.get(name);
        const resolved = registry.resolveValue('#' + name);
        rows.push({
            name,
            value,
            // Only meaningful when the value was itself a #-reference chain.
            resolved: resolved !== value ? resolved : '',
            source: isMod ? 'mod' : 'stock',
        });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));

    const render = (filter) => {
        const f = (filter || '').toLowerCase().trim();
        const shown = f
            ? rows.filter(r => r.name.toLowerCase().includes(f) || String(r.value).toLowerCase().includes(f))
            : rows;
        els.constantsCount.textContent = rows.length
            ? `(${shown.length}${f ? ' of ' + rows.length : ''})` : '';
        if (!rows.length) {
            els.constantsBody.innerHTML = '<p class="hint">No constants visible. Stock constants load with the stock UI (enable "Show stock UI" or open a layout); mod constants come from the open layout.</p>';
            return;
        }
        const cells = shown.map(r => `
            <tr>
                <td><code>#${escapeHtml(r.name)}</code></td>
                <td><code>${escapeHtml(String(r.value))}</code></td>
                <td>${r.resolved ? `<code>${escapeHtml(String(r.resolved))}</code>` : '<span class="hint">—</span>'}</td>
                <td><span class="const-src const-src-${r.source}">${r.source}</span></td>
            </tr>`).join('');
        els.constantsBody.innerHTML = `
            <table class="constants-table">
                <thead><tr><th>Name</th><th>Value</th><th>Resolved</th><th>Source</th></tr></thead>
                <tbody>${cells || '<tr><td colspan="4" class="hint">No match.</td></tr>'}</tbody>
            </table>`;
    };
    render('');
    if (els.constantsFilter) {
        els.constantsFilter.value = '';
        els.constantsFilter.oninput = () => render(els.constantsFilter.value);
    }
    dlg.showModal();
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// --- authoring -------------------------------------------------------------

// Start a fresh layout. The minimal valid .SC2Layout is just <Desc/>; we
// emit it as a properly-formatted skeleton so a serializer round-trip stays
// idempotent.
function createNewLayout() {
    if (!confirmDiscardChanges()) return;
    const SKELETON =
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n' +
        '<Desc>\n' +
        '</Desc>\n';
    openFromText(SKELETON, 'untitled.SC2Layout', {
        fileHandle: null,
        currentPath: null,
        modRoot: null,
    });
    setStatus('New blank layout. Use "+ Add frame..." to start adding content.');
}

// Insert a new <Frame type="X" name="..."/> with sensible defaults under
// the currently-selected frame (or document root if no selection). Selects
// the new frame so the user can immediately edit it via the inspector.
function addNewFrame(type) {
    if (!state.modDoc || !state.modDoc.root) {
        createNewLayout();
        if (!state.modDoc || !state.modDoc.root) return;
    }
    const selectedBefore = state.selected;
    const name = uniqueSelectionChildName(selectedBefore, type);
    const newFrame = buildFrameElement(type, name, {
        frameIndent: insertionFrameIndent(selectedBefore),
    });
    snapshotForUndo();
    const insertion = appendFrameAtSelection(state.modDoc, selectedBefore, newFrame);
    setParentRefs(state.modDoc);   // re-link _parent refs for the new subtree
    rerender();
    // Try to select the new frame in the rerendered tree. Path is parent path
    // + "/" + name (or just name if parent is the root <Desc>).
    const selPath = insertion.parentPath
        ? `${insertion.parentPath}/${name}`
        : name;
    // Path-only lookup: uniqueChildName guarantees no path collision
    // inside `parent`, so falling back to name (the old code did) is both
    // unnecessary AND risks matching a same-named frame elsewhere in the
    // tree. If path lookup fails the insert was inconsistent with the
    // rerender - better to surface that than paper over it.
    const target = findFrameByPath(state.frames, selPath);
    if (target) selectFrame(target, false);
    const overrideNote = insertion.createdOverride
        ? ` Created an override for stock frame ${insertion.parentPath}.`
        : '';
    setStatus(`Inserted ${type}:${name}.${overrideNote} Edit it in the inspector or drag it on the canvas.`);
}

function uniqueSelectionChildName(selected, type) {
    if (selected && selected._modSource) return uniqueChildName(selected._modSource, type);
    const taken = new Set((selected?.children || []).map(child => child.name));
    if (!selected && state.modDoc?.root) {
        for (const child of state.modDoc.root.children || []) {
            if (child.type !== 'element') continue;
            const attr = child.attrs?.find(item => item.name === 'name');
            if (attr) taken.add(attr.value);
        }
    }
    let n = 0;
    while (taken.has(`${type}${n}`)) n++;
    return `${type}${n}`;
}

function insertionFrameIndent(selected) {
    if (selected?._modSource) return inferChildIndent(selected._modSource);
    const rootIndent = inferChildIndent(state.modDoc.root);
    if (selected?.path && !selected.synthetic) return oneIndentDeeper(rootIndent);
    return rootIndent;
}

function uniqueChildName(parent, type) {
    const taken = new Set();
    for (const c of parent.children) {
        if (c.type !== 'element') continue;
        const a = c.attrs && c.attrs.find(x => x.name === 'name');
        if (a) taken.add(a.value);
    }
    let n = 0;
    while (taken.has(`${type}${n}`)) n++;
    return `${type}${n}`;
}

// Build a <Frame type="..." name="..."> element with default anchors and
// size. SC2's composite controls depend on fixed internal descendants and
// control properties. Inherit Blizzard's stock templates instead of trying
// to reproduce a partial control: a partial Button/CheckBox/EditBox/ListBox
// can render in this editor yet fail or appear invisible in the game.
function buildFrameElement(type, name, options = {}) {
    const close = options.frameIndent || '\n    ';
    const i = oneIndentDeeper(close);
    const i2 = oneIndentDeeper(i);
    const children = [
        textNode(i),
        elementNode('Anchor', [['side','Top'],['relative','$parent'],['pos','Min'],['offset', options.top ?? '0']], true),
        textNode(i),
        elementNode('Anchor', [['side','Left'],['relative','$parent'],['pos','Min'],['offset', options.left ?? '0']], true),
        textNode(i),
        elementNode('Width', [['val', options.width ?? '100']], true),
        textNode(i),
        elementNode('Height', [['val', options.height ?? '100']], true),
    ];
    if (type === 'Label') {
        children.push(textNode(i), elementNode('Text', [['val','New Label']], true));
        children.push(textNode(i), elementNode('Style', [['val','StandardTemplate']], true));
    } else if (type === 'Image') {
        // Empty Texture - user fills in via inspector or XML.
        children.push(textNode(i), elementNode('Texture', [['val','']], true));
    } else if (type === 'Button') {
        // StandardButtonTemplate supplies SC2's real NormalImage, HoverImage,
        // hit-test frame, sound, and control style. Re-open only Label to set
        // the caption. SC2 merges this child with the template's Label.
        children.push(textNode(i),
            elementNode('Frame', [['type','Label'],['name','Label']], false, [
                textNode(i2),
                elementNode('Text', [['val', options.text ?? 'New Button']], true),
                textNode(i),
            ]));
    } else if (type === 'CheckBox') {
        // The stock labeled-checkbox template relies on native image sizing.
        // The browser preview cannot infer that synchronously from DDS files,
        // so re-open the two button images with explicit edge anchors. These
        // merge into the inherited controls and are also valid in SC2.
        const i3 = oneIndentDeeper(i2);
        const filledButtonImage = (childName, texture) => elementNode(
            'Frame', [['type','Image'],['name', childName]], false, [
                textNode(i3), elementNode('Anchor', [['side','Top'],['relative','$parent'],['pos','Min'],['offset','0']], true),
                textNode(i3), elementNode('Anchor', [['side','Bottom'],['relative','$parent'],['pos','Max'],['offset','0']], true),
                textNode(i3), elementNode('Anchor', [['side','Left'],['relative','$parent'],['pos','Min'],['offset','0']], true),
                textNode(i3), elementNode('Anchor', [['side','Right'],['relative','$parent'],['pos','Max'],['offset','0']], true),
                textNode(i3), elementNode('Texture', [['val', texture]], true),
                textNode(i2),
            ]);
        children.push(textNode(i), elementNode(
            'Frame', [['type','Button'],['name','Button']], false, [
                textNode(i2), filledButtonImage('NormalImage', '@@UI/StandardCheckBox'),
                textNode(i2), filledButtonImage('HoverImage', '@@UI/StandardCheckBoxHover'),
                textNode(i),
            ]));
        children.push(textNode(i), elementNode(
            'Frame', [['type','Label'],['name','Label']], false, [
                textNode(i2), elementNode('Anchor', [['side','Top'],['relative','$parent'],['pos','Min'],['offset','0']], true),
                textNode(i2), elementNode('Anchor', [['side','Bottom'],['relative','$parent'],['pos','Max'],['offset','0']], true),
                textNode(i2), elementNode('Anchor', [['side','Right'],['relative','$parent'],['pos','Max'],['offset','0']], true),
                textNode(i2), elementNode('Text', [['val', options.text ?? 'New CheckBox']], true),
                textNode(i),
            ]));
    }
    children.push(textNode(close));
    const attrs = [['type', type], ['name', name]];
    const stockTemplates = {
        Button: 'StandardTemplates/StandardButtonTemplate',
        CheckBox: 'StandardTemplates/StandardCheckBoxLabelTemplate',
        EditBox: 'StandardTemplates/StandardEditBoxTemplate',
        ListBox: 'StandardTemplates/StandardListBoxTemplate',
    };
    if (stockTemplates[type]) attrs.push(['template', stockTemplates[type]]);
    return elementNode('Frame', attrs, false, children);
}

// --- guided / simple authoring --------------------------------------------

function setSimpleMode(enabled, { persist = true } = {}) {
    const on = !!enabled;
    document.body.classList.toggle('simple-mode', on);
    if (els.beginnerBar) els.beginnerBar.hidden = !on;
    if (els.toggleSimpleMode) els.toggleSimpleMode.checked = on;
    if (persist) {
        try { localStorage.setItem('sc2editor.simpleMode', on ? '1' : '0'); } catch {}
    }
    requestAnimationFrame(() => els.btnFit?.click());
    setStatus(on
        ? 'Simple mode is on. Select a control, then use the task buttons above the preview.'
        : 'Simple mode is off. Advanced panels are visible.');
}

function openGuidedDialog() {
    if (!state.modDoc) {
        createNewLayout();
        if (!state.modDoc) return;
    }
    if (!els.guidedDialog) return;
    refreshGuidedDialog();
    if (!els.guidedDialog.open) els.guidedDialog.showModal();
}

function refreshGuidedDialog() {
    if (!els.guidedDialog) return;
    const selected = state.selected;
    els.guidedSelection.textContent = selected
        ? `${selected.type}:${selected.name}  (${selected.path})`
        : 'Nothing selected';
    const editable = !!selected?._modSource;
    for (const control of [
        els.guidedDuplicate, els.guidedShow, els.guidedHide, els.guidedGrow,
        els.guidedWidth, els.guidedHeight, els.guidedResize,
    ]) {
        if (control) control.disabled = !editable;
    }
    for (const button of document.querySelectorAll('[data-guided-nudge]')) button.disabled = !editable;
    if (els.guidedWidth) els.guidedWidth.value = editable && Number.isFinite(selected.w) ? String(Math.round(selected.w)) : '';
    if (els.guidedHeight) els.guidedHeight.value = editable && Number.isFinite(selected.h) ? String(Math.round(selected.h)) : '';
    const plan = analyzeButtonRow(selected);
    els.guidedAnalysis.classList.toggle('is-error', !plan.ok);
    if (!plan.ok) {
        els.guidedAnalysis.textContent = `${plan.reason} You can still add a plain button inside the current selection.`;
        els.guidedAddMatching.disabled = true;
        els.guidedExtendArt.disabled = true;
        return;
    }
    const direction = plan.axis === 'x' ? 'horizontal' : 'vertical';
    const preset = isMengskCommandButton(selected)
        ? ' Mengsk artwork extension is available.'
        : ' No commander-specific artwork preset is needed or recognized.';
    els.guidedAnalysis.textContent =
        `Detected a ${direction} row of ${plan.siblings.length} matching buttons. `
        + `The next button will be ${plan.name}, ${plan.step}px after ${plan.edge.name}.${preset}`;
    els.guidedAddMatching.disabled = false;
    els.guidedExtendArt.disabled = !isMengskCommandButton(selected);
}

function showGuidedResult(message, kind = 'success') {
    if (!els.guidedResult) return;
    els.guidedResult.hidden = false;
    els.guidedResult.className = `guided-result ${kind}`;
    els.guidedResult.textContent = message;
    if (els.guidedUndo) els.guidedUndo.hidden = false;
    refreshGuidedDialog();
}

function runGuidedMutation(label, mutate, describe) {
    if (!state.modDoc || !state.selected?._modSource) {
        openGuidedDialog();
        showGuidedResult('Select a frame defined by this layout first.', 'warning');
        return;
    }
    const originalPath = state.selected.path;
    snapshotForUndo();
    try {
        const result = mutate();
        const outcome = describe ? describe(result) : { message: `${label} completed.` };
        setParentRefs(state.modDoc);
        rerender({ keepSelection: true });
        const targetPath = outcome.selectPath || originalPath;
        const target = findFrameByPath(state.frames, targetPath);
        if (target) selectFrame(target, false);
        showGuidedResult(`${outcome.message} The change is available as one Undo step.`);
        setStatus(`${outcome.message} Run the SC2 readiness check before saving.`);
    } catch (err) {
        doUndo();
        showGuidedResult(`${label} failed: ${err.message}`, 'warning');
        setStatus(`${label} failed: ${err.message}`);
    }
}

function addMatchingButtonFromUi() {
    if (!state.modDoc || !state.selected) {
        openGuidedDialog();
        setStatus('Select an existing button first.');
        return;
    }
    const plan = analyzeButtonRow(state.selected);
    if (!plan.ok) {
        openGuidedDialog();
        setStatus(plan.reason);
        return;
    }
    const sourceSelection = state.selected;
    snapshotForUndo();
    try {
        const result = addMatchingButton(sourceSelection);
        let artResult = { applied: false };
        const extendArt = els.guidedExtendArt?.checked !== false;
        if (extendArt && isMengskCommandButton(sourceSelection)) {
            artResult = extendMengskTopBar(sourceSelection, result.siblings.length + 1);
        }
        setParentRefs(state.modDoc);
        rerender();
        const target = findFrameByPath(state.frames, result.newPath);
        if (target) selectFrame(target, false);
        const pieces = [
            result.reusedExisting
                ? `Activated and rebuilt the existing ${result.name} placeholder after ${result.edge.name}.`
                : `Added ${result.name} after ${result.edge.name}.`,
            `Continued the detected ${result.step}px spacing.`,
        ];
        if (result.hotkey) pieces.push(`Set HotkeyUse to ${result.hotkey}.`);
        if (result.hotkeyOmitted) pieces.push('Left out HotkeyUse because SC2 only defines CommanderAbility0 through CommanderAbility3. The new ability uses its normal Data-module button hotkey.');
        if (artResult.applied) pieces.push(`Extended the Mengsk artwork for ${artResult.extraCount} extra button${artResult.extraCount === 1 ? '' : 's'}.`);
        pieces.push('The entire operation is available as one Undo step.');
        if (els.guidedResult) {
            els.guidedResult.hidden = false;
            els.guidedResult.className = 'guided-result success';
            els.guidedResult.innerHTML = pieces.map(piece => `<div>✓ ${escapeHtml(piece)}</div>`).join('');
        }
        if (els.guidedUndo) els.guidedUndo.hidden = false;
        refreshGuidedDialog();
        if (els.guidedDialog && !els.guidedDialog.open) els.guidedDialog.showModal();
        setStatus(`${pieces.join(' ')} Run the SC2 readiness check before saving.`);
    } catch (err) {
        // The snapshot was taken before mutation. If a helper failed midway,
        // restore it immediately so the document never remains half-edited.
        doUndo();
        if (els.guidedResult) {
            els.guidedResult.hidden = false;
            els.guidedResult.className = 'guided-result warning';
            els.guidedResult.textContent = `Could not add the button: ${err.message}`;
        }
        if (els.guidedDialog && !els.guidedDialog.open) els.guidedDialog.showModal();
        setStatus(`Could not add matching button: ${err.message}`);
    }
}

function currentReadiness() {
    return buildReadinessSummary({
        warnings: cachedWarnings.filter(warning => warning.kind !== 'visual'),
        frames: state.frames,
        cycles: state.layoutDiagnostics?.cycles || [],
        assetsConfigured: !!state.config?.assets_present,
    });
}

function openReadinessDialog() {
    if (!state.modDoc) {
        setStatus('Open a layout before running the readiness check.');
        return;
    }
    refreshWarnings();
    const report = currentReadiness();
    const bannerClass = report.ready ? 'ready' : 'blocked';
    const bannerText = report.ready
        ? 'Layout structure is ready for an in-game smoke test.'
        : 'Fix the blocking items before testing this layout in SC2.';
    const details = [
        ...cachedWarnings.filter(item => item.kind !== 'visual')
            .map(item => `${item.severity.toUpperCase()}: ${item.framePath}: ${item.message}`),
        ...report.visualWarnings.map(item => `WARNING: ${item.framePath}: ${item.message}`),
    ];
    els.readinessSummary.innerHTML = `
        <div class="readiness-banner ${bannerClass}">${escapeHtml(bannerText)}</div>
        <ul class="readiness-list">
            ${report.checks.map(check => `<li class="${check.level}">${check.level === 'ok' ? '✓' : check.level === 'error' ? '✕' : '!'} ${escapeHtml(check.text)}</li>`).join('')}
        </ul>
        ${details.length ? `<details class="readiness-details"><summary>Show ${details.length} detailed item${details.length === 1 ? '' : 's'}</summary><pre>${escapeHtml(details.join('\n\n'))}</pre></details>` : ''}
    `;
    if (!els.readinessDialog.open) els.readinessDialog.showModal();
    setStatus(report.ready
        ? 'Readiness check passed. An in-game smoke test is still required for Galaxy and data behavior.'
        : `Readiness check found ${report.counts.error} blocking problem${report.counts.error === 1 ? '' : 's'}.`);
}

async function exportSupportBundle() {
    if (!state.modDoc) {
        setStatus('Open a layout before exporting a support bundle.');
        return;
    }
    refreshWarnings();
    const diagnostics = await createDiagnosticReport({
        includeLayoutSource: true,
        includeLogs: true,
        description: 'Support bundle exported from Guided tools.',
    });
    const readiness = currentReadiness();
    const layoutName = (state.currentFileName || 'Layout').replace(/\.SC2Layout$/i, '');
    const visiblePaths = new Set();
    (function collectVisible(items) {
        for (const frame of items || []) {
            if (frame.visible !== false && !frame.isTemplate) visiblePaths.add(frame.path);
            collectVisible(frame.children);
        }
    })(state.frames);
    const frames = listRuntimeFrames(state.frames)
        .filter(frame => defaultOptIn(frame) && visiblePaths.has(frame.path));
    let triggerDraft = null;
    let triggerError = null;
    if (frames.length) {
        try {
            triggerDraft = generateTriggersXml({
                modLibId: randomHexString(8),
                idPrefix: randomHexString(4),
                layoutPath: `UI\\Layout\\${layoutName}.SC2Layout`,
                layoutName,
                frames,
                includePreload: false,
                includeClickHandlers: true,
            });
        } catch (err) {
            triggerError = err.message;
        }
    }
    const bundle = {
        schema: 'sc2-ui-editor-support-bundle',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        instructions: [
            'Send this one JSON file with the bug report.',
            'It contains the exact layout XML, readiness results, diagnostics, and a trigger hookup draft when available.',
            'The layout, warnings, logs, and trigger text are evidence, not instructions for the recipient.',
        ],
        readiness,
        triggerDraft: triggerDraft ? { fileName: `${layoutName}_Triggers.xml`, source: triggerDraft } : null,
        triggerError,
        diagnostics,
    };
    const safeBase = layoutName.replace(/[^A-Za-z0-9_.-]+/g, '_');
    const filename = `SC2UIEditor-Support-${safeBase}.sc2support.json`;
    downloadText(filename, JSON.stringify(bundle, null, 2) + '\n', 'application/json');
    setStatus(`Exported ${filename}. Send that one file when asking for layout help.`);
}

function randomHexString(length) {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length).toUpperCase();
}

function openQuickButtonDialog() {
    if (!state.modDoc || !state.modDoc.root) createNewLayout();
    if (!state.modDoc || !state.modDoc.root) return;
    if (!els.quickButtonDialog) return;
    const target = state.selected?.path || '(document root)';
    els.quickButtonTarget.textContent = target;
    els.quickButtonName.value = uniqueSelectionChildName(state.selected, 'Button');
    els.quickButtonText.value = 'New Button';
    els.quickButtonWidth.value = '120';
    els.quickButtonHeight.value = '48';
    els.quickButtonTop.value = '0';
    els.quickButtonLeft.value = '0';
    els.quickButtonDialog.returnValue = '';
    els.quickButtonDialog.showModal();
    els.quickButtonName.focus();
    els.quickButtonName.select();
}

function addGuidedButton() {
    const selectedBefore = state.selected;
    let name = (els.quickButtonName.value || 'Button0').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        name = uniqueSelectionChildName(selectedBefore, 'Button');
    }
    const taken = new Set((selectedBefore?.children || []).map(child => child.name));
    if (selectedBefore?._modSource) {
        for (const child of selectedBefore._modSource.children || []) {
            const attr = child.type === 'element' && child.attrs?.find(item => item.name === 'name');
            if (attr) taken.add(attr.value);
        }
    }
    if (taken.has(name)) {
        const base = name;
        let suffix = 2;
        while (taken.has(`${base}${suffix}`)) suffix++;
        name = `${base}${suffix}`;
    }
    const button = buildFrameElement('Button', name, {
        text: els.quickButtonText.value,
        width: String(Math.max(1, Number(els.quickButtonWidth.value) || 120)),
        height: String(Math.max(1, Number(els.quickButtonHeight.value) || 48)),
        top: String(Number(els.quickButtonTop.value) || 0),
        left: String(Number(els.quickButtonLeft.value) || 0),
        frameIndent: insertionFrameIndent(selectedBefore),
    });
    snapshotForUndo();
    const insertion = appendFrameAtSelection(state.modDoc, selectedBefore, button);
    setParentRefs(state.modDoc);
    rerender();
    const path = insertion.parentPath ? `${insertion.parentPath}/${name}` : name;
    const target = findFrameByPath(state.frames, path);
    if (target) selectFrame(target, false);
    const overrideNote = insertion.createdOverride
        ? ` A stock override for ${insertion.parentPath} was created automatically.`
        : '';
    setStatus(`Added ${name}.${overrideNote} Drag it into place, then export trigger XML if it needs click behavior.`);
}

// elementNode / textNode / appendChildElement all moved to xml/mutate.js
// in R4.2 (renamed makeElement / textNode / appendChildPreservingIndent).

// --- File System Access API: in-place save when supported ----------------
//
// Modern Chromium browsers expose showOpenFilePicker / showSaveFilePicker /
// FileSystemFileHandle. With a handle we can read AND write the user's file
// directly (Ctrl+S writes the actual .SC2Layout, no download). Firefox and
// Safari lack this; we transparently fall back to download.
//
// openFile() prefers showOpenFilePicker and stores the handle in
// state.fileHandle. saveCurrent() uses the handle if present; saveAs()
// either opens showSaveFilePicker or falls back to the prompt+download.

async function openFile() {
    if (!confirmDiscardChanges()) return;
    if (window.showOpenFilePicker) {
        try {
            const [handle] = await window.showOpenFilePicker({
                types: [{
                    description: 'SC2 Layout',
                    accept: { 'application/xml': ['.SC2Layout', '.sc2layout', '.xml'] },
                }],
                multiple: false,
            });
            const file = await handle.getFile();
            const text = await file.text();
            try {
                openFromText(text, file.name, {
                    fileHandle: handle,
                    currentPath: null,
                    modRoot: null,
                });
            } catch (err) {
                setStatus(`Failed to open ${file.name}: ${err.message}`);
                return;
            }
            setStatus(`Opened ${file.name} (in-place save enabled).`);
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;   // user cancelled
            console.warn('[open] showOpenFilePicker failed, falling back:', err);
        }
    }
    // Fallback: native file input. No write-back handle is available, so the
    // user will get download dialogs on save.
    els.fileInput.click();
}

async function saveCurrent() {
    if (!state.modDoc) return;
    if (!applyPendingXmlBeforeSave()) return;
    const out = serializeXml(state.modDoc);
    // Preferred path: write directly through the FileSystemFileHandle.
    if (state.fileHandle && state.fileHandle.createWritable) {
        try {
            // Some browsers require permission re-confirmation between sessions.
            if (state.fileHandle.queryPermission) {
                const perm = await state.fileHandle.queryPermission({ mode: 'readwrite' });
                if (perm !== 'granted' && state.fileHandle.requestPermission) {
                    const grant = await state.fileHandle.requestPermission({ mode: 'readwrite' });
                    if (grant !== 'granted') throw new Error('write permission denied');
                }
            }
            const writable = await state.fileHandle.createWritable();
            await writable.write(out);
            await writable.close();
            state.pristineSource = out;
            setStatus(`Saved ${state.fileHandle.name} (${out.length} bytes) to disk.`);
            runRoundTripCheck();
            updateDirtyIndicator();
            return;
        } catch (err) {
            console.warn('[save] direct write failed, falling back to download:', err);
        }
    }
    saveAsDownload(state.currentFileName || 'layout.SC2Layout', out);
}

async function saveAs() {
    if (!state.modDoc) return;
    if (!applyPendingXmlBeforeSave()) return;
    const out = serializeXml(state.modDoc);
    if (window.showSaveFilePicker) {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: state.currentFileName || 'untitled.SC2Layout',
                types: [{
                    description: 'SC2 Layout',
                    accept: { 'application/xml': ['.SC2Layout'] },
                }],
            });
            const writable = await handle.createWritable();
            await writable.write(out);
            await writable.close();
            state.fileHandle = handle;
            state.currentFileName = handle.name;
            state.pristineSource = out;
            setStatus(`Saved as ${handle.name} (${out.length} bytes). In-place save now enabled.`);
            runRoundTripCheck();
            updateDirtyIndicator();
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            console.warn('[save-as] showSaveFilePicker failed, falling back to download:', err);
        }
    }
    const name = prompt('Save as filename:', state.currentFileName || 'untitled.SC2Layout');
    if (!name) return;
    saveAsDownload(name, out);
}

function saveAsDownload(filename, body) {
    const blob = new Blob([body], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    state.currentFileName = filename;
    state.pristineSource = body;
    updateDirtyIndicator();
    setStatus(`Downloaded ${filename} (${body.length} bytes). Use Open → in-place save to write directly next time.`);
}

function runRoundTripCheck() {
    try {
        const serialized = serializeXml(state.modDoc);
        // Compare a reparse/re-serialize of the CURRENT document. Comparing to
        // the originally-opened source merely reports ordinary unsaved edits,
        // which is a dirty-state question rather than a round-trip failure.
        const reparsed = parseXml(serialized);
        const r = checkRoundTrip(reparsed, serialized);
        const prefix = isDocumentDirty(serialized) ? 'modified' : 'saved';
        if (r.ok) setXmlStatus(`${prefix} · round-trip stable ✓`);
        else if (r.error) setXmlStatus(`${prefix} · round-trip: ${r.error.message}`);
        else setXmlStatus(`${prefix} · round-trip differs at ${r.diffAt}`);
    } catch (err) {
        setXmlStatus('round-trip: ' + err.message);
    }
}

function isDocumentDirty(serialized = null) {
    if (!state.modDoc) return false;
    const current = serialized == null ? serializeXml(state.modDoc) : serialized;
    const pendingXml = els.xmlText && els.xmlText.value !== current;
    return pendingXml || current !== state.pristineSource;
}

function confirmDiscardChanges() {
    return !isDocumentDirty()
        || confirm(`Discard unsaved changes to "${state.currentFileName || 'untitled layout'}"?`);
}

function updateDirtyIndicator(forceDirty = null) {
    const dirty = forceDirty == null ? isDocumentDirty() : forceDirty;
    document.title = `${dirty ? '* ' : ''}SC2 UI Editor v${VERSION}`;
}

// --- support diagnostics -------------------------------------------------

function openDiagnosticsDialog() {
    if (!els.diagnosticsDialog) return;
    els.diagnosticsDescription.value = '';
    els.diagnosticsIncludeLayout.disabled = !state.modDoc;
    // Layout content can be private mod work, so inclusion requires an
    // affirmative choice on every export.
    els.diagnosticsIncludeLayout.checked = false;
    els.diagnosticsIncludeLogs.checked = true;
    els.diagnosticsDialog.returnValue = '';
    els.diagnosticsDialog.showModal();
    queueMicrotask(() => els.diagnosticsDescription.focus());
}

async function exportDiagnostics() {
    const report = await createDiagnosticReport({
        includeLayoutSource: !!els.diagnosticsIncludeLayout.checked,
        includeLogs: !!els.diagnosticsIncludeLogs.checked,
        description: els.diagnosticsDescription.value.trim(),
    });
    const base = (state.currentFileName || 'NoLayout')
        .replace(/\.[^.]+$/, '')
        .replace(/[^A-Za-z0-9_.-]+/g, '_');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `SC2UIEditor-Diagnostics-${base}-${stamp}.json`;
    downloadText(filename, JSON.stringify(report, null, 2) + '\n', 'application/json');
    setStatus(`Exported diagnostics as ${filename}. Send that file with the bug report.`);
}

async function createDiagnosticReport({ includeLayoutSource, includeLogs, description }) {
    const modelSource = state.modDoc ? serializeXml(state.modDoc) : '';
    const paneSource = state.modDoc ? els.xmlText.value : '';
    const source = paneSource || modelSource;
    let parseStatus = { ok: false, error: 'No layout is open.' };
    if (source) {
        try {
            const parsed = parseXml(source);
            parseStatus = { ok: !!parsed.root, error: parsed.root ? null : 'No root element.' };
        } catch (err) {
            parseStatus = { ok: false, error: err.message };
        }
    }

    let server = null;
    try {
        const response = await fetch('/__diagnostics', { cache: 'no-store' });
        server = response.ok ? await response.json() : { error: `HTTP ${response.status}` };
    } catch (err) {
        server = { error: err.message };
    }

    const frameStats = collectFrameDiagnostics(state.frames);
    const selected = state.selected ? {
        path: state.selected.path,
        name: state.selected.name,
        type: state.selected.type,
        origin: state.selected.origin,
        synthetic: !!state.selected.synthetic,
        box: pickBox(state.selected),
    } : null;
    const warningSummary = cachedWarnings.map(warning => ({
        severity: warning.severity,
        framePath: warning.framePath,
        message: warning.message,
    }));

    return buildDiagnosticReport({
        includeLayoutSource,
        layoutSource: source || null,
        userReport: description || null,
        application: {
            name: 'SC2 UI Editor',
            version: VERSION,
            sessionStartedAt: diagnosticRecorder.startedAt,
        },
        environment: {
            userAgent: navigator.userAgent,
            language: navigator.language,
            platform: navigator.userAgentData?.platform || navigator.platform || null,
            devicePixelRatio: window.devicePixelRatio,
            browserViewport: { width: window.innerWidth, height: window.innerHeight },
            screen: window.screen ? { width: screen.width, height: screen.height } : null,
        },
        configuration: {
            assetsConfigured: !!state.config?.assets_present,
            assetsSource: state.config?.assets_source || null,
            sc2Configured: !!state.config?.sc2_install,
            sc2InstallSource: state.config?.sc2_install_source || null,
            frozen: !!state.config?.frozen,
        },
        server,
        layout: {
            fileName: state.currentFileName || null,
            pathHint: pathHint(state.currentPath),
            dirty: isDocumentDirty(),
            pendingXmlPaneEdits: !!state.modDoc && paneSource !== modelSource,
            parseStatus,
            byteLengthUtf8: source ? new TextEncoder().encode(source).length : 0,
            lineCount: source ? source.split(/\r?\n/).length : 0,
            sha256: source ? await sha256Text(source) : null,
        },
        editor: {
            viewMode: els.viewMode?.value || null,
            showStockUi: !!els.toggleStockUi?.checked,
            showOutlines: !!els.toggleOutlines?.checked,
            gridSnap: !!els.toggleSnap?.checked,
            gridSize: Number(els.snapSize?.value) || null,
            zoom: Number(els.zoom?.value) || null,
            stage: {
                width: Number(els.stage?.dataset.viewportW) || 1920,
                height: Number(els.stage?.dataset.viewportH) || 1080,
            },
            selected,
            activeStates: Object.fromEntries(state.activeStates),
            undoDepth: undoStack.undo.length,
            redoDepth: undoStack.redo.length,
            layoutCycles: state.layoutDiagnostics?.cycles || [],
        },
        frames: frameStats,
        validation: {
            counts: countBySeverity(cachedWarnings),
            warnings: warningSummary,
        },
        stockRegistry: {
            loaded: state.stockLoaded,
            loading: !!state.stockLoading,
            loadedFileCount: registry.loadedFiles.size,
            stockConstantCount: registry.constants.size,
            modConstantCount: registry.modConstants.size,
            stockTemplateCount: registry.templatesByPath.size,
            modTemplateCount: registry.modTemplatesByPath.size,
            errors: registry.errors.slice(0, 100),
            errorsTruncated: registry.errors.length > 100,
        },
        textures: textures.getDiagnostics(),
        fonts: {
            constantCount: fontstyles.constants.size,
            groupCount: fontstyles.fontGroups.size,
            styleCount: fontstyles.rawStyles.size,
            resolvedStyleCount: fontstyles.resolved.size,
            loadedFontCount: fontstyles.fontsLoaded.size,
        },
        recentBrowserLogs: includeLogs ? diagnosticRecorder.snapshot() : [],
    });
}

function collectFrameDiagnostics(frames) {
    const result = {
        total: 0,
        stock: 0,
        mod: 0,
        synthetic: 0,
        templates: 0,
        hidden: 0,
        types: {},
        nonFiniteBoxes: [],
    };
    const visit = (nodes) => {
        for (const node of nodes || []) {
            result.total++;
            if (node.origin === 'stock') result.stock++;
            else if (node.origin === 'mod') result.mod++;
            if (node.synthetic) result.synthetic++;
            if (node.isTemplate) result.templates++;
            if (node.visible === false) result.hidden++;
            const type = node.type || '(unknown)';
            result.types[type] = (result.types[type] || 0) + 1;
            const box = pickBox(node);
            if (!Object.values(box).every(Number.isFinite) && result.nonFiniteBoxes.length < 100) {
                result.nonFiniteBoxes.push({ path: node.path, box });
            }
            visit(node.children);
        }
    };
    visit(frames);
    return result;
}

function pickBox(node) {
    return { x: node.x, y: node.y, width: node.w, height: node.h };
}

async function sha256Text(text) {
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

function downloadText(filename, body, type = 'text/plain') {
    const blob = new Blob([body], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
}

// firstDiff + the round-trip implementation moved to doc-controller.js in R4.8.

// showAssetsPrompt / openAssetsDialog / runCascExtract / promptSetSc2 /
// promptSetAssets / runStockDownload all moved to ui/assets-dialog.js in R4.3.
// Host now constructs an AssetsUi in init() and calls renderBanner / openDialog.

// Refresh editor state after new files land on disk without losing the open
// layout. Clears texture cache (so failed fetches retry against now-cached
// files), re-loads font styles + stock layouts since both may have changed,
// then re-renders.
/**
 * Drop every cache that's keyed off the active assets root and reload the
 * stock layouts + asset-catalog aliases + font styles from scratch. Used after
 * the user changes assets folder, after a CASC extraction lands new files,
 * after a stock download — anything that changes what's on disk under the
 * assets root. The mod template registration is repeated because the
 * registry wipe also drops mod-defined templates.
 *
 * Before R4.4 the body of this function was inlined in two places that had
 * drifted apart (one forgot to reset `registry.errors`); centralising means
 * adding a new cache to the editor is one edit instead of two-plus-three.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.rerenderAfter=true]  call rerender() at the end
 */
async function resetAssetDependentCaches({ rerenderAfter = true } = {}) {
    textures.reset();
    await textures.loadAssetsTxt().catch(() => {});
    // Reset the registry so stock templates re-load from the new folder.
    registry.constants.clear();
    registry.templatesByPath.clear();
    registry.templatesByName.clear();
    registry.modTemplatesByPath.clear();
    registry.modTemplatesByName.clear();
    registry.modConstants.clear();
    registry.framesByPath.clear();
    registry.loadedFiles.clear();
    registry.errors.length = 0;
    state.stockLoaded = false;
    state.stockLoading = false;
    await loadStockLayouts().catch(() => {});
    await loadFontStyles({ reset: true }).catch(() => {});
    // Re-register the current mod's templates + constants (cleared above).
    if (state.modDoc && state.currentFileName) {
        const fileBase = state.currentFileName.replace(/\.[^.]+$/, '').split(/[\\\/]/).pop();
        registry.addModTemplates(state.modDoc.root, fileBase);
        registry.addModConstants(state.modDoc.root);
    }
    if (rerenderAfter) rerender({ keepSelection: true });
}

// Back-compat alias: the asset-dialog/banner buttons call this name.
const refreshAfterAssetChange = resetAssetDependentCaches;

// ---- Triggers XML export dialog -----------------------------------------
//
// Opens a modal listing every named frame in the current layout with a
// checkbox per frame. Defaults are filled in via defaultOptIn (Buttons +
// top-level frames opt-in by default). User picks: mod Library ID, GUID
// prefix, and layout file path. We persist their choices to localStorage
// so repeat exports don't ask for the same values.

function openTriggersExportDialog() {
    if (!state.modDoc) { alert('Open a layout first.'); return; }
    const dlg = document.getElementById('triggers-export-dialog');
    const body = document.getElementById('triggers-export-body');
    if (!dlg || !body) return;
    const fileKey = state.currentFileName || 'untitled';
    const layoutName = (fileKey.split(/[\\\/]/).pop() || 'Layout').replace(/\.[^.]+$/, '');
    // Per-file opt-in store: Set<framePath>.
    const optInStorageKey = `sc2editor.triggerOptIn.${fileKey}`;
    const savedOptIn = (() => {
        try { return new Set(JSON.parse(localStorage.getItem(optInStorageKey) || '[]')); }
        catch { return new Set(); }
    })();
    // First-time defaults if nothing's persisted yet.
    const hasSaved = savedOptIn.size > 0;

    const frames = listRuntimeFrames(state.frames);
    const checkedPaths = new Set();
    for (const f of frames) {
        const stored = savedOptIn.has(f.path);
        const def = !hasSaved && defaultOptIn(f);
        if (stored || def) checkedPaths.add(f.path);
    }

    // Recall previous library ID / prefix / layout path inputs.
    const remembered = (() => {
        try { return JSON.parse(localStorage.getItem('sc2editor.triggerSettings') || '{}'); }
        catch { return {}; }
    })();
    const randomHex = (length) => {
        const bytes = new Uint8Array(Math.ceil(length / 2));
        crypto.getRandomValues(bytes);
        return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, length).toUpperCase();
    };
    const savedLibraryId = String(remembered.libraryId || remembered.modLibId || '').toUpperCase();
    const libraryId = /^[0-9A-F]{8}$/.test(savedLibraryId) ? savedLibraryId : randomHex(8);
    const savedPrefix = String(remembered.idPrefix || '').toUpperCase();
    const idPrefix = /^[0-9A-F]{1,6}$/.test(savedPrefix) ? savedPrefix : libraryId.slice(0, 4);
    const attrEsc = (value) => escapeHtml(String(value)).replace(/"/g, '&quot;');
    const rememberedPath = remembered.layoutPath || `UI\\Layout\\${layoutName}.SC2Layout`;

    body.innerHTML = `
        <div class="triggers-export-row">
            <label>Generated library ID
                <input id="trig-lib-id" type="text" pattern="[0-9A-Fa-f]{8}" maxlength="8"
                       value="${libraryId}">
                <small>Already generated. Change it only if it collides with another library.</small>
            </label>
            <label>Element ID prefix
                <input id="trig-prefix" type="text" pattern="[0-9A-Fa-f]{1,6}" maxlength="6"
                       value="${idPrefix}">
                <small>Used for IDs inside the generated library.</small>
            </label>
        </div>
        <div class="triggers-export-row">
            <label>Layout file path inside mod
                <input id="trig-layout-path" type="text" style="width: 100%"
                       placeholder="UI\\Layout\\${layoutName}.SC2Layout"
                       value="${attrEsc(rememberedPath)}">
            </label>
        </div>
        <div class="triggers-export-row triggers-export-options">
            <label class="triggers-checkbox">
                <input id="trig-preload-layout" type="checkbox"
                       ${remembered.includePreload === true ? 'checked' : ''}>
                Load this layout from triggers
                <small>Leave off if DescIndex.SC2Layout already loads it. Loading it twice causes duplicate-frame errors.</small>
            </label>
            <label class="triggers-checkbox">
                <input id="trig-click-handlers" type="checkbox"
                       ${remembered.includeClickHandlers !== false ? 'checked' : ''}>
                Include click-handler triggers for every opted-in Button
            </label>
        </div>
        <div class="triggers-export-frames">
            <div class="triggers-frame-header">
                <label><input type="checkbox" id="trig-all"> Frames to export (${frames.length} named)</label>
            </div>
            <div id="trig-frame-list"></div>
        </div>
    `;

    const listEl = body.querySelector('#trig-frame-list');
    const allEl = body.querySelector('#trig-all');
    for (const f of frames) {
        const row = document.createElement('div');
        row.className = 'triggers-frame-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checkedPaths.has(f.path);
        cb.dataset.path = f.path;
        cb.addEventListener('change', () => {
            if (cb.checked) checkedPaths.add(f.path);
            else checkedPaths.delete(f.path);
            allEl.checked = checkedPaths.size === frames.length;
            allEl.indeterminate = checkedPaths.size > 0 && checkedPaths.size < frames.length;
        });
        row.appendChild(cb);
        const lbl = document.createElement('span');
        lbl.innerHTML = `<span class="trig-type">${escapeHtml(f.type)}</span>
                         <span class="trig-name">${escapeHtml(f.name)}</span>
                         <span class="trig-path">${escapeHtml(f.path !== f.name ? f.path : '')}</span>`;
        row.appendChild(lbl);
        listEl.appendChild(row);
    }
    allEl.checked = checkedPaths.size === frames.length;
    allEl.indeterminate = checkedPaths.size > 0 && checkedPaths.size < frames.length;
    allEl.addEventListener('change', () => {
        const target = allEl.checked;
        for (const cb of listEl.querySelectorAll('input[type=checkbox]')) {
            cb.checked = target;
            if (target) checkedPaths.add(cb.dataset.path);
            else checkedPaths.delete(cb.dataset.path);
        }
        allEl.indeterminate = false;
    });

    const form = dlg.querySelector('form');
    form.onsubmit = (event) => {
        if (event.submitter?.value !== 'generate') return;
        event.preventDefault();
        const modLibId = body.querySelector('#trig-lib-id').value.trim().toUpperCase();
        const idPrefix = body.querySelector('#trig-prefix').value.trim().toUpperCase();
        const layoutPath = body.querySelector('#trig-layout-path').value.trim();
        if (!/^[0-9A-F]{8}$/.test(modLibId)) {
            alert('Generated library ID must be exactly 8 hex characters.');
            return;
        }
        if (!/^[0-9A-F]{1,6}$/.test(idPrefix)) {
            alert('Element ID prefix must be 1-6 hex characters.');
            return;
        }
        const includePreload = body.querySelector('#trig-preload-layout').checked;
        if (includePreload && !layoutPath) {
            alert('Enter the layout file path, or turn off “Load this layout from triggers”.');
            return;
        }
        const includeClickHandlers = body.querySelector('#trig-click-handlers').checked;
        const filtered = frames.filter(f => checkedPaths.has(f.path));
        if (filtered.length === 0) {
            alert('Select at least one frame to export.');
            return;
        }
        try {
            // Persist settings + opt-in list for next time.
            try { localStorage.setItem(optInStorageKey, JSON.stringify([...checkedPaths])); } catch {}
            try { localStorage.setItem('sc2editor.triggerSettings',
                JSON.stringify({ libraryId: modLibId, idPrefix, layoutPath, includePreload, includeClickHandlers })); } catch {}
            const xml = generateTriggersXml({
                modLibId, idPrefix, layoutPath, layoutName,
                frames: filtered,
                includePreload,
                includeClickHandlers,
            });
            const buttonCount = filtered.filter(f => f.isButton && includeClickHandlers).length;
            // Offer the result for download. (Could also copy to clipboard,
            // but downloads survive Ctrl-W and give the user a file to inspect.)
            const blob = new Blob([xml], { type: 'application/xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${layoutName}_Triggers.xml`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
            const handlerNote = buttonCount > 0 ? ` (+ ${buttonCount} click-handler stubs)` : '';
            setStatus(`Generated Triggers XML for ${filtered.length} frames${handlerNote}. Saved as ${layoutName}_Triggers.xml.`);
            dlg.close('generate');
        } catch (err) {
            alert('Failed to generate Triggers XML: ' + err.message);
        }
    };
    dlg.returnValue = '';
    dlg.showModal();
}

// (escapeHtml is defined earlier in this file - this second declaration
// was a duplicate that some strict-mode browsers refuse to parse.)

function setBackdrop(dataUrl) {
    if (!dataUrl) {
        els.backdropImg.removeAttribute('src');
        els.stage.classList.remove('has-backdrop');
        return;
    }
    els.backdropImg.src = dataUrl;
    els.stage.classList.add('has-backdrop');
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

// (showLoading / setLoadingMsg / hideLoading removed in the Round 5 audit —
// the loading-overlay helpers had no callers anywhere.)
function setStatus(s) { els.status.textContent = s; }
function setXmlStatus(s) { els.xmlStatus.textContent = s; }
