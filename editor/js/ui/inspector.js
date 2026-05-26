// Editable inspector panel.
//
// The panel renders form inputs bound directly to the selected frame's
// underlying mod XML element (_modSource). Each input writes through to
// XML via setAttr / createOrUpdateChild and fires `onChange(node)` so the
// host re-runs layout + paints + serializes the doc.
//
// Read-only sections (resolved box, template-inherited values) stay text
// only - those don't make sense to edit at the instance level.

import { setAttr } from '../xml/serializer.js';
import { attrMap, attrVal, findChild, hasChild, findAnchorChild } from '../xml/helpers.js';
import {
    makeElement, textNode,
    appendChildPreservingIndent, removeChildAndWhitespace,
    deepCloneElement, inferIndentBefore,
} from '../xml/mutate.js';
import { attachAutocomplete } from './autocomplete.js';
import { stateGroupsFor } from '../state-groups.js';

export class Inspector {
    constructor(rootEl, opts = {}) {
        this.rootEl = rootEl;
        this.frame = null;
        // onChange(frame, live) - live=true while user is mid-spin / mid-type
        // (host should do a cheap positions-only rerender); live=false on
        // commit (blur/Enter), host should do the full rerender + pane refresh.
        this.onChange = opts.onChange || (() => {});
        this.onBeforeChange = opts.onBeforeChange || (() => {});
        // Suggesters are functions that take a query string and return an
        // array of { value, label?, hint? } objects. Used to power
        // autocomplete on Texture / Style / template fields.
        //   suggesters.texture(query)  - alias keys + literal paths
        //   suggesters.style(query)    - FontStyles entries
        //   suggesters.template(query) - registered templates
        this.suggesters = opts.suggesters || {};
        // Map<framePath#groupName, stateName> tracking which visual state the
        // user has selected for preview, per frame + StateGroup. Survives
        // selection changes via main.js holding the reference.
        this.activeStates = opts.activeStates || new Map();
        // Callback fired when the user picks a different state from the
        // dropdown so the host can rerender.
        this.onStateChange = opts.onStateChange || (() => {});
    }

    show(frame) {
        // If a text/number input inside the inspector currently has focus,
        // it may have a typed-but-not-yet-committed value (change event
        // fires on blur, not on every keystroke for text fields). About to
        // rebuild the DOM via replaceChildren -> the input gets detached
        // without ever firing change -> the edit silently vanishes.
        // Force a blur on the active element first so it fires change.
        const active = document.activeElement;
        if (active && this.rootEl.contains(active) && typeof active.blur === 'function') {
            active.blur();
        }
        this.frame = frame;
        this.rootEl.replaceChildren();
        if (!frame) {
            const p = document.createElement('p');
            p.className = 'hint';
            p.textContent = 'Select a frame in the hierarchy.';
            this.rootEl.appendChild(p);
            return;
        }

        const source = frame._modSource;
        const editable = !!source && frame.origin === 'mod';
        if (!editable) {
            const note = document.createElement('div');
            note.className = 'inspector-readonly-note';
            note.textContent = frame.synthetic
                ? 'Synthetic chain wrapper (read-only).'
                : 'Stock-origin frame (read-only; copy to your mod to edit).';
            this.rootEl.appendChild(note);
        }

        this._identitySection(frame);
        this._boxSection(frame);
        if (editable) {
            this._declaredSizeSection(frame, source);
            this._anchorsSection(frame, source);
            this._textPropsSection(frame, source);
        } else {
            // Show inherited values as text only.
            if (frame.width != null || frame.height != null) {
                this._sectionTitle('Declared size (inherited)');
                this._textRow('Width', frame.width ?? '—');
                this._textRow('Height', frame.height ?? '—');
            }
            if (frame.anchors.length) {
                this._sectionTitle('Anchors (inherited)');
                for (const a of frame.anchors) {
                    this._textRow(`${a.side || 'all'} → ${a.relative} ${a.pos || ''}`, a.offset);
                }
            }
        }

        // Frame XML attributes - displayed read-only since most of them are
        // identity fields (type, name, template) we don't want users editing
        // via the inspector. The XML pane covers that workflow.
        if (source && source.attrs && source.attrs.length) {
            this._sectionTitle('Frame attributes');
            for (const a of source.attrs) {
                this._textRow(a.name, a.value);
            }
        }

        // Visual state preview: works for read-only frames too since picking
        // a state doesn't mutate XML, only the editor's preview override.
        this._statesSection(frame);

        if (editable) this._actionsSection(frame, source);
    }

