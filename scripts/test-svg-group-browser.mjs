import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pptedit-svg-group-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
await fs.writeFile(path.join(root, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 600"><g transform="translate(60 40) scale(.9)"><rect id="a" x="100" y="100" width="180" height="120" fill="orange"/><rect id="b" x="360" y="150" width="160" height="100" fill="cyan" transform="rotate(8 440 200)"/></g></svg>');
await fs.writeFile(path.join(root, 'target.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1200"></svg>');
await fs.writeFile(path.join(root, 'index.html'), 'const slides=[{"page":1,"title":"Group test","file":"page.svg"},{"page":2,"title":"Paste target","file":"target.svg"}]');
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ root, port, token: 'test' }));
const server = spawn('python3', [fileURLToPath(new URL('./serve-svg-editor.py', import.meta.url)), '--config', path.join(root, 'config.json')]);
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/editor.html?page=1#token=test`);
  await page.locator('html.pptedit-ready').waitFor({ state: 'attached' });
  await page.waitForTimeout(400);
  const boxes = () => page.evaluate(() => ['a', 'b'].map(id => {
    const el = document.getElementById(id), r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  const same = async expected => {
    const actual = await boxes();
    actual.forEach((r, i) => Object.keys(r).forEach(key => assert.ok(Math.abs(r[key] - expected[i][key]) < .1, `${i}.${key}: ${r[key]} != ${expected[i][key]}`)));
    assert.ok(actual.every(r => r.width > 50 && r.height > 30));
  };
  const before = await boxes();
  await page.locator('#a').click();
  await page.locator('#b').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Meta+g');
  await page.locator('g[data-h5ve-group="1"]').waitFor();
  assert.equal(await page.locator('svg div').count(), 0);
  await same(before);
  await page.screenshot({ path: path.join(root, 'grouped.png') });
  await page.keyboard.press('Meta+z');
  await page.waitForFunction(() => !document.querySelector('g[data-h5ve-group="1"]'));
  await same(before);
  await page.keyboard.press('Meta+Shift+z');
  await page.locator('g[data-h5ve-group="1"]').waitFor();
  await same(before);
  await page.locator('#a').click();
  await page.keyboard.press('Meta+Shift+g');
  await page.waitForFunction(() => !document.querySelector('g[data-h5ve-group="1"]'));
  await same(before);
  await page.locator('#b').click({ modifiers: ['Shift'] });
  await page.keyboard.press('Meta+g');
  await page.locator('g[data-h5ve-group="1"]').waitFor();
  await page.keyboard.press('Meta+s');
  await page.waitForFunction(async () => {
    const r = await fetch('/state?page=1', { headers: { 'X-PPTedit-Token': 'test' } });
    const { svg } = await r.json();
    return new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('#a')?.parentElement?.children.length === 2 && svg.includes('transform-box');
  });
  await page.reload();
  await page.locator('html.pptedit-ready').waitFor({ state: 'attached' });
  await page.waitForTimeout(400);
  await same(before);
  const designBoxes = p => p.evaluate(() => {
    const slide = document.querySelector('.slide'), sr = slide.getBoundingClientRect();
    return ['a', 'b'].map(id => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [(r.x - sr.x) * slide.offsetWidth / sr.width, (r.y - sr.y) * slide.offsetHeight / sr.height, r.width * slide.offsetWidth / sr.width, r.height * slide.offsetHeight / sr.height];
    });
  });
  const copy = p => p.evaluate(() => {
    const data = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData('text/html');
  });
  const paste = (p, html) => p.evaluate(html => {
    const data = new DataTransfer();
    data.setData('text/html', html);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, html);
  await page.locator('#a').click();
  await page.locator('#b').click({ modifiers: ['Shift'] });
  const original = await designBoxes(page);
  const html = await copy(page);
  assert.ok(html.includes('data-h5ve-clipboard-item'));
  const destination = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  destination.on('pageerror', error => errors.push(error.message));
  await destination.goto(`http://127.0.0.1:${port}/editor.html?page=2#token=test`);
  await destination.locator('html.pptedit-ready').waitFor({ state: 'attached' });
  await destination.waitForTimeout(400);
  await paste(destination, html);
  assert.equal(await destination.locator('#a, #b').count(), 2, JSON.stringify({ clipboard: html, target: await destination.locator('.slide').innerHTML(), errors }));
  const assertPasted = async () => {
    const result = await designBoxes(destination);
    result.forEach((r, i) => r.forEach((n, j) => assert.ok(Math.abs(n - original[i][j]) < .1, `paste ${i}.${j}: ${n} != ${original[i][j]}`)));
    assert.equal(await destination.locator('.slide > svg').count(), 1);
    assert.equal(await destination.locator('.slide > :not(svg)').count(), 0);
  };
  await assertPasted();
  await destination.keyboard.press('Meta+z');
  assert.equal(await destination.locator('#a').count(), 0);
  await destination.keyboard.press('Meta+Shift+z');
  await assertPasted();
  await destination.keyboard.press('Meta+s');
  await destination.waitForFunction(async () => (await (await fetch('/state?page=2', { headers: { 'X-PPTedit-Token': 'test' } })).json()).svg.includes('id="a"'));
  await destination.reload();
  await destination.locator('html.pptedit-ready').waitFor({ state: 'attached' });
  await destination.waitForTimeout(400);
  await assertPasted();
  // HTML elements in a nested grid also retain canvas coordinates when their
  // parent is absent from the destination document.
  const htmlCanvas = async (width, content, viewport) => {
    const p = await browser.newPage({ viewport });
    p.on('pageerror', error => errors.push(error.message));
    await p.route('**/html-fixture*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:0}#stage{width:${width}px;height:600px;position:relative}#deck,.slide{width:100%;height:100%;position:relative}</style><main id="stage" data-h5ve-width="${width}" data-h5ve-height="600"><div id="deck"><section class="slide">${content}</section></div></main><script>window.PPTEDIT_DOCUMENT_HOST={ready:()=>{window.ready=true},save:async()=>({revision:'test'})}</script><script src="/h5-editor/editor.js"></script>` }));
    await p.goto(`http://127.0.0.1:${port}/html-fixture?edit=1`);
    await p.waitForFunction(() => window.ready);
    await p.waitForTimeout(400);
    return p;
  };
  const htmlSource = await htmlCanvas(1000, '<div style="position:absolute;left:120px;top:80px;display:grid;grid-template-columns:180px 160px;gap:35px;transform:translate(25px,30px)"><div id="a" style="height:100px;background:orange">First</div><div id="b" style="height:100px;background:cyan">Second</div></div>', { width: 1500, height: 1000 });
  await htmlSource.locator('#a').click();
  await htmlSource.locator('#b').click({ modifiers: ['Shift'] });
  const htmlBefore = await designBoxes(htmlSource);
  const htmlDestination = await htmlCanvas(1400, '', { width: 1300, height: 900 });
  await paste(htmlDestination, await copy(htmlSource));
  const htmlAfter = await designBoxes(htmlDestination);
  htmlAfter.forEach((r, i) => r.forEach((n, j) => assert.ok(Math.abs(n - htmlBefore[i][j]) < .1, `HTML paste ${i}.${j}`)));
  assert.deepEqual(errors, []);
  console.log('PASS: SVG group and cross-window paste preserve canvas coordinates through undo, redo, save and reload, including different canvas sizes and zoom. Screenshot: ' + path.join(root, 'grouped.png'));
} finally {
  await browser?.close();
  server.kill();
}
