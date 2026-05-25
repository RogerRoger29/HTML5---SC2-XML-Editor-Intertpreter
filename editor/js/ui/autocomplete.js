// Lightweight autocomplete dropdown attached to an <input>.
//
// Usage:
//   attachAutocomplete(inputEl, (query) => [
//     { value: 'foo', label: 'foo', hint: 'optional secondary line' },
//     ...
//   ]);
//
// Behavior:
//   - Focus or type to open the dropdown
//   - ArrowDown / ArrowUp navigate items
//   - Enter or click commits the highlighted item (dispatches 'input' +
//     'change' events on the input so the inspector's existing wiring picks
//     up the change)
//   - Esc closes the dropdown without committing
//   - Blur closes the dropdown (small delay so click can land first)
//
// The dropdown is appended to <body> with position:fixed and is repositioned
// on scroll/resize so it stays anchored to the input.

const MAX_ITEMS = 200;

export function attachAutocomplete(input, getSuggestions, opts = {}) {
    const placeholder = opts.placeholder || 'No matches.';
    let dropdown = null;
    let suggestions = [];
    let activeIndex = 0;

    const close = () => {
        if (dropdown) dropdown.remove();
        dropdown = null;
        activeIndex = 0;
    };

    const refresh = () => {
        const q = input.value;
        const all = getSuggestions(q) || [];
        suggestions = all.slice(0, MAX_ITEMS);
        if (!suggestions.length) {
            if (!dropdown) return;
            dropdown.replaceChildren();
            const empty = document.createElement('div');
            empty.className = 'ac-empty';
            empty.textContent = placeholder;
            dropdown.appendChild(empty);
            position();
            return;
        }
        if (!dropdown) {
            dropdown = document.createElement('div');
            dropdown.className = 'ac-dropdown';
            document.body.appendChild(dropdown);
        }
        if (activeIndex >= suggestions.length) activeIndex = 0;
        dropdown.replaceChildren();
        for (let i = 0; i < suggestions.length; i++) {
            const s = suggestions[i];
            const item = document.createElement('div');
            item.className = 'ac-item';
            if (i === activeIndex) item.classList.add('active');
            const label = document.createElement('div');
            label.className = 'ac-label';
            label.textContent = s.label || s.value;
            item.appendChild(label);
            if (s.hint) {
                const hint = document.createElement('div');
                hint.className = 'ac-hint';
                hint.textContent = s.hint;
                item.appendChild(hint);
            }
            // mousedown (not click) so we commit BEFORE the input's blur
            // closes the dropdown.
            item.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                commit(i);
            });
            item.addEventListener('mouseenter', () => {
                activeIndex = i;
                for (const sib of dropdown.children) sib.classList.remove('active');
                item.classList.add('active');
            });
            dropdown.appendChild(item);
        }
        position();
        // Scroll the active item into view if it's offscreen.
        const active = dropdown.children[activeIndex];
        if (active) active.scrollIntoView({ block: 'nearest' });
    };

    const position = () => {
        if (!dropdown) return;
        const rect = input.getBoundingClientRect();
        dropdown.style.position = 'fixed';
        dropdown.style.left = rect.left + 'px';
        dropdown.style.top = (rect.bottom + 2) + 'px';
        dropdown.style.minWidth = rect.width + 'px';
    };

    const commit = (idx) => {
        if (idx < 0 || idx >= suggestions.length) return;
        input.value = suggestions[idx].value;
        // Mimic the user's typing/commit sequence so the inspector's
        // _wireLiveNumber / change handlers fire normally.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        close();
    };

    input.addEventListener('focus', refresh);
    input.addEventListener('input', () => { activeIndex = 0; refresh(); });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (ev) => {
        // Open on ArrowDown when closed.
        if (!dropdown && ev.key === 'ArrowDown') { refresh(); return; }
        if (!dropdown) return;
        switch (ev.key) {
            case 'ArrowDown':
                ev.preventDefault();
                activeIndex = Math.min(suggestions.length - 1, activeIndex + 1);
                refresh();
                break;
            case 'ArrowUp':
                ev.preventDefault();
                activeIndex = Math.max(0, activeIndex - 1);
                refresh();
                break;
            case 'Enter':
                if (activeIndex >= 0 && suggestions[activeIndex]) {
                    ev.preventDefault();
                    commit(activeIndex);
                }
                break;
            case 'Escape':
                ev.preventDefault();
                close();
                break;
            case 'Tab':
                if (activeIndex >= 0 && suggestions[activeIndex]) commit(activeIndex);
                else close();
                break;
        }
    });
    // Window listeners reposition the dropdown when the input scrolls or the
    // window resizes. The capturing scroll listener is the killer here: it
    // fires for EVERY scrollable ancestor. Inspector rebuilds on every
    // selection change + every inspector edit, recreating its inputs, and
    // until this fix each rebuild leaked another pair of listeners.
    //
    // We detect input detachment via MutationObserver on document.body and
    // tear the listeners + dropdown down once the input leaves the DOM.
    // (Inspector calls rootEl.replaceChildren() which detaches without
    // firing any 'remove' event.)
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    const cleanup = () => {
        window.removeEventListener('resize', position);
        window.removeEventListener('scroll', position, true);
        close();
        observer.disconnect();
    };
    const observer = new MutationObserver(() => {
        if (!input.isConnected) cleanup();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Expose for tests + callers that want to detach explicitly.
    return cleanup;
}
