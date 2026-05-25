// SC2 UI Editor - main entry. Wires parser, stock layout loader, tree merger,
// layout engine, renderer, font sheet, and texture loader into the shell.

import { parseXml } from './xml/parser.js';
import { serializeXml } from './xml/serializer.js';
import { FrameRenderer } from './render/frames.js';
import { TextureLoader } from './render/textures.js';
import { FontStyleSheet } from './render/fontstyle.js';
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
import { generateTriggersXml, listNamedFrames, defaultOptIn } from './export/triggers.js';
import { validate } from './validate.js';
import { applyStateActions } from './state-groups.js';
import { VERSION } from './version.js';

const els = {
    menuBar: document.getElementById('menu-bar'),
    btnApplyXml: document.getElementById('btn-apply-xml'),
    btnAssets: document.getElementById('btn-assets'),
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
    loadingOverlay: document.getElementById('loading-overlay'),
    loadingMsg: document.getElementById('loading-msg'),
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

    // Remove from old position, stripping leading whitespace text node.
    const sParent = sEl._parent;
    const sIdx = sParent.children.indexOf(sEl);
    if (sIdx < 0) return;
    const removed = [sEl];
    sParent.children.splice(sIdx, 1);
    if (sIdx > 0 && sParent.children[sIdx - 1] && sParent.children[sIdx - 1].type === 'text'
        && /^\s+$/.test(sParent.children[sIdx - 1].raw)) {
        sParent.children.splice(sIdx - 1, 1);
    }
    sParent.dirty = true;

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
    const indent = inferIndent(targetParent);
    targetParent.children.splice(insertIdx, 0,
        { type: 'text', raw: indent, start: 0, end: 0, dirty: true },
        sEl,
    );
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

function inferIndent(parent) {
    if (!parent || !parent.children) return '\n    ';
    for (let i = parent.children.length - 1; i >= 0; i--) {
        const k = parent.children[i];
        if (k.type === 'text' && /\n[ \t]*$/.test(k.raw)) {
            const m = k.raw.match(/\n([ \t]*)$/);
            if (m) return '\n' + m[1];
        }
    }
    return '\n    ';
}
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
        if (!frame) { selectFrame(null, false); return; }
        if (live) rerender({ keepSelection: true, positionsOnly: true });
        else rerender({ keepSelection: true });
    },
    // Suggester functions feed the inspector's autocomplete dropdowns.
    // Each takes a query string and returns [{ value, label?, hint? }].
    suggesters: {
        texture: (q) => suggestTextures(q),
        style: (q) => suggestStyles(q),
    },
});

// --- autocomplete data sources --------------------------------------------

const SUGGESTION_LIMIT = 200;

// Texture aliases live in textures.aliases (loaded from each mod's
// Base.SC2Data/GameData/Assets.txt). Keys look like "UI/HeroPanelButtonNormal"
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
});

// Undo stack: each entry is the raw XML string from before an edit.
// Bounded to 100 entries to keep memory under control on long sessions.
const UNDO_LIMIT = 100;
state.undoStack = [];
state.redoStack = [];

// Track the last canvas click point so successive clicks at (approximately)
// the same spot cycle through frames stacked at that point.
state.lastClick = null;

// FileSystemFileHandle from showOpenFilePicker (when the browser supports
// the File System Access API). Lets us write the open file back in place
// without prompting on every save.
state.fileHandle = null;

// Active state-group selections for preview. Keyed by
// `${framePath}#${groupName}` -> state name. Shared between the inspector
// and the renderer so picking a state in the inspector reflects on canvas.
state.activeStates = new Map();

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
    if (!state.config.assets_present) {
        showAssetsPrompt(state.config);
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
    }).catch(err => console.warn('[textures] Assets.txt load failed:', err));
}

async function loadFontStyles() {
    try {
        const text = await fetch('/assets/core.sc2mod/Base.SC2Data/UI/fontstyles.sc2style')
            .then(r => r.ok ? r.text() : null);
        if (!text) return;
        fontstyles.ingest(text);
        for (const name of ['StandardTemplate', 'HeaderTemplate', 'DebugDisplay']) {
            fontstyles.getStyle(name);
        }
        const sheet = newDynamicStylesheet();
        fontstyles.injectFontFaces(sheet, (path) =>
            '/assets/core.sc2mod/Base.SC2Data/' + path.replace(/\\/g, '/'));
    } catch (err) {
        console.warn('[fontstyles] could not load:', err);
    }
}

