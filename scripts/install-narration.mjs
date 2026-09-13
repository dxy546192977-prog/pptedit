import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/install-narration.mjs <absolute-index.html>');
const htmlPath = path.resolve(target);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/narration');
const destination = path.join(path.dirname(htmlPath), 'narration');
let html = await readFile(htmlPath, 'utf8');
for (const token of ['const slides', 'function show(i)', 'id="current-title"', 'id="notes-content"', 'id="prev"']) {
  if (!html.includes(token)) throw new Error('Deck adapter missing: ' + token);
}
if (!html.includes('id="narration-play"')) {
  html = html.replace('<button id="prev"', '<button id="narration-play" type="button" disabled>▶ 播放讲稿</button><button id="prev"');
}
html = html.replace('<footer class="bottom">', '<footer class="bottom has-narration">');
await mkdir(destination, { recursive: true });
for (const name of ['player.js', 'player.css']) await copyFile(path.join(source, name), path.join(destination, name));
const version = async name => createHash('sha256').update(await readFile(path.join(destination, name)).catch(() => '')).digest('hex').slice(0,12);
const marker = '<!-- ppt-narration:start -->';
const integration = `${marker}
<link rel="stylesheet" href="narration/player.css?v=${await version('player.css')}">
<script src="narration/manifest.js?v=${await version('manifest.js')}"></script>
<script>window.PPT_NARRATION_HOST={getSlides:()=>slides,getIndex:()=>index,goTo:i=>show(i),liveUpdates:true};</script>
<script src="narration/player.js?v=${await version('player.js')}"></script>
<!-- ppt-narration:end -->`;
if (html.includes(marker)) html = html.replace(/<!-- ppt-narration:start -->[\s\S]*?<!-- ppt-narration:end -->/, integration);
else html = html.replace('</body>', integration + '\n</body>');
html = html.replace('id="notes-content"', 'id="notes-content" tabindex="0" role="region" aria-label="讲稿正文"');
// Re-running the installer must not duplicate attributes.
html = html.replace(/( tabindex="0" role="region" aria-label="讲稿正文"){2,}/g, '$1');
html = html.replace("if(index!==previousIndex)byId('notes').scrollTop=0;", "if(index!==previousIndex){byId('notes').scrollTop=0;byId('notes-content').scrollTop=0;}");
await writeFile(htmlPath, html, 'utf8');
console.log('Narration installed:', htmlPath);
