import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the real capture handler: the embedded frame has one local slide,
// but navigation must reach the host deck, without moving selected elements.
const source = readFileSync(new URL('../assets/h5-editor/editor.js', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('  function handleSlideNavKeydown(e)'), source.indexOf('  function installDeckNavBridge()'));
let eligible = true;
let localNavigations = 0;
const deltas = [];
const context = vm.createContext({
  shouldArrowKeyNavigateSlides: () => eligible,
  document: { activeElement: null },
  getCurrentSlideIndex: () => 0,
  slideNavDelta: key => key === 'ArrowDown' ? 1 : -1,
  DOCUMENT_HOST: { navigateBy: delta => deltas.push(delta) },
  refreshDeckNavigation: () => localNavigations++,
  isH5vePreviewMode: () => false,
});
vm.runInContext(handler, context);
for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
  let prevented = false;
  let stopped = false;
  assert.equal(context.handleSlideNavKeydown({ key, preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } }), true);
  assert.ok(prevented && stopped);
}
assert.deepEqual(deltas, [1, 1, -1]);
assert.equal(localNavigations, 0);
eligible = false;
assert.equal(context.handleSlideNavKeydown({ key: 'ArrowUp' }), false);
assert.equal(deltas.length, 3);
console.log('PASS: host deck receives repeated arrow navigation; ineligible editing events remain untouched');