function newDynamicStylesheet() {
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
        const text = await file.text();
        // Native picker doesn't give us a writable handle, so save-back
        // will go through Save-As (download) until the user re-opens via
        // showOpenFilePicker.
        state.fileHandle = null;
        openFromText(text, file.name);
        ev.target.value = '';
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
    menubar.register('add-frame',   (data) => addNewFrame(data.type));
    menubar.register('fit',         () => fitZoom());
    menubar.register('set-backdrop', () => els.backdropInput.click());
    menubar.register('welcome-tour', () => welcomeTour.open());
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
        const text = await f.text();
        openFromText(text, f.name);
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
            openFromText(els.xmlText.value, state.currentFileName || 'layout.SC2Layout');
            setXmlStatus('Applied.');
        } catch (err) {
            setXmlStatus('Parse error: ' + err.message);
        }
    });
    // "Assets..." button - always-available access to SC2 install, stock data,
    // and texture extraction. Replaces the assets banner once it's dismissed.
    els.btnAssets.addEventListener('click', () => openAssetsDialog());

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
    console.info('[stock] starting background load from /assets/core.sc2mod/Base.SC2Data/UI/Layout/descindex.sc2layout');
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
    setStatus('Opening ' + path);
    try {
        const text = await fetch(path).then(r => {
            if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
            return r.text();
        });
        state.currentPath = path;
        // Find the containing .SC2Mod folder (or .SC2Map) so the renderer
        // can resolve custom textures from that mod's Base.SC2Assets first.
        // e.g. /project/Shepherd/ShepardMod.SC2Mod/Base.SC2Data/UI/Layout/foo.SC2Layout
        //   -> /project/Shepherd/ShepardMod.SC2Mod
        const modRootMatch = path.match(/^(.*?\.SC2(Mod|Map))\//i);
        textures.setModRoot(modRootMatch ? modRootMatch[1] : null);
        openFromText(text, path.split('/').pop());
        setStatus('Opened ' + path);
    } catch (err) {
        setStatus('Failed to open: ' + err.message);
    }
}

function openFromText(text, fileName) {
    state.pristineSource = text;
    state.modDoc = parseXml(text);
    // Tag every element with a _parent reference so the inspector's "Delete
    // frame" / "Duplicate" actions can walk to the containing element in O(1).
    setParentRefs(state.modDoc);
    state.currentFileName = fileName;
    // Enable menu items that need an open doc.
    if (menubar) {
        menubar.setEnabled('save', true);
        menubar.setEnabled('save-as', true);
        menubar.setEnabled('export-html', true);
    }
    // Register this file's bare-named top-level frames as templates so other
    // frames can resolve template="FileBase/Name" or template="Name".
    // Without this, frames inheriting from same-file templates render empty.
    const fileBase = fileName.replace(/\.[^.]+$/, '').split(/[\\\/]/).pop();
    const tmplCount = registry.addModTemplates(state.modDoc.root, fileBase);
    console.info(`[open] ${fileName}: registered ${tmplCount} mod templates as "${fileBase}/*"`);
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
            headers: { 'Content-Type': 'application/json' },
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
            // contribute their templates to the registry.
            textures.cache.clear();
            textures.aliasesLoaded = false;
            await textures.loadAssetsTxt().catch(() => {});
            // Reset stock registry so the new layouts get re-ingested.
            registry.constants.clear();
            registry.templatesByPath.clear();
            registry.templatesByName.clear();
            registry.framesByPath.clear();
            registry.loadedFiles.clear();
            state.stockLoaded = false;
            state.stockLoading = false;
            await loadStockLayouts().catch(() => {});
            await loadFontStyles().catch(() => {});
            if (state.modDoc && state.currentFileName) {
                const fileBase = state.currentFileName.replace(/\.[^.]+$/, '').split(/[\\\/]/).pop();
                registry.addModTemplates(state.modDoc.root, fileBase);
            }
            rerender({ keepSelection: true });
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
        layoutFrames(state.frames, W, H);
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
    layoutFrames(state.frames, W, H);
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
        refreshWarnings();
    }
}

// --- validator wiring -----------------------------------------------------

let cachedWarnings = [];

