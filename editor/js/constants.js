// Shared constants — one authoritative location for the magic strings and
// patterns that used to drift across modules. Before R4.6 these lived in
// 2–5 places each (the FRAME_TAG suffix regex, the stock-asset URL prefix,
// the four stock-mod directory names) and would silently fall out of sync
// when one site added a new frame type or one path moved.
//
// Keep this file dependency-free — it's imported from almost every module.

// Suffix-based "is this tag a frame container?" rule. Matches the open-ended
// SC2 convention where any author-defined type ending in one of these
// suffixes (e.g. "MyHeroFrame") behaves like its base. validate.js keeps
// its own narrower closed list for "is this a KNOWN frame type whose
// children we want to lint" - the two patterns answer different questions.
export const FRAME_TAG_SUFFIX_REGEX =
    /(Frame|Panel|Image|Label|Button|Bar|Box|Tooltip)$/;

// The four stock mod directories the SC2 base game ships, in DescIndex
// inclusion order. Mirrors casc.STOCK_MOD_DIRS on the Python side.
export const STOCK_MOD_DIRS = Object.freeze([
    'core.sc2mod', 'liberty.sc2mod', 'swarm.sc2mod', 'void.sc2mod',
]);

// All stock asset URLs start here. Concatenate the file path under
// Base.SC2Data/... directly. Keeping this as a constant means moving
// stock data to a new layout (e.g. mounting it at /stock/) is one edit.
export const STOCK_ASSETS_BASE = '/assets/core.sc2mod/Base.SC2Data/';
