// Frame renderers - turn resolved layout nodes into DOM under the stage.
//
// Each node becomes a <div class="sc2-frame" data-name="..." data-type="..."> with
// absolute positioning. Image / Label / Button children paint their visuals into
// nested elements.

import { styleToCss } from './fontstyle.js';

export class FrameRenderer {
    constructor({ stage, textures, fontstyles, onSelect, onBodyPointerDown }) {
        this.stage = stage;
        this.textures = textures;
        this.fontstyles = fontstyles;
        this.onSelect = onSelect;
        this.onBodyPointerDown = onBodyPointerDown || (() => {});
        this.nodesByEl = new WeakMap();
    }

    clear() {
        // Only remove rendered frame DOM - preserve siblings like the backdrop
        // <img> and the SelectionOverlay's <div>, which are also children of
        // the stage but must persist across re-renders.
        for (const child of Array.from(this.stage.children)) {
            if (child.classList.contains('sc2-frame')) child.remove();
        }
    }

    /** Update existing frame elements' position/size in place WITHOUT
     *  recreating any DOM. Used during a live drag so texture canvases
     *  don't flicker through the magenta loading placeholder on every
     *  pointermove. Each node must already have a ._el reference from
     *  a prior render(). */
    updatePositions(nodes) {
        for (const n of nodes) {
            if (n._el) {
                n._el.style.left = n.x + 'px';
                n._el.style.top = n.y + 'px';
                n._el.style.width = n.w + 'px';
                n._el.style.height = n.h + 'px';
            }
            if (n.children && n.children.length) this.updatePositions(n.children);
        }
    }

    render(nodes) {
        this.clear();
        for (const node of nodes) this._renderNode(node, this.stage);
    }