function refreshWarnings() {
    cachedWarnings = state.modDoc ? validate(state.modDoc, registry) : [];
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

// Run the existing anchor.js resolution on the materialized merged frames.
// The merged nodes already have anchors/width/height parsed by merge.js, but
// the layout walk lives in anchor.js. Inline it here against the merged shape:
function layoutFrames(nodes, stageW, stageH) {
    const stage = { x: 0, y: 0, w: stageW, h: stageH, parent: null, children: nodes };
    for (const n of nodes) n.parent = stage;
    walk(nodes);
}
function walk(nodes) {
    for (const node of nodes) {
        resolveBox(node);
        if (node.children.length) walk(node.children);
    }
}
function resolveBox(node) {
    const parentBox = node.parent;
    const hor = { min: null, max: null };
    const ver = { min: null, max: null };
    let fillOff = null;
    for (const a of node.anchors) {
        if (!a.side) { fillOff = a.offset || 0; continue; }
        const ref = resolveRelative(node, a.relative) || parentBox;
        if (a.side === 'Top' || a.side === 'Bottom') {
            const y = refPos(ref, a.pos, 'v') + a.offset;
            if (a.side === 'Top') ver.min = y; else ver.max = y;
        } else {
            const x = refPos(ref, a.pos, 'h') + a.offset;
            if (a.side === 'Left') hor.min = x; else hor.max = x;
        }
    }
    if (fillOff != null) {
        if (hor.min == null) hor.min = parentBox.x + fillOff;
        if (hor.max == null) hor.max = parentBox.x + parentBox.w - fillOff;
        if (ver.min == null) ver.min = parentBox.y + fillOff;
        if (ver.max == null) ver.max = parentBox.y + parentBox.h - fillOff;
    }
    if (!node.anchors.length) {
        hor.min = parentBox.x;
        ver.min = parentBox.y;
    }
    let x, w;
    if (hor.min != null && hor.max != null) { x = hor.min; w = hor.max - hor.min; }
    else if (hor.min != null) { x = hor.min; w = node.width != null ? node.width : 0; }
    else if (hor.max != null) { w = node.width != null ? node.width : 0; x = hor.max - w; }
    else { x = parentBox.x; w = node.width != null ? node.width : parentBox.w; }
    let y, h;
    if (ver.min != null && ver.max != null) { y = ver.min; h = ver.max - ver.min; }
    else if (ver.min != null) { y = ver.min; h = node.height != null ? node.height : 0; }
    else if (ver.max != null) { h = node.height != null ? node.height : 0; y = ver.max - h; }
    else { y = parentBox.y; h = node.height != null ? node.height : parentBox.h; }
    node.x = x; node.y = y; node.w = w; node.h = h;
}
function refPos(ref, pos, axis) {
    if (axis === 'h') {
        if (pos === 'Min') return ref.x;
        if (pos === 'Max') return ref.x + ref.w;
        return ref.x + ref.w / 2;
    }
    if (pos === 'Min') return ref.y;
    if (pos === 'Max') return ref.y + ref.h;
    return ref.y + ref.h / 2;
}
function resolveRelative(node, ref) {
    if (!ref || ref === '$parent') return node.parent;
    if (ref === '$this') return node;
    if (ref === '$root' || ref.startsWith('$ancestor')) {
        let n = node;
        while (n.parent && n.parent.children) n = n.parent;
        return n;
    }
    let cur = ref.startsWith('$parent/') ? node.parent : node.parent;
    const path = ref.replace(/^\$parent\//, '').split('/');
    for (const seg of path) {
        if (!cur || !cur.children) return null;
        const next = cur.children.find(c => c.name === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

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

function findFrameByName(frames, name) {
    for (const f of frames) {
        if (f.name === name) return f;
        const r = findFrameByName(f.children || [], name);
        if (r) return r;
    }
    return null;
}

function snapshotForUndo() {
    if (!state.modDoc) return;
    const snap = serializeXml(state.modDoc);
    state.undoStack.push(snap);
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
    // A fresh edit invalidates any pending redo.
    state.redoStack.length = 0;
}

function doUndo() {
    if (!state.undoStack.length) { setStatus('Nothing to undo.'); return; }
    const cur = serializeXml(state.modDoc);
    const prev = state.undoStack.pop();
    state.redoStack.push(cur);
    // Re-parse the snapshot rather than mutating in place so all references
    // (sources, props arrays) are rebuilt cleanly.
    state.modDoc = parseXml(prev);
    state.pristineSource = prev;
    els.xmlText.value = prev;
    rerender({ keepSelection: true });
    setStatus(`Undo. ${state.undoStack.length} more available.`);
}

function doRedo() {
    if (!state.redoStack.length) { setStatus('Nothing to redo.'); return; }
    const cur = serializeXml(state.modDoc);
    const next = state.redoStack.pop();
    state.undoStack.push(cur);
    state.modDoc = parseXml(next);
    state.pristineSource = next;
    els.xmlText.value = next;
    rerender({ keepSelection: true });
    setStatus(`Redo. ${state.redoStack.length} more available.`);
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
    if (!frame) { inspector.show(null); selection.hide(); return; }
    inspector.show(frame);
    tree.select(frame);
    for (const sel of els.stage.querySelectorAll('.sc2-frame.selected')) {
        sel.classList.remove('selected');
    }
    if (frame._el) frame._el.classList.add('selected');
    selection.show(frame);
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
<p class="preview-meta">Exported from <code>SC2 UI Editor v${state.config && state.config.version || '0.3'}</code> &middot; source: <code>${escapeHtml(state.currentFileName || '(unknown)')}</code></p>
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
    const SKELETON =
        '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n' +
        '<Desc>\n' +
        '</Desc>\n';
    state.currentPath = null;
    // Clear the previously-opened file's FileSystemFileHandle - otherwise
    // Ctrl+S on the new untitled doc would silently overwrite the file the
    // user just had open. Data-loss bug. Save / SaveAs will prompt for a
    // new handle when needed.
    state.fileHandle = null;
    textures.setModRoot(null);     // no mod assets context for a brand-new doc
    openFromText(SKELETON, 'untitled.SC2Layout');
    setStatus('New blank layout. Use "+ Add frame..." to start adding content.');
}

// Insert a new <Frame type="X" name="..."/> with sensible defaults under
// the currently-selected frame (or document root if no selection). Selects
// the new frame so the user can immediately edit it via the inspector.
function addNewFrame(type) {
    if (!state.modDoc || !state.modDoc.root) {
        createNewLayout();
    }
    const parent = (state.selected && state.selected._modSource)
        || state.modDoc.root;
    const name = uniqueChildName(parent, type);
    const newFrame = buildFrameElement(type, name);
    snapshotForUndo();
    appendChildElement(parent, newFrame);
    setParentRefs(state.modDoc);   // re-link _parent refs for the new subtree
    rerender();
    // Try to select the new frame in the rerendered tree. Path is parent path
    // + "/" + name (or just name if parent is the root <Desc>).
    let selPath = name;
    if (parent !== state.modDoc.root) {
        const parentName = (parent.attrs.find(a => a.name === 'name') || {}).value;
        if (parentName) selPath = `${parentName}/${name}`;
    }
    // Path-only lookup: uniqueChildName guarantees no path collision
    // inside `parent`, so falling back to name (the old code did) is both
    // unnecessary AND risks matching a same-named frame elsewhere in the
    // tree. If path lookup fails the insert was inconsistent with the
    // rerender - better to surface that than paper over it.
    const target = findFrameByPath(state.frames, selPath);
    if (target) selectFrame(target, false);
    setStatus(`Inserted ${type}:${name}. Edit in the inspector or rename via XML.`);
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
// size, plus any type-specific children that make the frame useful out of
// the box (e.g. Buttons get a NormalImage/HoverImage placeholder).
function buildFrameElement(type, name) {
    const i = '\n        ';
    const i2 = '\n            ';
    const close = '\n    ';
    const children = [
        textNode(i),
        elementNode('Anchor', [['side','Top'],['relative','$parent'],['pos','Min'],['offset','0']], true),
        textNode(i),
        elementNode('Anchor', [['side','Left'],['relative','$parent'],['pos','Min'],['offset','0']], true),
        textNode(i),
        elementNode('Width', [['val','100']], true),
        textNode(i),
        elementNode('Height', [['val','100']], true),
    ];
    if (type === 'Label') {
        children.push(textNode(i), elementNode('Text', [['val','New Label']], true));
        children.push(textNode(i), elementNode('Style', [['val','StandardTemplate']], true));
    } else if (type === 'Image') {
        // Empty Texture - user fills in via inspector or XML.
        children.push(textNode(i), elementNode('Texture', [['val','']], true));
    } else if (type === 'Button') {
        // Buttons need a NormalImage + HoverImage to be visible.
        children.push(textNode(i),
            elementNode('Frame', [['type','Image'],['name','NormalImage']], false, [
                textNode(i2),
                elementNode('Anchor', [['relative','$parent'],['offset','0']], true),
                textNode(i2),
                elementNode('Texture', [['val','@@@UI/HeroPanelButtonNormal']], true),
                textNode(i),
            ]));
        children.push(textNode(i),
            elementNode('Frame', [['type','Image'],['name','HoverImage']], false, [
                textNode(i2),
                elementNode('Anchor', [['relative','$parent'],['offset','0']], true),
                textNode(i2),
                elementNode('Texture', [['val','@@@UI/HeroPanelButtonHover']], true),
                textNode(i),
            ]));
    }
    children.push(textNode(close));
    return elementNode('Frame', [['type', type], ['name', name]], false, children);
}

function elementNode(tag, attrs, selfClosing, children = []) {
    return {
        type: 'element',
        tag,
        attrs: attrs.map(([n, v]) => ({
            name: n, value: String(v), quote: '"',
            rawBetween: ' ', rawEq: '=', rawAfter: '',
        })),
        selfClosing: !!selfClosing,
        children,
        opening: null, closing: null,
        source: null,
        start: 0, end: 0,
        dirty: true,
    };
}

function textNode(raw) {
    return { type: 'text', raw, start: 0, end: 0, dirty: true };
}

function appendChildElement(parent, child) {
    const kids = parent.children;
    let indent = '\n    ';
    for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.type === 'text' && /\n[ \t]*$/.test(k.raw)) {
            const m = k.raw.match(/\n([ \t]*)$/);
            if (m) indent = '\n' + m[1];
            break;
        }
    }
    const last = kids[kids.length - 1];
    if (!last || last.type !== 'text' || !/\s$/.test(last.raw)) {
        kids.push(textNode(indent));
    }
    kids.push(child);
    // Ensure there's a trailing newline before the close tag.
    parent.dirty = true;
}

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
            state.fileHandle = handle;
            state.currentPath = null;
            textures.setModRoot(null);
            openFromText(text, file.name);
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
            return;
        } catch (err) {
            console.warn('[save] direct write failed, falling back to download:', err);
        }
    }
    saveAsDownload(state.currentFileName || 'layout.SC2Layout', out);
}

async function saveAs() {
    if (!state.modDoc) return;
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
    setStatus(`Downloaded ${filename} (${body.length} bytes). Use Open → in-place save to write directly next time.`);
}

function runRoundTripCheck() {
    try {
        const out = serializeXml(state.modDoc);
        if (out === state.pristineSource) {
            setXmlStatus('round-trip: byte-exact ✓');
        } else {
            const diff = firstDiff(state.pristineSource, out);
            setXmlStatus(`round-trip: differs at offset ${diff}`);
        }
    } catch (err) {
        setXmlStatus('round-trip: ' + err.message);
    }
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
    return n;
}

// Show a persistent banner when the server didn't auto-find an assets folder.
// The user types a path; we POST it to /__config so the server saves it to
// config.json and starts serving from there. Then we reload.
function showAssetsPrompt(cfg) {
    const banner = document.createElement('div');
    banner.id = 'assets-banner';
    const sc2Detected = cfg.sc2_install
        ? `<div class="assets-banner-sc2">SC2 install: <code>${cfg.sc2_install}</code> <span class="src">(${cfg.sc2_install_source})</span></div>`
        : `<div class="assets-banner-sc2 not-found">SC2 install: <em>not auto-detected</em> <span class="src">(${cfg.sc2_install_source})</span></div>`;
    banner.innerHTML = `
        <div class="assets-banner-text">
            <strong>No SC2 assets folder found.</strong>
            Templates / fontstyles / textures won't load until you set one.
        </div>
        ${sc2Detected}
        <button id="cascextract-btn" type="button" title="Extracts textures + fonts from your local StarCraft II install using CascLib. Requires SC2 to be installed.">Extract from SC2&nbsp;install</button>
        <button id="set-sc2-path-btn" type="button" title="Tell the editor where SC2 is installed if auto-detect couldn't find it.">Set SC2 path&hellip;</button>
        <button id="download-stock-btn" type="button" title="Fetches ~30 essential layout + asset files from github.com/SC2Mapster/SC2GameData (about 500 KB - 2 MB). XML / Assets.txt only - no textures.">Download essentials</button>
        <button id="set-assets-btn" type="button">Use existing folder&hellip;</button>
        <button id="dismiss-banner-btn" type="button" title="Dismiss">&times;</button>
        <div id="download-progress" hidden></div>
    `;
    document.body.appendChild(banner);

    // Manual SC2 install path override - for installs Battle.net put in a
    // location my auto-detect doesn't cover.
    document.getElementById('set-sc2-path-btn').addEventListener('click', async () => {
        const path = prompt(
            "Enter the path to your StarCraft II install folder.\n\n" +
            "This is the folder that contains 'StarCraft II.exe' and 'Data\\'.\n" +
            "Examples:\n" +
            "  C:\\Program Files (x86)\\StarCraft II\n" +
            "  C:\\Games\\StarCraft II\n" +
            "  D:\\Battle.net\\Games\\StarCraft II",
            cfg.sc2_install || '');
        if (!path) return;
        try {
            const resp = await fetch('/__config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sc2_install: path }),
            });
            const r = await resp.json();
            if (r.error) {
                alert(`Could not set SC2 install path: ${r.error}\n${r.path || ''}\n\nMake sure the folder contains 'StarCraft II.exe'.`);
                return;
            }
            state.config = r;
            setStatus(`SC2 install set: ${r.sc2_install}`);
            banner.remove();
        } catch (err) {
            alert('Failed to update config: ' + err.message);
        }
    });

    // CASC extraction: when SC2 is detected (or user-set), pull textures + fonts
    // directly from their own install without any manual extraction tool.
    const cascBtn = document.getElementById('cascextract-btn');
    if (cascBtn) {
        if (!cfg.sc2_install) {
            cascBtn.disabled = true;
            cascBtn.title = 'No SC2 install detected. Click "Set SC2 path…" first.';
        }
        cascBtn.addEventListener('click', async () => {
            const ok = confirm(
                "Extract textures and fonts from your SC2 install?\n\n" +
                `SC2 install: ${cfg.sc2_install}\n\n` +
                "This uses the open-source CascLib to read the game's CASC archive\n" +
                "and copies only the files referenced by your loaded layouts.\n" +
                "Typical: ~5-50 MB of textures + 2-5 MB of fonts.\n\n" +
                "First extraction can take 30 seconds while CascLib scans the archive.\n" +
                "Subsequent extractions are much faster (cached).");
            if (!ok) return;
            const progress = document.getElementById('download-progress');
            cascBtn.disabled = true;
            cascBtn.textContent = 'Extracting…';
            progress.hidden = false;
            progress.textContent = 'Opening CASC archive (this can take ~30s)…';
            try {
                const resp = await fetch('/__cascextract', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ all_textures: true, include_fonts: true }),
                });
                const r = await resp.json();
                if (r.error) {
                    progress.textContent = `Failed: ${r.error}${r.detail ? ' - ' + r.detail : ''}`;
                    cascBtn.disabled = false;
                    cascBtn.textContent = 'Extract from SC2 install';
                    return;
                }
                progress.textContent =
                    `Extracted ${r.extracted}, skipped ${r.skipped} existing, ${r.failed.length} failed `
                    + `(${(r.bytes / 1024 / 1024).toFixed(1)} MB).`;
                if (r.failed.length) console.warn('[cascextract] failures:', r.failed);
                banner.remove();
                await refreshAfterAssetChange();
            } catch (err) {
                progress.textContent = `Failed: ${err.message}`;
                cascBtn.disabled = false;
                cascBtn.textContent = 'Extract from SC2 install';
            }
        });
    }

    document.getElementById('set-assets-btn').addEventListener('click', async () => {
        const path = prompt(
            'Enter the path to your extracted SC2 mods folder ' +
            '(the one containing core.sc2mod, liberty.sc2mod, etc.):',
            cfg.assets_root || '');
        if (!path) return;
        try {
            const resp = await fetch('/__config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ assets_root: path }),
            });
            const updated = await resp.json();
            if (updated.error) {
                alert(`Could not set assets folder: ${updated.error}\n${updated.path || updated.detail || ''}`);
                return;
            }
            state.config = updated;
            banner.remove();
            await refreshAfterAssetChange();
        } catch (err) {
            alert('Failed to update server config: ' + err.message);
        }
    });

    document.getElementById('download-stock-btn').addEventListener('click', async () => {
        const ok = confirm(
            "Download SC2 stock data?\n\n" +
            "This fetches about 30 essential files (~500 KB - 2 MB) from\n" +
            "github.com/SC2Mapster/SC2GameData and saves them to a 'stock-data'\n" +
            "folder next to this app.\n\n" +
            "Note: this does NOT include binary texture files (.dds). Those\n" +
            "require a real SC2 install + an extraction tool. The editor will\n" +
            "still work for layout editing without textures - frames just render\n" +
            "as colored boxes instead of images.\n\n" +
            "Continue?");
        if (!ok) return;
        const btn = document.getElementById('download-stock-btn');
        const progress = document.getElementById('download-progress');
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        progress.hidden = false;
        progress.textContent = 'Contacting github.com…';
        try {
            const resp = await fetch('/__download', { method: 'POST' });
            const result = await resp.json();
            if (result.error) {
                progress.textContent = `Failed: ${result.error}`;
                btn.disabled = false;
                btn.textContent = 'Download essentials';
                return;
            }
            const msg = `Downloaded ${result.downloaded} new, skipped ${result.skipped} existing, ${result.failed.length} failed (${(result.bytes / 1024).toFixed(0)} KB).`;
            progress.textContent = msg;
            if (result.failed.length) {
                console.warn('[download] failures:', result.failed);
            }
            banner.remove();
            await refreshAfterAssetChange();
        } catch (err) {
            progress.textContent = `Failed: ${err.message}`;
            btn.disabled = false;
            btn.textContent = 'Download essentials';
        }
    });

    document.getElementById('dismiss-banner-btn').addEventListener('click', () => banner.remove());
    setStatus('No assets folder. Click "Download essentials" or "Use existing folder…".');
}

