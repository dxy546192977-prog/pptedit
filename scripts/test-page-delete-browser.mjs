import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pptedit-delete-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const slides = [1, 5.1, 8].map(page => ({ page, title: `Page ${page}`, file: 'page.svg', notes: ['Keep notes'] }));
await fs.writeFile(path.join(root, 'page.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><text x="100" y="200">Test page</text></svg>');
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ root, port, token: 'test' }));
const controller = await fs.readFile(new URL('../assets/preview-edit-mode.js', import.meta.url), 'utf8');
await fs.writeFile(path.join(root, 'index.html'), `<!doctype html><style>iframe{width:1400px;height:900px} [hidden]{display:none!important}</style><div class="app"><div class="bottom"></div><img id="slide"></div><script>const slides=${JSON.stringify(slides)};let index=0;window.PPT_NARRATION_HOST={getSlides:()=>slides,getIndex:()=>index,goTo:i=>{index=i}};window.PPTEDIT_PREVIEW_CONFIG={url:'http://127.0.0.1:${port}',token:'test'};</script><script>${controller}</script>`);
const server = spawn('python3', [fileURLToPath(new URL('./serve-svg-editor.py', import.meta.url)), '--config', path.join(root, 'config.json')]);
let browser;
try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('file://' + path.join(root, 'index.html'));
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const active = () => page.frameLocator('iframe:not([hidden])');
  try { await active().locator('.pptedit-page-delete').first().waitFor({ timeout: 12000 }); }
  catch (error) {
    console.log('Errors:', errors);
    for (const frame of page.frames()) console.log('Frame:', frame.url(), (await frame.locator('body').innerText()).slice(0, 2000));
    throw error;
  }
  await page.waitForFunction(() => document.querySelector('.pptedit-overlay strong').textContent.includes('PPTedit · 第 1 页'));
  await active().locator('[data-delete-page="5.1"]').click();
  await page.waitForFunction(() => window.PPT_NARRATION_HOST.getSlides().length === 2);
  assert.equal(await active().locator('.pptedit-page-delete').count(), 2);
  await active().locator('[data-delete-page="1"]').click();
  await page.waitForFunction(() => window.PPT_NARRATION_HOST.getSlides().length === 1);
  await active().locator('[data-delete-page="8"]').waitFor();
  assert.ok(await active().locator('[data-delete-page="8"]').isDisabled());
  await page.waitForFunction(() => document.querySelector('.pptedit-overlay strong').textContent.includes('PPTedit · 第 8 页'));
  assert.equal(await page.evaluate(() => window.PPT_NARRATION_HOST.getSlides()[window.PPT_NARRATION_HOST.getIndex()].page), 8);
  await page.screenshot({ path: path.join(root, 'deleted-pages.png') });
  await page.reload();
  assert.deepEqual(await page.evaluate(() => window.PPT_NARRATION_HOST.getSlides().map(s => s.page)), [8]);
  assert.deepEqual(errors, []);
  console.log('PASS: browser deletes other/current pages, opens next page, protects last page, persists after reload without JS errors');
  console.log('Screenshot: ' + path.join(root, 'deleted-pages.png'));
} finally {
  await browser?.close();
  server.kill();
}
