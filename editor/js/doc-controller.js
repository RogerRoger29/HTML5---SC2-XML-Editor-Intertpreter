// Document lifecycle helpers - undo/redo stack and the round-trip diff check.
//
// R4.8 extracted these clean self-contained primitives from main.js. The
// open/save/new/saveAs functions still live in main.js because they touch
// too many surrounding subsystems (registry, textures, fileHandle, status
// bar, rerender) to extract safely without focused review - flagged as
// follow-up work in SESSION_STATE.md.
//
// UndoStack stores serialized snapshots (strings) so undoing rebuilds the
// modDoc by re-parsing rather than mutating in place - that's the safe way
// to recover from any internal state any mutation may have left dirty.

import { serializeXml } from './xml/serializer.js';

const UNDO_LIMIT = 100;

export class UndoStack {
    constructor(limit = UNDO_LIMIT) {
        this.limit = limit;
        this.undo = [];
        this.redo = [];
    }

    /** Capture the current doc as a snapshot. Call BEFORE the mutation. */
    snapshot(modDoc) {
        if (!modDoc) return;
        this.undo.push(serializeXml(modDoc));
        if (this.undo.length > this.limit) this.undo.shift();
        // A fresh edit invalidates any pending redo branch.
        this.redo.length = 0;
    }

    /** Push the current state onto the redo stack and return the previous
     *  snapshot string (caller re-parses + reinstalls). Returns null if no
     *  undo is available. */
    popForUndo(modDoc) {
        if (!this.undo.length) return null;
        this.redo.push(serializeXml(modDoc));
        return this.undo.pop();
    }

    /** Mirror of popForUndo for the redo side. */
    popForRedo(modDoc) {
        if (!this.redo.length) return null;
        this.undo.push(serializeXml(modDoc));
        return this.redo.pop();
    }

    /** Clear both stacks - call on Open / New / Save-As-new-file. */
    clear() {
        this.undo.length = 0;
        this.redo.length = 0;
    }

    canUndo() { return this.undo.length > 0; }
    canRedo() { return this.redo.length > 0; }
}

/** Find the byte offset of the first character that differs between two
 *  strings, or min(len) if one is a prefix of the other. */
export function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
    return n;
}

/** Re-serialize the current modDoc and compare to the pristine source.
 *  Returns { ok: true } if byte-exact, { ok: false, diffAt } otherwise,
 *  { ok: false, error } if serialization threw. Pure - host decides how
 *  to display the result. */
export function checkRoundTrip(modDoc, pristineSource) {
    try {
        const out = serializeXml(modDoc);
        if (out === pristineSource) return { ok: true };
        return { ok: false, diffAt: firstDiff(pristineSource, out) };
    } catch (err) {
        return { ok: false, error: err };
    }
}
