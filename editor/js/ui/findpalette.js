// Find-frame palette: VS Code / Photoshop-style Ctrl+P fuzzy locator.
//
// Opens a centered floating box at the top of the screen. Type to filter
// the currently-loaded frame tree; Up/Down navigates results; Enter selects
// the highlighted frame. Esc or click-outside closes without selecting.
//
// Ranking: exact match > starts-with > substring. Matches against both the
// frame's local name and its full path so deep frames are findable by any
// path segment.

export class FindPalette {
    constructor(opts) {
        this.getFrames = opts.getFrames;
        this.onSelect = opts.onSelect;
        this.container = null;
        this.input = null;
        this.list = null;
        this.results = [];
        this.activeIndex = 0;
    }

    open() {
        if (this.container) {
            this.input.focus();
            this.input.select();
            return;
        }
        this.container = document.createElement('div');
        this.container.className = 'find-palette-overlay';
        this.container.innerHTML = `
            <div class="find-palette">
                <input type="text" class="find-palette-input"
                       placeholder="Find frame by name or path..." spellcheck="false">
                <div class="find-palette-list"></div>
                <div class="find-palette-hint">
                    <kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate &middot;
                    <kbd>Enter</kbd> select &middot;
                    <kbd>Esc</kbd> close
                </div>
            </div>
        `;
        document.body.appendChild(this.container);
        this.input = this.container.querySelector('.find-palette-input');
        this.list = this.container.querySelector('.find-palette-list');
        this.input.addEventListener('input', () => this.refresh());
        this.input.addEventListener('keydown', (ev) => this._onKey(ev));
        // Click anywhere outside the inner box closes the palette.
        this.container.addEventListener('mousedown', (ev) => {
            if (ev.target === this.container) this.close();
        });
        this.refresh();
        this.input.focus();
    }

    close() {
        if (this.container) {
            this.container.remove();
            this.container = null;
            this.input = null;
            this.list = null;
        }
    }

    refresh() {
        const all = flatten(this.getFrames() || []);
        const q = (this.input ? this.input.value : '').toLowerCase().trim();
        if (!q) {
            // Empty query: show everything (capped) so the user can browse.
            this.results = all.slice(0, 250);
        } else {
            const exact = [], starts = [], sub = [];
            for (const f of all) {
                const ln = (f.name || '').toLowerCase();
                const lp = (f.path || '').toLowerCase();
                if (ln === q || lp === q) exact.push(f);
                else if (ln.startsWith(q) || lp.startsWith(q)) starts.push(f);
                else if (ln.includes(q) || lp.includes(q)) sub.push(f);
            }
            this.results = [...exact, ...starts, ...sub].slice(0, 250);
        }
        this.activeIndex = 0;
        this._render(q);
    }

    _render(query) {
        this.list.replaceChildren();
        if (!this.results.length) {
            const empty = document.createElement('div');
            empty.className = 'find-palette-empty';
            empty.textContent = query ? `No frames match "${query}".` : 'No frames in this layout.';
            this.list.appendChild(empty);
            return;
        }
        for (let i = 0; i < this.results.length; i++) {
            const f = this.results[i];
            const item = document.createElement('div');
            item.className = 'find-palette-item' + (i === this.activeIndex ? ' active' : '');
            const pathRest = (f.path && f.path !== f.name) ? f.path : '';
            item.innerHTML = `
                <span class="find-type">${escapeHtml(f.type || 'Frame')}</span>
                <span class="find-name">${highlight(f.name || '', query)}</span>
                <span class="find-path">${highlight(pathRest, query)}</span>
            `;
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();   // keep focus in the input until we commit
                this.activeIndex = i;
                this._commit();
            });
            item.addEventListener('mouseenter', () => {
                this.activeIndex = i;
                for (const sib of this.list.children) sib.classList.remove('active');
                item.classList.add('active');
            });
            this.list.appendChild(item);
        }
        // Scroll the active item into view (important for keyboard nav).
        const active = this.list.children[this.activeIndex];
        if (active) active.scrollIntoView({ block: 'nearest' });
    }

    _onKey(ev) {
        switch (ev.key) {
            case 'Escape':
                ev.preventDefault();
                this.close();
                break;
            case 'ArrowDown':
                ev.preventDefault();
                this.activeIndex = Math.min(this.results.length - 1, this.activeIndex + 1);
                this._render(this.input.value.toLowerCase().trim());
                break;
            case 'ArrowUp':
                ev.preventDefault();
                this.activeIndex = Math.max(0, this.activeIndex - 1);
                this._render(this.input.value.toLowerCase().trim());
                break;
            case 'Enter':
                ev.preventDefault();
                this._commit();
                break;
        }
    }

    _commit() {
        const f = this.results[this.activeIndex];
        if (f) this.onSelect(f);
        this.close();
    }
}

function flatten(frames) {
    const out = [];
    const walk = (nodes) => {
        for (const f of nodes) {
            out.push(f);
            if (f.children && f.children.length) walk(f.children);
        }
    };
    walk(frames);
    return out;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Wrap the query string within `text` (case-insensitive) in <mark> for visual
// emphasis. If query is empty, just escapes the text.
function highlight(text, query) {
    const escaped = escapeHtml(text);
    if (!query) return escaped;
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) return escaped;
    const head = escapeHtml(text.slice(0, idx));
    const mid = escapeHtml(text.slice(idx, idx + query.length));
    const tail = escapeHtml(text.slice(idx + query.length));
    return `${head}<mark>${mid}</mark>${tail}`;
}
