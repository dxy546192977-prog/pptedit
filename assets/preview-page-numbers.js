/* Stable page IDs route content; presentation positions are the visible numbers. */
(() => {
  const host = window.PPT_NARRATION_HOST;
  if (!host) return;
  const label = n => String(n).padStart(2, '0');
  const position = id => host.getSlides().findIndex(s => String(s.page) === String(id)) + 1;
  host.normalizeSvg = (text, id) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const number = doc.querySelector('[id="page-number"]');
    if (number) number.textContent = label(position(id));
    return new XMLSerializer().serializeToString(doc.documentElement);
  };
  const rendered = new WeakMap();
  async function updateImage(img, id) {
    // 静态封面（JPG/PNG）不是 SVG，不做页码注入，避免 DOMParser 报错并覆盖成空图。
    if (img.dataset.staticCover === '1') return;
    const src = img.getAttribute('src');
    const stamp = `${id}:${position(id)}:${src}`;
    if (!src || rendered.get(img) === stamp) return;
    rendered.set(img, stamp);
    try {
      const response = await fetch(src, { cache: 'no-cache' });
      if (!response.ok) return;
      const text = await response.text();
      if (img.getAttribute('src') !== src || rendered.get(img) !== stamp) return;
      const next = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(host.normalizeSvg(text, id));
      rendered.set(img, `${id}:${position(id)}:${next}`);
      img.src = next;
    } catch (error) { console.warn('页码同步失败', id, error); }
  }
  function update() {
    const slides = host.getSlides();
    const current = slides[host.getIndex()];
    const identity = document.querySelector('.sidebar .identity p');
    if (identity) identity.textContent = identity.textContent.replace(/\d+\s*页/, `${slides.length} 页`);
    for (const row of document.querySelectorAll('.slide-link, .thumb')) {
      const id = row.dataset.page;
      const slide = slides.find(s => String(s.page) === id);
      if (!slide) continue;
      const number = position(id);
      const text = row.querySelector('.nav-slide-number') || (row.matches('.slide-link') ? row.querySelector('span') : null);
      if (text) text.textContent = label(number);
      const caption = row.matches('.thumb') && row.querySelector('p');
      if (caption) caption.textContent = `${label(number)}  /  ${slide.title}`;
      row.title = `第 ${number} 页 · ${slide.title}`;
      row.setAttribute('aria-label', row.title);
      const img = row.querySelector('img');
      if (img) void updateImage(img, id);
    }
    for (const group of document.querySelectorAll('.nav-chapter')) {
      const rows = [...group.querySelectorAll('.slide-link')];
      const range = group.querySelector(':scope > summary .nav-chapter-range');
      if (range && rows.length) range.textContent = `${label(position(rows[0].dataset.page))}–${label(position(rows.at(-1).dataset.page))}`;
    }
    if (current) {
      const counter = document.getElementById('counter');
      const value = `${label(host.getIndex() + 1)} / ${slides.length}`;
      if (counter && counter.textContent !== value) counter.textContent = value;
      const img = document.getElementById('slide');
      if (img) { img.alt = `${label(host.getIndex() + 1)} · ${current.title}`; void updateImage(img, current.page); }
    }
  }
  // ---- 校对：可见页码必须恰好是 01..N、无重复无遗漏；不一致则强制重渲染并（可选）让服务端修正磁盘上的烘焙页码 ----
  function audit() {
    const slides = host.getSlides();
    const ids = slides.map(s => String(s.page));
    const problems = [];
    if (new Set(ids).size !== ids.length) problems.push('slides 中存在重复页 id');
    const rows = [...document.querySelectorAll('.sidebar nav .slide-link')];
    if (rows.length) {
      const seen = rows.map(row => ({ id: row.dataset.page, shown: Number((row.querySelector('.nav-slide-number') || row.querySelector('span'))?.textContent) }));
      const rowIds = seen.map(x => x.id);
      const missing = ids.filter(id => !rowIds.includes(id));
      const extra = rowIds.filter(id => !ids.includes(id));
      if (missing.length) problems.push(`侧栏缺少页：${missing.join(', ')}`);
      if (extra.length) problems.push(`侧栏多出已不存在的页：${extra.join(', ')}`);
      const bad = seen.filter(x => ids.includes(x.id) && x.shown !== position(x.id));
      if (bad.length) problems.push(`侧栏页码与实际位置不一致：${bad.map(x => `${x.id}→显示${x.shown}/应为${position(x.id)}`).join('；')}`);
      const shownSet = new Set(seen.map(x => x.shown));
      if (shownSet.size !== seen.length) problems.push('侧栏页码有重复');
    }
    const counter = document.getElementById('counter');
    const expected = `${label(host.getIndex() + 1)} / ${slides.length}`;
    if (counter && counter.textContent.trim() !== expected) problems.push(`计数器 ${counter.textContent.trim()} ≠ ${expected}`);
    return problems;
  }
  function forceRerender() {
    // 清空缓存戳，让每张图按当前位置重新注入页码
    for (const img of document.querySelectorAll('.slide-link img, .thumb img, #slide')) rendered.delete(img);
    update();
  }
  let auditTimer = 0;
  function reconcile(detail) {
    update();
    clearTimeout(auditTimer);
    auditTimer = setTimeout(() => {
      let problems = audit();
      if (problems.length) { console.warn('[页码校对] 发现不一致，强制重渲染：', problems); forceRerender(); problems = audit(); }
      if (problems.length) console.error('[页码校对] 重渲染后仍不一致：', problems);
      const r = detail?.renumber;
      if (r?.error) console.warn('[页码校对] 服务端页码写盘失败：', r.error);
      if (r?.missing?.length) console.warn('[页码校对] 找不到文件的页：', r.missing);
    }, 120);
  }
  // 服务端只读审计 + 修正（磁盘上每个 SVG 烘焙页码 vs 实际顺序）。排序/删页路径服务端已顺手修正，
  // 这里兜底：页面加载后做一次只读审计，发现漂移再修，避免历史遗留的错页码一直留在文件里。
  async function syncDisk({ fix }) {
    const config = window.PPTEDIT_PREVIEW_CONFIG;
    if (!config) return null;
    try {
      const response = await fetch(new URL('/renumber', config.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PPTedit-Token': config.token }, body: JSON.stringify({ fix: !!fix }) });
      if (!response.ok) return null;
      const data = await response.json();
      if (fix && data.renumber?.updated?.length) { forceRerender(); console.info(`[页码校对] 已修正磁盘页码 ${data.renumber.updated.length} 页`, data.renumber.updated); }
      return data;
    } catch { return null; }
  }
  host.auditPageNumbers = audit;
  host.renumberPages = () => syncDisk({ fix: true });
  const canvas = document.getElementById('slide');
  if (canvas) new MutationObserver(() => update()).observe(canvas, { attributes: true, attributeFilter: ['src'] });
  window.addEventListener('pptedit-order-changed', event => reconcile(event.detail));
  // 侧栏被整体重建（章节合并/解组/恢复导航）时也重算，覆盖没走事件的路径
  const nav = document.querySelector('.sidebar nav');
  if (nav) {
    let navTimer = 0;
    // 只关心「行/章节被增删」这类结构变更；update() 自己改的页码文本节点（span 内）要忽略，否则自触发循环。
    const structural = record => [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && (node.matches('.slide-link, details, summary') || node.querySelector?.('.slide-link')));
    new MutationObserver(records => {
      if (!records.some(structural)) return;
      clearTimeout(navTimer); navTimer = setTimeout(() => reconcile(), 60);
    }).observe(nav, { childList: true, subtree: true });
  }
  reconcile();
  // 首屏后只读审计磁盘；有漂移（历史遗留）才修
  if (document.readyState === 'complete') void syncDisk({ fix: false }).then(d => d?.problems?.length && syncDisk({ fix: true }));
  else window.addEventListener('load', () => void syncDisk({ fix: false }).then(d => d?.problems?.length && syncDisk({ fix: true })), { once: true });
})();
