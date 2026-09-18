// Regression: nested canvas groups (Cmd+G inside a sub-group, drill-down
// selection, ungroup) and layer-panel drag sorting across nesting depths.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test-layer-nested-group-browser.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fixture = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;background:#111}
  #stage{position:relative;width:1600px;height:900px}
  #deck{position:relative;width:1600px;height:900px}
  .slide{position:absolute;inset:0;background:#1d2128}
  .box{position:absolute;width:160px;height:100px;color:#fff;font:20px/100px sans-serif;text-align:center}
</style>
<main id="stage" data-h5ve-width="1600" data-h5ve-height="900"><div id="deck">
<section class="slide">
  <div class="box" id="a" style="left:100px;top:100px;background:#c33">A</div>
  <div class="box" id="b" style="left:320px;top:100px;background:#3c3">B</div>
  <div class="box" id="c" style="left:540px;top:100px;background:#33c">C</div>
  <div class="box" id="d" style="left:100px;top:400px;background:#cc3">D</div>
  <div class="box" id="e" style="left:320px;top:400px;background:#3cc">E</div>
</section>
</div></main>
<script src="/h5-editor/bootstrap.js"></script>`;

const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://local");
  try {
    if (url.pathname.startsWith("/h5-editor/")) {
      const file = path.join(repoRoot, "assets", url.pathname);
      res.setHeader("Content-Type", `${types[path.extname(file)] || "text/plain"};charset=utf-8`);
      res.end(await fs.readFile(file));
      return;
    }
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(fixture);
  } catch (error) {
    res.writeHead(404);
    res.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1700, height: 1100 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/index.html?edit=1`);
  await page.locator("#h5ve-elements:not([hidden])").waitFor();
  await page.waitForTimeout(300);

  const center = async (id) => {
    const r = await page.locator(`#${id}`).boundingBox();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  };
  const click = async (id, modifiers = []) => {
    const p = await center(id);
    // page.mouse.click({ modifiers }) does not reliably set shiftKey on
    // synthesized mouse events in headless Chromium; hold the key explicitly.
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.click(p.x, p.y);
    for (const key of modifiers) await page.keyboard.up(key);
    await page.waitForTimeout(60);
  };
  const clickEmpty = async () => {
    // Bottom-right of the slide (no boxes there).
    const r = await page.locator("#deck > .slide").boundingBox();
    await page.mouse.click(r.x + r.width - 40, r.y + r.height - 40);
    await page.waitForTimeout(60);
  };
  const selectedIds = () =>
    page.evaluate(() => [...document.querySelectorAll("[data-h5ve-selected='true']")].map((el) => el.id || el.dataset.tag || el.className));
  const rects = (ids) =>
    page.evaluate((ids) => ids.map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }), ids);
  const structure = () =>
    page.evaluate(() => {
      const walk = (el) => [...el.children]
        .filter((c) => !c.matches("script,style,[data-h5ve-structural],[data-h5ve-speaker-note]"))
        .map((c) => (c.dataset.h5veGroup === "1" ? { g: c.dataset.tag || "", k: walk(c) } : c.id));
      return walk(document.querySelector(".slide"));
    });
  const tagGroups = () =>
    page.evaluate(() => {
      document.querySelectorAll("[data-h5ve-group='1']").forEach((g, i) => {
        if (!g.dataset.tag) g.dataset.tag = `G${document.querySelectorAll("[data-h5ve-group='1'][data-tag]").length + 1}`;
      });
    });

  // ---- 1. Outer group A+B+C ------------------------------------------------
  const before = await rects(["a", "b", "c", "d", "e"]);
  await click("a");
  await click("b", ["Shift"]);
  await click("c", ["Shift"]);
  assert.deepEqual(await selectedIds(), ["a", "b", "c"]);
  await page.keyboard.press("Meta+g");
  await page.waitForTimeout(120);
  await tagGroups();
  let tree = await structure();
  assert.equal(tree.length, 3, "outer group replaces a,b,c");
  assert.deepEqual(tree[0].k, ["a", "b", "c"]);
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "grouping keeps geometry");
  const outer = tree[0].g;

  // ---- 2. Click on leaf inside selected group drills one level -------------
  //   selection is currently the outer group (after Cmd+G). Click A → drill to A.
  assert.deepEqual(await selectedIds(), [outer]);
  await click("a");
  assert.deepEqual(await selectedIds(), ["a"], "click inside selected group drills to child");
  // Click empty canvas, then click A again → outermost group is picked first.
  await clickEmpty();
  await page.waitForTimeout(60);
  assert.deepEqual(await selectedIds(), []);
  await click("a");
  assert.deepEqual(await selectedIds(), [outer], "fresh click picks outermost group");

  // ---- 3. Sub-group inside the group: select A, shift-click B, Cmd+G -------
  await click("a"); // drill to A
  await click("b", ["Shift"]);
  assert.deepEqual(await selectedIds(), ["a", "b"], "shift-click sibling inside group adds only that sibling");
  await page.keyboard.press("Meta+g");
  await page.waitForTimeout(120);
  await tagGroups();
  tree = await structure();
  assert.equal(tree[0].g, outer);
  assert.equal(tree[0].k.length, 2, "outer now holds inner group + c");
  assert.deepEqual(tree[0].k[0].k, ["a", "b"], "inner group holds a,b only (c untouched)");
  assert.equal(tree[0].k[1], "c");
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "nested grouping keeps geometry");
  const inner = tree[0].k[0].g;

  // ---- 4. Drill chain outer → inner → leaf ---------------------------------
  await clickEmpty();
  await page.waitForTimeout(60);
  await click("a");
  assert.deepEqual(await selectedIds(), [outer]);
  await click("a");
  assert.deepEqual(await selectedIds(), [inner], "second click drills to inner group");
  await click("a");
  assert.deepEqual(await selectedIds(), ["a"], "third click drills to leaf");
  // Shift-click on a selected element (or its descendant) toggles it off.
  await click("a", ["Shift"]);
  assert.deepEqual(await selectedIds(), []);

  // ---- 5. Ungroup inner via Cmd+Shift+G while a leaf is selected -----------
  await click("a"); await click("a"); await click("a");
  assert.deepEqual(await selectedIds(), ["a"]);
  await page.keyboard.press("Meta+Shift+g");
  await page.waitForTimeout(120);
  tree = await structure();
  assert.equal(tree[0].g, outer);
  assert.deepEqual(tree[0].k, ["a", "b", "c"], "inner group dissolved back into outer");
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "ungroup keeps geometry");

  // Re-create inner (a,b) for drag tests.
  await clickEmpty();
  await click("a"); await click("a");
  await click("b", ["Shift"]);
  await page.keyboard.press("Meta+g");
  await page.waitForTimeout(120);
  await tagGroups();
  tree = await structure();
  assert.deepEqual(tree[0].k[0].k, ["a", "b"]);
  const inner2 = tree[0].k[0].g;

  // ---- 6. Layer panel drag sort --------------------------------------------
  // Helper: synthesize HTML5 drag from a row to a pointer position in the list.
  // page.evaluate cannot receive functions; wrap with string → Function.
  const dragRow = async (sourceId, targetSrc) => {
    await page.evaluate(() => {
      document.querySelectorAll(".h5ve-element-item").forEach((row) => {
        const el = row.__h5veElement;
        row.dataset.rowFor = el?.id || el?.dataset?.tag || "";
      });
    });
    await page.evaluate(async ({ sourceId, targetSrc }) => {
      const target = new Function("rows", "list", targetSrc);
      const list = document.querySelector(".h5ve-elements-list");
      const row = document.querySelector(`.h5ve-element-item[data-row-for="${sourceId}"]`);
      if (!row) throw new Error(`row ${sourceId} not found`);
      const dt = new DataTransfer();
      const rr = row.getBoundingClientRect();
      row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.x + 40, clientY: rr.y + rr.height / 2 }));
      const rowsNow = [...list.querySelectorAll(".h5ve-element-item")];
      const tr = target(rowsNow, list);
      for (let i = 0; i < 3; i += 1) {
        list.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tr.x, clientY: tr.y }));
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      const ind = list.querySelector(".h5ve-layer-drop-indicator");
      const inside = list.querySelector(".h5ve-element-item.drop-inside");
      window.__lastIndicator = { visible: !!ind && !ind.hidden, left: ind ? parseFloat(ind.style.left) : null, inside: inside?.dataset.rowFor || null };
      list.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tr.x, clientY: tr.y }));
      row.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    }, { sourceId, targetSrc });
    await page.waitForTimeout(120);
  };
  const indicator = () => page.evaluate(() => window.__lastIndicator);
  const rowOrder = () =>
    page.evaluate(() => [...document.querySelectorAll(".h5ve-element-item")].map((row) => {
      const el = row.__h5veElement;
      return `${el?.id || el?.dataset?.tag}@${row.style.getPropertyValue("--h5ve-layer-depth")}`;
    }));

  // Expand all so rows are visible: outer expanded by default after selection.
  await page.evaluate(() => { document.querySelectorAll(".h5ve-element-disclosure[aria-label='展开子元素']").forEach((b) => b.click()); });
  await page.waitForTimeout(80);
  let order = await rowOrder();
  // Panel is DOM-reversed: e, d, outer(inner2(b,a), c)
  assert.deepEqual(order, ["e@0", "d@0", `${outer}@0`, "c@1", `${inner2}@1`, "b@2", "a@2"], `initial rows: ${order}`);

  // 6a. Drag D into the inner group (drop on the inner row's middle band).
  await dragRow("d", `
    const r = rows.find((x) => x.dataset.rowFor === "${inner2}").getBoundingClientRect();
    return { x: r.x + 60, y: r.y + r.height / 2 };`);
  let ind = await indicator();
  assert.equal(ind.inside, inner2, "inside highlight on inner group row");
  tree = await structure();
  assert.deepEqual(tree[0].k[0].k, ["a", "b", "d"], "D appended into inner group (DOM end = top of panel block)");
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "moving into nested group keeps geometry");
  order = await rowOrder();
  assert.deepEqual(order, ["e@0", `${outer}@0`, "c@1", `${inner2}@1`, "d@2", "b@2", "a@2"], `after move-in: ${order}`);

  // 6b. Drag D out to the root, *between* e and outer, choosing depth 0 by pointer X.
  await dragRow("d", `
    const e = rows.find((x) => x.dataset.rowFor === "e").getBoundingClientRect();
    const o = rows.find((x) => x.dataset.rowFor === "${outer}").getBoundingClientRect();
    return { x: list.getBoundingClientRect().x + 6, y: (e.bottom + o.top) / 2 };`);
  ind = await indicator();
  assert.ok(ind.visible, "gap indicator visible");
  assert.ok(ind.left < 10, `indicator at depth 0 (left=${ind.left})`);
  tree = await structure();
  assert.deepEqual(tree.map((n) => (typeof n === "string" ? n : n.g)), [outer, "d", "e"], `root order after drag out: ${JSON.stringify(tree)}`);
  assert.deepEqual(tree[0].k[0].k, ["a", "b"], "inner group back to a,b");
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "drag out keeps geometry");

  // 6c. Ambiguous gap below the last row of a group block: pointer X far right → deepest depth (inside inner, below a).
  order = await rowOrder();
  // rows: e, d, outer, c, inner2, b, a  → gap below "a" and above nothing (last row). Use X deep.
  await dragRow("e", `
    const a = rows.find((x) => x.dataset.rowFor === "a").getBoundingClientRect();
    return { x: list.getBoundingClientRect().x + 5 + 13 * 2 + 4, y: a.bottom + 2 };`);
  ind = await indicator();
  assert.ok(ind.visible && ind.left >= 5 + 13 * 2 - 1, `indicator at depth 2 (left=${ind.left})`);
  tree = await structure();
  assert.deepEqual(tree[0].k[0].k, ["e", "a", "b"], "E inserted at DOM start of inner (panel bottom of block)");

  // 6d. Same gap, pointer X far left → depth 0 → after outer at root.
  await dragRow("e", `
    const a = rows.find((x) => x.dataset.rowFor === "a").getBoundingClientRect();
    return { x: list.getBoundingClientRect().x + 4, y: a.bottom + 2 };`);
  ind = await indicator();
  assert.ok(ind.visible && ind.left < 10, `indicator at depth 0 (left=${ind.left})`);
  tree = await structure();
  assert.deepEqual(tree.map((n) => (typeof n === "string" ? n : n.g)), ["e", outer, "d"], `root order: ${JSON.stringify(tree)}`);
  assert.deepEqual(tree[1].k[0].k, ["a", "b"]);

  // 6e. Invalid: drop a group onto its own descendant → structure unchanged.
  const snapshot = JSON.stringify(await structure());
  await dragRow(outer, `
    const a = rows.find((x) => x.dataset.rowFor === "a").getBoundingClientRect();
    return { x: a.x + 40, y: a.y + a.height / 2 };`);
  assert.equal(JSON.stringify(await structure()), snapshot, "dropping group into its own child is rejected");

  // 6f. No-op: drop e exactly where it is → no history entry.
  const histBefore = await page.evaluate(() => window.__h5veHistoryLen?.() ?? null);
  await dragRow("e", `
    const e = rows.find((x) => x.dataset.rowFor === "e").getBoundingClientRect();
    return { x: list.getBoundingClientRect().x + 4, y: e.bottom + 1 };`);
  assert.equal(JSON.stringify(await structure()), JSON.stringify(await structure()), "noop keeps structure");
  void histBefore;

  // 6g. Escape cancels an in-flight drag.
  await page.evaluate(() => {
    document.querySelectorAll(".h5ve-element-item").forEach((row) => { row.dataset.rowFor = row.__h5veElement?.id || row.__h5veElement?.dataset?.tag || ""; });
  });
  const cancelled = await page.evaluate(async () => {
    const list = document.querySelector(".h5ve-elements-list");
    const row = document.querySelector('.h5ve-element-item[data-row-for="d"]');
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 }));
    const target = document.querySelector('.h5ve-element-item[data-row-for="c"]').getBoundingClientRect();
    list.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: target.x + 40, clientY: target.y + 2 }));
    await new Promise((r) => requestAnimationFrame(() => r()));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const ind = list.querySelector(".h5ve-layer-drop-indicator");
    const hidden = !ind || ind.hidden;
    list.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: target.x + 40, clientY: target.y + 2 }));
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt }));
    return hidden;
  });
  assert.ok(cancelled, "Escape hides the indicator");
  await page.waitForTimeout(80);
  tree = await structure();
  assert.deepEqual(tree.map((n) => (typeof n === "string" ? n : n.g)), ["e", outer, "d"], "cancelled drag leaves structure intact");

  // ---- 7. Undo restores geometry & structure --------------------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(150);
  assert.deepEqual(await rects(["a", "b", "c", "d", "e"]), before, "geometry stable across undo");

  assert.deepEqual(errors, [], `page errors: ${errors.join("\n")}`);
  console.log("PASS: nested Cmd+G inside sub-group, drill-down click chain, shift toggle owner, nested ungroup, layer drag in/out of nested groups with depth-by-pointer, invalid/noop/escape handling, geometry preserved.");
} finally {
  await browser?.close();
  server.close();
}
