import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the actual parent controller with a small DOM/message harness. In
// particular, readiness and painting are separate events, as in the browser.
class Element {
  children = [];
  style = {};
  hidden = false;
  inert = false;
  attributes = {};
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  append(child) { this.children.push(child); }
  prepend(child) { this.children.unshift(child); }
  after() {}
  focus() {}
  remove() { this.removed = true; }
  set innerHTML(value) {
    if (value.includes('<header>')) {
      this.heading = new Element(); this.button = new Element(); this.area = new Element();
    } else this.children = [new Element(), new Element()];
  }
  querySelector(selector) { return { strong: this.heading, button: this.button, '.pptedit-frame-area': this.area }[selector]; }
}
const bar = new Element();
const app = new Element();
const body = new Element();
const handlers = {};
const timers = new Map();
let timerId = 0;
let healthChecks = 0;
let index = 0;
let navigations = 0;
let decodeFails = false;
const canvas = new Element();
const slides = [1, 2, 3].map(page => ({ page, title: `Page ${page}`, file: `${page}.svg` }));
const context = vm.createContext({
  URL, AbortSignal,
  Image: class { async decode() { if (decodeFails) throw new Error('invalid SVG'); } },
  location: { protocol: 'http:', origin: 'http://preview.test' },
  window: {
    PPTEDIT_PREVIEW_CONFIG: { url: 'http://editor.test', token: 'test' },
    PPT_NARRATION_HOST: { getSlides: () => slides, getIndex: () => index, goTo: value => { index = value; navigations++; } },
  },
  document: {
    body, activeElement: new Element(),
    querySelector: selector => ({ '.bottom': bar, '.app': app }[selector]),
    querySelectorAll: () => [], getElementById: id => id === 'slide' ? canvas : null,
    createElement: tag => {
      const element = new Element();
      if (tag === 'iframe') element.contentWindow = { messages: [], postMessage(message) { this.messages.push(message); } };
      return element;
    },
  },
  fetch: async () => { healthChecks++; return { ok: true }; },
  addEventListener: (type, handler) => { handlers[type] = handler; },
  setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
  clearTimeout: id => timers.delete(id),
});
vm.runInContext(readFileSync(new URL('../assets/preview-edit-mode.js', import.meta.url), 'utf8'), context);
const overlay = body.children[0];
const edit = bar.children[0].children[1];
const frames = overlay.area.children;
const send = (frame, page, type, extra = {}) => handlers.message({ origin: 'http://editor.test', source: frame.contentWindow, data: { page, type, ...extra } });
const paint = (frame, page) => {
  const preparation = frame.contentWindow.messages.findLast(message => message.type === 'pptedit-prepare');
  send(frame, page, 'pptedit-painted', { request: preparation.request });
};
await edit.onclick();
const first = frames[0];
send(first, 1, 'pptedit-ready');
assert.equal(first.style.opacity, '0');
paint(first, 1);
assert.equal(first.style.opacity, '');
await edit.onclick(2);
const second = frames[1];
assert.equal(first.hidden, false, 'old page stays visible during loading');
assert.equal(first.style.opacity, '');
assert.equal(second.style.opacity, '0');
assert.equal(index, 0, 'preview index only changes at commit');
send(second, 2, 'pptedit-ready');
send(second, 2, 'pptedit-painted', { request: -1 });
assert.equal(first.hidden, false, 'stale paint cannot commit');
paint(second, 2);
assert.equal(first.hidden, true);
assert.equal(second.hidden, false);
assert.equal(index, 1);
await edit.onclick(1);
assert.equal(frames.length, 2, 'returning reuses the editor and its undo history');
assert.equal(second.hidden, false);
paint(first, 1);
assert.equal(index, 0);
assert.equal(healthChecks, 1, 'page switches do not repeat health checks');
await edit.onclick(3);
send(frames[2], 3, 'pptedit-error');
assert.equal(first.hidden, false);
assert.equal(first.inert, false);
assert.equal(index, 0);
assert.ok(frames[2].removed);
await edit.onclick(2);
overlay.button.onclick();
assert.ok(!second.removed, 'canceling a cached page preserves its undo history');
assert.equal(first.hidden, false);
assert.equal(first.inert, false);
await edit.onclick(3);
for (const callback of [...timers.values()]) callback();
assert.equal(first.hidden, false, 'timeout retains current page');
assert.equal(first.inert, false);
assert.equal(index, 0);
console.log('PASS: paint handoff, old-page retention, cached navigation, stale messages, failure, cancel and timeout');
const beforeReturn = navigations;
send(first, 1, 'pptedit-preview');
assert.equal(overlay.hidden, false, 'missing saved SVG must not show stale preview');
decodeFails = true;
send(first, 1, 'pptedit-preview', { svg: '<svg/>' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(overlay.hidden, false, 'decode failure retains editor');
decodeFails = false;
const savedSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Saved change</text></svg>';
send(first, 1, 'pptedit-preview', { svg: savedSvg });
await new Promise(resolve => setImmediate(resolve));
assert.equal(canvas.src, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(savedSvg));
assert.equal(overlay.hidden, true);
assert.equal(navigations, beforeReturn, 'return must not reload the slide through goTo');
assert.equal(first.removed, undefined, 'editor and undo history remain alive');
console.log('PASS: return uses saved SVG without re-navigation, and retains editing on missing or invalid preview');

const editor = readFileSync(new URL('../assets/h5-editor/editor.js', import.meta.url), 'utf8');
const navigationSave = editor.match(/saveForNavigation: (async \(\) => \{[\s\S]*?\n      \})/)[1];
let saves = 0;
const saveContext = vm.createContext({
  changeVersion: 0, savedChangeVersion: 0, autoSaveInFlight: false,
  autoSaveTimer: 0, endAnyTextEditing() {}, clearTimeout() {},
  saveToDisk: async () => { saves++; return false; },
});
const save = vm.runInContext(`(${navigationSave})`, saveContext);
assert.equal(await save(), true);
assert.equal(saves, 0, 'clean navigation skips serialization and disk save');
saveContext.changeVersion = 1;
assert.equal(await save(), false, 'failed dirty save blocks navigation');
assert.equal(saves, 1);
saveContext.savedChangeVersion = 1;
assert.equal(await save(), true);
assert.equal(saves, 1, 'completed autosave also skips duplicate navigation save');
console.log('PASS: clean-page save bypass and dirty-save failure protection');
