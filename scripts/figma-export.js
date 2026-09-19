// Read-only native export. Follow figma-use font loading and node lookup rules.
const node = await figma.getNodeByIdAsync(TARGET_NODE_ID);
if (!node || typeof node.exportAsync !== 'function') throw Error('指定节点不存在或不可导出');
if (figma.fileKey !== TARGET_FILE_KEY) throw Error('Figma 文件不匹配，停止导出');
const texts = node.type === 'TEXT' ? [node] :
  ('findAllWithCriteria' in node ? node.findAllWithCriteria({ types: ['TEXT'] }) : []);
const fonts = new Map();
for (const text of texts) {
  for (const segment of text.getStyledTextSegments(['fontName'])) {
    const font = segment.fontName;
    const key = JSON.stringify(font);
    if (!fonts.has(key)) fonts.set(key, { font, nodeIds: [] });
    fonts.get(key).nodeIds.push(text.id);
  }
}
const available = new Set((await figma.listAvailableFontsAsync()).map(f => JSON.stringify(f.fontName)));
const loadedFonts = [];
for (const { font, nodeIds } of fonts.values()) {
  try {
    await figma.loadFontAsync(font);
    loadedFonts.push({ ...font, listed: available.has(JSON.stringify(font)) });
  } catch (error) {
    throw Error(JSON.stringify({ reason: '字体加载失败，未替换字体', font, nodeIds, error: String(error) }));
  }
}
const svg = await node.exportAsync({ format: 'SVG_STRING', svgOutlineText: true, svgIdAttribute: true });
let hash = 2166136261;
for (let i = 0; i < svg.length; i++) hash = Math.imul(hash ^ svg.charCodeAt(i), 16777619) >>> 0;
return { fileKey: figma.fileKey, nodeId: node.id, name: node.name,
  width: node.width, height: node.height, loadedFonts, length: svg.length, hash,
  index: CHUNK_INDEX, total: Math.ceil(svg.length / 8000),
  chunk: CHUNK_INDEX < 0 ? '' : svg.slice(CHUNK_INDEX * 8000, (CHUNK_INDEX + 1) * 8000) };