// Persistent assets/settings dialog. Mirrors the assets-banner buttons but
// stays accessible after the banner is dismissed.
async function openAssetsDialog() {
    const dlg = els.assetsDialog;
    const body = els.assetsDialogBody;
    body.innerHTML = '<p class="hint">Loading current config…</p>';
    dlg.showModal();
    let cfg;
    try {
        cfg = await fetch('/__config').then(r => r.json());
    } catch (err) {
        body.innerHTML = `<p>Could not contact server: ${err.message}</p>`;
        return;
    }
    body.innerHTML = `
        <table class="assets-table">
            <tr><th>Editor version</th><td>${cfg.version || '?'}</td></tr>
            <tr><th>Assets folder</th>
                <td>
                    ${cfg.assets_present ? `<code>${cfg.assets_root}</code> <span class="src">(${cfg.assets_source})</span>` : '<em>none set</em>'}
                </td></tr>
            <tr><th>SC2 install</th>
                <td>
                    ${cfg.sc2_install ? `<code>${cfg.sc2_install}</code> <span class="src">(${cfg.sc2_install_source})</span>` : `<em>not detected</em> <span class="src">(${cfg.sc2_install_source})</span>`}
                </td></tr>
        </table>
        <div class="assets-actions">
            <button type="button" id="dlg-cascextract" ${cfg.sc2_install ? '' : 'disabled'}
                    title="${cfg.sc2_install ? 'Extract textures + fonts from the SC2 install via CascLib.' : 'No SC2 install detected. Click "Set SC2 path…" first.'}">
                Extract textures + fonts from SC2
            </button>
            <button type="button" id="dlg-set-sc2">Set SC2 install path&hellip;</button>
            <button type="button" id="dlg-download">Download stock essentials</button>
            <button type="button" id="dlg-set-assets">Set assets folder&hellip;</button>
        </div>
        <div id="dlg-progress" class="dlg-progress" hidden></div>
    `;
    const progress = body.querySelector('#dlg-progress');
    const showStatus = (msg) => { progress.hidden = false; progress.textContent = msg; };
    body.querySelector('#dlg-cascextract').addEventListener('click', () => runCascExtract(cfg, showStatus));
    body.querySelector('#dlg-set-sc2').addEventListener('click', () => promptSetSc2(cfg));
    body.querySelector('#dlg-download').addEventListener('click', () => runStockDownload(showStatus));
    body.querySelector('#dlg-set-assets').addEventListener('click', () => promptSetAssets(cfg));
}

