import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const target = process.argv[2];
if (!target) throw Error('Usage: node scripts/install-preview-workspace.mjs <deck-directory>');
const icons = {
  arrow_back: '#prev', arrow_forward: '#next', grid_view: '#show-overview', fullscreen: '#fullscreen',
  speaker_notes: '#show-notes', content_copy: '#copy-svg', dashboard_customize: '#layout-reference-open',
  edit_note: '#edit-notes', play_arrow: '#narration-play', pause: '#narration-play[aria-label^="暂停"]',
  tune: '[data-settings], .action-menu>button:last-of-type', replay: '[data-restart]',
  more_horiz: '.action-overflow>button', close: '#close-overview, .layout-reference-dialog header>button',
  visibility: '.preview-mode-switch>button:first-child', edit: '.preview-mode-switch>button:last-child',
  save: '.pptedit-overlay>header>button', chevron_right: '.nav-chapter>summary'
};
const dir = path.join(source, 'material-symbols');
await fs.mkdir(dir, { recursive: true });
await Promise.all(Object.keys(icons).map(async name => {
  const file = path.join(dir, name + '.svg');
  try { await fs.access(file); return; } catch {}
  const response = await fetch(`https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/${name}/materialsymbolsoutlined/${name}_24px.svg`);
  if (!response.ok) throw Error(`Icon ${name}: ${response.status}`);
  await fs.writeFile(file, await response.text());
}));
const license = await fetch('https://raw.githubusercontent.com/google/material-design-icons/master/LICENSE');
if (!license.ok) throw Error('Could not retrieve icon license');
await fs.writeFile(path.join(dir, 'LICENSE'), await license.text());
await fs.writeFile(path.join(dir, 'README.md'), 'Google Material Symbols Outlined — Apache-2.0.\nSource: https://github.com/google/material-design-icons/tree/master/symbols\nOriginal SVGs, rendered as currentColor masks.\n');
const selectors = Object.values(icons).join(', ');
let css = `/* Google Material Symbols, Apache-2.0; see material-symbols/LICENSE. */\n:is(${selectors}) { --tool-icon: none; }\n:is(${selectors})::before { content: ''; display: inline-block; width: 20px; height: 20px; flex: 0 0 20px; vertical-align: middle; background: currentColor; mask: var(--tool-icon) center / contain no-repeat; border: 0 !important; }\n:is(${selectors}):not(summary) { display: inline-flex; align-items: center; gap: 8px; }\n:is(${selectors})>svg { display: none !important; }\n.action-overflow>button>span { display: none; }\n`;
for (const [name, selector] of Object.entries(icons)) css += `${selector} { --tool-icon: url('material-symbols/${name}.svg'); }\n`;
css += '.nav-chapter>summary::before { transform: none; }\n.nav-chapter[open]>summary::before { transform: rotate(90deg); }\n';
// Keep layout rules low-specificity so existing hidden/rail controls stay hidden.
css = css.replace(':is(' + selectors + ') { --tool-icon: none; }', ':where(' + selectors + ') { --tool-icon: none; }')
  .replace(':is(' + selectors + '):not(summary)', ':where(' + selectors + '):not(summary)');
await fs.writeFile(path.join(source, 'preview-icons.css'), css);
await fs.mkdir(path.join(target, 'assets'), { recursive: true });
for (const name of ['preview-workspace.js', 'preview-workspace.css', 'preview-icons.css', 'preview-page-numbers.js']) await fs.copyFile(path.join(source, name), path.join(target, 'assets', name));
await fs.cp(dir, path.join(target, 'assets/material-symbols'), { recursive: true });
const htmlPath = path.join(target, 'index.html');
let html = await fs.readFile(htmlPath, 'utf8');
html = html.replace(/<!-- preview-workspace:start -->[\s\S]*?<!-- preview-workspace:end -->\s*/g, '');
html = html.replace('</body>', '<!-- preview-workspace:start -->\n<link rel="stylesheet" href="assets/preview-workspace.css?v=1">\n<link rel="stylesheet" href="assets/preview-icons.css?v=1">\n<script src="assets/preview-workspace.js?v=1"></script>\n<!-- preview-workspace:end -->\n</body>');
await fs.writeFile(htmlPath, html);
// Install after the host and navigation controllers, independently of workspace styling.
html = html.replace(/<script src="assets\/preview-page-numbers\.js[^\"]*"><\/script>\s*/g, '');
html = html.replace('</body>', '<script src="assets/preview-page-numbers.js?v=1"></script>\n</body>');
await fs.writeFile(htmlPath, html);
console.log('Installed resizable notes and local Google Material Symbols.');
