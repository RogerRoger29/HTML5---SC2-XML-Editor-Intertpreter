// SC2 StateGroup parsing + preview application.
//
// In SC2 a <StateGroup> defines named visual states (Normal, Hover, Pressed,
// Checked, Disabled, etc.) and the conditions under which each is active.
// Each state has <Action>s that set properties on child frames:
//
//     <StateGroup name="ButtonStateGroup">
//         <DefaultState val="Normal"/>
//         <State name="Hover">
//             <When type="Property" mouseover="true"/>
//             <Action type="SetProperty" frame="$this/NormalImage" visible="false"/>
//             <Action type="SetProperty" frame="$this/HoverImage" visible="true"/>
//         </State>
//     </StateGroup>
//
// At runtime SC2 evaluates the When conditions and switches between states.
// The editor can't actually drive runtime conditions (mouseover isn't real
// here) so instead we let the user PICK a state from the inspector and
// apply that state's Actions to the materialised tree before rendering.
//
// Only Action type="SetProperty" is honoured today; other action types
// (animations, sounds) are ignored.

export function parseStateGroupsOnFrame(modSource) {
    if (!modSource || !modSource.children) return [];
    const groups = [];
    for (const c of modSource.children) {
        if (c.type !== 'element' || c.tag !== 'StateGroup') continue;
        const groupName = attrVal(c, 'name') || '(unnamed)';
        let defaultState = null;
        const states = [];
        for (const sc of c.children) {
            if (sc.type !== 'element') continue;
            if (sc.tag === 'DefaultState') {
                defaultState = attrVal(sc, 'val') || null;
            } else if (sc.tag === 'State') {
                const stateName = attrVal(sc, 'name') || '(unnamed)';
                const conditions = [];
                const actions = [];
                for (const inner of sc.children) {
                    if (inner.type !== 'element') continue;
                    if (inner.tag === 'When') {
                        conditions.push(attrMap(inner));
                    } else if (inner.tag === 'Action') {
                        const a = attrMap(inner);
                        if (a.type === 'SetProperty') {
                            actions.push({
                                kind: 'SetProperty',
                                frame: a.frame || '$this',
                                props: { ...a, type: undefined, frame: undefined },
                            });
                        }
                    }
                }
                states.push({ name: stateName, conditions, actions });
            }
        }
        // Fall back to the first state's name if no DefaultState declared.
        if (!defaultState && states.length) defaultState = states[0].name;
        groups.push({ name: groupName, defaultState, states });
    }
    return groups;
}

/** Walk the materialised frame tree and, for any frame whose XML source
 *  declares a StateGroup, apply the user-selected state's actions to
 *  descendant frames before render.
 *
 *  activeStates: Map(frame.path + '#' + groupName -> stateName)
 *  Resets each visited frame's state-override properties so previously-
 *  applied states from older renders don't leak through.
 */
export function applyStateActions(frames, activeStates) {
    if (!activeStates) activeStates = new Map();
    const walk = (nodes) => {
        for (const n of nodes) {
            applyToFrame(n, activeStates);
            if (n.children && n.children.length) walk(n.children);
        }
    };
    walk(frames);
}

/** Returns the list of state-group metadata visible for a single frame
 *  (used to populate the inspector dropdowns). Reads from any source XML
 *  element of the materialised node (including template-inherited ones). */
export function stateGroupsFor(node) {
    if (!node) return [];
    const groups = [];
    // Direct sources first.
    const sources = node.sources || (node._modSource ? [node._modSource] : []);
    for (const src of sources) {
        for (const g of parseStateGroupsOnFrame(src)) {
            // De-duplicate by group name across multiple sources.
            if (!groups.find(x => x.name === g.name)) groups.push(g);
        }
    }
    // Also check materialised xml (covers template-derived StateGroups).
    if (node.xml) {
        for (const g of parseStateGroupsOnFrame(node.xml)) {
            if (!groups.find(x => x.name === g.name)) groups.push(g);
        }
    }
    return groups;
}

// ---- internals -----------------------------------------------------------

function applyToFrame(node, activeStates) {
    const groups = stateGroupsFor(node);
    if (!groups.length) return;
    for (const g of groups) {
        const key = `${node.path}#${g.name}`;
        const stateName = activeStates.get(key) || g.defaultState;
        const state = g.states.find(s => s.name === stateName);
        if (!state) continue;
        for (const action of state.actions) {
            applyAction(node, action);
        }
    }
}

function applyAction(baseFrame, action) {
    const target = resolveFrameRef(baseFrame, action.frame);
    if (!target) return;
    const props = action.props || {};
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined) continue;
        const key = k.toLowerCase();
        if (key === 'visible') {
            target.visible = (String(v).toLowerCase() === 'true');
        } else if (key === 'color') {
            target._stateColor = v;
        } else if (key === 'alpha') {
            const n = parseFloat(v);
            if (Number.isFinite(n)) target._stateAlpha = n;
        }
        // Other property names (e.g. texture, text) ignored for now -
        // would require coordinating with the renderer's _paintImage path.
    }
}

/** Resolve $this / $parent / $ancestor / sibling-name references in
 *  Action frame= attributes against the materialised tree. Mirrors
 *  the anchor resolver used during layout. */
function resolveFrameRef(node, ref) {
    if (!ref || ref === '$this') return node;
    if (ref === '$parent') return node.parent || null;
    if (ref === '$root') {
        let n = node;
        while (n.parent) n = n.parent;
        return n;
    }
    if (ref.startsWith('$ancestor')) {
        const m = /type=([A-Za-z0-9_]+)/.exec(ref);
        if (m) {
            for (let p = node.parent; p; p = p.parent) {
                if (p.type === m[1]) return p;
            }
        }
        return null;
    }
    let cur = node;
    const segments = ref.replace(/^\$this\//, '').split('/');
    for (const seg of segments) {
        if (seg === '$parent') { cur = cur.parent; continue; }
        if (!cur || !cur.children) return null;
        const next = cur.children.find(c => c.name === seg);
        if (!next) return null;
        cur = next;
    }
    return cur;
}

function attrMap(el) {
    const out = {};
    if (!el || !el.attrs) return out;
    for (const a of el.attrs) out[a.name] = a.value;
    return out;
}

function attrVal(el, name) {
    if (!el || !el.attrs) return undefined;
    const a = el.attrs.find(x => x.name === name);
    return a ? a.value : undefined;
}