    /** "Visual state" section. Shows one dropdown per StateGroup defined on
     *  the selected frame (typically Normal / Hover / Pressed). Picking a
     *  state writes to the shared activeStates Map and calls onStateChange. */
    _statesSection(frame) {
        const groups = stateGroupsFor(frame);
        if (!groups.length) return;
        this._sectionTitle('Visual state preview');
        for (const g of groups) {
            const key = `${frame.path}#${g.name}`;
            const current = this.activeStates.get(key) || g.defaultState;
            const div = document.createElement('div');
            div.className = 'inspector-row';
            const l = document.createElement('label');
            l.textContent = g.name;
            l.title = `StateGroup "${g.name}"`;
            const sel = document.createElement('select');
            for (const s of g.states) {
                const opt = document.createElement('option');
                opt.value = s.name;
                opt.textContent = s.name + (s.name === g.defaultState ? ' (default)' : '');
                if (s.name === current) opt.selected = true;
                sel.appendChild(opt);
            }
            sel.addEventListener('change', () => {
                if (sel.value === g.defaultState) this.activeStates.delete(key);
                else this.activeStates.set(key, sel.value);
                this.onStateChange();
            });
            div.appendChild(l);
            div.appendChild(sel);
            this.rootEl.appendChild(div);
        }
        // Show the most recent action summary for the active state so the
        // user can tell at a glance what the state is doing.
        for (const g of groups) {
            const key = `${frame.path}#${g.name}`;
            const stateName = this.activeStates.get(key) || g.defaultState;
            const state = g.states.find(s => s.name === stateName);
            if (!state || !state.actions.length) continue;
            const note = document.createElement('div');
            note.className = 'inspector-state-actions';
            const lines = state.actions.map(a => {
                const props = Object.entries(a.props || {})
                    .filter(([k, v]) => v !== undefined && k !== 'requiredtoload')
                    .map(([k, v]) => `${k}=${v}`).join(' ');
                return `→ ${a.frame} { ${props} }`;
            });
            note.textContent = `${g.name}/${stateName}: ${lines.join('  ')}`;
            this.rootEl.appendChild(note);
        }
    }

    // ------- sections -------

    _identitySection(frame) {
        this._sectionTitle('Identity');
        this._textRow('Type', frame.type);
        this._textRow('Name', frame.name);
        this._textRow('Path', frame.path || frame.name);
    }

    _boxSection(frame) {
        this._sectionTitle('Box (resolved)');
        this._textRow('x', round(frame.x));
        this._textRow('y', round(frame.y));
        this._textRow('w', round(frame.w));
        this._textRow('h', round(frame.h));
    }

    _declaredSizeSection(frame, source) {
        this._sectionTitle('Declared size');
        const widthEl = findChild(source, 'Width');
        const heightEl = findChild(source, 'Height');
        // Issue #2: when both opposing anchors are set, SC2 DOES honour an
        // explicit Width/Height — the frame is centered between the two
        // anchor extents. (Beware the Mid/Mid case: if both anchors target
        // pos="Mid" on a parent that doesn't itself define those anchors,
        // SC2's resolution can render unexpectedly.) We surface the
        // situation as an informational note but keep the input editable.
        const hasLeft = !!findAnchorChild(source, 'Left');
        const hasRight = !!findAnchorChild(source, 'Right');
        const hasTop = !!findAnchorChild(source, 'Top');
        const hasBottom = !!findAnchorChild(source, 'Bottom');
        const bothHor = hasLeft && hasRight;
        const bothVer = hasTop && hasBottom;
        const midWarn = (a, b) => {
            const apos = a && attrVal(a, 'pos');
            const bpos = b && attrVal(b, 'pos');
            return apos === 'Mid' && bpos === 'Mid';
        };
        const horMidMid = bothHor && midWarn(findAnchorChild(source, 'Left'),
                                             findAnchorChild(source, 'Right'));
        const verMidMid = bothVer && midWarn(findAnchorChild(source, 'Top'),
                                             findAnchorChild(source, 'Bottom'));
        this._numberRow('Width', widthEl ? attrVal(widthEl, 'val') : '',
            (v, live) => this._writeSizedChild(source, 'Width', v, 'val', { live, liveSession: true }),
            'auto',
            bothHor ? {
                note: horMidMid
                    ? 'Both Left + Right anchors target Mid — SC2 may render unexpectedly unless the parent itself defines these anchors. With Width set, the frame is centered between the anchor extents.'
                    : 'Anchored on Left + Right. With Width set, SC2 centers the frame within the anchor extent; leave blank to fill the extent.',
            } : {});
        this._numberRow('Height', heightEl ? attrVal(heightEl, 'val') : '',
            (v, live) => this._writeSizedChild(source, 'Height', v, 'val', { live, liveSession: true }),
            'auto',
            bothVer ? {
                note: verMidMid
                    ? 'Both Top + Bottom anchors target Mid — SC2 may render unexpectedly unless the parent itself defines these anchors. With Height set, the frame is centered between the anchor extents.'
                    : 'Anchored on Top + Bottom. With Height set, SC2 centers the frame within the anchor extent; leave blank to fill the extent.',
            } : {});
    }

