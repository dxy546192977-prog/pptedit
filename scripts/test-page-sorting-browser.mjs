import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pptedit-sort-'));
const socket = createServer();
await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise(r => socket.close(r));
const slides = Array.from({length: 18}, (_, i) => ({page: i + 1, title: `Page ${i + 1} with a long title to verify wrapping`, file: `${i+1}.svg`}));
for (const slide of slides) await fs.writeFile(path.join(root, slide.file), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#163b30"/><text id="page-number" x="1600" y="100" fill="white">${slide.page}</text></svg>`);
await fs.writeFile(path.join(root, 'index.html'), `const slides=${JSON.stringify(slides)};const chapters={};`);
await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({root, port, token:'test'}));
const server = spawn('python3', ['scripts/serve-svg-editor.py', '--config', path.join(root, 'config.json')]);
let browser;
try {
  for (let i=0;i<50;i++) {try {if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;}catch{} await new Promise(r=>setTimeout(r,100));}
  browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1500,height:850}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/editor.html?page=1#token=test`);
  await page.locator('html.pptedit-ready').waitFor({state:'attached'});
  const row = id => page.locator(`[data-page-item="${id}"]`);
  const order = () => page.locator('.pptedit-page-link').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.page)));
  const checkBounds = () => page.evaluate(() => {
    const list=document.querySelector('.h5ve-slides-list');
    const rows=[...list.querySelectorAll('.pptedit-page-item')];
    return {display:getComputedStyle(list).display, overflow:list.scrollHeight>list.clientHeight, contained:rows.every(row=>{
      const r=row.getBoundingClientRect();
      return [...row.querySelectorAll('img,span,.pptedit-page-actions')].every(child=>{const c=child.getBoundingClientRect();return c.bottom<=r.bottom+1&&c.left>=r.left-1&&c.right<=r.right+1;});
    }),ordered:rows.every((r,i)=>!i||r.getBoundingClientRect().top>=rows[i-1].getBoundingClientRect().bottom)};
  });
  assert.deepEqual(await checkBounds(),{display:'block',overflow:true,contained:true,ordered:true});
  const first = await row(1).locator('.pptedit-page-link').boundingBox();
  const second = await row(2).boundingBox();
  await page.mouse.move(first.x+60,first.y+40); await page.mouse.down();
  await page.mouse.move(second.x+60,second.y+second.height-4,{steps:18}); await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.pptedit-page-link').dataset.page==='2');
  assert.deepEqual((await order()).slice(0,3),[2,1,3]);
  // Real mouse drag onto the action/gap area, outside the thumbnail.
  await row(1).scrollIntoViewIfNeeded();
  const from=await row(2).locator('.pptedit-page-link').boundingBox();
  const to=await row(1).locator('.pptedit-page-actions').boundingBox();
  await page.mouse.move(from.x+60,from.y+40);await page.mouse.down();
  await page.mouse.move(to.x+10,to.y+to.height-2,{steps:18});
  await page.waitForFunction(()=>!!document.querySelector('[data-drop]'));
  // The drop indicator must be mounted inside the scrolling list (not body, where the
  // equal-z-index fixed sidebar occludes it), visible, and painted at the marker edge.
  const line=await page.evaluate(()=>{
    const l=document.querySelector('.pptedit-page-drop-line');if(!l)return null;
    const m=document.querySelector('[data-drop]');const lr=l.getBoundingClientRect(),mr=m.getBoundingClientRect();
    const list=document.querySelector('.h5ve-slides-list').getBoundingClientRect();
    const cs=getComputedStyle(l);
    return{parentIsList:l.parentElement.classList.contains('h5ve-slides-list'),hidden:l.hidden,display:cs.display,position:cs.position,
      width:Math.round(lr.width),insideList:lr.top>=list.top&&lr.bottom<=list.bottom,
      gap:Math.round(m.dataset.drop==='after'?lr.top-mr.bottom:mr.top-lr.bottom)};
  });
  assert.ok(line,'drop line exists during drag');
  assert.equal(line.parentIsList,true);assert.equal(line.hidden,false);assert.equal(line.display,'block');assert.equal(line.position,'absolute');
  assert.ok(line.width>100&&line.insideList,`line painted inside list: ${JSON.stringify(line)}`);
  assert.ok(line.gap>=0&&line.gap<=4,`line hugs marker edge (gap=${line.gap})`);
  await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('.pptedit-page-link').dataset.page==='1');
  assert.deepEqual((await order()).slice(0,3),[1,2,3]);
  // Edge scrolling must continue even while the pointer is held still.
  await row(1).scrollIntoViewIfNeeded();
  const start=await row(1).boundingBox(), list=await page.locator('.h5ve-slides-list').boundingBox();
  await page.mouse.move(start.x+70,start.y+35);await page.mouse.down();
  await page.mouse.move(list.x+90,list.y+list.height-8,{steps:20});
  const before=await page.locator('.h5ve-slides-list').evaluate(n=>n.scrollTop);
  await page.waitForTimeout(500);
  assert.ok(await page.locator('.h5ve-slides-list').evaluate(n=>n.scrollTop)>before+30);
  await page.keyboard.press('Escape');await page.mouse.up();
  assert.equal(await page.locator('[data-drop],.is-dragging,.pptedit-page-drag-preview,.pptedit-page-drop-line,.is-page-sorting').count(),0);
  assert.deepEqual(await order(),slides.map(s=>s.page));
  await page.reload();await page.locator('html.pptedit-ready').waitFor({state:'attached'});
  assert.deepEqual(await checkBounds(),{display:'block',overflow:true,contained:true,ordered:true});
  // Exercise the editor's real navigation-update path for nested ungrouping.
  const ownOrigin = `http://127.0.0.1:${port}`;
  await page.goto(`${ownOrigin}/editor.html?page=1#token=test&parent=${encodeURIComponent(ownOrigin)}`);
  await page.reload();
  await page.locator('html.pptedit-ready').waitFor({state:'attached'});
  const sendTree = tree => page.evaluate(tree => window.postMessage({type:'pptedit-navigation',navigation:{tree,view:'thumbnails'}},location.origin),tree);
  const leaves=slides.map(s=>({page:s.page}));
  await sendTree([{key:'outer',title:'Outer',open:true,children:[{key:'inner',title:'Inner',open:true,children:leaves.slice(0,3)},...leaves.slice(3)]}]);
  await page.waitForTimeout(300);
  await page.locator('[data-chapter-key="inner"]').waitFor({state:'attached',timeout:3000});
  await sendTree([{key:'outer',title:'Outer',open:true,children:leaves}]);
  await page.waitForFunction(()=>!document.querySelector('[data-chapter-key="inner"]'));
  assert.deepEqual(await checkBounds(),{display:'block',overflow:true,contained:true,ordered:true});
  await page.locator('.h5ve-slides-list').evaluate(n=>n.scrollTop=600);
  await sendTree(leaves);
  await page.waitForFunction(()=>!document.querySelector('[data-chapter-key="outer"]'));
  await page.waitForTimeout(100);
  assert.ok(await page.locator('.h5ve-slides-list').evaluate(n=>n.scrollTop)>=590,'Ungroup must retain scroll position');
  assert.deepEqual(await checkBounds(),{display:'block',overflow:true,contained:true,ordered:true});
  assert.deepEqual(await order(),slides.map(s=>s.page));
  assert.deepEqual(errors,[]);
  console.log('PASS: ungrouped page containment, drop-line painted inside list, mouse reorder, mouse drag onto gap/actions, continuous edge scroll, escape cleanup, persisted order and reload.');
} finally {await browser?.close();server.kill();await fs.rm(root,{recursive:true,force:true});}
