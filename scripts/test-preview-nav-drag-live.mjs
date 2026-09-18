// Live E2E for preview-sidebar page drag (cross-level). Runs against a REAL deck served on
// :8775 (static) + :48766 (serve-svg-editor.py), mutates it via /reorder, then restores the
// original order by dragging back. Not part of `npm test` (needs a running deck).
//   DECK=/abs/path/to/deck PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-preview-nav-drag-live.mjs
// Chapter keys below are deck-specific; adjust KH/SEAT/BG/AGENTS for another deck.
import fs from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const DECK = process.env.DECK;
if (!DECK) throw new Error('Set DECK to the local test deck directory. This live test changes its page order.');
const SHOT_DIR = process.env.SHOT_DIR || process.cwd();
const orig = { index: fs.readFileSync(`${DECK}/index.html`, 'utf8'), chapters: fs.readFileSync(`${DECK}/chapter-settings.json`, 'utf8') };
const readOrder = () => JSON.parse(fs.readFileSync(`${DECK}/index.html`, 'utf8').match(/const slides=(\[.*?\]);/s)[1]).map(s => s.page);
const readTree = () => JSON.parse(fs.readFileSync(`${DECK}/chapter-settings.json`, 'utf8')).__navigation.tree;
const find = (nodes, page, path = []) => { for (const n of nodes) { if (n.page === page) return path; if (n.children) { const r = find(n.children, page, [...path, n.key]); if (r) return r; } } return null; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (c, m) => { if (!c) throw new Error('ASSERT ' + m); };

const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://127.0.0.1:8775/#15'); await p.waitForSelector('#nav[data-drag-enhanced]'); await p.waitForTimeout(900);

const row = page => p.locator(`#nav .slide-link[data-page="${page}"]`);
const summaryOf = key => p.locator(`#nav details[data-chapter-key="${key}"] > summary`);
const openAll = async () => p.evaluate(() => document.querySelectorAll('#nav details').forEach(d => d.open = true));
const scrollTo = async loc => { await loc.scrollIntoViewIfNeeded(); await p.waitForTimeout(120); };
const drag = async (fromLoc, toPoint, { shot } = {}) => {
  await scrollTo(fromLoc); const r = await fromLoc.boundingBox();
  await p.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await p.mouse.down();
  await p.mouse.move(r.x + r.width / 2 + 3, r.y + r.height / 2 + 8, { steps: 3 }); // exceed 6px threshold
  // 目标可能在可视区外：拖动中把指针停在列表中段（不触发边缘自动滚动），程序化滚动直到目标进入安全带，再重新量取。
  const nb0 = await p.locator('#nav').boundingBox(); const cx = nb0.x + nb0.width / 2, cy = nb0.y + nb0.height / 2;
  let to = typeof toPoint === 'function' ? await toPoint() : toPoint;
  if (to.y < nb0.y + 80 || to.y > nb0.y + nb0.height - 80) {
    await p.mouse.move(cx, cy, { steps: 4 });
    for (let i = 0; i < 80; i++) { to = typeof toPoint === 'function' ? await toPoint() : toPoint; if (to.y >= nb0.y + 80 && to.y <= nb0.y + nb0.height - 80) break; await p.evaluate(d => { document.getElementById('nav').scrollTop += d * 120; }, to.y < cy ? -1 : 1); await p.waitForTimeout(30); }
    await p.waitForTimeout(150); to = typeof toPoint === 'function' ? await toPoint() : toPoint;
  }
  await p.mouse.move(to.x, to.y, { steps: 8 });
  await p.waitForTimeout(260);
  const state = await p.evaluate(() => { const l = document.querySelector('#nav .nav-drop-line'); const inside = document.querySelector('#nav .nav-drop-inside'); const nav = document.getElementById('nav').getBoundingClientRect(); const lr = l && !l.hidden ? l.getBoundingClientRect() : null; return { line: lr ? { x: Math.round(lr.x), y: Math.round(lr.y), w: Math.round(lr.width), inNav: lr.y >= nav.top && lr.y <= nav.bottom } : null, inside: inside?.dataset.chapterKey || null, dragging: !!document.querySelector('#nav .is-dragging'), noop: document.getElementById('nav').classList.contains('nav-drop-noop') }; });
  if (shot) { const nb = await p.locator('#nav').boundingBox(); const vh = p.viewportSize().height; const y0 = Math.min(Math.max(0, to.y - 220), Math.max(0, vh - 440)); await p.screenshot({ path: `${SHOT_DIR}/${shot}.png`, clip: { x: nb.x, y: y0, width: nb.width, height: Math.min(440, vh - y0) } }); }
  await p.mouse.up();
  await p.waitForFunction(() => !document.querySelector('#nav .is-dragging'));
  await p.waitForTimeout(900); // persist + rebuild
  return state;
};
const rightEdgeBelow = async (loc, dx) => { const r = await loc.boundingBox(); return { x: r.x + r.width - dx, y: r.y + r.height - 3 }; };
const leftBelow = async (loc) => { const r = await loc.boundingBox(); const n = await p.locator('#nav').boundingBox(); return { x: n.x + 12 + 2 * 22 - 4, y: r.y + r.height - 3 }; }; // 深度2刻度(Agents)
const middleOf = async (loc) => { const r = await loc.boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
const topOf = async (loc) => { const r = await loc.boundingBox(); return { x: r.x + r.width / 2, y: r.y + 4 }; };

try {
  const startOrder = readOrder();
  await openAll();
  const KH = 'custom:689fe6f6-2a65-4a60-ac33-8c01d35aa41f';   // Know How (depth 3): 13.1 13.2 14 17
  const SEAT = 'custom:e4bbf153-2bb1-4afc-97b0-1e80537d785e'; // 座椅生成 (depth 3): 15 16 16.1
  const BG = 'page:10';                                       // 项目背景 (depth 2): 10 18 12 13
  const AGENTS = 'custom:7f39632d-3abe-4ca2-8dbe-30969407ec4f';

  // 1) 子层级 → 父层级：把 17（Know How 末尾，深度3）拖到 Know How 中「17 之前的最后一项」下方、指针靠左(深度2刻度) => 放到 Agents 层，位于 Know How 之后
  //    章节内页序可能被外部内容服务改动，动态取最后一项，不写死。
  const lastBefore17 = await p.evaluate(k => { const d = document.querySelector(`#nav details[data-chapter-key="${k}"]`); const kids = [...d.children].filter(e => e.matches('.slide-link')).map(e => e.dataset.page); return kids[kids.indexOf('17') - 1]; }, KH);
  let st = await drag(row(17), () => leftBelow(row(lastBefore17)), { shot: 'navdrag-1-out-to-parent' });
  // 注意：拖动时 17 自身被剔除，Know How 的最后一个可见项是 14；线画在 14 下方，左侧对齐 Agents 层
  assert(st.dragging, 'dragging state set');
  let tree = readTree(), order = readOrder();
  assert(eq(find(tree, 17), ['section:0', AGENTS]), `17 now child of Agents, got ${JSON.stringify(find(tree, 17))}`);
  assert(order.indexOf(17) === order.indexOf(Number(lastBefore17)) + 1, `17 immediately after last KH item (${lastBefore17}); order=${JSON.stringify(order.slice(12,20))}`);
  console.log('1 PASS  17 -> Agents (out of Know How, left-biased gap):', st);

  // 2) 父层级 → 子层级：把 17 拖到「座椅生成」标题中段 => 放进座椅生成、作为第一项（标题高亮 + 标题下方插入线）
  await openAll();
  st = await drag(row(17), () => middleOf(summaryOf(SEAT)), { shot: 'navdrag-2-into-chapter' });
  assert(st.inside === SEAT && st.line && st.line.inNav, `inside highlight + line on 座椅生成, got ${JSON.stringify(st)}`);
  tree = readTree(); order = readOrder();
  assert(eq(find(tree, 17), ['section:0', AGENTS, SEAT]), '17 now inside 座椅生成');
  const seatFirst = (function firstOf(nodes){ for (const n of nodes) { if (n.key === SEAT) return n.children[0]?.page; if (n.children) { const r = firstOf(n.children); if (r !== undefined) return r; } } })(tree);
  assert(seatFirst === 17, `17 is FIRST child of 座椅生成 (got ${seatFirst})`);
  console.log('2 PASS  17 -> into 座椅生成 as first (summary middle band):', st);

  // 3) 同级精确定位：把 17 拖到 16 的上半部 => 16 之前（线在 16 顶部）
  await openAll();
  st = await drag(row(17), () => topOf(row(16)), { shot: 'navdrag-3-before-sibling' });
  assert(st.line && st.line.inNav, 'line visible inside nav');
  order = readOrder();
  assert(order.indexOf(17) === order.indexOf(16) - 1, '17 immediately before 16');
  console.log('3 PASS  17 -> before 16 (line at row top):', st);

  // 4) 边界歧义右偏：把 13（项目背景末尾）拖到 Know How 最后一项 13.2 下方、指针靠右 => 进 Know How 末尾（深度3）
  await openAll();
  const khLast = await p.evaluate(k => { const d = document.querySelector(`#nav details[data-chapter-key="${k}"]`); const kids = [...d.children].filter(e => e.matches('.slide-link')).map(e => e.dataset.page); return kids[kids.length - 1]; }, KH);
  st = await drag(row(13), () => rightEdgeBelow(row(khLast), 20), { shot: 'navdrag-4-right-biased-into' });
  tree = readTree(); order = readOrder();
  assert(eq(find(tree, 13), ['section:0', AGENTS, KH]), `13 now inside Know How, got ${JSON.stringify(find(tree, 13))}`);
  console.log('4 PASS  13 -> Know How end (right-biased gap):', st);

  // 5) 拖到根级：把 13 拖到「开场」章节标题上沿 => 根级，开场之前（跨 3 层）
  await openAll();
  st = await drag(row(13), () => topOf(summaryOf('page:1')), { shot: 'navdrag-5-to-root-top' });
  tree = readTree(); order = readOrder();
  assert(eq(find(tree, 13), []), `13 at root, got ${JSON.stringify(find(tree, 13))}`);
  assert(order[0] === 13, '13 is first page now');
  console.log('5 PASS  13 -> root, before 开场:', st);

  // 6) 无变化放置不写盘：把 13 拖回自己原位（它上方即 nav 顶部）→ noop
  const before6 = fs.statSync(`${DECK}/index.html`).mtimeMs;
  await openAll();
  st = await drag(row(13), () => topOf(row(13)));
  assert(st.noop === true && st.line === null, `noop state, got ${JSON.stringify(st)}`);
  assert(fs.statSync(`${DECK}/index.html`).mtimeMs === before6, 'noop did not write index.html');
  console.log('6 PASS  noop drop does not persist');

  // 7) Esc 取消：开始拖动后按 Esc → 不改动
  await openAll(); await scrollTo(row(13));
  { const r = await row(13).boundingBox(); await p.mouse.move(r.x + 40, r.y + 20); await p.mouse.down(); await p.mouse.move(r.x + 40, r.y + 160, { steps: 8 }); await p.waitForTimeout(150);
    assert(await p.evaluate(() => !!document.querySelector('#nav .is-dragging')), 'drag active before Esc');
    await p.keyboard.press('Escape'); await p.mouse.up(); await p.waitForTimeout(200);
    assert(await p.evaluate(() => !document.querySelector('#nav .is-dragging, #nav .nav-drop-line:not([hidden]), #nav .nav-drop-inside')), 'Esc cleaned up'); }
  assert(readOrder()[0] === 13, 'Esc did not change order');
  console.log('7 PASS  Escape cancels');

  // 8) 拖动结束后的 click 不翻页
  const idxBefore = await p.evaluate(() => window.PPT_NARRATION_HOST.getIndex());
  await drag(row(13), () => topOf(row(13)));
  assert(await p.evaluate(() => window.PPT_NARRATION_HOST.getIndex()) === idxBefore, 'no page jump after drag');
  console.log('8 PASS  post-drag click suppressed');

  // 9) 窄侧栏（≤1100 → 272px）仍可拖且线在 nav 内
  await p.setViewportSize({ width: 1000, height: 900 }); await p.waitForTimeout(400); await openAll();
  st = await drag(row(13), () => topOf(row(1)), { shot: 'navdrag-9-narrow' });
  assert(st.line && st.line.inNav && st.line.w > 80, `narrow: line visible, ${JSON.stringify(st)}`);
  console.log('9 PASS  narrow sidebar:', st);
  await p.setViewportSize({ width: 1440, height: 900 }); await p.waitForTimeout(300);

  // 10) 复原（两步）：13 回到 项目背景 末尾（12 之后）；17 回到 Know How 末尾（14 之后）→ 与初始顺序/树一致
  await openAll();
  await drag(row(13), () => rightEdgeBelow(row(12), 20));
  assert(eq(find(readTree(), 13), ['section:0', BG]), '13 back in 项目背景');
  await openAll();
  await drag(row(17), () => rightEdgeBelow(row(14), 20));
  assert(eq(find(readTree(), 17), ['section:0', AGENTS, KH]), '17 back in Know How');
  const finalOrder = readOrder();
  if (!eq(finalOrder, startOrder)) throw new Error(`restore mismatch\n start=${JSON.stringify(startOrder)}\n final=${JSON.stringify(finalOrder)}`);
  console.log('10 PASS restored to original order via two drags');
  console.log('page errors:', errs);
} catch (e) {
  console.error('FAILED:', e.message);
  fs.writeFileSync(`${DECK}/index.html`, orig.index); fs.writeFileSync(`${DECK}/chapter-settings.json`, orig.chapters);
  console.error('!! restored index.html + chapter-settings.json from in-memory snapshot');
  process.exitCode = 1;
} finally { await b.close(); }
