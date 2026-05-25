// Smart alignment guides shown while a frame is being dragged on the canvas.
//
// computeGuides() walks the frame tree, comparing the dragged frame's edges
// and center against every other frame's edges and center on the same axis.
// Matches within `tolerance` canvas pixels become guide lines.
//
// renderGuides() paints them as 1px lines on a dedicated overlay div that
// lives inside the stage so it scales with the canvas zoom transform.

const DEFAULT_TOLERANCE = 3;       // px in canvas space
const MAX_GUIDES = 12;             // cap so dense scenes don't flood the screen

export function computeGuides(dragged, rootFrames, tolerance = DEFAULT_TOLERANCE) {
    if (!dragged || typeof dragged.x !== 'number') return [];
    // Edges/centers of the dragged frame in canvas space.
    const dxEdges = [
        { val: dragged.x,                    edge: 'left' },
        { val: dragged.x + dragged.w,        edge: 'right' },
        { val: dragged.x + dragged.w / 2,    edge: 'centerX' },
    ];
    const dyEdges = [
        { val: dragged.y,                    edge: 'top' },
        { val: dragged.y + dragged.h,        edge: 'bottom' },
        { val: dragged.y + dragged.h / 2,    edge: 'centerY' },
    ];
    // Skip the dragged frame + its own descendants (we shouldn't align to
    // ourselves) and pure synthetic chain wrappers (their positions are
    // derived, not authoritative).
    const skip = new Set();
    collect(dragged, skip);

    const guides = [];
    const visit = (nodes) => {
        for (const f of nodes) {
            if (!skip.has(f) && !f.synthetic && typeof f.x === 'number') {
                checkFrame(f, dxEdges, dyEdges, tolerance, guides);
            }
            if (f.children && f.children.length) visit(f.children);
        }
    };
    visit(rootFrames);
    // De-duplicate guides at the same axis+position (multiple matches at the
    // same coordinate collapse into one line).
    const seen = new Set();
    const unique = [];
    for (const g of guides) {
        const key = `${g.axis}:${Math.round(g.position * 100) / 100}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(g);
        if (unique.length >= MAX_GUIDES) break;
    }
    return unique;
}

function collect(node, set) {
    set.add(node);
    if (node.children) for (const c of node.children) collect(c, set);
}

function checkFrame(f, dxEdges, dyEdges, tol, out) {
    const fxEdges = [
        { val: f.x,             edge: 'left' },
        { val: f.x + f.w,       edge: 'right' },
        { val: f.x + f.w / 2,   edge: 'centerX' },
    ];
    const fyEdges = [
        { val: f.y,             edge: 'top' },
        { val: f.y + f.h,       edge: 'bottom' },
        { val: f.y + f.h / 2,   edge: 'centerY' },
    ];
    for (const a of dxEdges) {
        for (const b of fxEdges) {
            if (Math.abs(a.val - b.val) <= tol) {
                out.push({ axis: 'x', position: b.val, fromEdge: a.edge, toEdge: b.edge, toFrame: f });
            }
        }
    }
    for (const a of dyEdges) {
        for (const b of fyEdges) {
            if (Math.abs(a.val - b.val) <= tol) {
                out.push({ axis: 'y', position: b.val, fromEdge: a.edge, toEdge: b.edge, toFrame: f });
            }
        }
    }
}

export function renderGuides(stage, guides) {
    let container = stage.querySelector(':scope > .guides-overlay');
    if (!container) {
        container = document.createElement('div');
        container.className = 'guides-overlay';
        stage.appendChild(container);
    }
    container.replaceChildren();
    if (!guides || !guides.length) return;
    for (const g of guides) {
        const line = document.createElement('div');
        line.className = `guide-line guide-${g.axis}`;
        if (g.axis === 'x') {
            line.style.left = g.position + 'px';
        } else {
            line.style.top = g.position + 'px';
        }
        container.appendChild(line);
    }
}

export function clearGuides(stage) {
    const container = stage.querySelector(':scope > .guides-overlay');
    if (container) container.replaceChildren();
}
