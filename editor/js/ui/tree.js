// Hierarchy tree view: collapsible list of frames + drag-to-reorder support.
//
// Each row is a draggable element. While dragging another row over it, we
// compute drop position based on cursor Y within the row:
//   top 25%    -> drop ABOVE  (new sibling above target)
//   bottom 25% -> drop BELOW  (new sibling below target)
//   middle 50% -> drop INSIDE (new last child of target)
//
// On drop we call `onReorder(sourceFrame, targetFrame, mode)` so the host
// can mutate the underlying XML. The tree itself doesn't touch the doc.

export class TreeView {
    constructor(rootEl, onSelect, opts = {}) {
        this.rootEl = rootEl;
        this.onSelect = onSelect;
        this.onReorder = opts.onReorder || null;
        this.selected = null;
        // Key collapse state by frame.path, NOT by frame object identity.
        // rerender() allocates fresh MergedNode instances every time, so a
        // WeakSet (or Set) keyed by object would lose collapse state on
        // every edit. Path is stable across rerenders.
        this.collapsedPaths = new Set();
        this._lastFrames = [];
        this._dragSource = null;
        this._dragMode = null;
    }

    render(frames) {
        this._lastFrames = frames;
        this.rootEl.replaceChildren();
        const list = document.createElement('div');
        list.className = 'tree-list';
        for (const f of frames) this._row(f, list, 0);
        this.rootEl.appendChild(list);
    }

    _row(frame, parent, depth) {
        const row = document.createElement('div');
        row.className = 'tree-node';
        row.style.paddingLeft = (depth * 14 + 8) + 'px';
        row.dataset.name = frame.name;
        row.dataset.path = frame.path || frame.name;
        // Mod-origin frames are draggable; stock/synthetic frames are not
        // (moving them would have no effect since they're read-only).
        const draggable = frame.origin === 'mod' && !frame.synthetic && !!frame._modSource;
        if (draggable) row.draggable = true;

        const hasKids = frame.children && frame.children.length > 0;
        const pathKey = frame.path || frame.name;
        const collapsed = this.collapsedPaths.has(pathKey);

        const twisty = document.createElement('span');
        twisty.className = 'twisty';
        twisty.textContent = hasKids ? (collapsed ? '▸' : '▾') : '·';
        twisty.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (!hasKids) return;
            if (collapsed) this.collapsedPaths.delete(pathKey);
            else this.collapsedPaths.add(pathKey);
            this.render(this._lastFrames);
            if (this.selected) this.select(this.selected);
        });
        row.appendChild(twisty);

        const t = document.createElement('span');
        t.className = 'type';
        t.textContent = frame.type;
        row.appendChild(t);

        const n = document.createElement('span');
        n.className = 'name';
        n.textContent = frame.name;
        row.appendChild(n);

        row.addEventListener('click', () => {
            this.select(frame);
            this.onSelect && this.onSelect(frame);
        });
        if (this.selected === frame) row.classList.add('selected');

        if (draggable && this.onReorder) {
            this._wireDrag(row, frame);
        }
        // Every row is a drop target (even stock ones can accept a child).
        if (this.onReorder) this._wireDrop(row, frame);

        parent.appendChild(row);

        if (hasKids && !collapsed) {
            for (const c of frame.children) this._row(c, parent, depth + 1);
        }
    }

    _wireDrag(row, frame) {
        row.addEventListener('dragstart', (ev) => {
            this._dragSource = frame;
            ev.dataTransfer.effectAllowed = 'move';
            // Required by Firefox; the actual value is ignored - we resolve
            // the source via the closure variable, not the dataTransfer.
            ev.dataTransfer.setData('text/plain', frame.path || frame.name);
            row.classList.add('drag-source');
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('drag-source');
            this._clearDropIndicators();
            this._dragSource = null;
            this._dragMode = null;
        });
    }

    _wireDrop(row, frame) {
        row.addEventListener('dragover', (ev) => {
            if (!this._dragSource) return;
            if (this._isDescendant(frame, this._dragSource)) return;  // no cycles
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            const rect = row.getBoundingClientRect();
            const yFrac = (ev.clientY - rect.top) / rect.height;
            let mode;
            if (yFrac < 0.25) mode = 'above';
            else if (yFrac > 0.75) mode = 'below';
            else mode = 'inside';
            this._dragMode = mode;
            this._showDropIndicator(row, mode);
        });
        row.addEventListener('dragleave', () => {
            row.classList.remove('drop-above', 'drop-below', 'drop-inside');
        });
        row.addEventListener('drop', (ev) => {
            if (!this._dragSource) return;
            if (this._isDescendant(frame, this._dragSource)) return;
            ev.preventDefault();
            const source = this._dragSource;
            const mode = this._dragMode || 'inside';
            this._clearDropIndicators();
            this._dragSource = null;
            this._dragMode = null;
            this.onReorder(source, frame, mode);
        });
    }

    _showDropIndicator(row, mode) {
        this._clearDropIndicators();
        row.classList.add(`drop-${mode}`);
    }

    _clearDropIndicators() {
        for (const r of this.rootEl.querySelectorAll('.drop-above, .drop-below, .drop-inside')) {
            r.classList.remove('drop-above', 'drop-below', 'drop-inside');
        }
    }

    // Refuse drops that would create a cycle (dropping an ancestor onto its
    // own descendant). Walks the tree from target upward and returns true
    // if `candidate` appears anywhere along the chain.
    _isDescendant(target, candidate) {
        if (!target || !candidate) return false;
        if (target === candidate) return true;
        for (const child of (candidate.children || [])) {
            if (this._isDescendant(target, child)) return true;
        }
        return false;
    }

    select(frame) {
        this.selected = frame;
        // Match by full path, not name. Two frames at different paths can
        // share a name (e.g. every Button0..14 has a child "Button"), and
        // matching on name would highlight all of them.
        const targetPath = frame ? (frame.path || frame.name) : null;
        for (const row of this.rootEl.querySelectorAll('.tree-node')) {
            row.classList.toggle('selected', targetPath != null && row.dataset.path === targetPath);
        }
    }
}
