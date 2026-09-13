import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/pptedit-frame.js', import.meta.url), 'utf8');
const start = source.indexOf("button.addEventListener('drop', async event => {");
const end = source.indexOf('\n        });', start) + '\n        });'.length;
const handlerSource = source.slice(start, end);
async function run({ after = false, save = true, ok = true, moving = 8, target = 4 } = {}) {
  let handler;
  const requests = [], notifications = [], applied = [];
  const context = vm.createContext({
    button: { dataset: { drop: after ? 'after' : 'before' }, addEventListener: (_, value) => { handler = value; } },
    draggedPage: moving, sorting: false, navigating: false,
    clearDrop() {}, item: { page: target }, source: { slides: [4, 6, 8, 10].map(page => ({ page })) },
    api: { saveForNavigation: async () => save }, headers: {}, foot: {},
    fetch: async (_, request) => { requests.push(JSON.parse(request.body)); return { ok, json: async () => ({ error: 'conflict' }) }; },
    notify: (...args) => notifications.push(args), applyOrder: order => applied.push([...order]),
  });
  vm.runInContext(handlerSource, context);
  await handler({ preventDefault() {} });
  assert.equal(context.navigating, false);
  assert.equal(context.sorting, false);
  return { requests, notifications, applied, context };
}
assert.deepEqual((await run()).applied, [[8, 4, 6, 10]]);
assert.deepEqual((await run({ after: true })).applied, [[4, 8, 6, 10]]);
assert.deepEqual((await run({ moving: 4, target: 10, after: true })).applied, [[6, 8, 10, 4]]);
assert.equal((await run({ save: false })).requests.length, 0);
assert.equal((await run({ ok: false })).applied.length, 0);
assert.equal((await run({ moving: 4, target: 4 })).requests.length, 0);
assert.equal((await run({ moving: 6, target: 4, after: true })).requests.length, 0);
console.log('PASS: actual drop handler moves both directions, supports before/after, ignores no-ops, and preserves order on save failures');
