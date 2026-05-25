// Top menu-bar controller. Native HTML doesn't have a built-in menu
// component so we roll our own:
//   - Click a menu button to toggle that menu open (closes any other open menu)
//   - Hover between open menus to switch (classic desktop-menu feel)
//   - Click outside any menu to close
//   - Esc closes the open menu
//   - Click a menu item: fires the registered handler for data-action
//
// Each menu item has data-action="<name>"; handlers are registered via
// register(name, callback). data-type="..." is forwarded as the second arg
// (used by the Insert menu for frame types).

export class MenuBar {
    constructor(rootEl) {
        this.rootEl = rootEl;
        this.menus = [...rootEl.querySelectorAll(':scope > .menu')];
        this.handlers = new Map();
        this._wire();
    }

    register(action, fn) {
        this.handlers.set(action, fn);
    }

    setEnabled(action, enabled) {
        for (const btn of this.rootEl.querySelectorAll(`[data-action="${action}"]`)) {
            btn.disabled = !enabled;
        }
    }

    _wire() {
        for (const m of this.menus) {
            const btn = m.querySelector('.menu-button');
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const wasOpen = m.classList.contains('open');
                this._closeAll();
                if (!wasOpen) m.classList.add('open');
            });
            btn.addEventListener('mouseenter', () => {
                // If any menu is already open, hovering another menu's button
                // switches to it (Photoshop / Office behaviour).
                if (this.rootEl.querySelector('.menu.open') && !m.classList.contains('open')) {
                    this._closeAll();
                    m.classList.add('open');
                }
            });
        }
        // Wire data-action buttons. Use mousedown so the action fires before
        // the dropdown closes on the subsequent click event.
        this.rootEl.addEventListener('click', (ev) => {
            const target = ev.target.closest('[data-action]');
            if (!target) return;
            if (target.disabled) return;
            const action = target.dataset.action;
            const fn = this.handlers.get(action);
            if (fn) {
                ev.preventDefault();
                this._closeAll();
                fn(target.dataset);
            }
        });
        // Click outside menus closes them.
        document.addEventListener('click', (ev) => {
            if (!this.rootEl.contains(ev.target)) this._closeAll();
        });
        // Esc closes.
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && this.rootEl.querySelector('.menu.open')) {
                this._closeAll();
                ev.stopPropagation();
            }
        });
    }

    _closeAll() {
        for (const m of this.menus) m.classList.remove('open');
    }
}