async function runCascExtract(cfg, showStatus) {
    const ok = confirm(
        `Extract textures and fonts from your SC2 install?\n\n` +
        `SC2 install: ${cfg.sc2_install}\n\n` +
        `Reads the game's CASC archive via CascLib and writes the referenced files\n` +
        `into the active assets folder. ~5-50 MB textures, ~2-5 MB fonts.\n\n` +
        `First extraction can take ~30 seconds while CascLib scans the archive.`);
    if (!ok) return;
    showStatus('Opening CASC archive (this can take ~30s)…');
    try {
        const r = await fetch('/__cascextract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all_textures: true, include_fonts: true }),
        }).then(r => r.json());
        if (r.error) {
            showStatus(`Failed: ${r.error}${r.detail ? ' - ' + r.detail : ''}`);
            console.warn('[cascextract] failed:', r);
            return;
        }
        showStatus(
            `Extracted ${r.extracted}, skipped ${r.skipped} existing, ${r.failed.length} failed `
            + `(${(r.bytes / 1024 / 1024).toFixed(1)} MB).`);
        if (r.failed.length) console.warn('[cascextract] failures:', r.failed);
        // Refresh in place - drop the texture cache so previously-failed
        // textures get re-fetched against the now-extracted files. Keeps the
        // currently-loaded layout open.
        refreshAfterAssetChange();
    } catch (err) {
        showStatus('Failed: ' + err.message);
    }
}

