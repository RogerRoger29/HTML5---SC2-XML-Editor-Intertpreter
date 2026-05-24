// First-launch welcome overlay. Walks a new tester through the four things
// they need to know to actually USE the editor: set up assets, open or
// create a layout, edit with the inspector, save back to disk. Each step
// can highlight a UI region for visual cueing. Dismissible at any point;
// dismissal is remembered in localStorage so it never shows again unless
// the user explicitly re-runs it.

const STORAGE_KEY = 'sc2editor.welcomeSeen.v1';

const STEPS = [
    {
        title: 'Welcome to the SC2 UI Editor',
        body: `
            <p>Author and edit StarCraft 2 <code>.SC2Layout</code> files visually.</p>
            <p>This short tour walks through the four things you'll do most.
            You can skip it; the button to re-run it lives in the <strong>Help</strong> menu.</p>
        `,
        highlight: null,
    },
    {
        title: '1 — Get SC2 assets',
        body: `
            <p>The editor previews real textures and fonts when you point it at
            stock SC2 data. Two options:</p>
            <ul>
                <li><strong>Extract from your SC2 install</strong> — if SC2 is
                installed locally, click <strong>Assets&hellip;</strong> in the top bar
                and pick "Extract textures + fonts from SC2." Reads via CascLib.
                First extraction takes about 30 seconds.</li>
                <li><strong>Download stock essentials</strong> — if no SC2 install,
                grab ~2&nbsp;MB of layout XML from
                <code>github.com/SC2Mapster/SC2GameData</code>. Templates and
                constants work; textures show as magenta placeholders.</li>
            </ul>
            <p>You can still edit and save layouts without either, but the canvas
            previews will be sparse.</p>
        `,
        highlight: '#btn-assets',
    },
    {
        title: '2 — Open or create a layout',
        body: `
            <p>Use the <strong>File</strong> menu:</p>
            <ul>
                <li><strong>New</strong> (Ctrl+N) — start a blank layout from scratch.</li>
                <li><strong>Open&hellip;</strong> (Ctrl+O) — pick a <code>.SC2Layout</code> file.
                On Chromium browsers you get in-place save-back; on others, downloads on save.</li>
            </ul>
            <p>Use the <strong>Insert</strong> menu to drop new frames (Frame /
            Image / Label / Button / etc.) under the current selection.</p>
        `,
        highlight: '[data-menu="file"] > .menu-button',
    },
    {
        title: '3 — Edit',
        body: `
            <p>Click any frame on the canvas to select it. The
            <strong>Inspector</strong> on the right shows everything editable:</p>
            <ul>
                <li>Width, Height, anchor offsets — type or use the spinners.
                Live updates as you scrub.</li>
                <li>Texture / Style fields autocomplete from your loaded assets.</li>
                <li>HAlign / VAlign for labels and buttons.</li>
                <li>LayerColor gets a real color picker.</li>
                <li>Visual state preview lets you flip between Normal / Hover /
                Pressed if the frame has a <code>StateGroup</code>.</li>
            </ul>
            <p>On the canvas: drag the frame body to move; drag a corner handle to
            resize; press <kbd>G</kbd> to toggle grid snap; <kbd>Ctrl+Z</kbd> undoes anything.</p>
        `,
        highlight: '#pane-inspector',
    },
    {
        title: '4 — Save',
        body: `
            <p><kbd>Ctrl+S</kbd> writes the file back to disk on Chromium browsers
            (Edge, Chrome). Firefox/Safari fall back to download dialogs.</p>
            <p><kbd>Ctrl+Shift+S</kbd> = Save As; <kbd>Ctrl+Shift+E</kbd> = Export
            current canvas as a standalone <code>.html</code> file with textures
            embedded.</p>
            <p>The <strong>Warnings</strong> button in the top bar (when visible)
            shows validator issues — dangling templates, missing children,
            anchor / size conflicts. Click any warning to jump to the offending frame.</p>
            <p>That's it. Drop the saved <code>.SC2Layout</code> into your mod's
            <code>Base.SC2Data\\UI\\Layout\\</code> folder, add it to
            <code>DescIndex.SC2Layout</code>, and load in-game.</p>
        `,
        highlight: '[data-menu="file"] > .menu-button',
    },
];

export class WelcomeTour {
    constructor() {
        this.container = null;
        this.stepIndex = 0;
        this.spotlight = null;
    }

    static shouldShow() {
        try {
            return localStorage.getItem(STORAGE_KEY) !== '1';
        } catch {
            return true;
        }
    }

    open() {
        if (this.container) return;
        this.stepIndex = 0;
        this.container = document.createElement('div');
        this.container.className = 'welcome-overlay';
        this.container.innerHTML = `
            <div class="welcome-card">
                <button class="welcome-close" type="button" title="Skip" aria-label="Skip">&times;</button>
                <div class="welcome-progress"></div>
                <h2 class="welcome-title"></h2>
                <div class="welcome-body"></div>
                <div class="welcome-actions">
                    <button class="welcome-back" type="button" disabled>Back</button>
                    <button class="welcome-skip" type="button">Skip tour</button>
                    <button class="welcome-next" type="button">Next</button>
                </div>
            </div>
            <div class="welcome-spotlight" hidden></div>
        `;
        document.body.appendChild(this.container);
        this.spotlight = this.container.querySelector('.welcome-spotlight');
        this.container.querySelector('.welcome-close').addEventListener('click', () => this.dismiss());
        this.container.querySelector('.welcome-skip').addEventListener('click', () => this.dismiss());
        this.container.querySelector('.welcome-back').addEventListener('click', () => this._nav(-1));
        this.container.querySelector('.welcome-next').addEventListener('click', () => this._nav(1));
        this._render();
        // Esc closes; clicking the dim background does NOT (avoid losing tour
        // accidentally - require an explicit Skip/X press).
        document.addEventListener('keydown', this._onKey = (ev) => {
            if (ev.key === 'Escape' && this.container) {
                ev.preventDefault();
                this.dismiss();
            }
        });
    }

    dismiss() {
        try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
        if (this.container) { this.container.remove(); this.container = null; }
        if (this._onKey) document.removeEventListener('keydown', this._onKey);
    }

    _nav(delta) {
        const next = this.stepIndex + delta;
        if (next < 0) return;
        if (next >= STEPS.length) { this.dismiss(); return; }
        this.stepIndex = next;
        this._render();
    }

    _render() {
        const step = STEPS[this.stepIndex];
        const c = this.container;
        c.querySelector('.welcome-title').textContent = step.title;
        c.querySelector('.welcome-body').innerHTML = step.body;
        c.querySelector('.welcome-progress').textContent =
            `Step ${this.stepIndex + 1} of ${STEPS.length}`;
        c.querySelector('.welcome-back').disabled = this.stepIndex === 0;
        c.querySelector('.welcome-next').textContent =
            this.stepIndex === STEPS.length - 1 ? 'Got it' : 'Next';
        this._spotlight(step.highlight);
    }

    _spotlight(selector) {
        if (!this.spotlight) return;
        if (!selector) { this.spotlight.hidden = true; return; }
        const el = document.querySelector(selector);
        if (!el) { this.spotlight.hidden = true; return; }
        const r = el.getBoundingClientRect();
        Object.assign(this.spotlight.style, {
            left: (r.left - 6) + 'px',
            top:  (r.top - 6) + 'px',
            width:  (r.width + 12) + 'px',
            height: (r.height + 12) + 'px',
        });
        this.spotlight.hidden = false;
    }
}
