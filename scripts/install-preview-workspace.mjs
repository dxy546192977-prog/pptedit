import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const target = process.argv[2];
if (!target) throw Error('Usage: node scripts/install-preview-workspace.mjs <deck-directory>');
const htmlPath = path.join(target, 'index.html');
let html = await fs.readFile(htmlPath, 'utf8');
if (!html.includes('PPT_NARRATION_HOST') || !/<\/body>/i.test(html)) {
  throw Error('目标必须是已接入 PPT_NARRATION_HOST 的完整预览工作台；此脚本更新运行资源，不创建业务页面。');
}
// Include dynamic imports and editor dependencies; preserve project wiring/config.
const backup = path.join(target, '制作源', 'PPTedit资源备份', new Date().toISOString().replaceAll(':','-'));
async function backupChanged(relative = '') {
  for (const entry of await fs.readdir(path.join(source, relative), {withFileTypes:true})) {
    const name = path.join(relative,entry.name);
    if(entry.isDirectory()) { await backupChanged(name); continue; }
    try {
      const old = await fs.readFile(path.join(target,'assets',name));
      if(!old.equals(await fs.readFile(path.join(source,name)))) {
        const file = path.join(backup,'assets',name);
        await fs.mkdir(path.dirname(file),{recursive:true});
        await fs.writeFile(file,old);
      }
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
}
await backupChanged();
await fs.mkdir(backup,{recursive:true});
await fs.writeFile(path.join(backup,'index.html'),html);
if (path.resolve(target, 'assets') !== source) await fs.cp(source, path.join(target, 'assets'), { recursive:true });
const required = ['preview-workspace.css','preview-icons.css','preview-navigation.css',
  'preview-workspace.js','preview-navigation.js','preview-page-numbers.js'];
for (const name of required) {
  const escaped = name.replaceAll('.', '\\.');
  const present = new RegExp(`(?:src|href)=["']assets/${escaped}(?:\\?[^"']*)?["']`).test(html);
  if (!present) html = html.replace(/<\/body>/i, `${name.endsWith('.css') ? `<link rel="stylesheet" href="assets/${name}">` : `<script src="assets/${name}"></script>`}\n</body>`);
}
for (const match of [...html.matchAll(/(?:src|href)=["'](assets\/[^"'?]+)(?:\?[^"']*)?["']/g)]) {
  const relative = match[1];
  const file = path.resolve(target, relative);
  if (!file.startsWith(path.resolve(target, 'assets') + path.sep)) continue;
  try {
    const version = createHash('sha256').update(await fs.readFile(file)).digest('hex').slice(0,12);
    html = html.replace(match[0], match[0].replace(/assets\/[^"']+/, `${relative}?v=${version}`));
  } catch (error) { if(error.code !== 'ENOENT') throw error; }
}
await fs.writeFile(htmlPath, html);
console.log('Updated complete preview/editor assets. Restart the editor service from this checkout and reload the deck without cache.');
