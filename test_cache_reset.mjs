import assert from 'node:assert/strict';
import { TextureLoader } from './editor/js/render/textures.js';
import { FontStyleSheet } from './editor/js/render/fontstyle.js';

const textures = new TextureLoader('/assets/');
textures.aliases.set('Old/Alias', 'Assets\\Textures\\old.dds');
textures.aliasesLoaded = true;
textures.cache.set('old', Promise.resolve(null));
textures.results.set('old', { status: 'not_found' });
textures.reset();
assert.equal(textures.aliases.size, 0);
assert.equal(textures.cache.size, 0);
assert.equal(textures.aliasesLoaded, false);
assert.equal(textures.results.size, 0);
assert.equal(textures.getDiagnostics().counts.not_found, 0);

const fonts = new FontStyleSheet();
fonts.constants.set('Old', '1');
fonts.rawStyles.set('OldStyle', {});
fonts.resolved.set('OldStyle', {});
fonts.fontsLoaded.add('old-font');
fonts.reset();
assert.equal(fonts.constants.size, 0);
assert.equal(fonts.rawStyles.size, 0);
assert.equal(fonts.resolved.size, 0);
assert.equal(fonts.fontsLoaded.size, 0);

console.log('ALL PASS');