    _anchorsSection(frame, source) {
        this._sectionTitle('Anchors');
        const anchorsBySide = {
            Top: null, Bottom: null, Left: null, Right: null,
        };
        for (const c of source.children) {
            if (c.type !== 'element' || c.tag !== 'Anchor') continue;
            const side = attrVal(c, 'side');
            if (side && side in anchorsBySide) anchorsBySide[side] = c;
        }
        for (const side of ['Top', 'Bottom', 'Left', 'Right']) {
            this._anchorRow(side, anchorsBySide[side], source);
        }
    }

    _anchorRow(side, anchorEl, source) {
        const row = document.createElement('div');
        row.className = 'inspector-row inspector-anchor-row';
        row.style.gridTemplateColumns = '54px 60px 1fr 60px 24px';

        const label = document.createElement('label');
        label.textContent = side;
        row.appendChild(label);

        if (!anchorEl) {
            // Compact "add" affordance for missing sides.
            const placeholder = document.createElement('span');
            placeholder.className = 'inspector-anchor-placeholder';
            placeholder.textContent = '—';
            placeholder.style.gridColumn = '2 / span 3';
            row.appendChild(placeholder);
            const add = document.createElement('button');
            add.type = 'button';
            add.textContent = '+';
            add.title = `Add ${side} anchor to $parent`;
            add.addEventListener('click', () => {
                this.onBeforeChange(this.frame);
                const created = makeElement('Anchor', [
                    ['side', side],
                    ['relative', '$parent'],
                    ['pos', (side === 'Top' || side === 'Left') ? 'Min' : 'Max'],
                    ['offset', '0'],
                ], true);
                appendChildPreservingIndent(source, created);
                this.onChange(this.frame);
                this.show(this.frame);
            });
            row.appendChild(add);
            this.rootEl.appendChild(row);
            return;
        }

        const posSelect = document.createElement('select');
        for (const p of ['Min', 'Mid', 'Max']) {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            if (attrVal(anchorEl, 'pos') === p) opt.selected = true;
            posSelect.appendChild(opt);
        }
        posSelect.addEventListener('change', () => {
            this.onBeforeChange(this.frame);
            setAttr(anchorEl, 'pos', posSelect.value);
            this.onChange(this.frame);
        });
        row.appendChild(posSelect);

        const rel = document.createElement('input');
        rel.type = 'text';
        rel.value = attrVal(anchorEl, 'relative') || '$parent';
        rel.addEventListener('change', () => {
            this.onBeforeChange(this.frame);
            setAttr(anchorEl, 'relative', rel.value);
            this.onChange(this.frame);
        });
        row.appendChild(rel);

        const off = document.createElement('input');
        off.type = 'number';
        off.step = '1';
        off.value = attrVal(anchorEl, 'offset') || '0';
        // Live update: hold the spinner or type a value and the canvas
        // tracks it in real time. Undo snapshot fires once per focus session.
        this._wireLiveNumber(off, (val, live) => {
            const v = parseFloat(val);
            if (!Number.isFinite(v)) return;
            setAttr(anchorEl, 'offset', String(v));
            this.onChange(this.frame, !!live);
        });
        row.appendChild(off);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.title = `Remove ${side} anchor`;
        remove.addEventListener('click', () => {
            this.onBeforeChange(this.frame);
            removeChildAndWhitespace(source, anchorEl);
            this.onChange(this.frame);
            this.show(this.frame);
        });
        row.appendChild(remove);

        this.rootEl.appendChild(row);
    }

