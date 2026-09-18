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
    resolveManifest({ slides: event.data.slides, chapters: event.data.chapters || {}, navigation: event.data.navigation });
  });
  // Do not wait for iframe load (which can wait for slow page resources).
  notify('pptedit-manifest-request');
  try {
    const { normalizeTree, moveInTree } = await import('/navigation-tree.js');
    const response = await fetch('/state?page=' + page, { headers });
    const source = await response.json();
    if (!response.ok) throw new Error(source.error);
    // Older running servers can keep serving saves; the preview supplies its exact directory.
    if (!Array.isArray(source.slides)) Object.assign(source, await manifestFromPreview);
    if (parent !== window) Object.assign(source, await manifestFromPreview);
    const displayPage = () => source.slides.findIndex(item => item.page === page) + 1;
    const parsed = new DOMParser().parseFromString(source.svg, 'image/svg+xml');
    if (parsed.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const svg = document.importNode(parsed.documentElement, true);
    svg.dataset.ppteditSvg = 'true';
    const slide = document.querySelector('.slide');
    slide.setAttribute('aria-label', source.slide.title);
    slide.append(svg);
    // Preview videos use SVG poster images while editing. Keep their media identity
    // in editor-only metadata, which markup() strips before saving the SVG.
    const previewMedia = source.slides.find(item => item.page === page)?.previewMedia || source.slide.previewMedia;
    const mediaItems = Array.isArray(previewMedia) ? previewMedia : [previewMedia];
    const mediaPath = value => {
      try { return decodeURIComponent(new URL(value, location.origin + '/deck/').pathname); }
      catch { return value; }
    };
    for (const media of mediaItems) {
      if (!media?.file || !media.poster) continue;
      for (const image of svg.querySelectorAll('image')) {
        const href = image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        const matchesBounds = [['x', 'x'], ['y', 'y'], ['width', 'w'], ['height', 'h']]
          .every(([attr, key]) => Number.isFinite(media[key]) && image.hasAttribute(attr) && Math.abs(Number(image.getAttribute(attr)) - media[key]) < 0.01);
        if ((href && mediaPath(href) === mediaPath(media.poster)) || matchesBounds) image.dataset.h5veMediaType = 'video';
      }
    }
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
        adoptRevisions(result.renumber?.revisions);
        notify('pptedit-deleted', { deletedPage: targetPage, order: result.order, revisions: result.renumber?.revisions });
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
    const selectedPages = new Set([page]);
    let pageSelectionAnchor = page;
    function updatePageSelection() {
      document.querySelectorAll('.pptedit-page-link').forEach(button => {
        const selected = selectedPages.has(Number(button.dataset.page));
        button.classList.toggle('is-page-selected', selected);
        button.setAttribute('aria-pressed', String(selected));
      });
      const foot = document.querySelector('.pptedit-page-feedback');
      if (foot) {
        foot.textContent = selectedPages.size > 1 ? `已选 ${selectedPages.size} 页 · ` : '⌘ 点选 / Shift 连选 · ';
        const group = document.createElement('button');
        group.type = 'button'; group.className = 'pptedit-group-pages';
        group.textContent = '组成子章节 ⌘G'; group.disabled = selectedPages.size < 2;
        group.onclick = groupSelectedPages;
        foot.append(group);
      }
    }
    function groupSelectedPages() {
      if (selectedPages.size < 2 || navigating) return;
      notify('pptedit-group-pages', { pages: source.slides.filter(slide => selectedPages.has(slide.page)).map(slide => slide.page) });
    }
    addEventListener('keydown', event => {
      if (!event.target.closest?.('.h5ve-slides')) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault(); event.stopImmediatePropagation(); groupSelectedPages();
      } else if (event.key === 'Escape') {
        selectedPages.clear(); selectedPages.add(page); pageSelectionAnchor = page; updatePageSelection();
      }
    }, true);
    const thumbnailCache = new Map();
    let panelRenderFrame;
    function refreshSlidePanel() {
      cancelAnimationFrame(panelRenderFrame);
      panelRenderFrame = requestAnimationFrame(() => {
        const list = document.querySelector('.h5ve-slides-list');
        if (list) { delete list.dataset.fullDeck; renderSlidePanel(list.closest('.h5ve-slides')); }
      });
    }
    function orderedNavigation(nodes) { return normalizeTree(nodes, source.slides.map(slide => slide.page)); }
    function renderSlidePanel(panel) {
      panel.hidden = false;
      const list = panel.querySelector('.h5ve-slides-list');
      if (list.dataset.fullDeck) return;
      const previousScroll = list.dataset.rendered ? list.scrollTop : null;
      list.dataset.rendered = 'true';
      list.dataset.fullDeck = 'true';
      list.replaceChildren();
      const heading = panel.querySelector('.h5ve-slides-head');
      if (heading) heading.textContent = `幻灯片 · ${source.slides.length} 页`;
      const foot = panel.querySelector('.h5ve-slides-foot');
      if (foot) { foot.classList.add('pptedit-page-feedback'); foot.textContent = '拖动页面调整顺序 · ⌘ 点选 / Shift 连选'; }
      let draggedPage, dropTarget, dropMarker, ghost, expandTimer, hoverChapter;
      let dropGeometry, dragBounds, lastPointerY, lastScrollTop, pointerInside = true;
      const dropLine = document.createElement('div');
      dropLine.className = 'pptedit-page-drop-line';
      dropLine.hidden = true;
      let sorting = false, scrollFrame = 0, pointerY = 0;
      const clearDrop = () => {
        dropMarker?.removeAttribute('data-drop');
        dropMarker = undefined;
        dropTarget = undefined;
        dropLine.hidden = true;
      };
      const finishDrag = () => {
        draggedPage = undefined;
        clearDrop();
        cancelAnimationFrame(scrollFrame);
        clearTimeout(expandTimer);
        hoverChapter = undefined;
        ghost?.remove();
        dropLine.remove();
        list.classList.remove('is-page-sorting');
        list.querySelector('.is-dragging')?.classList.remove('is-dragging');
      };
      list._finishDrag?.();
      list._finishDrag = finishDrag;
      async function movePage(moving, target, after) {
        if (sorting || navigating || moving === target) return;
        const previousOrder = source.slides.map(slide => slide.page);
        const order = previousOrder.filter(value => value !== moving);
        if (!previousOrder.includes(moving) || !order.includes(target)) return;
        order.splice(order.indexOf(target) + Number(after), 0, moving);
        if (order.every((value, i) => value === previousOrder[i])) return;
        sorting = true;
        navigating = true;
        if (foot) foot.textContent = '正在保存演讲顺序…';
        try {
          if (!await api.saveForNavigation()) throw new Error('当前页未保存，请处理保存提示后重试');
          const navigation = source.navigation?.tree ? moveInTree(source.navigation.tree, order, moving, target, after) : undefined;
          const response = await fetch('/reorder', { method: 'POST', headers, body: JSON.stringify({ order, previousOrder, navigation }) });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || '保存失败');
          if (navigation) source.navigation.tree = navigation;
          adoptRevisions(result.renumber?.revisions);
          notify('pptedit-reordered', { order, navigation, revisions: result.renumber?.revisions });
          applyOrder(order);
          if (foot) foot.textContent = '演讲顺序已保存 · 拖动可继续调整';
        } catch (error) { if (foot) foot.textContent = '排序失败：' + error.message; }
        finally { sorting = false; navigating = false; }
      }
      function measureDropTargets() {
        dragBounds = list.getBoundingClientRect();
        const scrollTop = list.scrollTop;
        dropGeometry = [...list.querySelectorAll('.pptedit-page-item, summary')].flatMap(node => {
          if (node.closest('.is-dragging')) return [];
          for (let ancestor = node.parentElement; ancestor && ancestor !== list; ancestor = ancestor.parentElement) {
            if (ancestor.matches('details:not([open])') && node !== ancestor.firstElementChild) return [];
          }
          const rect = node.getBoundingClientRect();
          if (!rect.height) return [];
          const rows = node.matches('summary') ? node.parentElement.querySelectorAll('.pptedit-page-link') : null;
          // 坐标统一换算到列表滚动内容坐标系：定位线挂在列表内部，随滚动跟随且天然被 overflow 裁切。
          return [{ node, left: rect.left - dragBounds.left, width: rect.width, top: rect.top - dragBounds.top + scrollTop, bottom: rect.bottom - dragBounds.top + scrollTop,
            first: rows ? Number(rows[0]?.dataset.page) : Number(node.dataset.pageItem),
            last: rows ? Number(rows[rows.length - 1]?.dataset.page) : Number(node.dataset.pageItem) }];
        });
      }
      function targetAt(y) {
        if (!dropGeometry) measureDropTargets();
        const contentY = y - dragBounds.top + list.scrollTop;
        const target = dropGeometry.find(item => contentY < item.bottom) || dropGeometry.at(-1);
        if (!target) { clearDrop(); return; }
        const after = contentY >= (target.top + target.bottom) / 2;
        const value = after ? 'after' : 'before';
        dropTarget = { page: after ? target.last : target.first, after };
        if (dropMarker !== target.node) { dropMarker?.removeAttribute('data-drop'); dropMarker = target.node; }
        if (dropMarker.dataset.drop !== value) dropMarker.dataset.drop = value;
        const lineY = after ? target.bottom + 3 : target.top - 3;
        dropLine.hidden = false;
        Object.assign(dropLine.style, { left: target.left + 'px', top: lineY + 'px', width: target.width + 'px' });
        const chapter = target.node.matches('summary') ? target.node.parentElement : null;
        if (hoverChapter !== chapter) {
          clearTimeout(expandTimer);
          hoverChapter = chapter;
          if (chapter && !chapter.open) expandTimer = setTimeout(() => {
            if (draggedPage !== undefined) { chapter.open = true; dropGeometry = null; }
          }, 650);
        }
      }
      function autoScroll() {
        if (draggedPage === undefined) return;
        if (pointerInside) {
          if (!dropGeometry) measureDropTargets();
          const edge = 56;
          const speed = pointerY < dragBounds.top + edge ? -Math.min(14, (dragBounds.top + edge - pointerY) / 4)
            : pointerY > dragBounds.bottom - edge ? Math.min(14, (pointerY - dragBounds.bottom + edge) / 4) : 0;
          if (speed) list.scrollTop += speed;
          const scrollTop = list.scrollTop;
          if (pointerY !== lastPointerY || scrollTop !== lastScrollTop || !dropMarker) targetAt(pointerY);
          lastPointerY = pointerY; lastScrollTop = scrollTop;
        }
        scrollFrame = requestAnimationFrame(autoScroll);
      }
      list.ondragover = event => {
        if (draggedPage === undefined || sorting) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        pointerY = event.clientY;
        pointerInside = true;
      };
      list.ondragleave = event => {
        if (!list.contains(event.relatedTarget)) { clearDrop(); pointerInside = false; clearTimeout(expandTimer); hoverChapter = undefined; }
      };
      list.ondrop = event => {
        if (draggedPage === undefined) return;
        event.preventDefault();
        targetAt(event.clientY);
        const moving = draggedPage, target = dropTarget;
        finishDrag();
        if (target) void movePage(moving, target.page, target.after);
      };
      for (const item of source.slides) {
        if (!source.navigation && source.chapters[String(item.page)]) {
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
        const row = document.createElement('div');
        row.className = 'pptedit-page-item';
        row.dataset.pageItem = item.page;
        button.addEventListener('dragstart', event => {
          if (sorting || navigating) { event.preventDefault(); return; }
          draggedPage = item.page;
          pointerY = event.clientY;
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(item.page));
          ghost = document.createElement('div');
          ghost.className = 'pptedit-page-drag-preview';
          ghost.textContent = `${source.slides.indexOf(item) + 1}  ${item.title}`;
          document.body.append(ghost);
          // 挂进列表内部而不是 body：侧栏本身是同 z-index 的 fixed 层，挂 body 会被遮住。
          list.append(dropLine);
          list.classList.add('is-page-sorting');
          event.dataTransfer.setDragImage(ghost, 20, 18);
          row.classList.add('is-dragging');
          pointerInside = true; dropGeometry = null; lastPointerY = undefined; lastScrollTop = undefined;
          measureDropTargets();
          scrollFrame = requestAnimationFrame(autoScroll);
        });
        button.addEventListener('dragend', finishDrag);
        button.setAttribute('aria-current', item.page === page ? 'page' : 'false');
        button.setAttribute('aria-label', `第 ${source.slides.indexOf(item) + 1} 页 · ${item.title}`);
        const image = document.createElement('img');
        const imagePath = '/deck/' + item.file.split('/').map(encodeURIComponent).join('/');
        image.alt = '';
        image.draggable = false;
        image.loading = 'lazy';
        image.decoding = 'async';
        let cached = thumbnailCache.get(item.file);
        if (!cached) {
          cached = { text: fetch(imagePath, { cache: 'no-cache' }).then(response => {
            if (!response.ok) throw new Error('缩略图加载失败');
            return response.text();
          }) };
          thumbnailCache.set(item.file, cached);
        }
        const number = source.slides.indexOf(item) + 1;
        if (cached.number === number && cached.url) image.src = cached.url;
        else cached.text.then(text => {
          if (!image.isConnected) return;
          if (cached.number !== number || !cached.url) {
            const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
            const label = doc.querySelector('#page-number');
            if (label) label.textContent = String(number).padStart(2, '0');
            if (cached.url) URL.revokeObjectURL(cached.url);
            cached.url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(doc.documentElement)], { type: 'image/svg+xml' }));
            cached.number = number;
          }
          image.src = cached.url;
        }).catch(error => { thumbnailCache.delete(item.file); console.warn(error.message); });
        const title = document.createElement('span');
        title.textContent = String(source.slides.indexOf(item) + 1).padStart(2, '0') + '  ' + item.title;
        button.append(image, title);
        button.onclick = event => {
          if (event.shiftKey) {
            const ids = source.slides.map(slide => slide.page);
            const start = ids.indexOf(pageSelectionAnchor), end = ids.indexOf(item.page);
            if (!event.metaKey && !event.ctrlKey) selectedPages.clear();
            ids.slice(Math.min(start, end), Math.max(start, end) + 1).forEach(id => selectedPages.add(id));
          } else if (event.metaKey || event.ctrlKey) {
            if (selectedPages.has(item.page)) selectedPages.delete(item.page); else selectedPages.add(item.page);
            pageSelectionAnchor = item.page;
          } else {
            selectedPages.clear(); selectedPages.add(item.page); pageSelectionAnchor = item.page;
            void navigateTo(item.page);
          }
          updatePageSelection();
        };
        row.append(button);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'pptedit-page-delete';
        remove.dataset.deletePage = item.page;
        remove.textContent = '删除此页';
        remove.setAttribute('aria-label', `删除第 ${source.slides.indexOf(item) + 1} 页 · ${item.title}`);
        remove.disabled = source.slides.length <= 1;
        remove.onclick = () => deletePage(item.page);
        const actions = document.createElement('div');
        actions.className = 'pptedit-page-actions';
        actions.append(remove);
        row.append(actions);
        list.append(row);
      }
      if (source.navigation?.tree) {
        const pages = new Map([...list.querySelectorAll('.pptedit-page-link')].map(button => [Number(button.dataset.page), [button.closest('.pptedit-page-item')]]));
        const used = new Set();
        function build(nodes, container) {
          for (const node of nodes) {
            if ('page' in node) {
              if (used.has(node.page) || !pages.has(node.page)) continue;
              used.add(node.page);
              container.append(...pages.get(node.page).filter(Boolean));
              continue;
            }
            const details = document.createElement('details');
            details.className = 'nav-chapter';
            if (node.key?.startsWith('section:') || node.children?.some(child => child.children)) details.classList.add('nav-section');
            details.dataset.chapterKey = node.key;
            const summary = document.createElement('summary');
            const text = document.createElement('span');
            text.className = 'nav-chapter-text';
            const title = document.createElement('strong'); title.textContent = node.title;
            text.append(title);
            if (node.subtitle) { const subtitle = document.createElement('span'); subtitle.textContent = node.subtitle; text.append(subtitle); }
            const range = document.createElement('span'); range.className = 'nav-chapter-range';
            const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'nav-chapter-edit'; edit.textContent = '⋯'; edit.setAttribute('aria-label', '编辑章节名称或解组');
            edit.onclick = event => { event.preventDefault(); event.stopPropagation(); notify('pptedit-chapter-edit', { key: node.key }); };
            text.ondblclick = event => { event.preventDefault(); notify('pptedit-chapter-edit', { key: node.key }); };
            summary.append(text, range, edit); details.append(summary);
            build(node.children || [], details);
            const rows = [...details.querySelectorAll('.pptedit-page-link')];
            if (!rows.length) continue;
            const label = row => String(source.slides.findIndex(item => item.page === Number(row.dataset.page)) + 1).padStart(2, '0');
            range.textContent = `${label(rows[0])}–${label(rows.at(-1))}`;
            const current = rows.some(row => Number(row.dataset.page) === page);
            details.classList.toggle('current-chapter', current);
            details.open = current || node.open;
            details.addEventListener('toggle', () => notify('pptedit-chapter-toggle', { key: node.key, open: details.open }));
            container.append(details);
          }
        }
        const content = document.createDocumentFragment();
        build(orderedNavigation(source.navigation.tree), content);
        // New pages must remain reachable until the preview sends its updated tree.
        for (const [id, nodes] of pages) if (!used.has(id)) content.append(...nodes.filter(Boolean));
        list.replaceChildren(content);
        list.dataset.view = source.navigation.view || 'thumbnails';
      }
      updatePageSelection();
      list.onkeydown = event => {
        const summary = event.target.closest('summary');
        if (summary) {
          if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); summary.parentElement.open = event.key === 'ArrowRight'; }
          event.stopPropagation();
          return;
        }
        const index = source.slides.findIndex(item => item.page === page);
        const keys = { ArrowUp: index - 1, ArrowLeft: index - 1, ArrowDown: index + 1, ArrowRight: index + 1, Home: 0, End: source.slides.length - 1 };
        if (!(event.key in keys) || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = source.slides[keys[event.key]];
        if (item) navigateTo(item.page);
      };
      requestAnimationFrame(() => {
        if (previousScroll !== null) list.scrollTop = previousScroll;
        else list.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
      });
    }
    // 服务端在排序/删页后会重写各 SVG 里烘焙的页码，磁盘 revision 随之变化；
    // 若本页在其中，更新乐观锁基线，否则下一次保存会被判成「被其他操作修改」(409)。
    function adoptRevisions(revisions) {
      const next = revisions && revisions[String(page)];
      if (next) source.revision = next;
    }
    function applyOrder(order, refresh = false) {
      const byPage = new Map(source.slides.map(slide => [slide.page, slide]));
      if (!order.length || new Set(order).size !== order.length || order.some(p => !byPage.has(p))) return;
      if (!refresh && order.length === source.slides.length && order.every((p, i) => p === source.slides[i].page)) return;
      source.slides = order.map(p => byPage.get(p));
      window.PPTEDIT_DOCUMENT_HOST.pageInfo.total = order.length;
      window.PPTEDIT_DOCUMENT_HOST.pageInfo.page = displayPage();
      const idx = document.getElementById('h5ve-slide-idx');
      if (idx) idx.textContent = String(displayPage());
      if (svg.querySelector('#page-number')) svg.querySelector('#page-number').textContent = String(displayPage()).padStart(2, '0');
      const total = document.getElementById('h5ve-slide-total');
      if (total) total.textContent = String(order.length);
      refreshSlidePanel();
    }
    window.PPTEDIT_DOCUMENT_HOST = {
      slidesPanelWidth: 300,
      renderSlidePanel,
      navigateBy: delta => {
        const index = source.slides.findIndex(item => item.page === page);
        const target = source.slides[index + delta];
        if (target) return navigateTo(target.page);
      },
      pageInfo: { page: displayPage(), total: source.slides.length },
      readonlyNotes: source.slide.notes || [],
      loadRevision: async () => source.revision,
      save: async ({ html }) => {
        const svg = markup(html);
        // 以 frame 持有的 source.revision 为唯一基线（含服务端重编页码后的最新值），不用编辑器内部副本。
        const response = await fetch('/save', { method: 'POST', headers, body: JSON.stringify({ page, svg, revision: source.revision }) });
        if (response.ok) {
          try { const data = await response.clone().json(); if (data?.revision) source.revision = data.revision; } catch {}
          savedSvg = svg;
          const cached = thumbnailCache.get(source.slide.file);
          if (cached?.url) URL.revokeObjectURL(cached.url);
          thumbnailCache.set(source.slide.file, { text: Promise.resolve(svg) });
        }
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
      if (event.data?.type === 'pptedit-navigation' && event.data.navigation) {
        source.navigation = event.data.navigation;
        if (Array.isArray(event.data.order)) { applyOrder(event.data.order, true); return; }
        refreshSlidePanel();
      }
      if (event.data?.type === 'pptedit-order' && Array.isArray(event.data.order)) { adoptRevisions(event.data.revisions); applyOrder(event.data.order); }
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
