// Standalone round-trip test. Run with: node test_roundtrip.mjs <file...>
//
// For each file: parse, serialize, compare byte-for-byte against the source.
// Exits 0 on success, 1 on any mismatch / parse error.

import { readFileSync } from 'node:fs';
import { parseXml } from './editor/js/xml/parser.js';
import { serializeXml } from './editor/js/xml/serializer.js';

const files = process.argv.slice(2);
if (!files.length) {
    console.error('usage: node test_roundtrip.mjs <file.SC2Layout> [...]');
    process.exit(2);
}

let failures = 0;
for (const f of files) {
    let src;
    try { src = readFileSync(f, 'utf8'); }
    catch (err) { console.error(`[FAIL] ${f}: ${err.message}`); failures++; continue; }
    try {
        const doc = parseXml(src);
        const out = serializeXml(doc);
        if (out === src) {
            console.log(`[ OK ] ${f}  (${src.length} bytes)`);
        } else {
            const diff = firstDiff(src, out);
            console.log(`[DIFF] ${f}  first diff at offset ${diff} of ${src.length}`);
            console.log('  expected: ' + JSON.stringify(src.slice(diff, diff + 60)));
            console.log('  got     : ' + JSON.stringify(out.slice(diff, diff + 60)));
            failures++;
        }
    } catch (err) {
        console.error(`[FAIL] ${f}: ${err.message}`);
        failures++;
    }
}
process.exit(failures ? 1 : 0);

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
    return n;
}
