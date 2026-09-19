import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { moveToTreePosition } from '../assets/navigation-tree.js';
const chapterTree=[{key:'a',title:'A',children:[{page:1},{page:2}]},{key:'b',title:'B',children:[{page:3.5}]}];
assert.deepEqual(moveToTreePosition(chapterTree,'a',null,1).order,[3.5,1,2]);
assert.equal(moveToTreePosition(chapterTree,'a','a',0),null,'chapter cannot become its own child');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = await fs.mkdtemp(path.join(os.tmpdir(),'pptedit-overview-'));
const staticServer = http.createServer(async (req,res)=>{
  try {
    const file = path.join(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/$/,'/index.html'));
    res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.json')?'application/json':'text/html');
    res.end(await fs.readFile(file));
  } catch {res.writeHead(404);res.end();}
});
await new Promise(r=>staticServer.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${staticServer.address().port}`;
const socket = http.createServer();
await new Promise(r=>socket.listen(0,'127.0.0.1',r));
const port = socket.address().port;
await new Promise(r=>socket.close(r));
const slides = [1,2,3.5,4,5,6,7,8,9].map(page=>({page,title:`Page ${page}`,file:`${page}.svg`}));
await fs.writeFile(path.join(root,'index.html'),`<!doctype html><html><body>
<style>#overview{position:fixed;inset:0;overflow:auto;background:white;padding:20px}#overview[hidden]{display:none}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.thumb{height:150px}.thumb img{width:80px}.sidebar{width:200px}</style>
<aside class="sidebar"><div class="identity"></div><nav id="nav"></nav></aside><span id="counter"></span>
<button id="show-overview">Overview</button><div id="overview" hidden><button id="close-overview">Close</button><div id="grid" class="grid"></div></div>
<script>const slides=${JSON.stringify(slides)};const chapters={};let index=0;
const overview=document.getElementById('overview');
window.PPTEDIT_PREVIEW_CONFIG={url:'http://127.0.0.1:${port}',token:'test'};
window.PPT_NARRATION_HOST={getSlides:()=>slides,getIndex:()=>index,goTo:i=>{index=i;document.getElementById('counter').textContent=i+1}};
for(const s of slides){for(const [id,cls] of [['nav','slide-link'],['grid','thumb']]){const b=document.createElement('button');b.className=cls;b.dataset.page=s.page;b.innerHTML='<span>'+s.page+'</span><img src="'+s.file+'"><p>'+s.title+'</p>';b.onclick=()=>{index=slides.indexOf(s);overview.hidden=true};document.getElementById(id).append(b)}}
document.getElementById('show-overview').onclick=()=>overview.hidden=false;
document.getElementById('close-overview').onclick=()=>overview.hidden=true;
</script></body></html>`);
for(const s of slides) await fs.writeFile(path.join(root,s.file),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080"><text id="page-number" x="10" y="60">${s.page}</text></svg>`);
await fs.writeFile(path.join(root,'chapter-settings.json'),JSON.stringify({__navigation:{tree:[{key:'a',title:'A',children:[{page:1},{page:2}]},{key:'b',title:'B',children:slides.slice(2).map(s=>({page:s.page}))}]}}));
await fs.writeFile(path.join(root,'config.json'),JSON.stringify({root,port,token:'test',allowedOrigins:[origin]}));
execFileSync(process.execPath,['scripts/install-preview-workspace.mjs',root]);
const installed = await fs.readFile(path.join(root,'index.html'),'utf8');
execFileSync(process.execPath,['scripts/install-preview-workspace.mjs',root]);
assert.equal(await fs.readFile(path.join(root,'index.html'),'utf8'),installed,'installation is idempotent');
async function audit(dir=''){
  for(const entry of await fs.readdir(path.join('assets',dir),{withFileTypes:true})){
    const name=path.join(dir,entry.name);
    if(entry.isDirectory())await audit(name);
    else assert.deepEqual(await fs.readFile(path.join(root,'assets',name)),await fs.readFile(path.join('assets',name)),name);
  }
}
await audit();
const server=spawn('python3',['scripts/serve-svg-editor.py','--config',path.join(root,'config.json')]);
let browser;
try{
  for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1000,height:700}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(origin);await page.waitForSelector('#grid[data-drag-enhanced]',{state:'attached'});await page.waitForTimeout(200);await page.click('#show-overview');};
  const order=()=>page.locator('#grid .thumb').evaluateAll(nodes=>nodes.map(n=>Number(n.dataset.page)));
  const drag=async(from,to,{cancel=false}={})=>{
    const a=await page.locator(`#grid [data-page="${from}"]`).boundingBox();
    const b=await page.locator(`#grid [data-page="${to}"]`).boundingBox();
    await page.mouse.move(a.x+a.width/2,a.y+50);await page.mouse.down();
    await page.mouse.move(b.x+b.width-10,b.y+60,{steps:20});await page.waitForTimeout(100);
    if(cancel)await page.keyboard.press('Escape');
    await page.mouse.up();
  };
  await open();await drag(1,3.5);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#grid .thumb').first().getAttribute('data-page'),'2',JSON.stringify({status:await page.locator('#overview [role="status"]').textContent(),errors}));
  assert.deepEqual((await order()).slice(0,3),[2,3.5,1]);
  assert.equal(await page.locator('#overview').isVisible(),true,'drag does not open page');
  assert.equal(await page.evaluate(()=>PPT_NARRATION_HOST.getSlides()[PPT_NARRATION_HOST.getIndex()].page),1,'active page retained');
  const saved=JSON.parse(await fs.readFile(path.join(root,'chapter-settings.json'),'utf8'));
  assert(saved.__navigation.tree.find(n=>n.key==='b').children.some(n=>n.page===1),'cross chapter move');
  await open();assert.deepEqual((await order()).slice(0,3),[2,3.5,1]);
  await drag(2,1,{cancel:true});assert.deepEqual((await order()).slice(0,3),[2,3.5,1]);
  assert.equal(await page.locator('#overview').isVisible(),true,'Esc cancels drag only');
  await page.evaluate(()=>PPTEDIT_PREVIEW_CONFIG.token='invalid');
  await drag(2,1);await page.waitForFunction(()=>document.querySelector('#overview [role="status"]').textContent.includes('排序失败'));
  assert.deepEqual((await order()).slice(0,3),[2,3.5,1]);
  await page.waitForTimeout(450);await page.click('#grid [data-page="3.5"]');
  assert.equal(await page.locator('#overview').isVisible(),false,'click still opens page');
  assert.deepEqual(errors,[]);
  console.log('PASS: complete installed assets, idempotence, real grid drag, fractional IDs, chapter sync, persistence after reload, Esc, save failure and click');
}finally{await browser?.close();server.kill();staticServer.close();await fs.rm(root,{recursive:true,force:true});}
