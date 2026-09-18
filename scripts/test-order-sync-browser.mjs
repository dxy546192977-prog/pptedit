import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pptedit-order-sync-'));
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const reserve=http.createServer();await listen(reserve);const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const slides=Array.from({length:6},(_,i)=>({page:i+1,title:`Page ${i+1}`,file:`${i+1}.svg`}));
for(const slide of slides)await fs.writeFile(path.join(root,slide.file),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#183c30"/><text id="page-number" x="1700" y="100" fill="white">${slide.page}</text></svg>`);
await fs.writeFile(path.join(root,'index.html'),`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/assets/preview-navigation.css"><link rel="stylesheet" href="/assets/preview-edit-mode.css"><style>body{margin:0}.app{display:flex}.sidebar{width:300px}#nav{height:700px;overflow:auto}#slide{width:700px}.bottom{position:fixed;bottom:0}button{cursor:pointer}</style><body class="material-preview"><div class="app"><div class="sidebar"><div class="identity"></div><nav id="nav" data-chapter-groups='[{"title":"Outer","children":[1,3]},5]'></nav></div><div><img id="slide"><div id="counter"></div></div><div class="bottom"></div></div><script>const slides=${JSON.stringify(slides)};const chapters={"1":"One","3":"Two","5":"Three"};let index=0;const nav=document.getElementById('nav');for(const s of slides){if(chapters[s.page]){const h=document.createElement('div');h.className='chapter';h.textContent=chapters[s.page];nav.append(h);}const b=document.createElement('button');b.className='slide-link';b.dataset.page=s.page;b.textContent=s.title;nav.append(b);}function show(i){index=i;document.querySelectorAll('.slide-link').forEach(n=>n.classList.toggle('current',Number(n.dataset.page)===slides[i].page));document.getElementById('slide').src=slides[i].file;document.getElementById('counter').textContent=String(i+1);}window.PPT_NARRATION_HOST={getSlides:()=>slides,getIndex:()=>index,goTo:show};window.PPTEDIT_PREVIEW_CONFIG={url:'http://127.0.0.1:${port}',token:'test'};show(0);</script><script src="/assets/preview-navigation.js"></script><script src="/assets/preview-edit-mode.js"></script>`);
await fs.writeFile(path.join(root,'chapter-settings.json'),'{}');await fs.writeFile(path.join(root,'config.json'),JSON.stringify({root,port,token:'test'}));
const adapter=spawn('python3',['scripts/serve-svg-editor.py','--config',path.join(root,'config.json')]);
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://local').pathname;const file=url.startsWith('/assets/')?path.join(process.cwd(),url):path.join(root,url==='/'?'index.html':url);const ext=path.extname(file);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'}[ext]||'text/html')+';charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end();}});await listen(server);
let browser;
try{
for(let i=0;i<50;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1500,height:1900}});let thumbnailRequests=0;page.on('request',r=>{if(/\/deck\/\d+\.svg$/.test(r.url()))thumbnailRequests++;});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route(`http://127.0.0.1:${port}/**`,async route=>{const response=await route.fetch();await route.fulfill({response,headers:{...response.headers(),'access-control-allow-origin':'*'}});});
const url=`http://127.0.0.1:${server.address().port}`;
const enter=async()=>{await page.locator('.preview-mode-switch button').filter({hasText:'编辑'}).click();await page.locator('.pptedit-overlay iframe:not([hidden])').waitFor();const f=page.frameLocator('.pptedit-overlay iframe:not([hidden])');await f.locator('html.pptedit-ready').waitFor({state:'attached'});await f.locator('.pptedit-page-link').first().waitFor();await page.waitForFunction(()=>{const f=document.querySelector('.pptedit-overlay iframe:not([hidden])');return f&&!f.inert&&getComputedStyle(f).opacity==='1';});await page.waitForTimeout(100);return f;};
await page.goto(url);let frame=await enter();let expected=slides.map(s=>s.page);
const assertAll=async()=>{await page.waitForTimeout(300);assert.deepEqual(await page.evaluate(()=>window.PPT_NARRATION_HOST.getSlides().map(s=>s.page)),expected,'host order');assert.deepEqual(await page.locator('#nav .slide-link').evaluateAll(rows=>rows.map(r=>Number(r.dataset.page))),expected,'preview DOM order');assert.deepEqual(await frame.locator('.pptedit-page-link').evaluateAll(rows=>rows.map(r=>Number(r.dataset.page))),expected,'editor DOM order');const html=await fs.readFile(path.join(root,'index.html'),'utf8');assert.deepEqual(JSON.parse(html.split('const slides=')[1].split(';const chapters=')[0]).map(s=>s.page),expected,'saved order');};
// Adjacent swap across the old chapter anchor must retain the same chapter.
for (const [moving, target] of [[4,3],[3,4]]) {
 await frame.locator('details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
 const from=await frame.locator(`[data-page="${moving}"]`).boundingBox(),to=await frame.locator(`[data-page-item="${target}"]`).boundingBox();
 const saved=page.waitForResponse(r=>r.url().endsWith('/reorder')&&r.request().method()==='POST');
 await page.mouse.move(from.x+70,from.y+40);await page.mouse.down();await page.mouse.move(to.x+70,to.y+6,{steps:20});
 await frame.locator('.pptedit-page-drop-line:not([hidden])').waitFor();
 assert.equal(await frame.locator('.pptedit-page-drop-line:not([hidden])').count(),1);
 assert.equal(await frame.locator('[data-drop]').count(),1);
 assert.equal(await frame.locator('[data-drop]').evaluate(n=>getComputedStyle(n,'::after').content),'none');
 await page.mouse.up();assert.equal((await saved).status(),200);
 expected=expected.filter(p=>p!==moving);expected.splice(expected.indexOf(target),0,moving);await assertAll();
 assert.deepEqual(await frame.locator('[data-chapter-key="page:3"] .pptedit-page-link').evaluateAll(rows=>rows.map(r=>Number(r.dataset.page))), expected.filter(p=>p===3||p===4));
 await page.reload();frame=await enter();await assertAll();
 assert.deepEqual(await frame.locator('[data-chapter-key="page:3"] .pptedit-page-link').evaluateAll(rows=>rows.map(r=>Number(r.dataset.page))), expected.filter(p=>p===3||p===4));
}
const initialThumbnailRequests=thumbnailRequests;
for(const [moving,target,after] of [[3,1,false],[2,5,true],[5,1,false],[1,6,true],[6,3,false]]){
await frame.locator('details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));await page.waitForTimeout(80);
const from=await frame.locator(`[data-page="${moving}"]`).boundingBox();const to=await frame.locator(`[data-page-item="${target}"]`).boundingBox();
const response=page.waitForResponse(r=>r.url().endsWith('/reorder')&&r.request().method()==='POST');
await page.mouse.move(from.x+70,from.y+40);await page.mouse.down();await page.mouse.move(to.x+70,after?to.y+to.height-6:to.y+6,{steps:20});await page.mouse.up();assert.equal((await response).status(),200);
expected=expected.filter(p=>p!==moving);expected.splice(expected.indexOf(target)+Number(after),0,moving);await assertAll();
}
// Ungroup the persisted chapter, then continue moving pages.
await page.evaluate(()=>window.PPT_NARRATION_HOST.editChapter('page:3'));await page.locator('dialog [data-ungroup]').click();await page.waitForFunction(()=>!document.querySelector('dialog').open);await assertAll();
await frame.locator('details').evaluateAll(nodes=>nodes.forEach(n=>n.open=true));
const first=expected[0];const response=page.waitForResponse(r=>r.url().endsWith('/reorder')&&r.request().method()==='POST');const from=await frame.locator(`[data-page="${first}"]`).boundingBox();const to=await frame.locator(`[data-page-item="${expected[1]}"]`).boundingBox();await page.mouse.move(from.x+70,from.y+40);await page.mouse.down();await page.mouse.move(to.x+70,to.y+to.height-4,{steps:20});await page.mouse.up();assert.equal((await response).status(),200);[expected[0],expected[1]]=[expected[1],expected[0]];await assertAll();
assert.equal(thumbnailRequests,initialThumbnailRequests,'Reorders must reuse SVG thumbnail downloads');await page.reload();frame=await enter();await assertAll();assert.deepEqual(errors,[]);console.log('PASS: chapter-boundary adjacent swap and reload, single insertion line, 5 consecutive cross-chapter mouse drags, chapter-anchor movement, ungroup then reorder, host/preview/editor/disk parity, reload.');
}finally{await browser?.close();adapter.kill();server.close();await fs.rm(root,{recursive:true,force:true});}
