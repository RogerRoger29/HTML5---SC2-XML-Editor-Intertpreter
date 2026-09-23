// Authoring helpers that bridge the merged preview tree back to the mod XML.
//
// A selected preview node may come entirely from Blizzard's stock layouts and
// therefore have no _modSource element to append to. In that case, extending
// it requires a deep-path override in the user's document. Keeping this logic
// outside main.js makes the important stock-edit behavior directly testable.

import {
    inferChildIndent, makeElement, textNode, appendChildPreservingIndent,
} from './xml/mutate.js';

export function oneIndentDeeper(indent) {
    const match = /^\n([ \t]*)$/.exec(indent || '');
    if (!match) return '\n        ';
    const whitespace = match[1];
    const unit = whitespace.endsWith('\t') ? '\t' : (whitespace || '    ');
    return `\n${whitespace}${unit}`;
}

/**
 * Append a new frame under the user's current selection.
 *
 * - Mod-backed selection: append directly to its source element.
 * - Stock-only selection: create a root-level deep-path override, then put the
 *   child inside it. SC2 merges that override into the stock frame at runtime.
 * - No selection: append to <Desc> as a top-level frame/template.
 */
export function appendFrameAtSelection(modDoc, selected, child) {
    if (!modDoc || !modDoc.root) throw new Error('No layout document is open.');

    if (selected && selected._modSource) {
        appendChildPreservingIndent(selected._modSource, child);
        return {
            parent: selected._modSource,
            parentPath: selected.path || '',
            createdOverride: false,
        };
    }

    if (selected && selected.path && !selected.synthetic) {
        const rootIndent = inferChildIndent(modDoc.root);
        const childIndent = oneIndentDeeper(rootIndent);
        const override = makeElement('Frame', [
            ['type', selected.type || 'Frame'],
            ['name', selected.path],
        ], false, [
            textNode(childIndent),
            child,
            textNode(rootIndent),
        ]);
        appendChildPreservingIndent(modDoc.root, override);
        return {
            parent: override,
            parentPath: selected.path,
            createdOverride: true,
        };
    }

    appendChildPreservingIndent(modDoc.root, child);
    return { parent: modDoc.root, parentPath: '', createdOverride: false };
}
