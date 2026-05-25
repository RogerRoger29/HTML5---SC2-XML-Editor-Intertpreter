// Assets / settings UI - the startup banner and the persistent "Assets…"
// dialog, plus the four action handlers they share (CASC extract, set SC2
// path, download stock, set assets folder).
//
// Before R4.3 this lived as ~335 LOC inside main.js with the banner and
// the dialog each re-implementing nearly-identical button wiring. Extracted
// here so changing the wording of a confirm prompt or renaming an endpoint
// is one edit instead of three. The host wires it up via:
//
//     const assetsUi = new AssetsUi({
//         dialog, dialogBody, setStatus, refresh,
//         getConfig, onConfigChanged,
//     });
//     assetsUi.openDialog();
//     assetsUi.renderBanner(currentConfig);

const CONFIRM_CASC_EXTRACT = (sc2Path) =>
    `Extract textures and fonts from your SC2 install?\n\n` +
    `SC2 install: ${sc2Path}\n\n` +
    `Reads the game's CASC archive via CascLib and writes the referenced files\n` +
    `into the active assets folder. ~5-50 MB textures, ~2-5 MB fonts.\n\n` +
    `First extraction can take ~30 seconds while CascLib scans the archive.`;

const CONFIRM_DOWNLOAD_STOCK =
    "Download SC2 stock data?\n\n" +
    "This fetches about 30 essential files (~500 KB - 2 MB) from\n" +
    "github.com/SC2Mapster/SC2GameData and saves them to a 'stock-data'\n" +
    "folder next to this app.\n\n" +
    "Note: this does NOT include binary texture files (.dds). Those\n" +
    "require a real SC2 install + an extraction tool. The editor will\n" +
    "still work for layout editing without textures - frames just render\n" +
    "as colored boxes instead of images.\n\n" +
    "Continue?";

const PROMPT_SC2_PATH =
    "Enter the path to your StarCraft II install folder.\n\n" +
    "This is the folder that contains 'StarCraft II.exe' and 'Data\\'.\n" +
    "Examples:\n" +
    "  C:\\Program Files (x86)\\StarCraft II\n" +
    "  C:\\Games\\StarCraft II\n" +
    "  D:\\Battle.net\\Games\\StarCraft II";

const PROMPT_ASSETS_PATH =
    'Enter the path to your extracted SC2 mods folder ' +
    '(the one containing core.sc2mod, liberty.sc2mod, etc.):';

async function postJson(url, payload) {
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return resp.json();
}

async function fetchConfig() {
    return fetch('/__config').then(r => r.json());
}

export class AssetsUi {
    /**
     * @param {object} opts
     * @param {HTMLDialogElement} opts.dialog - <dialog> for the persistent panel
     * @param {HTMLElement}      opts.dialogBody - body container inside the <dialog>
     * @param {Function}         opts.setStatus - (msg) => void
     * @param {Function}         opts.refresh   - async () => void (resetAssetDependentCaches)
     * @param {Function}         opts.onConfigChanged - (newCfg) => void; host updates its
     *                                              local state.config from this callback
     */
    constructor(opts) {
        this.dialog = opts.dialog;
        this.dialogBody = opts.dialogBody;
        this.setStatus = opts.setStatus || (() => {});
        this.refresh = opts.refresh || (async () => {});
        this.onConfigChanged = opts.onConfigChanged || (() => {});
    }

    // -- Action handlers (shared between banner + dialog) -------------------

    async extractFromCasc(sc2Path, showStatus = this.setStatus) {
        if (!confirm(CONFIRM_CASC_EXTRACT(sc2Path))) return false;
        showStatus('Opening CASC archive (this can take ~30s)…');
        try {
            const r = await postJson('/__cascextract', { all_textures: true, include_fonts: true });
            if (r.error) {
                showStatus(`Failed: ${r.error}${r.detail ? ' - ' + r.detail : ''}`);
                console.warn('[cascextract] failed:', r);
                return false;
            }
            showStatus(
                `Extracted ${r.extracted}, skipped ${r.skipped} existing, ${r.failed.length} failed `
                + `(${(r.bytes / 1024 / 1024).toFixed(1)} MB).`);
            if (r.failed.length) console.warn('[cascextract] failures:', r.failed);
            await this.refresh();
            return true;
        } catch (err) {
            showStatus('Failed: ' + err.message);
            return false;
        }
    }

    async setSc2Path(currentPath) {
        const path = prompt(PROMPT_SC2_PATH, currentPath || '');
        if (!path) return false;
        const r = await postJson('/__config', { sc2_install: path });
        if (r.error) {
            alert(`Could not set SC2 install path: ${r.error}\n${r.path || ''}\n\nMake sure the folder contains 'StarCraft II.exe'.`);
            return false;
        }
        const cfg = await fetchConfig();
        this.onConfigChanged(cfg);
        this.setStatus(`SC2 install set: ${cfg.sc2_install}`);
        return true;
    }

