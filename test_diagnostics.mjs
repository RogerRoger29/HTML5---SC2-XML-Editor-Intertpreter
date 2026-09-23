import assert from 'node:assert/strict';
import {
    DiagnosticRecorder,
    buildDiagnosticReport,
    pathHint,
    redactSensitiveText,
} from './editor/js/diagnostics.js';

const exactLayout = '<Desc><Frame name="C:\\Private\\Layout"/></Desc>\n';
const report = buildDiagnosticReport({
    includeLayoutSource: true,
    layoutSource: exactLayout,
    configuration: {
        session_token: 'super-secret',
        assets_root: 'C:\\Users\\Nicholas\\mods',
    },
    recentBrowserLogs: [{ message: 'opened C:\\Users\\Nicholas\\mods\\foo.SC2Layout' }],
    layout: { fileName: 'foo.SC2Layout' },
});

assert.equal(report.schema, 'sc2-ui-editor-diagnostics');
assert.equal(report.schemaVersion, 1);
assert.equal(report.layout.source, exactLayout, 'opted-in layout source must remain byte-exact');
assert.equal(report.configuration.session_token, '[redacted]');
assert.ok(!JSON.stringify(report.configuration).includes('super-secret'));
assert.ok(!JSON.stringify(report.recentBrowserLogs).includes('Nicholas'));
assert.equal(pathHint('/project/MyMod.SC2Mod/Base.SC2Data/UI/Layout/Test.SC2Layout'),
    'MyMod.SC2Mod/Base.SC2Data/UI/Layout/Test.SC2Layout');
assert.equal(pathHint('C:\\private\\plain.SC2Layout'), 'plain.SC2Layout');
assert.ok(!redactSensitiveText('failed at C:\\Users\\Name\\secret.txt').includes('Name'));

const withoutLayout = buildDiagnosticReport({
    includeLayoutSource: false,
    layoutSource: exactLayout,
    layout: { fileName: 'foo.SC2Layout' },
});
assert.equal(withoutLayout.layout.source, null);
assert.equal(withoutLayout.privacy.layoutSourceIncluded, false);

const calls = [];
const fakeConsole = {
    debug: (...args) => calls.push(['debug', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    log: (...args) => calls.push(['log', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
};
const originalLog = fakeConsole.log;
const recorder = new DiagnosticRecorder(2);
const restore = recorder.installConsoleCapture(fakeConsole);
fakeConsole.log('one');
fakeConsole.warn('two', { sessionToken: 'hidden' });
fakeConsole.error('three');
assert.equal(recorder.snapshot().length, 2, 'recorder should enforce its ring-buffer limit');
assert.ok(!JSON.stringify(recorder.snapshot()).includes('hidden'));
assert.equal(calls.length, 3, 'console output should continue after capture is installed');
restore();
assert.equal(fakeConsole.log, originalLog);

console.log('ALL PASS');
