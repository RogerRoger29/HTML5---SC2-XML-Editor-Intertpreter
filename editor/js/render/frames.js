// Frame renderers - turn resolved layout nodes into DOM under the stage.
//
// Each node becomes a <div class="sc2-frame" data-name="..." data-type="..."> with
// absolute positioning. Image / Label / Button children paint their visuals into
// nested elements.

import { styleToCss } from './fontstyle.js';
import { findChildVal, findChildAttrs } from '../xml/helpers.js';

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
     *  a prior render().
     *
     *  Issue #3: node.x / node.y are STAGE-absolute (resolved by
     *  layoutFrames). But each .sc2-frame is `position: absolute` and is
     *  nested inside its parent .sc2-frame in the DOM, so CSS interprets
     *  `left` relative to the parent's padding box. Writing the stage-
     *  absolute x as `style.left` made the child double-displace whenever
     *  the parent moved: child appeared to shift by 2*Δ instead of Δ.
     *  Subtract parent's stage origin so CSS positioning matches.
     */
    updatePositions(nodes) {
        for (const n of nodes) {
            if (n._el) {
                const px = n.parent ? n.parent.x : 0;
                const py = n.parent ? n.parent.y : 0;
                n._el.style.left = (n.x - px) + 'px';
                n._el.style.top = (n.y - py) + 'px';
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
        // Issue #3: node.x / node.y are stage-absolute; subtract parent's
        // origin so CSS positioning (which is relative to the nearest
        // positioned ancestor — here the parent .sc2-frame) doesn't double-
        // displace. See updatePositions for the full explanation.
        const px = node.parent ? node.parent.x : 0;
        const py = node.parent ? node.parent.y : 0;
        el.style.left = (node.x - px) + 'px';
        el.style.top = (node.y - py) + 'px';
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
                document.removeEventListener('pointercancel', onUp);
                if (!dragged) {
                    this.onSelect && this.onSelect(node, { x: startX, y: startY });
                }
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            // pointercancel fires when the OS hijacks the gesture (e.g.
            // alt-tab mid-drag, touchscreen palm rejection). Without this
            // listener the move/up handlers leak permanently in those cases.
            document.addEventListener('pointercancel', onUp);
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
            // Async race guard: a rerender after this load was queued may
            // have removed `inner` from the DOM (or re-created its parent
            // .sc2-frame with a different size). Bail rather than:
            //   1) mutating an orphaned div (work the user never sees), or
            //   2) compositing against a stale node.w/node.h that no longer
            //      reflects the current layout.
            if (!inner.isConnected) return;
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
                // Re-check inside the try too - composite is sync but a
                // microtask between then() and replaceChildren can still
                // detach `inner` if another rerender lands.
                if (!inner.isConnected) return;
                inner.style.background = '';
                inner.style.opacity = '';
                inner.title = `${texAttr}  (src ${canvas.width}x${canvas.height})`;
                inner.replaceChildren(renderCanvas);
                console.info(`[paint] ${node.name}: painted ${texAttr} into ${node.w}x${node.h}`);
            } catch (err) {
                console.warn(`[paint] composite failed for ${node.name}:`, err, texAttr);
                if (inner.isConnected) inner.title = `composite error: ${err.message}`;
            }
        }).catch(err => {
            console.warn('[texture]', err);
            if (inner.isConnected) inner.title = `error: ${err.message}`;
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

        // For 9-slice / border modes, c.left/right and c.top/bottom are
        // interpreted as inset fractions into the source: c.left is how far
        // in (from the left edge) the "left slice" ends; c.right is where
        // the "right slice" starts. Same vertically.
        const W = srcCanvas.width, H = srcCanvas.height;
        const lx = c.left * W, ty = c.top * H;
        const rx = c.right * W, by = c.bottom * H;
        const cornerL = lx;             // width of left source slice
        const cornerT = ty;             // height of top source slice
        const cornerR = W - rx;         // width of right source slice
        const cornerB = H - by;         // height of bottom source slice
        const midSrcW = Math.max(0, rx - lx);  // stretchable middle (h)
        const midSrcH = Math.max(0, by - ty);  // stretchable middle (v)
        const midDstW = Math.max(0, out.width  - cornerL - cornerR);
        const midDstH = Math.max(0, out.height - cornerT - cornerB);

        // Helpers for the four corner pieces and four edge pieces of a
        // 9-slice. Used by both NineSlice and Border; Border just skips
        // the center.
        const drawCorners = () => {
            drawSlice(ctx, srcCanvas, 0,         0,          cornerL, cornerT, 0,                    0,                     cornerL, cornerT); // TL
            drawSlice(ctx, srcCanvas, W-cornerR, 0,          cornerR, cornerT, out.width - cornerR,  0,                     cornerR, cornerT); // TR
            drawSlice(ctx, srcCanvas, 0,         H-cornerB,  cornerL, cornerB, 0,                    out.height - cornerB,  cornerL, cornerB); // BL
            drawSlice(ctx, srcCanvas, W-cornerR, H-cornerB,  cornerR, cornerB, out.width - cornerR,  out.height - cornerB,  cornerR, cornerB); // BR
        };
        const drawEdges = () => {
            drawSlice(ctx, srcCanvas, cornerL, 0,          midSrcW, cornerT, cornerL,             0,                    midDstW, cornerT); // T
            drawSlice(ctx, srcCanvas, cornerL, H-cornerB,  midSrcW, cornerB, cornerL,             out.height-cornerB,   midDstW, cornerB); // B
            drawSlice(ctx, srcCanvas, 0,       cornerT,    cornerL, midSrcH, 0,                   cornerT,              cornerL, midDstH); // L
            drawSlice(ctx, srcCanvas, W-cornerR, cornerT,  cornerR, midSrcH, out.width-cornerR,   cornerT,              cornerR, midDstH); // R
        };
        const drawCenter = () => {
            drawSlice(ctx, srcCanvas, cornerL, cornerT, midSrcW, midSrcH, cornerL, cornerT, midDstW, midDstH);
        };

        switch (textureType) {
            case 'NineSlice':
                drawCorners();
                drawEdges();
                drawCenter();
                break;

            case 'Border':
                // 9-slice with the center omitted - leaves a transparent
                // middle, commonly used to outline a region.
                drawCorners();
                drawEdges();
                break;

            case 'HorizontalBorder':
            case 'EndCap': {
                // 3-slice horizontally: left cap, stretched middle, right cap.
                // Vertical axis stretches the full source height to the full
                // output height. HorizontalBorder and EndCap behave the same
                // way in our preview - in-game EndCap is documented as a
                // 2-row split; without a clear spec we draw it as a 3-slice
                // which covers the common use case (caps + stretched middle).
                drawSlice(ctx, srcCanvas, 0,         0,        cornerL, H,        0,                    0,           cornerL,            out.height); // L cap
                drawSlice(ctx, srcCanvas, lx,        0,        midSrcW, H,        cornerL,              0,           midDstW,            out.height); // middle
                drawSlice(ctx, srcCanvas, W-cornerR, 0,        cornerR, H,        out.width - cornerR,  0,           cornerR,            out.height); // R cap
                break;
            }

            default:
                if (tiled) {
                    const pat = ctx.createPattern(srcCanvas, 'repeat');
                    ctx.fillStyle = pat;
                    ctx.fillRect(0, 0, out.width, out.height);
                } else {
                    // Normal: stretch (or excerpt via TextureCoords) the
                    // source to fill the box.
                    const sx = c.left * W;
                    const sy = c.top * H;
                    const sw = Math.max(1, (c.right - c.left) * W);
                    const sh = Math.max(1, (c.bottom - c.top) * H);
                    ctx.drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
                }
                break;
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

// findChildVal / findChildAttrs moved to xml/helpers.js in R4.1.