    _textPropsSection(frame, source) {
        // Type-specific common props: Image has Texture, Label has Text + Style.
        // Render only when the corresponding tag is currently present OR the
        // frame's type suggests it would commonly have one.
        const wants = {
            Texture:    frame.type === 'Image' || frame.type === 'Button' || hasChild(source, 'Texture'),
            Text:       frame.type === 'Label' || frame.type === 'Button' || hasChild(source, 'Text'),
            Style:      frame.type === 'Label' || frame.type === 'Button' || hasChild(source, 'Style'),
            Tooltip:    frame.type === 'Button' || hasChild(source, 'Tooltip'),
            LayerColor: frame.type === 'Image' || hasChild(source, 'LayerColor'),
        };
        // Tags that render with a color swatch + native color picker.
        const colorFields = new Set(['LayerColor']);
        const fields = Object.entries(wants).filter(([_, v]) => v).map(([k]) => k);
        if (!fields.length) return;
        this._sectionTitle('Content');
        // Map tag -> suggester key. Tags not listed here get no autocomplete.
        const suggesterByTag = {
            Texture: this.suggesters.texture,
            Style:   this.suggesters.style,
        };
        for (const tag of fields) {
            const el = findChild(source, tag);
            const value = el ? attrVal(el, 'val') : '';
            if (colorFields.has(tag)) {
                this._colorRow(tag, value,
                    (v) => this._writeSizedChild(source, tag, v, 'val'));
            } else {
                this._textPropRow(tag, value,
                    (v) => this._writeSizedChild(source, tag, v, 'val'),
                    suggesterByTag[tag]);
            }
        }
        // TextureType: only meaningful when the frame has a Texture (so
        // it controls how that texture maps to the frame box). Many SC2
        // UI assets are designed to be 9-sliced / border-stretched - not
        // exposing this locked users out of using them properly.
        // Documented values (sc2mapster.wiki.gg/wiki/UI/Frame_Properties/TextureType):
        //   Normal | Border | HorizontalBorder | EndCap | NineSlice
        // Default when omitted = Normal.
        if (wants.Texture) {
            this._textureTypeRow(source);
        }
        // (Issue #4: removed HAlign/VAlign inputs. SC2 doesn't recognise
        // those as per-frame XML elements - text alignment is dictated by
        // the assigned FontStyle (HAlign/VAlign live inside .SC2Style
        // entries, not inside layout frames). Emitting them was at-best
        // ignored, at-worst caused the game to abort rendering. To change
        // alignment, edit/select a FontStyle whose Style entry has the
        // desired HAlign/VAlign.)
    }

    /** Dropdown for <TextureType val="..."/>. Blank = remove the element
     *  and inherit the default (Normal). */
    _textureTypeRow(source) {
        const VALUES = ['Normal', 'Border', 'HorizontalBorder', 'EndCap', 'NineSlice'];
        const div = document.createElement('div');
        div.className = 'inspector-row';
        const l = document.createElement('label');
        l.textContent = 'TextureType';
        l.title = 'How the texture maps to the frame box. Border / NineSlice / HorizontalBorder / EndCap use TextureCoords as slice insets.';
        const sel = document.createElement('select');
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '(default: Normal)';
        sel.appendChild(blank);
        for (const o of VALUES) {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = o;
            sel.appendChild(opt);
        }
        const el = findChild(source, 'TextureType');
        if (el) {
            const cur = attrVal(el, 'val') || '';
            sel.value = cur;
            // If the file has a value we don't list, surface it as a new
            // option so it's editable rather than silently wiped on commit.
            if (cur && !VALUES.includes(cur)) {
                const stray = document.createElement('option');
                stray.value = cur;
                stray.textContent = `${cur} (non-standard)`;
                sel.insertBefore(stray, sel.options[1]);
                sel.value = cur;
            }
        }
        sel.addEventListener('change', () => {
            this._writeSizedChild(source, 'TextureType', sel.value, 'val');
        });
        div.appendChild(l);
        div.appendChild(sel);
        this.rootEl.appendChild(div);
    }

    _actionsSection(frame, source) {
        this._sectionTitle('Actions');
        const row = document.createElement('div');
        row.className = 'inspector-actions';
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete frame';
        del.className = 'danger';
        del.addEventListener('click', () => {
            if (!confirm(`Delete frame "${frame.name}" and all its children?`)) return;
            this.onBeforeChange(frame);
            removeFromParent(source);
            this.onChange(null);
        });
        row.appendChild(del);

        const dup = document.createElement('button');
        dup.type = 'button';
        dup.textContent = 'Duplicate';
        dup.addEventListener('click', () => {
            this.onBeforeChange(frame);
            duplicateSibling(source);
            this.onChange(frame);
        });
        row.appendChild(dup);
        this.rootEl.appendChild(row);
    }

