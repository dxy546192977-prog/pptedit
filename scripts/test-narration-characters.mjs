import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.classes = new Set();
    this.classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
    this.scrollTop = 0;
  }
  append(node) { node.parent = this; this.children.push(node); }
  replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.append(node)); }
  setAttribute() {}
  addEventListener(name, callback) { this.events[name] = callback; }
  hasAttribute(name) { return name === 'data-start' && this.dataset.start !== undefined; }
  matches(selector) { return this.className === 'note-char' && (!selector.includes('[data-start]') || this.hasAttribute('data-start')); }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  focus() { this.focused = true; }
  getBoundingClientRect() { return this.rect || {top: 0, bottom: 100, height: 100}; }
  scrollTo(value) { this.scrolled = value; }
}
const context = { window: {}, document: { createElement: tag => new Element(tag) }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
vm.runInNewContext(fs.readFileSync(new URL('../assets/narration/characters.js', import.meta.url), 'utf8'), context);
const container = new Element('div'), seeks = [];
const view = context.window.PPT_NARRATION_CHARACTERS.create(container, time => seeks.push(time));
view.render({notes: ['你**好**。再见']}, {chars: [[[0, .2], [.2, .5], null, [2, 2.4], [2.4, 3]]]}, true);
const chars = container.querySelectorAll('.note-char');
assert.equal(chars.length, 5); assert.equal(chars[1].parent.tagName, 'strong');
view.update(.3, false); assert.ok(chars[1].classes.has('current-char')); assert.ok(!chars[0].classes.has('current-char'));
assert.ok(chars.slice(0, 3).every(node => node.classes.has('current-phrase')), 'whole clause including punctuation is emphasized');
assert.ok(!chars[3].classes.has('current-phrase'));
view.start({currentTime:.3, paused:false}); assert.equal(container.dataset.reading, 'true');
view.stop(); assert.equal(container.dataset.reading, 'false');
view.update(1, false); assert.ok(!chars[1].classes.has('current-char'), 'silence must not advance through characters');
container.children[0].events.click({target: chars[3]}); assert.equal(seeks.at(-1), 2);
container.children[0].events.click({target: chars[2]}); assert.equal(seeks.at(-1), 2, 'punctuation seeks next speech char');
chars[4].rect = {top: 300, bottom: 320, height: 20}; view.update(2.5); assert.equal(container.scrolled.top, 260);
assert.ok(chars.slice(0,3).every(node => !node.classes.has('current-phrase')));
assert.ok(chars.slice(3).every(node => node.classes.has('current-phrase')));
view.render({notes: ['尚未对齐']}, null, true);container.children[0].events.click({target: container.children[0]});assert.equal(seeks.at(-1), null);
console.log('PASS: exact char seek, bold preservation, silence, punctuation, container-only scroll, no estimated fallback');
