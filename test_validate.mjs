// v0.6.2: validator flags unresolved #constant references (typo'd / undefined
// constants), gated on stock being loaded to avoid false positives during the
// async stock-load window. validate(modDoc, registry) is pure.

import { validate } from './editor/js/validate.js';
import { StockRegistry } from './editor/js/stock.js';
import { parseXml } from './editor/js/xml/parser.js';

let failures = 0;
function check(label, cond) {
    console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const layout = (val) => parseXml(
    `<?xml version="1.0"?>\n<Desc><Frame type="Frame" name="P"><Width val="${val}"/></Frame></Desc>\n`);

function regWith(consts, stockLoaded = true) {
    const r = new StockRegistry();
    for (const [k, v] of Object.entries(consts)) r.modConstants.set(k, v);
    if (stockLoaded) r.loadedFiles.add('core'); // mark stock as loaded (gate)
    return r;
}

const hasConstError = (results) =>
    results.some(w => w.severity === 'error' && /references constant/.test(w.message));

// 1. Unresolved #ref -> error.
{
    const out = validate(layout('#Missing'), regWith({}));
    check('unresolved #Missing flagged as error', hasConstError(out));
}

// 2. Resolvable #ref -> no const error.
{
    const out = validate(layout('#Defined'), regWith({ Defined: '42' }));
    check('resolvable #Defined: no const error', !hasConstError(out));
}

// 3. Chained #ref that ultimately resolves -> no error.
{
    const out = validate(layout('#A'), regWith({ A: '#B', B: '7' }));
    check('chained #A->#B->7: no const error', !hasConstError(out));
}

// 4. Gate: stock not loaded -> suppressed (no false positive during load).
{
    const out = validate(layout('#Missing'), regWith({}, /*stockLoaded=*/false));
    check('unresolved ref suppressed while stock not loaded', !hasConstError(out));
}

// 5. Plain numeric value -> no const error.
{
    const out = validate(layout('50'), regWith({}));
    check('numeric value: no const error', !hasConstError(out));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