    // ------- writers -------

    /** Write <Width val="N"/>, <Height val="N"/>, <Text val="..."/> etc.
     *  Creates the child element on first edit; empty string removes it.
     *  Skips the undo snapshot when `liveSession` is set (caller already
     *  snapshotted at the start of the editing session). */
    _writeSizedChild(source, tag, newValue, attrName = 'val', opts = {}) {
        if (!opts.liveSession) this.onBeforeChange(this.frame);
        const existing = findChild(source, tag);
        const trimmed = newValue == null ? '' : String(newValue).trim();
        if (trimmed === '' && existing) {
            removeChildAndWhitespace(source, existing);
        } else if (existing) {
            setAttr(existing, attrName, trimmed);
        } else if (trimmed !== '') {
            const created = makeElement(tag, [[attrName, trimmed]], true);
            appendChildPreservingIndent(source, created);
        }
        this.onChange(this.frame, !!opts.live);
    }

    /** Wire input/change/focus/blur on a number input so the canvas
     *  updates LIVE while the user holds the spinner or types, while
     *  snapshots happen exactly once per focus-session. */
    _wireLiveNumber(inp, applyFn) {
        let sessionStarted = false;
        const startSession = () => {
            if (!sessionStarted) {
                this.onBeforeChange(this.frame);
                sessionStarted = true;
            }
        };
        const endSession = () => { sessionStarted = false; };
        inp.addEventListener('focus', endSession);   // reset; next input starts the new session
        inp.addEventListener('input', () => {
            startSession();
            applyFn(inp.value, /*live=*/true);
        });
        inp.addEventListener('change', () => {
            startSession();
            applyFn(inp.value, /*live=*/false);
            endSession();
        });
        inp.addEventListener('blur', () => {
            if (sessionStarted) {
                applyFn(inp.value, /*live=*/false);
                endSession();
            }
        });
    }

    // ------- ui primitives -------

    _sectionTitle(title) {
        const h = document.createElement('div');
        h.className = 'inspector-section-title';
        h.textContent = title;
        this.rootEl.appendChild(h);
    }

    _textRow(label, value) {
        const div = document.createElement('div');
        div.className = 'inspector-row';
        const l = document.createElement('label');
        l.textContent = label;
        const v = document.createElement('span');
        v.textContent = value;
        v.style.fontFamily = 'Consolas, monospace';
        v.style.fontSize = '12px';
        div.appendChild(l);
        div.appendChild(v);
        this.rootEl.appendChild(div);
    }

    _numberRow(label, value, onCommit, placeholder = '', opts = {}) {
        const div = document.createElement('div');
        div.className = 'inspector-row';
        if (opts.disabled) div.classList.add('inspector-row-disabled');
        const l = document.createElement('label');
        l.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '1';
        inp.value = value;
        inp.placeholder = placeholder;
        if (opts.disabled) {
            inp.disabled = true;
            inp.title = opts.note || 'Overridden.';
        } else if (opts.note) {
            inp.title = opts.note;
        }
        // Live update on every spinner click / keystroke; commit on blur/Enter.
        this._wireLiveNumber(inp, (val, live) => {
            const v = val === '' ? '' : parseFloat(val);
            if (val !== '' && !Number.isFinite(v)) return;
            onCommit(v === '' ? '' : v, live);
        });
        div.appendChild(l);
        div.appendChild(inp);
        this.rootEl.appendChild(div);
        // Inline explanatory note below the row whenever provided - it's
        // either an "input is disabled because X" message or an
        // informational warning that doesn't block editing (issue #2).
        if (opts.note) {
            const note = document.createElement('div');
            note.className = 'inspector-row-note';
            note.textContent = opts.note;
            this.rootEl.appendChild(note);
        }
    }

