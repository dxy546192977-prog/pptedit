import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Reproduce the reported old-ID sequence, including an inserted fractional ID.
let slides = [9, 6, 8, 5.1].map(page => ({ page, title: `Page ${page}` }));
const initialIds = slides.map(s => s.page);
let index = 1;
const identity = { textContent: 'SVG 确认稿 · 99 页' };
const counter = { textContent: '' };
const events = {};
function row(id, thumb = false) {
  const number = { textContent: '' }, caption = { textContent: '' };
  return {
    dataset: { page: String(id) }, number, caption,
    matches: selector => thumb ? selector === '.thumb' : selector === '.slide-link',
    querySelector: selector => selector === '.nav-slide-number' ? (thumb ? null : number) : selector === 'p' ? caption : null,
    setAttribute() {},
  };
}
let rows = initialIds.flatMap(id => [row(id), row(id, true)]);
const context = {
  window: { PPT_NARRATION_HOST: { getSlides: () => slides, getIndex: () => index }, addEventListener: (event, fn) => { events[event] = fn; } },
  document: {
    querySelector: () => identity,
    querySelectorAll: selector => selector === '.slide-link, .thumb' ? rows : [],
    getElementById: id => id === 'counter' ? counter : null,
  }, console,
};
vm.runInNewContext(readFileSync(new URL('../assets/preview-page-numbers.js', import.meta.url), 'utf8'), context);
assert.deepEqual(rows.filter(r => r.matches('.slide-link')).map(r => r.number.textContent), ['01', '02', '03', '04']);
assert.equal(identity.textContent, 'SVG 确认稿 · 4 页');
assert.equal(counter.textContent, '02 / 4');
slides = [slides[2], slides[0], slides[3], slides[1]];
events['pptedit-order-changed']();
assert.deepEqual(rows.filter(r => r.matches('.slide-link')).map(r => r.number.textContent), ['02', '04', '01', '03']);
assert.equal(rows.find(r => r.dataset.page === '8' && r.matches('.thumb')).caption.textContent, '01  /  Page 8');
slides = slides.filter(s => s.page !== 9);
rows = rows.filter(r => r.dataset.page !== '9');
index = 2;
events['pptedit-order-changed']();
assert.equal(identity.textContent, 'SVG 确认稿 · 3 页');
assert.equal(counter.textContent, '03 / 3');
assert.deepEqual(slides.map(s => s.page), [8, 5.1, 6]);
assert.deepEqual(rows.filter(r => r.matches('.slide-link')).map(r => r.number.textContent), ['03', '01', '02']);
console.log('PASS: nonsequential/fractional IDs, reorder, deletion, overview captions and totals keep positional numbers without changing IDs');
