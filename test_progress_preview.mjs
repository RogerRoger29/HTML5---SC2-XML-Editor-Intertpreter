import { progressBarFraction } from './editor/js/render/frames.js';
import { parseXml } from './editor/js/xml/parser.js';
import { findLastChildVal } from './editor/js/xml/helpers.js';

let failures = 0;
function check(name, actual, expected) {
    const pass = Math.abs(actual - expected) < 0.000001;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) {
        console.log(`      expected ${expected}, got ${actual}`);
        failures++;
    }
}

check('empty bar', progressBarFraction(0, 0, 100), 0);
check('half bar', progressBarFraction(50, 0, 100), 0.5);
check('full bar', progressBarFraction(100, 0, 100), 1);
check('clamps below minimum', progressBarFraction(-25, 0, 100), 0);
check('clamps above maximum', progressBarFraction(125, 0, 100), 1);
check('supports a non-zero minimum', progressBarFraction(30, 20, 40), 0.5);
check('preserves an explicit zero maximum', progressBarFraction(0, 0, 0), 1);
check('uses SC2 defaults for missing values', progressBarFraction(undefined, undefined, undefined), 0);

const overridden = parseXml('<Desc><Frame><Value val="100"/><Value val="50"/></Frame></Desc>');
const overriddenFrame = overridden.root.children.find(node => node.type === 'element');
check('materialized property overrides use the last value',
    Number(findLastChildVal(overriddenFrame, 'Value')), 50);

if (failures) process.exit(1);
console.log('\nProgress preview tests passed.');