async function promptSetSc2(cfg) {
    const path = prompt(
        "Enter the path to your StarCraft II install folder.\n" +
        "This is the folder that contains 'StarCraft II.exe' and 'Data\\'.\n\n" +
        "Examples:\n" +
        "  C:\\Program Files (x86)\\StarCraft II\n" +
        "  C:\\Games\\StarCraft II\n" +
        "  D:\\Battle.net\\Games\\StarCraft II",
        cfg.sc2_install || '');
    if (!path) return;
    const r = await fetch('/__config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sc2_install: path }),
    }).then(r => r.json());
    if (r.error) {
        alert(`Could not set SC2 install path: ${r.error}\n${r.path || ''}\n\nMake sure the folder contains 'StarCraft II.exe'.`);
        return;
    }
    // SC2 path change only affects /__cascextract - no asset reload needed.
    state.config = await fetch('/__config').then(r => r.json());
    setStatus(`SC2 install set: ${state.config.sc2_install}`);
}

async function promptSetAssets(cfg) {
    const path = prompt(
        'Enter the path to your extracted SC2 mods folder ' +
        '(the one containing core.sc2mod, liberty.sc2mod, etc.):',
        cfg.assets_root || '');
    if (!path) return;
    const r = await fetch('/__config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assets_root: path }),
    }).then(r => r.json());
    if (r.error) {
        alert(`Could not set assets folder: ${r.error}\n${r.path || ''}`);
        return;
    }
    state.config = await fetch('/__config').then(r => r.json());
    setStatus(`Assets folder: ${state.config.assets_root}`);
    refreshAfterAssetChange();
}