    /** Color row: text input + swatch that opens the native color picker.
     *  Parses SC2 color formats (RRGGBB / AARRGGBB / r,g,b / r,g,b,a /
     *  #NamedConstant). Writes back as uppercase RRGGBB hex by default
     *  unless the user types a different form into the text input. */
    _colorRow(label, value, onCommit) {
        const div = document.createElement('div');
        div.className = 'inspector-row inspector-color-row';
        const l = document.createElement('label');
        l.textContent = label;
        const wrap = document.createElement('div');
        wrap.className = 'inspector-color-wrap';

        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'inspector-color-swatch';
        swatch.title = 'Pick color (writes as RRGGBB hex)';

        const text = document.createElement('input');
        text.type = 'text';
        text.value = value || '';
        text.className = 'inspector-color-text';
        text.spellcheck = false;
        text.placeholder = 'RRGGBB or r,g,b or #Constant';

        const syncSwatchFromText = () => {
            const parsed = parseSc2ColorToHex(text.value);
            if (parsed) {
                swatch.value = parsed;
                swatch.disabled = false;
                swatch.title = 'Pick color (writes as RRGGBB hex)';
            } else {
                // Value is a constant reference or unparseable; disable the
                // swatch since we can't preview an unknown value.
                swatch.value = '#888888';
                swatch.disabled = true;
                swatch.title = 'Value is a constant or non-literal color; cannot preview.';
            }
        };
        syncSwatchFromText();

        text.addEventListener('change', () => {
            syncSwatchFromText();
            onCommit(text.value);
        });
        swatch.addEventListener('input', () => {
            // SC2's convention for hex is RRGGBB without a leading #, so write
            // back without the # but preserve user's casing preference (upper).
            const hex = swatch.value.slice(1).toUpperCase();
            text.value = hex;
            onCommit(hex);
        });

        wrap.appendChild(swatch);
        wrap.appendChild(text);
        div.appendChild(l);
        div.appendChild(wrap);
        this.rootEl.appendChild(div);
    }

    _textPropRow(label, value, onCommit, suggester) {
        const div = document.createElement('div');
        div.className = 'inspector-row';
        const l = document.createElement('label');
        l.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = value || '';
        inp.spellcheck = false;
        inp.addEventListener('change', () => onCommit(inp.value));
        if (suggester) attachAutocomplete(inp, suggester);
        div.appendChild(l);
        div.appendChild(inp);
        this.rootEl.appendChild(div);
    }
}

// ------- XML helpers ------- (attrMap/attrVal/findChild/hasChild/
// findAnchorChild live in xml/helpers.js since R4.1)

// Parse an SC2-style color string into a CSS-friendly #RRGGBB hex, or null
// if the value is a constant reference / gradient / unparseable. Supports:
//   RRGGBB        - 6 hex digits
//   AARRGGBB      - 8 hex digits (ARGB order; alpha dropped for the swatch)
//   r,g,b         - decimal triple 0..255
//   r,g,b,a       - decimal quad
//   "stop1|stop2" - takes the first stop
//   "#Foo"        - constant ref (returns null so caller disables swatch)
function parseSc2ColorToHex(v) {
    if (!v || typeof v !== 'string') return null;
    v = v.trim();
    if (v.startsWith('#')) return null;       // named constant, can't preview
    if (v.includes('|')) v = v.split('|')[0].trim();
    const h2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
    if (v.includes(',')) {
        const parts = v.split(',').map(s => parseInt(s.trim(), 10));
        if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
            return '#' + h2(parts[0]) + h2(parts[1]) + h2(parts[2]);
        }
        return null;
    }
    if (/^[0-9a-fA-F]{6}$/.test(v)) return '#' + v.toLowerCase();
    if (/^[0-9a-fA-F]{8}$/.test(v)) return '#' + v.slice(2).toLowerCase();
    return null;
}

// makeElement / appendNewChild / removeChild / deepCloneElement /
// indent-inferring helpers all moved to xml/mutate.js in R4.2.

// Remove a node from wherever it lives in the document. The parent isn't
// stored on the node itself, so we ask the caller to provide the source
// element which holds a parent reference via _parent (set by the merger
// when it constructs the tree). If unavailable we fall back to a doc walk.
function removeFromParent(el) {
    if (!el || !el._parent) {
        console.warn('[inspector] cannot remove: no parent reference on', el);
        return false;
    }
    return removeChildAndWhitespace(el._parent, el);
}

function duplicateSibling(el) {
    if (!el || !el._parent) return false;
    const copy = deepCloneElement(el);
    // Insert immediately after the original.
    const kids = el._parent.children;
    const idx = kids.indexOf(el);
    if (idx === -1) return false;
    const indent = inferIndentBefore(el._parent, idx);
    kids.splice(idx + 1, 0, textNode(indent), copy);
    el._parent.dirty = true;
    return true;
}

function round(n) {
    if (typeof n !== 'number') return n;
    return Math.round(n * 100) / 100;
}