    async setAssetsFolder(currentPath) {
        const path = prompt(PROMPT_ASSETS_PATH, currentPath || '');
        if (!path) return false;
        const r = await postJson('/__config', { assets_root: path });
        if (r.error) {
            alert(`Could not set assets folder: ${r.error}\n${r.path || r.detail || ''}`);
            return false;
        }
        const cfg = await fetchConfig();
        this.onConfigChanged(cfg);
        this.setStatus(`Assets folder: ${cfg.assets_root}`);
        await this.refresh();
        return true;
    }

    async downloadStock(showStatus = this.setStatus, { skipConfirm = false } = {}) {
        if (!skipConfirm && !confirm(CONFIRM_DOWNLOAD_STOCK)) return false;
        showStatus('Downloading stock essentials from github.com/SC2Mapster/SC2GameData…');
        try {
            const r = await postJson('/__download', {});
            if (r.error) {
                showStatus(`Failed: ${r.error}`);
                return false;
            }
            showStatus(`Downloaded ${r.downloaded} new, skipped ${r.skipped} existing, ${r.failed.length} failed (${(r.bytes / 1024).toFixed(0)} KB).`);
            if (r.failed.length) console.warn('[download] failures:', r.failed);
            await this.refresh();
            return true;
        } catch (err) {
            showStatus(`Failed: ${err.message}`);
            return false;
        }
    }

    // -- Banner -------------------------------------------------------------

    /** Render the startup "no assets folder" banner. Returns the banner
     *  element so the caller can remove it on dismiss. */
    renderBanner(cfg) {
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

        const progress = banner.querySelector('#download-progress');
        const showProgress = (msg) => {
            progress.hidden = false;
            progress.textContent = msg;
        };

        // SC2 install path override.
        banner.querySelector('#set-sc2-path-btn').addEventListener('click', async () => {
            const ok = await this.setSc2Path(cfg.sc2_install);
            if (ok) banner.remove();
        });

        // CASC extraction.
        const cascBtn = banner.querySelector('#cascextract-btn');
        if (!cfg.sc2_install) {
            cascBtn.disabled = true;
            cascBtn.title = 'No SC2 install detected. Click "Set SC2 path…" first.';
        }
        cascBtn.addEventListener('click', async () => {
            cascBtn.disabled = true;
            cascBtn.textContent = 'Extracting…';
            const ok = await this.extractFromCasc(cfg.sc2_install, showProgress);
            if (ok) banner.remove();
            else {
                cascBtn.disabled = false;
                cascBtn.textContent = 'Extract from SC2 install';
            }
        });

        // Set existing assets folder.
        banner.querySelector('#set-assets-btn').addEventListener('click', async () => {
            const ok = await this.setAssetsFolder(cfg.assets_root);
            if (ok) banner.remove();
        });

        // Download stock essentials.
        const downloadBtn = banner.querySelector('#download-stock-btn');
        downloadBtn.addEventListener('click', async () => {
            downloadBtn.disabled = true;
            downloadBtn.textContent = 'Downloading…';
            const ok = await this.downloadStock(showProgress);
            if (ok) banner.remove();
            else {
                downloadBtn.disabled = false;
                downloadBtn.textContent = 'Download essentials';
            }
        });

        banner.querySelector('#dismiss-banner-btn').addEventListener('click', () => banner.remove());
        this.setStatus('No assets folder. Click "Download essentials" or "Use existing folder…".');
        return banner;
    }

    // -- Persistent dialog --------------------------------------------------

    async openDialog() {
        const dlg = this.dialog;
        const body = this.dialogBody;
        body.innerHTML = '<p class="hint">Loading current config…</p>';
        dlg.showModal();
        let cfg;
        try { cfg = await fetchConfig(); }
        catch (err) {
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
                        title="${cfg.sc2_install ? 'Extract textures + fonts from the SC2 install via CascLib.' : 'No SC2 install detected. Click &quot;Set SC2 path…&quot; first.'}">
                    Extract textures + fonts from SC2
                </button>
                <button type="button" id="dlg-set-sc2">Set SC2 install path&hellip;</button>
                <button type="button" id="dlg-download">Download stock essentials</button>
                <button type="button" id="dlg-set-assets">Set assets folder&hellip;</button>
            </div>
            <div id="dlg-progress" class="dlg-progress" hidden></div>
        `;
        const progress = body.querySelector('#dlg-progress');
        const showProgress = (msg) => { progress.hidden = false; progress.textContent = msg; };
        body.querySelector('#dlg-cascextract').addEventListener('click',
            () => this.extractFromCasc(cfg.sc2_install, showProgress));
        body.querySelector('#dlg-set-sc2').addEventListener('click',
            () => this.setSc2Path(cfg.sc2_install));
        body.querySelector('#dlg-download').addEventListener('click',
            () => this.downloadStock(showProgress));
        body.querySelector('#dlg-set-assets').addEventListener('click',
            () => this.setAssetsFolder(cfg.assets_root));
    }
}
