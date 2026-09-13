/* Adapt a source SVG to the PPTedit workbench without converting it to a bitmap. */
(async () => {
  const query = new URLSearchParams(location.search);
  const secrets = new URLSearchParams(location.hash.slice(1));
  const page = Number(query.get('page'));
  const token = secrets.get('token');
  const rawParentOrigin = secrets.get('parent');
  const parentOrigin = /^https?:\/\//.test(rawParentOrigin || '') ? rawParentOrigin : 'null';
  const headers = { 'Content-Type': 'application/json', 'X-PPTedit-Token': token };
  const notify = (type, extra = {}) => parent.postMessage({ type, page, ...extra }, parentOrigin === 'null' ? '*' : parentOrigin);
  function fail(message) {
    const status = document.getElementById('load-status');
    if (status) status.textContent = '无法进入编辑：' + message;
    notify('pptedit-error');
  }
  addEventListener('error', event => {
    if (!document.documentElement.classList.contains('pptedit-ready')) fail(event.message || '编辑器资源加载失败，请返回后重试');
  }, true);
  let resolveManifest;
  const manifestFromPreview = new Promise(resolve => { resolveManifest = resolve; });
  addEventListener('message', event => {
    if (event.source !== parent || event.origin !== parentOrigin || event.data?.type !== 'pptedit-manifest') return;
    if (event.data.page !== page || !Array.isArray(event.data.slides)) return;
    resolveManifest({ slides: event.data.slides, chapters: event.data.chapters || {} });
  });
  // Do not wait for iframe load (which can wait for slow page resources).
  notify('pptedit-manifest-request');
  try {
    const response = await fetch('/state?page=' + page, { headers });
    const source = await response.json();
    if (!response.ok) throw new Error(source.error);
    // Older running servers can keep serving saves; the preview supplies its exact directory.
    if (!Array.isArray(source.slides)) Object.assign(source, await manifestFromPreview);
    const parsed = new DOMParser().parseFromString(source.svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const svg = document.importNode(parsed.documentElement, true);
    svg.dataset.ppteditSvg = 'true';
    const slide = document.querySelector('.slide');
    slide.setAttribute('aria-label', source.slide.title);
    slide.append(svg);
    const [, , width, height] = svg.getAttribute('viewBox').split(/[ ,]+/).map(Number);
    Object.assign(document.getElementById('stage').dataset, { h5veWidth: width, h5veHeight: height });
    Object.assign(document.getElementById('stage').style, { width: width + 'px', height: height + 'px' });
    function markup(html) {
      const doc = html ? new DOMParser().parseFromString(html, 'text/html') : document;
      const container = doc.querySelector('.slide');
      const root = container?.querySelector(':scope > svg[data-pptedit-svg]');
      if (!root || container.children.length !== 1) throw new Error('请在现有 SVG 图层内编辑；新增的 HTML 图层尚不能写入 SVG，草稿会保留');
      const clean = root.cloneNode(true);
      clean.removeAttribute('data-pptedit-svg');
      for (const node of [clean, ...clean.querySelectorAll('*')]) {
        for (const attr of [...node.attributes]) if (attr.name.startsWith('data-h5ve-')) node.removeAttribute(attr.name);
        node.style?.removeProperty('--h5ve-force-transform');
      }
      return new XMLSerializer().serializeToString(clean);
    }
    let api;
    let savedSvg = source.svg;
    let navigating = false;
    async function navigateTo(targetPage) {
      if (targetPage === page || navigating || !api) return;
      navigating = true;
      const feedback = document.querySelector('.pptedit-page-feedback');
      if (feedback) feedback.textContent = '正在保存当前页…';
      try {
        if (await api.saveForNavigation()) {
          notify('pptedit-navigate', { targetPage });
          if (feedback) feedback.textContent = '';
        } else if (feedback) feedback.textContent = '保存未完成，请处理右侧保存提示后再切换';
      } catch (error) { if (feedback) feedback.textContent = '切换失败：' + error.message; }
      finally { navigating = false; }
    }
    function renderSlidePanel(panel) {
      panel.hidden = false;
      const list = panel.querySelector('.h5ve-slides-list');
      if (list.dataset.fullDeck) return;
      list.dataset.fullDeck = 'true';
      list.replaceChildren();
      const heading = panel.querySelector('.h5ve-slides-head');
      if (heading) heading.textContent = `幻灯片 · ${source.slides.length} 页`;
      const foot = panel.querySelector('.h5ve-slides-foot');
      if (foot) { foot.classList.add('pptedit-page-feedback'); foot.textContent = '拖拽调整演讲顺序 · ↑ ↓ 切换页面'; }
      let draggedPage;
      let sorting = false;
      const clearDrop = () => list.querySelectorAll('[data-drop]').forEach(node => node.removeAttribute('data-drop'));
      for (const item of source.slides) {
        if (source.chapters[String(item.page)]) {
          const chapter = document.createElement('p');
          chapter.className = 'pptedit-chapter';
          chapter.textContent = source.chapters[String(item.page)];
          list.append(chapter);
        }
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pptedit-page-link';
        button.dataset.page = item.page;
        button.draggable = true;
        button.title = '拖拽调整演讲顺序';
        button.addEventListener('dragstart', event => {
          if (sorting || navigating) { event.preventDefault(); return; }
          draggedPage = item.page;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(item.page));
        });
        button.addEventListener('dragend', () => { draggedPage = undefined; clearDrop(); });
        button.addEventListener('dragover', event => {
          if (draggedPage === undefined || sorting) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          clearDrop();
          const rect = button.getBoundingClientRect();
          button.dataset.drop = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          const bounds = list.getBoundingClientRect();
          if (event.clientY < bounds.top + 45) list.scrollTop -= 18;
          if (event.clientY > bounds.bottom - 45) list.scrollTop += 18;
        });
        button.addEventListener('drop', async event => {
          event.preventDefault();
          if (draggedPage === undefined || sorting) return;
          const moving = draggedPage;
          const after = button.dataset.drop === 'after';
          draggedPage = undefined;
          clearDrop();
          if (moving === item.page) return;
          const previousOrder = source.slides.map(slide => slide.page);
          const order = previousOrder.filter(value => value !== moving);
          order.splice(order.indexOf(item.page) + Number(after), 0, moving);
          if (order.every((value, i) => value === previousOrder[i])) return;
          sorting = true;
          navigating = true;
          if (foot) foot.textContent = '正在保存演讲顺序…';
          try {
            if (!await api.saveForNavigation()) throw new Error('当前页未保存，请处理保存提示后重试');
            const response = await fetch('/reorder', { method: 'POST', headers, body: JSON.stringify({ order, previousOrder }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || '保存失败');
            notify('pptedit-reordered', { order });
            applyOrder(order);
            if (foot) foot.textContent = '演讲顺序已保存 · 拖拽可继续调整';
          } catch (error) { if (foot) foot.textContent = '排序失败：' + error.message; }
          finally { sorting = false; navigating = false; }
        });
        button.setAttribute('aria-current', item.page === page ? 'page' : 'false');
        button.setAttribute('aria-label', `第 ${item.page} 页 · ${item.title}`);
        const image = document.createElement('img');
        image.src = '/deck/' + item.file.split('/').map(encodeURIComponent).join('/');
        image.alt = '';
        image.draggable = false;
        image.loading = 'lazy';
        const title = document.createElement('span');
        title.textContent = String(item.page).padStart(2, '0') + '  ' + item.title;
        button.append(image, title);
        button.onclick = () => navigateTo(item.page);
        list.append(button);
      }
      list.addEventListener('keydown', event => {
        const index = source.slides.findIndex(item => item.page === page);
        const keys = { ArrowUp: index - 1, ArrowLeft: index - 1, ArrowDown: index + 1, ArrowRight: index + 1, Home: 0, End: source.slides.length - 1 };
        if (!(event.key in keys) || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = source.slides[keys[event.key]];
        if (item) navigateTo(item.page);
      }, true);
      requestAnimationFrame(() => list.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' }));
    }
    function applyOrder(order) {
      const byPage = new Map(source.slides.map(slide => [slide.page, slide]));
      if (order.length !== byPage.size || new Set(order).size !== byPage.size || order.some(p => !byPage.has(p))) return;
      source.slides = order.map(p => byPage.get(p));
      const list = document.querySelector('.h5ve-slides-list');
      if (list) {
        const chapters = [...list.querySelectorAll('.pptedit-chapter')];
        const chapterNodes = new Map(chapters.map(node => [Number(node.nextElementSibling?.dataset.page), node]));
        for (const p of order) {
          const row = list.querySelector(`[data-page="${p}"]`);
          if (chapterNodes.has(p)) list.append(chapterNodes.get(p));
          if (row) list.append(row);
        }
      }
    }
    window.PPTEDIT_DOCUMENT_HOST = {
      renderSlidePanel,
      navigateBy: delta => {
        const index = source.slides.findIndex(item => item.page === page);
        const target = source.slides[index + delta];
        if (target) return navigateTo(target.page);
      },
      pageInfo: { page, total: source.slides.length },
      readonlyNotes: source.slide.notes || [],
      loadRevision: async () => source.revision,
      save: async ({ html, revision }) => {
        const svg = markup(html);
        const response = await fetch('/save', { method: 'POST', headers, body: JSON.stringify({ page, svg, revision }) });
        if (response.ok) savedSvg = svg;
        return response;
      },
      buildSvg: async () => ({ markup: markup(), stats: { width, height, textLayers: document.querySelectorAll('.slide text').length, tspanLayers: document.querySelectorAll('.slide tspan').length, vectorElements: document.querySelectorAll('.slide svg *').length, rasterAssets: document.querySelectorAll('.slide image').length, foreignObjects: 0, externalImages: 0, fullCanvasRasters: 0 } }),
      onPreview: () => notify('pptedit-preview', { svg: savedSvg }),
      ready: value => {
        api = value;
        document.documentElement.classList.add('pptedit-ready');
        document.getElementById('load-status')?.remove();
        notify('pptedit-ready');
      }
    };
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== parentOrigin) return;
      if (event.data?.type === 'pptedit-order' && Array.isArray(event.data.order)) applyOrder(event.data.order);
      if (event.data?.type === 'pptedit-prepare' && api) {
        const serial = event.data.request;
        dispatchEvent(new Event('resize'));
        requestAnimationFrame(() => requestAnimationFrame(() => notify('pptedit-painted', { request: serial })));
      }
      if (event.data?.type === 'pptedit-return') api?.preview();
      if (event.data?.type === 'pptedit-active') {
        const current = document.querySelector('.pptedit-page-link[aria-current="page"]');
        current?.scrollIntoView({ block: 'nearest' });
        current?.focus({ preventScroll: true });
        dispatchEvent(new Event('resize'));
      }
    });
    const script = document.createElement('script');
    script.src = '/h5-editor/editor.js';
    script.onerror = () => fail('编辑器脚本加载失败，请返回后重试');
    document.body.append(script);
  } catch (error) {
    fail(error.message);
  }
})();
