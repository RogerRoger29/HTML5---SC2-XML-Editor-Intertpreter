import assert from 'node:assert/strict';
import { parseXml, XmlParseError } from './editor/js/xml/parser.js';
import { serializeXml } from './editor/js/xml/serializer.js';

const valid = '<Desc/>\n';
assert.equal(serializeXml(parseXml(valid)), valid);
assert.throws(() => parseXml('<Desc/>TRAIL</Oops>'), XmlParseError);
assert.throws(() => parseXml('</Desc>'), XmlParseError);

console.log('ALL PASS');
