import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ppt-chapters-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const reserve = http.createServer(); await listen(reserve);
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
const html = `<!doctype html><body class="material-preview"><div class="sidebar"><div class="identity"></div><nav id="nav" data-chapter-groups='[{"title":"外层","children":[1,3]}]'><div class="chapter">第一章 · 描述</div><button class="slide-link current" data-page="1">一</button><button class="slide-link" data-page="2">二</button><div class="chapter">第二章</div><button class="slide-link" data-page="3">三</button></nav></div><div id="counter"></div><script>const slides=[{"page":1},{"page":2},{"page":3}];window.PPT_NARRATION_HOST={getSlides:()=>slides,getIndex:()=>0,goTo:()=>{}};window.PPTEDIT_PREVIEW_CONFIG={url:'http://127.0.0.1:${port}',token:'test'};</script><link rel="stylesheet" href="/nav.css"><script src="/nav.js"></script>`;
await fs.writeFile(path.join(root, 'index.html'), html);
await fs.writeFile(path.join(root, 'chapter-settings.json'), '{}');
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ root, port, token: 'test' }));
const adapter = spawn('python3', ['scripts/serve-svg-editor.py', '--config', path.join(root, 'config.json')]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', (req.url === '/nav.js' || req.url === '/navigation-tree.js') ? 'text/javascript' : req.url === '/nav.css' ? 'text/css' : req.url === '/chapter-settings.json' ? 'application/json' : 'text/html');
  res.setHeader('Content-Type', res.getHeader('Content-Type') + '; charset=utf-8');
  res.end(await fs.readFile(req.url === '/navigation-tree.js' ? 'assets/navigation-tree.js' : req.url === '/nav.js' ? 'assets/preview-navigation.js' : req.url === '/nav.css' ? 'assets/preview-navigation.css' : path.join(root, req.url === '/chapter-settings.json' ? 'chapter-settings.json' : 'index.html')));
});
await listen(server);
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Local adapter intentionally restricts CORS to known preview origins.
  await page.route(`http://127.0.0.1:${port}/**`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForTimeout(300);
  assert.deepEqual(errors, []);
  const chapter = key => page.locator(`[data-chapter-key="${key}"]`);
  const edit = key => chapter(key).locator(':scope > summary .nav-chapter-edit').click();
  await edit('page:1');
  await page.locator('input').fill('自定义章节');
  await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-chapter-key="page:1"] strong')?.textContent === '自定义章节');
  await edit('section:0'); await page.locator('input').fill('外层改名'); await page.locator('button[type=submit]').click();
  await page.waitForFunction(() => !document.querySelector('dialog').open);
  await edit('page:1'); await page.locator('[data-ungroup]').click();
  await page.waitForFunction(() => !document.querySelector('[data-chapter-key="page:1"]'));
  assert.equal(await chapter('section:0').locator(':scope > .slide-link').count(), 2);
  await edit('section:0'); await page.locator('[data-ungroup]').click();
  await page.waitForFunction(() => !document.querySelector('[data-chapter-key="section:0"]'));
  await page.reload(); await page.locator('.nav-chapter-edit').waitFor();
  assert.equal(await page.locator('#nav > .slide-link').count(), 2);
  assert.deepEqual(await page.locator('.slide-link').evaluateAll(rows => rows.map(r => r.dataset.page)), ['1', '2', '3']);
  await page.evaluate(() => window.dispatchEvent(new Event('pptedit-order-changed')));
  assert.equal(await chapter('section:0').count(), 0);
  assert.equal(await chapter('page:1').count(), 0);
  assert.equal(await page.locator('.slide-link').count(), 3);
  assert.deepEqual(errors, []);
  console.log('PASS: nested rename, leaf/parent ungroup, disk save, reload, rebuild, page order, no JS errors');
} finally { await browser?.close(); adapter.kill(); server.close(); await fs.rm(root, { recursive: true, force: true }); }
