import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');
const target = process.argv[2];
if (!target) throw Error('Usage: node scripts/build-editor-material.mjs <deck-directory>');
const rules = [];
const add = (name, selector, only = false) => rules.push({ name, selector, only });
for (const [action, name] of Object.entries({ versions:'history', help:'help', exit:'visibility', insert:'add', commands:'search', screenshot:'photo_camera', export:'content_copy', pick:'arrow_selector_tool', 'pan-left':'arrow_back', 'pan-right':'arrow_forward', 'zoom-out':'remove', 'zoom-in':'add', 'zoom-fit':'fit_screen', 'close-help':'close', 'close-versions':'close', 'clear-layer-search':'close', 'duplicate-slide':'content_copy', undo:'undo', redo:'redo' })) {
  add(name, `[data-action="${action}"]`, ['pan-left','pan-right','zoom-out','zoom-in','close-help','close-versions','clear-layer-search'].includes(action));
}
for (const [kind, name] of Object.entries({ text:'title', rectangle:'rectangle', ellipse:'circle', line:'horizontal_rule', frame:'filter_center_focus' })) add(name, `[data-insert-kind="${kind}"]>span:first-child`, true);
for (const [action, name] of Object.entries({ rename:'edit', back:'vertical_align_bottom', backward:'arrow_downward', forward:'arrow_upward', front:'vertical_align_top' })) add(name, `[data-layer-action="${action}"]`);
for (const [align, name] of Object.entries({ left:'align_horizontal_left', right:'align_horizontal_right', 'h-center':'align_horizontal_center', top:'align_vertical_top', bottom:'align_vertical_bottom', 'v-center':'align_vertical_center', 'distribute-h':'horizontal_distribute', 'distribute-v':'vertical_distribute' })) add(name, `[data-align="${align}"]`, true);
for (const align of ['left','center','right']) add('format_align_' + align, `[data-text-align="${align}"]`, true);
for (const align of ['left','center','right']) add('format_align_' + align, `[data-multi-text-align="${align}"]`, true);
for (const [kind, name] of Object.entries({ bold:'format_bold', italic:'format_italic', underline:'format_underlined' })) {
  add(name, `[data-text-style="${kind}"]`, true);
  add(name, `[data-multi-text-style="${kind}"]`, true);
}
add('visibility', '.h5ve-visibility-toggle');
add('visibility_off', '.h5ve-visibility-toggle[aria-pressed="false"]');
for (const [field, name] of Object.entries({ paddingX:'horizontal_distribute', paddingY:'vertical_distribute', marginX:'horizontal_distribute', marginY:'vertical_distribute' })) add(name, `[data-scrub-field="${field}"]`);
for (const [flow, name] of Object.entries({ free:'dashboard', horizontal:'view_column', vertical:'view_agenda', grid:'grid_view' })) add(name, `[data-flow="${flow}"]`);
add('visibility', '.h5ve-element-visibility');
add('visibility_off', '.h5ve-element-visibility.is-active');
add('lock_open', '.h5ve-element-lock');
add('lock', '.h5ve-element-lock.is-active');
add('delete', '.h5ve-element-delete', true);
add('chevron_right', '.h5ve-element-disclosure[aria-label="展开子元素"]', true);
add('expand_more', '.h5ve-element-disclosure[aria-label="收起子元素"]', true);
add('search', '.h5ve-elements-search');
add('rounded_corner', '#h5ve-f-corner-mode');
add('rotate_right', '.h5ve-rotate-handle');
add('lock', '.h5ve-aspect-lock[aria-pressed="true"]');
add('lock_open', '.h5ve-aspect-lock[aria-pressed="false"]');
for (const [kind, name] of Object.entries({ G:'layers', T:'title', '▧':'image', '◇':'shapes', '□':'rectangle' })) add(name, `.h5ve-element-icon[data-material-kind="${kind}"]`, true);
const dir = path.join(assets, 'material-symbols');
await fs.mkdir(dir, { recursive: true });
await Promise.all([...new Set(rules.map(r => r.name))].map(async name => {
  const file = path.join(dir, name + '.svg');
  try { await fs.access(file); return; } catch {}
  const response = await fetch(`https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web/${name}/materialsymbolsoutlined/${name}_24px.svg`);
  if (!response.ok) throw Error(`${name}: ${response.status}`);
  await fs.writeFile(file, await response.text());
}));
let css = '/* Generated Google Material Symbols masks; Apache-2.0, material-symbols/LICENSE. */\n';
for (const { name, selector, only } of rules) {
  const scoped = selector.split(',').map(s => 'html .h5ve-root ' + s).join(',');
  css += `${scoped} { --editor-icon: url('material-symbols/${name}.svg'); ${only ? 'font-size:0 !important;' : ''} }\n`;
  css += `${scoped}::before { content:''; display:inline-block; width:18px; height:18px; flex:0 0 18px; vertical-align:middle; background:currentColor; mask:var(--editor-icon) center/contain no-repeat; }\n`;
  css += `${scoped}>svg { display:none !important; }\n`;
}
css += `.h5ve-root [data-action="insert"]>span:first-child { display:none; }
.h5ve-root :is(.h5ve-element-control,.h5ve-element-delete,.h5ve-element-disclosure,.h5ve-element-icon)::before { width:14px; height:14px; flex-basis:14px; }
.h5ve-root :is(.h5ve-btn,.h5ve-insert-trigger,.h5ve-command-trigger,.h5ve-elements-actions button) { gap:8px; }
.h5ve-root .h5ve-element-icon { border:0; background:transparent; }
.h5ve-root :is([data-text-style],[data-multi-text-style])>:is(strong,em,u) { display:none; }
`;
await fs.writeFile(path.join(assets, 'editor-material-icons.css'), css);
// The editor bridge serves only its small allowlist and deck media. Embed the
// generated chrome CSS in the frame instead of widening that server allowlist.
const frameFile = path.join(assets, 'pptedit-frame.html');
let frame = await fs.readFile(frameFile, 'utf8');
frame = frame.replace(/<link rel="stylesheet" href="assets\/editor-material[^\"]*">\s*/g, '')
  .replace(/<!-- editor-material:start -->[\s\S]*?<!-- editor-material:end -->\s*/g, '');
const theme = await fs.readFile(path.join(assets, 'editor-material.css'), 'utf8');
frame = frame.replace('</head>', `<!-- editor-material:start -->\n<style>\n${theme}\n${css.replaceAll("url('material-symbols/", "url('/deck/assets/material-symbols/")}\n</style>\n<!-- editor-material:end -->\n</head>`);
await fs.writeFile(frameFile, frame);
for (const file of ['editor-material.css', 'editor-material-icons.css']) await fs.copyFile(path.join(assets, file), path.join(target, 'assets', file));
await fs.cp(dir, path.join(target, 'assets/material-symbols'), { recursive: true });
console.log(`Installed editor theme and ${new Set(rules.map(r=>r.name)).size} Google icon symbols.`);