    _renderNode(node, parentEl) {
        const el = document.createElement('div');
        el.className = 'sc2-frame outline';
        if (node.synthetic) el.classList.add('synthetic');
        el.dataset.name = node.name;
        el.dataset.type = node.type;
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        el.style.width = node.w + 'px';
        el.style.height = node.h + 'px';
        if (!node.visible) el.style.display = 'none';

        // Type-specific painters.
        switch (node.type) {
            case 'Image':      this._paintImage(node, el); break;
            case 'Label':      this._paintLabel(node, el); break;
            case 'Button':     this._paintButton(node, el); break;
            default:           /* generic Frame: container only */ break;
        }

        // pointerdown does double duty:
        //   - if no movement: it's a click -> select (or cycle through stack)
        //   - if movement crosses threshold: start a body drag on the selected
        //     frame via the SelectionOverlay.
        // We deliberately don't stopPropagation on pointerdown so the body-drag
        // logic in main.js can still see the event for stack tracking.
        el.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return;
            // Crucial: stop the pointerdown here so it does NOT bubble up to
            // ancestor .sc2-frame elements. Without this, every nested parent
            // also fires its own pointerdown -> attaches its own move/up
            // listeners -> drags itself simultaneously when the user moves
            // the cursor. Result: dragging a child also drags its grandparent.
            ev.stopPropagation();
            const startX = ev.clientX, startY = ev.clientY;
            let dragged = false;
            const onMove = (e) => {
                if (dragged) return;
                if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) {
                    dragged = true;
                    this.onBodyPointerDown(node, ev, el);
                }
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                if (!dragged) {
                    this.onSelect && this.onSelect(node, { x: startX, y: startY });
                }
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });

        this.nodesByEl.set(el, node);
        node._el = el;
        parentEl.appendChild(el);

        for (const child of node.children) this._renderNode(child, el);
    }

    _paintImage(node, el) {
        const inner = document.createElement('div');
        inner.className = 'sc2-image';
        el.appendChild(inner);

        const texAttr = findChildVal(node.xml, 'Texture');
        const textureType = findChildVal(node.xml, 'TextureType') || 'Normal';
        const tiled = (findChildVal(node.xml, 'Tiled') || '').toLowerCase() === 'true';
        const coords = findChildAttrs(node.xml, 'TextureCoords');

        if (!texAttr) {
            inner.style.background = 'rgba(120,120,140,0.18)';
            inner.title = '(no Texture child)';
            return;
        }

        // Bright magenta placeholder while loading. If the texture loads, we
        // replace the inner contents; if it fails to load OR decode, the magenta
        // stays so it's obvious which frames are missing pixels.
        inner.style.background = 'magenta';
        inner.style.opacity = '0.4';
        inner.title = `loading: ${texAttr}`;

        this.textures.load(texAttr).then(canvas => {
            if (!canvas) {
                inner.title = `failed: ${texAttr}`;
                return;
            }
            try {
                const renderCanvas = this._compositeTexture(canvas, {
                    width: node.w,
                    height: node.h,
                    textureType,
                    tiled,
                    coords,
                });
                if (renderCanvas.width === 0 || renderCanvas.height === 0) {
                    console.warn(`[paint] zero-size canvas for ${node.name} (${node.w}x${node.h})`, texAttr);
                    inner.title = `zero-size frame: ${texAttr}`;
                    return;
                }
                inner.style.background = '';
                inner.style.opacity = '';
                inner.title = `${texAttr}  (src ${canvas.width}x${canvas.height})`;
                inner.replaceChildren(renderCanvas);
                console.info(`[paint] ${node.name}: painted ${texAttr} into ${node.w}x${node.h}`);
            } catch (err) {
                console.warn(`[paint] composite failed for ${node.name}:`, err, texAttr);
                inner.title = `composite error: ${err.message}`;
            }
        }).catch(err => {
            console.warn('[texture]', err);
            inner.title = `error: ${err.message}`;
        });
    }

    _compositeTexture(srcCanvas, { width, height, textureType, tiled, coords }) {
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(width));
        out.height = Math.max(1, Math.round(height));
        const ctx = out.getContext('2d');

        // TextureCoords (normalized 0..1, defaults to full image).
        const c = coords ? {
            left: parseFloat(coords.left) || 0,
            top: parseFloat(coords.top) || 0,
            right: parseFloat(coords.right) || 1,
            bottom: parseFloat(coords.bottom) || 1,
        } : { left: 0, top: 0, right: 1, bottom: 1 };
        const sx = c.left * srcCanvas.width;
        const sy = c.top * srcCanvas.height;
        const sw = (c.right - c.left) * srcCanvas.width;
        const sh = (c.bottom - c.top) * srcCanvas.height;

        if (textureType === 'NineSlice') {
            // Splits the source into a 3x3 grid using TextureCoords as the
            // *inset* fractions. Corners stay fixed size, edges stretch.
            const insetL = c.left, insetT = c.top, insetR = c.right, insetB = c.bottom;
            const W = srcCanvas.width, H = srcCanvas.height;
            const lx = insetL * W, ty = insetT * H;
            const rx = insetR * W, by = insetB * H;
            const cornerL = lx, cornerT = ty, cornerR = W - rx, cornerB = H - by;
            // Source rects.
            drawSlice(ctx, srcCanvas,   0,          0,          cornerL, cornerT,   0,                  0,                  cornerL, cornerT); // TL
            drawSlice(ctx, srcCanvas,   W - cornerR, 0,         cornerR, cornerT,   out.width - cornerR,0,                  cornerR, cornerT); // TR
            drawSlice(ctx, srcCanvas,   0,          H - cornerB,cornerL, cornerB,   0,                  out.height-cornerB, cornerL, cornerB); // BL
            drawSlice(ctx, srcCanvas,   W - cornerR,H - cornerB,cornerR, cornerB,   out.width-cornerR,  out.height-cornerB, cornerR, cornerB); // BR
            // Edges (stretched).
            drawSlice(ctx, srcCanvas,   cornerL,    0,          rx-lx,   cornerT,   cornerL,            0,                  out.width-cornerL-cornerR, cornerT); // T
            drawSlice(ctx, srcCanvas,   cornerL,    H-cornerB,  rx-lx,   cornerB,   cornerL,            out.height-cornerB, out.width-cornerL-cornerR, cornerB); // B
            drawSlice(ctx, srcCanvas,   0,          cornerT,    cornerL, by-ty,     0,                  cornerT,            cornerL, out.height-cornerT-cornerB); // L
            drawSlice(ctx, srcCanvas,   W-cornerR,  cornerT,    cornerR, by-ty,     out.width-cornerR,  cornerT,            cornerR, out.height-cornerT-cornerB); // R
            // Centre.
            drawSlice(ctx, srcCanvas,   cornerL,    cornerT,    rx-lx,   by-ty,     cornerL,            cornerT,            out.width-cornerL-cornerR, out.height-cornerT-cornerB);
        } else if (tiled) {
            const pat = ctx.createPattern(srcCanvas, 'repeat');
            ctx.fillStyle = pat;
            ctx.fillRect(0, 0, out.width, out.height);
        } else {
            ctx.drawImage(srcCanvas, sx, sy, Math.max(1, sw), Math.max(1, sh), 0, 0, out.width, out.height);
        }
        return out;
    }

    _paintLabel(node, el) {
        const inner = this._buildTextElement(node);
        if (inner) el.appendChild(inner);
    }

    _paintButton(node, el) {
        // A Button stacks Normal/Hover image children plus an optional inline
        // text label. Child Images already render via the recursive walker;
        // we only emit a text element when this Button has its own Text=.
        const text = findChildVal(node.xml, 'Text');
        if (!text) return;
        const inner = this._buildTextElement(node, { defaultHAlign: 'Center', defaultVAlign: 'Middle' });
        if (inner) el.appendChild(inner);
    }

    /** Build the <div class="sc2-label"> that paints a frame's text.
     *  Honors per-frame <HAlign>/<VAlign> overrides on top of the resolved
     *  Style's hjustify/vjustify; passes-through optional defaults so
     *  Buttons centre text without an explicit override. */
    _buildTextElement(node, opts = {}) {
        const text = findChildVal(node.xml, 'Text') || '';
        const styleName = findChildVal(node.xml, 'Style');
        const style = this.fontstyles ? this.fontstyles.getStyle(styleName) : null;
        const css = styleToCss(style);
        const halign = findChildVal(node.xml, 'HAlign')
            || (style && style.hjustify)
            || opts.defaultHAlign
            || null;
        const valign = findChildVal(node.xml, 'VAlign')
            || (style && style.vjustify)
            || opts.defaultVAlign
            || null;
        if (halign === 'Center') css.justifyContent = 'center';
        else if (halign === 'Right') css.justifyContent = 'flex-end';
        else if (halign === 'Left') css.justifyContent = 'flex-start';
        if (valign === 'Middle') css.alignItems = 'center';
        else if (valign === 'Bottom') css.alignItems = 'flex-end';
        else if (valign === 'Top') css.alignItems = 'flex-start';
        const inner = document.createElement('div');
        inner.className = 'sc2-label';
        Object.assign(inner.style, css);
        inner.textContent = text;
        return inner;
    }
}

function drawSlice(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

function findChildVal(el, tag) {
    if (!el || !el.children) return undefined;
    for (const c of el.children) {
        if (c.type === 'element' && c.tag === tag) {
            const a = c.attrs.find(x => x.name === 'val');
            if (a) return a.value;
        }
    }
    return undefined;
}

function findChildAttrs(el, tag) {
    if (!el || !el.children) return undefined;
    for (const c of el.children) {
        if (c.type === 'element' && c.tag === tag) {
            const out = {};
            for (const a of c.attrs) out[a.name] = a.value;
            return out;
        }
    }
    return undefined;
}
