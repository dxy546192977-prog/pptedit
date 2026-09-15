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
    const displayPage = () => source.slides.findIndex(item => item.page === page) + 1;
    const parsed = new DOMParser().parseFromString(source.svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const svg = document.importNode(parsed.documentElement, true);
    svg.dataset.ppteditSvg = 'true';
    const slide = document.querySelector('.slide');
    slide.setAttribute('aria-label', source.slide.title);
    slide.append(svg);
    if (svg.querySelector('#page-number')) svg.querySelector('#page-number').textContent = String(displayPage()).padStart(2, '0');
    const [, , width, height] = svg.getAttribute('viewBox').split(/[ ,]+/).map(Number);
    Object.assign(document.getElementById('stage').dataset, { h5veWidth: width, h5veHeight: height });
    Object.assign(document.getElementById('stage').style, { width: width + 'px', height: height + 'px' });
    function markup(html) {
      const doc = html ? new DOMParser().parseFromString(html, 'text/html') : document;
      const container = doc.querySelector('.slide');
      const root = container?.querySelector(':scope > svg[data-pptedit-svg]');
      if (!root || container.children.length !== 1) throw new Error('请在现有 SVG 图层内编辑；新增的 HTML 图层尚不能写入 SVG，草稿会保留');
      const clean = root.cloneNode(true);
      if (clean.querySelector('#page-number')) clean.querySelector('#page-number').textContent = String(displayPage()).padStart(2, '0');
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
    async function deletePage(targetPage) {
      if (navigating || !api || source.slides.length <= 1) return;
      const item = source.slides.find(slide => slide.page === targetPage);
      if (!item || !confirm(`删除第 ${targetPage} 页「${item.title}」？\n将从演讲目录中移除，源 SVG 和目录备份会保留。`)) return;
      navigating = true;
      const feedback = document.querySelector('.pptedit-page-feedback');
      try {
        if (feedback) feedback.textContent = '正在保存并删除页面…';
        if (!await api.saveForNavigation()) throw new Error('当前页未保存，请处理保存提示后重试');
        const previousOrder = source.slides.map(slide => slide.page);
        const response = await fetch('/delete-page', { method: 'POST', headers, body: JSON.stringify({ page: targetPage, previousOrder }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '删除失败');
        notify('pptedit-deleted', { deletedPage: targetPage, order: result.order });
        applyOrder(result.order);
      } catch (error) { if (feedback) feedback.textContent = '删除失败：' + error.message; }
      finally { navigating = false; }
    }
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
      if (foot) { foot.classList.add('pptedit-page-feedback'); foot.textContent = '拖拽排序 · ↑ ↓ 切页 · 每页下方可删除'; }
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
        button.setAttribute('aria-label', `第 ${source.slides.indexOf(item) + 1} 页 · ${item.title}`);
        const image = document.createElement('img');
        image.src = '/deck/' + item.file.split('/').map(encodeURIComponent).join('/');
        image.alt = '';
        image.draggable = false;
        image.loading = 'lazy';
        // The thumbnail's embedded corner number follows the same current order.
        fetch(image.src, { cache: 'no-cache' }).then(response => {
          if (!response.ok) throw new Error('缩略图加载失败');
          return response.text();
        }).then(text => {
          if (!image.isConnected) return;
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          const number = doc.querySelector('#page-number');
          if (number) number.textContent = String(source.slides.indexOf(item) + 1).padStart(2, '0');
          image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(doc.documentElement));
        }).catch(error => console.warn(error.message));
        const title = document.createElement('span');
        title.textContent = String(source.slides.indexOf(item) + 1).padStart(2, '0') + '  ' + item.title;
        button.append(image, title);
        button.onclick = () => navigateTo(item.page);
        list.append(button);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'pptedit-page-delete';
        remove.dataset.deletePage = item.page;
        remove.textContent = '删除此页';
        remove.setAttribute('aria-label', `删除第 ${source.slides.indexOf(item) + 1} 页 · ${item.title}`);
        remove.disabled = source.slides.length <= 1;
        remove.onclick = () => deletePage(item.page);
        list.append(remove);
      }
      list.onkeydown = event => {
        const index = source.slides.findIndex(item => item.page === page);
        const keys = { ArrowUp: index - 1, ArrowLeft: index - 1, ArrowDown: index + 1, ArrowRight: index + 1, Home: 0, End: source.slides.length - 1 };
        if (!(event.key in keys) || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = source.slides[keys[event.key]];
        if (item) navigateTo(item.page);
      };
      requestAnimationFrame(() => list.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' }));
    }
    function applyOrder(order) {
      const byPage = new Map(source.slides.map(slide => [slide.page, slide]));
      if (!order.length || new Set(order).size !== order.length || order.some(p => !byPage.has(p))) return;
      source.slides = order.map(p => byPage.get(p));
      window.PPTEDIT_DOCUMENT_HOST.pageInfo.total = order.length;
      window.PPTEDIT_DOCUMENT_HOST.pageInfo.page = displayPage();
      const idx = document.getElementById('h5ve-slide-idx');
      if (idx) idx.textContent = String(displayPage());
      if (svg.querySelector('#page-number')) svg.querySelector('#page-number').textContent = String(displayPage()).padStart(2, '0');
      const total = document.getElementById('h5ve-slide-total');
      if (total) total.textContent = String(order.length);
      const list = document.querySelector('.h5ve-slides-list');
      if (list) {
        delete list.dataset.fullDeck;
        renderSlidePanel(list.closest('.h5ve-slides'));
      }
    }
    window.PPTEDIT_DOCUMENT_HOST = {
      renderSlidePanel,
      navigateBy: delta => {
        const index = source.slides.findIndex(item => item.page === page);
        const target = source.slides[index + delta];
        if (target) return navigateTo(target.page);
      },
      pageInfo: { page: displayPage(), total: source.slides.length },
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