async function runStockDownload(showStatus) {
    showStatus('Downloading stock essentials from github.com/SC2Mapster/SC2GameData…');
    try {
        const r = await fetch('/__download', { method: 'POST' }).then(r => r.json());
        if (r.error) {
            showStatus(`Failed: ${r.error}`);
            return;
        }
        showStatus(`Downloaded ${r.downloaded} new, skipped ${r.skipped} existing, ${r.failed.length} failed.`);
        refreshAfterAssetChange();
    } catch (err) {
        showStatus('Failed: ' + err.message);
    }
}

// Refresh editor state after new files land on disk without losing the open
// layout. Clears texture cache (so failed fetches retry against now-cached
// files), re-loads font styles + stock layouts since both may have changed,
// then re-renders.
async function refreshAfterAssetChange() {
    textures.cache.clear();
    textures.aliasesLoaded = false;
    await textures.loadAssetsTxt().catch(() => {});
    // Reset the registry so stock templates re-load from the new folder.
    registry.constants.clear();
    registry.templatesByPath.clear();
    registry.templatesByName.clear();
    registry.framesByPath.clear();
    registry.loadedFiles.clear();
    registry.errors.length = 0;
    state.stockLoaded = false;
    state.stockLoading = false;
    await loadStockLayouts().catch(() => {});
    await loadFontStyles().catch(() => {});
    // Also re-register the current mod's templates (they got cleared above).
    if (state.modDoc && state.currentFileName) {
        const fileBase = state.currentFileName.replace(/\.[^.]+$/, '').split(/[\\\/]/).pop();
        registry.addModTemplates(state.modDoc.root, fileBase);
    }
    rerender({ keepSelection: true });
}

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

    const frames = listNamedFrames(state.modDoc);
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

    body.innerHTML = `
        <div class="triggers-export-row">
            <label>Mod library ID
                <input id="trig-lib-id" type="text" pattern="[0-9A-Fa-f]{8}" maxlength="8"
                       placeholder="e.g. 555B09F0" value="${remembered.modLibId || ''}">
            </label>
            <label>GUID prefix
                <input id="trig-prefix" type="text" pattern="[0-9A-Fa-f]{1,6}" maxlength="6"
                       placeholder="e.g. 7C0D" value="${remembered.idPrefix || '7C0D'}">
            </label>
        </div>
        <div class="triggers-export-row">
            <label>Layout file path inside mod
                <input id="trig-layout-path" type="text" style="width: 100%"
                       placeholder="UI\\Layout\\${layoutName}.SC2Layout"
                       value="${remembered.layoutPath || `UI\\\\Layout\\\\${layoutName}.SC2Layout`}">
            </label>
        </div>
        <div class="triggers-export-row triggers-export-options">
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

    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = () => {
        if (dlg.returnValue !== 'generate') return;
        const modLibId = body.querySelector('#trig-lib-id').value.trim().toUpperCase();
        const idPrefix = body.querySelector('#trig-prefix').value.trim().toUpperCase();
        const layoutPath = body.querySelector('#trig-layout-path').value.trim();
        if (!/^[0-9A-F]{8}$/.test(modLibId)) {
            alert('Mod library ID must be exactly 8 hex characters.');
            return;
        }
        if (!/^[0-9A-F]{1,6}$/.test(idPrefix)) {
            alert('GUID prefix must be 1-6 hex characters.');
            return;
        }
        const includeClickHandlers = body.querySelector('#trig-click-handlers').checked;
        try {
            // Persist settings + opt-in list for next time.
            try { localStorage.setItem(optInStorageKey, JSON.stringify([...checkedPaths])); } catch {}
            try { localStorage.setItem('sc2editor.triggerSettings',
                JSON.stringify({ modLibId, idPrefix, layoutPath, includeClickHandlers })); } catch {}
            const filtered = frames.filter(f => checkedPaths.has(f.path));
            const xml = generateTriggersXml({
                modLibId, idPrefix, layoutPath, layoutName,
                frames: filtered,
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
            URL.revokeObjectURL(url);
            const handlerNote = buttonCount > 0 ? ` (+ ${buttonCount} click-handler stubs)` : '';
            setStatus(`Generated Triggers XML for ${filtered.length} frames${handlerNote}. Saved as ${layoutName}_Triggers.xml.`);
        } catch (err) {
            alert('Failed to generate Triggers XML: ' + err.message);
        }
    };
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

function showLoading(msg) {
    els.loadingOverlay.hidden = false;
    setLoadingMsg(msg);
}
function setLoadingMsg(msg) { els.loadingMsg.textContent = msg; }
function hideLoading() { els.loadingOverlay.hidden = true; }
function setStatus(s) { els.status.textContent = s; }
function setXmlStatus(s) { els.xmlStatus.textContent = s; }
