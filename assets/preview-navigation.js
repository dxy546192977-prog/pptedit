/* Visual page navigation built on the host's existing slide buttons and handlers. */
(async () => {
  const { normalizeTree, groupInTree } = await import('./navigation-tree.js');
  const nav = document.getElementById('nav');
  const identity = document.querySelector('.sidebar .identity');
  const host = window.PPT_NARRATION_HOST;
  if (!nav || !identity || !host || nav.dataset.enhanced) return;
  nav.dataset.enhanced = 'true';
  const slides = host.getSlides();
  // 页 id 统一为数字：index.html 里偶见 "28.2" 字符串，严格相等会让章节树/侧栏悄悄丢页
  for (const slide of slides) if (typeof slide.page === 'string' && slide.page.trim() !== '' && !Number.isNaN(Number(slide.page))) slide.page = Number(slide.page);

  // ---- 刷新后恢复：位置 / 章节展开收起 / 侧栏滚动（sessionStorage，按 deck 路径隔离） ----
  // hash 里放的是稳定页 id（分享链接不怕重排）；但重排/删页后 id 可能不在了，这时回到「上次所在位置」而不是第一页。
  const storeKey = name => `pptedit:${name}:${location.pathname}`;
  const store = {
    get(name) { try { return JSON.parse(sessionStorage.getItem(storeKey(name))); } catch { return null; } },
    set(name, value) { try { sessionStorage.setItem(storeKey(name), JSON.stringify(value)); } catch {} },
  };
  const rememberPosition = () => store.set('pos', host.getIndex());
  // 章节展开状态：以用户最近一次操作为准，覆盖章节树里的默认 open 标记
  const rememberChapters = () => store.set('chapters', Object.fromEntries([...nav.querySelectorAll('details[data-chapter-key]')].map(d => [d.dataset.chapterKey, d.open])));
  const applyRememberedChapters = () => {
    const saved = store.get('chapters'); if (!saved) return false;
    for (const d of nav.querySelectorAll('details[data-chapter-key]')) if (d.dataset.chapterKey in saved) d.open = !!saved[d.dataset.chapterKey];
    return true;
  };
  let restoringChapters = false; // build/restore 期间不把默认 open 记录为用户意图
  // 修正首屏落点：hash 指向的页 id 不存在（被删/改 id）时，host 已回退到第 0 页 → 改到上次位置
  (function fixInitialPosition() {
    const hashId = Number(location.hash.slice(1));
    if (!location.hash || Number.isNaN(hashId)) return;
    const exists = slides.some(slide => slide.page === hashId);
    if (exists) return;
    const last = store.get('pos');
    if (typeof last === 'number' && last > 0 && last < slides.length) host.goTo(last);
  })();
  // 一次页面加载内所有缩略图共用同一版本号，避免每张图都产生独立缓存条目。
  const thumbnailVersion = Date.now().toString(36);
  const slideByPage = new Map(slides.map(slide => [String(slide.page), slide]));
  const switcher = document.createElement('div');
  switcher.className = 'nav-view-switch';
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', '目录显示方式');
  switcher.innerHTML = '<button type="button" data-view="thumbnails" aria-pressed="true">缩略图</button><button type="button" data-view="outline" aria-pressed="false">大纲</button>';
  identity.append(switcher);
  let keepCollapsed = store.get('nav-all-collapsed') === true;
  const expansionToggle = document.createElement('button');
  expansionToggle.type = 'button';
  expansionToggle.className = 'nav-expansion-toggle';
  expansionToggle.setAttribute('aria-controls', 'nav');
  switcher.append(expansionToggle);
  function syncExpansionToggle() {
    const chapters = [...nav.querySelectorAll('details')];
    const expanded = chapters.length > 0 && chapters.every(chapter => chapter.open);
    expansionToggle.textContent = expanded ? '收起全部' : '展开全部';
    expansionToggle.setAttribute('aria-expanded', String(expanded));
    expansionToggle.title = expanded ? '收起子页面，仅保留主框架' : '展开所有章节和子页面';
    expansionToggle.disabled = !chapters.length;
  }
  expansionToggle.addEventListener('click', () => {
    const expand = expansionToggle.getAttribute('aria-expanded') !== 'true';
    keepCollapsed = !expand;
    store.set('nav-all-collapsed', keepCollapsed);
    for (const chapter of nav.querySelectorAll('details')) chapter.open = expand;
    rememberChapters();
    syncExpansionToggle();
  });
  const groups = [];
  let group;
  for (const child of [...nav.children]) {
    if (child.classList.contains('chapter')) {
      const details = document.createElement('details');
      details.className = 'nav-chapter';
      const summary = document.createElement('summary');
      const text = document.createElement('span');
      text.className = 'nav-chapter-text';
      const [name, ...description] = child.textContent.split(' · ');
      const title = document.createElement('strong');
      title.textContent = name;
      const subtitle = document.createElement('span');
      subtitle.textContent = description.join(' · ');
      text.append(title, subtitle);
      const range = document.createElement('span');
      range.className = 'nav-chapter-range';
      summary.append(text, range);
      details.append(summary);
      child.replaceWith(details);
      group = { details, range, rows: [] };
      groups.push(group);
      summary.addEventListener('keydown', event => {
        if ([' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
      });
    } else if (child.classList.contains('slide-link')) {
      const slide = slideByPage.get(child.dataset.page);
      if (!slide) continue;
      const image = document.createElement('img');
      image.className = 'nav-thumbnail';
      // 与主舞台 show() 保持同一缓存策略：SVG 文件被重新导出/改名重排后，
      // 缩略图不能再命中浏览器旧缓存，否则左侧封面与实际演示内容不一致。
      // 舞台上由 HTML/iframe 覆盖层承载内容的页面，SVG 只是底稿；
      // 元数据可声明 thumbnail（静帧）让封面与实际演示一致。
      const cover = slide.thumbnail || slide.file;
      image.src = cover + (cover.includes('?') ? '&' : '?') + 'v=' + thumbnailVersion;
      if (slide.thumbnail) image.dataset.staticCover = '1';
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      const info = document.createElement('span');
      info.className = 'nav-slide-info';
      const number = document.createElement('span');
      number.className = 'nav-slide-number';
      number.textContent = String(slide.page).padStart(2, '0');
      const title = document.createElement('span');
      title.className = 'nav-slide-title';
      title.textContent = slide.title;
      info.append(number, title);
      child.replaceChildren(image, info);
      child.title = `第 ${slide.page} 页 · ${slide.title}`;
      child.setAttribute('aria-label', child.title);
      if (group) {
        group.details.append(child);
        group.rows.push(child);
        group.details.dataset.chapterKey ||= 'page:' + child.dataset.page;
      }
    }
  }
  const pageLabel = value => String(value).padStart(2, '0');
  // The host supplies nested sections; leaf values identify chapter start pages.
  const hierarchy = JSON.parse(nav.dataset.chapterGroups || '[]');
  function nestChapters() {
    function build(section, indexPath) {
      if (typeof section !== 'object') return groups.find(g => g.rows[0]?.dataset.page === String(section))?.details;
      const children = (section.children || []).map((child, i) => build(child, `${indexPath}.${i}`)).filter(Boolean);
      if (!children.length) return null;
      // Chapter configuration describes membership, never the presentation order.
      // Only wrap adjacent siblings; gathering separated sections would move pages.
      children.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
      if (children.some((child, i) => child.parentElement !== children[0].parentElement ||
          (i > 0 && children[i - 1].nextElementSibling !== child))) return null;
      const details = document.createElement('details');
      details.className = 'nav-chapter nav-section';
      details.dataset.chapterKey = 'section:' + indexPath;
      details.open = true;
      const summary = document.createElement('summary');
      const title = document.createElement('strong');
      title.textContent = section.title;
      const text = document.createElement('span');
      text.className = 'nav-chapter-text';
      text.append(title);
      const range = document.createElement('span');
      range.className = 'nav-chapter-range';
      summary.append(text, range);
      children[0].before(details);
      details.append(summary, ...children);
      const rows = [...details.querySelectorAll('.slide-link')];
      range.textContent = `${pageLabel(rows[0].dataset.page)}–${pageLabel(rows.at(-1).dataset.page)}`;
      return details;
    }
    hierarchy.forEach(build);
  }
  for (const { range, rows } of groups) {
    if (rows.length) range.textContent = `${pageLabel(rows[0].dataset.page)}–${pageLabel(rows.at(-1).dataset.page)}`;
  }
  let preservedPage = null;
  const chapterTemplates = new Map(groups.filter(g => g.rows.length).map(g => [g.rows[0].dataset.page, g.details.querySelector('summary').cloneNode(true)]));
  window.addEventListener('pptedit-order-changed', () => {
    if (chapterSettings.__navigation?.tree) {
      applyChapterSettings();
      preservedPage = null;
      window.dispatchEvent(new Event('pptedit-navigation-changed'));
      return;
    }
    const rows = new Map([...nav.querySelectorAll('.slide-link')].map(row => [row.dataset.page, row]));
    groups.length = 0;
    nav.replaceChildren();
    let current;
    for (const slide of slides) {
      const page = String(slide.page);
      if (!current || chapterTemplates.has(page)) {
        const details = document.createElement('details');
        details.className = 'nav-chapter';
        details.dataset.chapterKey = 'page:' + page;
        details.open = true;
        const summary = chapterTemplates.get(page)?.cloneNode(true) || document.createElement('summary');
        if (!summary.children.length) summary.innerHTML = '<span class="nav-chapter-text"><strong>演讲顺序</strong></span><span class="nav-chapter-range"></span>';
        summary.addEventListener('keydown', event => {
          if ([' ', 'Enter', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
        });
        details.append(summary);
        nav.append(details);
        current = { details, range: summary.querySelector('.nav-chapter-range'), rows: [] };
        groups.push(current);
      }
      const row = rows.get(page);
      if (row) { current.details.append(row); current.rows.push(row); }
    }
    for (const g of groups) if (g.rows.length && g.range) g.range.textContent = `${pageLabel(g.rows[0].dataset.page)}–${pageLabel(g.rows.at(-1).dataset.page)}`;
    nestChapters();
    applyChapterSettings();
    preservedPage = null;
    window.dispatchEvent(new Event('pptedit-navigation-changed'));
  });
  let revealAfterImages = 0;
  function revealCurrent() {
    const row = nav.querySelector('.slide-link.current');
    if (!row) return;
    rememberPosition();
    for (const details of nav.querySelectorAll('details')) {
      const active = details.contains(row);
      details.classList.toggle('current-chapter', active);
      if (active && !keepCollapsed && row.dataset.page !== preservedPage && !document.fullscreenElement) details.open = true;
    }
    if (document.fullscreenElement) return;
    const position = host.getIndex();
    const small = document.querySelector('.toolbar .label small');
    const chapter = row.closest('details')?.querySelector('summary strong')?.textContent || '演讲顺序';
    if (small) small.textContent = `FY27 / ${chapter} · 第 ${pageLabel(position + 1)} 页，共 ${slides.length} 页`;
    if (position === 0) { nav.scrollTop = 0; return; }
    const bounds = nav.getBoundingClientRect();
    const focused = nav.contains(document.activeElement) ? document.activeElement.closest('summary, .slide-link') : null;
    const rect = visibleTarget(focused || row).getBoundingClientRect();
    if (rect.top < bounds.top + 12) nav.scrollTop += rect.top - bounds.top - 12;
    else if (rect.bottom > bounds.bottom - 12) nav.scrollTop += rect.bottom - bounds.bottom + 12;
  }
  function setView(view) {
    nav.dataset.view = view === 'outline' ? 'outline' : 'thumbnails';
    for (const button of switcher.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === nav.dataset.view));
    // Hidden outline thumbnails should not consume image loading bandwidth.
    revealCurrent();
  }
  let savedView;
  let chapterSettings = {};
  host.getNavigation = () => {
    const read = container => [...container.children].flatMap(node => {
      if (node.matches('.slide-link')) return [{ page: Number(node.dataset.page) }];
      if (!node.matches('details')) return [];
      const text = node.querySelector(':scope > summary .nav-chapter-text');
      return [{ key: node.dataset.chapterKey, title: text?.querySelector('strong')?.textContent || '', subtitle: text?.querySelector('span')?.textContent || '', open: node.open, children: read(node) }];
    });
    return { tree: read(nav), view: nav.dataset.view };
  };
  host.editChapter = key => {
    const details = [...nav.querySelectorAll('details')].find(node => node.dataset.chapterKey === key);
    if (details) editChapter(details);
  };
  host.setChapterOpen = (key, open) => {
    const details = [...nav.querySelectorAll('details')].find(node => node.dataset.chapterKey === key);
    if (details) details.open = open;
  };
  const chapterDialog = document.createElement('dialog');
  chapterDialog.className = 'nav-chapter-dialog';
  chapterDialog.innerHTML = '<form><h3>编辑章节</h3><label>章节名称<input name="title" maxlength="100" required autocomplete="off"></label><p>解组后，内容移到上一层，页面和顺序保持不变。</p><p role="status"></p><footer><button type="button" data-ungroup>解组</button><button type="button" data-cancel>取消</button><button type="submit">保存名称</button></footer></form>';
  document.body.append(chapterDialog);
  let editingChapter, groupingPages;
  const chapterInput = chapterDialog.querySelector('input');
  const chapterStatus = chapterDialog.querySelector('[role="status"]');
  function editChapter(details) {
    groupingPages = null;
    chapterDialog.querySelector('h3').textContent = '编辑章节';
    chapterDialog.querySelector('p').textContent = '解组后，内容移到上一层，页面和顺序保持不变。';
    chapterDialog.querySelector('[data-ungroup]').hidden = false;
    chapterDialog.querySelector('[type=submit]').textContent = '保存名称';
    editingChapter = details;
    chapterInput.value = details.querySelector('summary strong').textContent;
    chapterStatus.textContent = '';
    chapterDialog.showModal();
    chapterInput.select();
  }
  host.groupPages = pages => {
    if (!Array.isArray(pages) || chapterDialog.open) return;
    const selected = new Set(pages);
    groupingPages = slides.filter(slide => selected.has(slide.page)).map(slide => slide.page);
    if (groupingPages.length < 2) { groupingPages = null; return; }
    editingChapter = null;
    chapterDialog.querySelector('h3').textContent = `将 ${groupingPages.length} 页组成子章节`;
    chapterDialog.querySelector('p').textContent = '选中页面将按当前顺序收拢到首个选中页的位置。';
    chapterDialog.querySelector('[data-ungroup]').hidden = true;
    chapterDialog.querySelector('[type=submit]').textContent = '创建子章节';
    chapterInput.value = '新子章节'; chapterStatus.textContent = '';
    chapterDialog.showModal(); chapterInput.select();
  };
  function applyCustomChapters() {
    for (const details of [...nav.querySelectorAll('[data-custom-chapter]')].reverse()) {
      details.replaceWith(...[...details.children].filter(child => child.tagName !== 'SUMMARY'));
    }
    const rank = new Map(slides.map((slide, i) => [String(slide.page), i]));
    for (const [key, setting] of Object.entries(chapterSettings)) {
      if (!Array.isArray(setting.pages) || setting.ungrouped) continue;
      const selected = new Set(setting.pages.map(String));
      const rows = [...nav.querySelectorAll('.slide-link')].filter(row => selected.has(row.dataset.page));
      if (!rows.length) continue;
      // Dragging pages apart must never pull them back into an old group order.
      const first = rank.get(rows[0].dataset.page), last = rank.get(rows.at(-1).dataset.page);
      if (last - first + 1 !== rows.length) continue;
      let container = rows[0].parentElement;
      while (container !== nav && !rows.every(row => container.contains(row))) container = container.parentElement;
      const details = document.createElement('details');
      details.className = 'nav-chapter'; details.dataset.chapterKey = key;
      details.dataset.customChapter = 'true'; details.open = true;
      const summary = document.createElement('summary');
      const text = document.createElement('span'); text.className = 'nav-chapter-text';
      const title = document.createElement('strong'); title.textContent = setting.title;
      text.append(title);
      const range = document.createElement('span'); range.className = 'nav-chapter-range';
      range.textContent = `${pageLabel(first + 1)}–${pageLabel(last + 1)}`;
      summary.append(text, range); details.append(summary, ...rows);
      for (const empty of [...container.querySelectorAll('details')].reverse()) {
        if (!empty.querySelector('.slide-link')) empty.remove();
      }
      const next = [...container.children].find(child => {
        const row = child.matches('.slide-link') ? child : child.querySelector('.slide-link');
        return row && rank.get(row.dataset.page) > first;
      });
      container.insertBefore(details, next || null);
    }
  }
  function restoreNavigation(tree) {
    restoringChapters = true;
    try { return restoreNavigationInner(tree); }
    finally { restoringChapters = false; applyRememberedChapters(); }
  }
  function restoreNavigationInner(tree) {
    const rows = new Map([...nav.querySelectorAll('.slide-link')].map(row => [Number(row.dataset.page), row]));
    const build = nodes => nodes.map(node => {
      if ('page' in node) return rows.get(node.page);
      const details = document.createElement('details');
      details.className = 'nav-chapter'; details.dataset.chapterKey = node.key;
      if (node.key.startsWith('section:') || node.children.some(child => child.children)) details.classList.add('nav-section');
      details.open = node.open !== false;
      const summary = document.createElement('summary'), text = document.createElement('span');
      text.className = 'nav-chapter-text';
      const title = document.createElement('strong'); title.textContent = node.title; text.append(title);
      if (node.subtitle) { const subtitle = document.createElement('span'); subtitle.textContent = node.subtitle; text.append(subtitle); }
      const range = document.createElement('span'); range.className = 'nav-chapter-range';
      summary.append(text, range); details.append(summary, ...build(node.children)); return details;
    }).filter(Boolean);
    nav.replaceChildren(...build(normalizeTree(tree, slides.map(slide => slide.page))));
  }
  host.acceptNavigation = tree => { chapterSettings.__navigation = { tree }; };
  function applyChapterSettings() {
    if (chapterSettings.__navigation?.tree) restoreNavigation(chapterSettings.__navigation.tree);
    else applyCustomChapters();
    for (const details of [...nav.querySelectorAll('details[data-chapter-key]')]) {
      const setting = chapterSettings[details.dataset.chapterKey];
      if (setting?.ungrouped) {
        details.replaceWith(...[...details.children].filter(child => child.tagName !== 'SUMMARY'));
        continue;
      }
      const summary = details.querySelector(':scope > summary');
      const rows = [...details.querySelectorAll('.slide-link')];
      const range = summary.querySelector('.nav-chapter-range');
      if (range && rows.length) {
        const position = row => slides.findIndex(slide => String(slide.page) === row.dataset.page) + 1;
        range.textContent = `${pageLabel(position(rows[0]))}–${pageLabel(position(rows.at(-1)))}`;
      }
      if (setting?.title) summary.querySelector('strong').textContent = setting.title;
      if (!summary.querySelector('.nav-chapter-edit')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'nav-chapter-edit';
        button.textContent = '⋯';
        button.title = '编辑章节名称或解组';
        button.setAttribute('aria-label', '编辑章节名称或解组');
        summary.append(button);
      }
    }
  }
  nav.addEventListener('click', event => {
    if (!event.target.closest('.nav-chapter-edit')) return;
    event.preventDefault();
    event.stopPropagation();
    editChapter(event.target.closest('details'));
  });
  nav.addEventListener('dblclick', event => {
    if (!event.target.closest('.nav-chapter-text')) return;
    event.preventDefault();
    editChapter(event.target.closest('details'));
  });
  chapterDialog.querySelector('[data-cancel]').onclick = () => chapterDialog.close();
  async function saveChapter(ungrouped = false) {
    const title = chapterInput.value.trim();
    if (!ungrouped && !title) { chapterStatus.textContent = '请输入章节名称'; return; }
    const config = window.PPTEDIT_PREVIEW_CONFIG;
    const key = groupingPages ? 'custom:' + crypto.randomUUID() : editingChapter.dataset.chapterKey;
    const settings = { ...chapterSettings, [key]: { ...chapterSettings[key], ...(groupingPages ? { title, pages: groupingPages } : ungrouped ? { ungrouped: true } : { title }) } };
    const previousOrder = slides.map(slide => slide.page);
    let order;
    if (groupingPages) {
      const selected = new Set(groupingPages);
      const first = previousOrder.findIndex(page => selected.has(page));
      order = previousOrder.filter(page => !selected.has(page));
      order.splice(first, 0, ...previousOrder.filter(page => selected.has(page)));
      settings.__navigation = { tree: groupInTree(host.getNavigation().tree, order, groupingPages, key, title) };
    }
    const buttons = [...chapterDialog.querySelectorAll('button')];
    buttons.forEach(button => button.disabled = true);
    try {
      if (!config) throw Error('请先启动本地编辑服务');
      const response = await fetch(new URL('/chapters', config.url), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PPTedit-Token': config.token }, body: JSON.stringify({ previous: chapterSettings, settings, ...(order ? { order, previousOrder } : {}) }) });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '章节保存失败');
      chapterSettings = settings;
      if (order) {
        const current = slides[host.getIndex()]?.page;
        const byPage = new Map(slides.map(slide => [slide.page, slide]));
        slides.splice(0, slides.length, ...order.map(page => byPage.get(page)));
        window.dispatchEvent(new Event('pptedit-order-changed'));
        for (const page of order) {
          const thumb = document.querySelector(`.thumb[data-page="${page}"]`);
          if (thumb) thumb.parentNode.append(thumb);
        }
        host.goTo(slides.findIndex(slide => slide.page === current));
      } else {
        applyChapterSettings();
        window.dispatchEvent(new Event('pptedit-navigation-changed'));
      }
      groupingPages = null;
      chapterDialog.close();
      revealCurrent();
    } catch (error) { chapterStatus.textContent = error.message; }
    finally { buttons.forEach(button => button.disabled = false); }
  }
  // 预览态直接拖动缩略图排序（含跨层级）。持久化复用编辑服务的 /reorder，
  // 成功后与编辑器回传 pptedit-reordered 时走同一条刷新链路。
  import('./preview-nav-drag.js').then(({ installNavDrag }) => {
    let statusEl = nav.parentElement?.querySelector('.nav-drag-status');
    if (!statusEl) {
      statusEl = document.createElement('p');
      statusEl.className = 'nav-drag-status';
      statusEl.setAttribute('role', 'status');
      statusEl.hidden = true;
      nav.before(statusEl);
    }
    let statusTimer = 0;
    const setStatus = text => {
      clearTimeout(statusTimer);
      statusEl.textContent = text || '';
      statusEl.hidden = !text;
      if (text && !/失败|正在/.test(text)) statusTimer = setTimeout(() => { statusEl.hidden = true; }, 2200);
    };
    installNavDrag({
      nav, slides, host, setStatus,
      getTree: () => host.getNavigation().tree,
      persist: async ({ order, previousOrder, navigation }) => {
        const config = window.PPTEDIT_PREVIEW_CONFIG;
        if (!config) throw new Error('请先启动本地编辑服务');
        const response = await fetch(new URL('/reorder', config.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-PPTedit-Token': config.token },
          body: JSON.stringify({ order, previousOrder, navigation }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `保存失败（HTTP ${response.status}）`);
        return result; // 含 renumber: {updated, revisions}
      },
      onApplied: ({ order, tree, result }) => {
        const current = slides[host.getIndex()]?.page;
        const byPage = new Map(slides.map(slide => [slide.page, slide]));
        slides.splice(0, slides.length, ...order.map(page => byPage.get(page)));
        chapterSettings.__navigation = { tree };
        // 带 detail：preview-edit-mode 据此把新顺序 + 新 revision 转给已打开的编辑器 frame；
        // preview-page-numbers 据此重算所有页码并校对。
        window.dispatchEvent(new CustomEvent('pptedit-order-changed', { detail: { order, revisions: result?.renumber?.revisions, renumber: result?.renumber } }));
        for (const page of order) {
          const thumb = document.querySelector(`.thumb[data-page="${page}"]`);
          if (thumb) thumb.parentNode.append(thumb);
        }
        host.goTo(slides.findIndex(slide => slide.page === current));
        revealCurrent();
      },
    });
  });
  chapterDialog.querySelector('form').onsubmit = event => { event.preventDefault(); void saveChapter(); };
  chapterDialog.querySelector('[data-ungroup]').onclick = () => void saveChapter(true);
  fetch('chapter-settings.json', { cache: 'no-store' }).then(async response => {
    if (response.ok) chapterSettings = await response.json();
    applyChapterSettings();
    applyRememberedChapters();
    revealCurrent();
    window.dispatchEvent(new Event('pptedit-navigation-changed'));
  }).catch(() => { applyChapterSettings(); applyRememberedChapters(); revealCurrent(); });
  try { savedView = localStorage.getItem('ppt-preview-nav-view'); } catch {}
  nestChapters();
  setView(savedView);
  switcher.addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    setView(button.dataset.view);
    try { localStorage.setItem('ppt-preview-nav-view', nav.dataset.view); } catch {}
  });
  new MutationObserver(revealCurrent).observe(document.getElementById('counter'), { childList: true, characterData: true, subtree: true });
  // 章节展开/收起（点击、键盘、revealCurrent 自动展开）都记住；build/restore 期间的默认值不算
  new MutationObserver(() => { if (!restoringChapters) rememberChapters(); }).observe(nav, { attributes: true, attributeFilter: ['open'], subtree: true });
  new MutationObserver(syncExpansionToggle).observe(nav, { attributes: true, attributeFilter: ['open'], childList: true, subtree: true });
  syncExpansionToggle();
  // 缩略图加载后行高才确定：首屏 revealCurrent 常在图片加载前跑，当前行会被顶出可视区 → 图片加载完再校正一次
  nav.addEventListener('load', event => {
    if (!(event.target instanceof HTMLImageElement)) return;
    clearTimeout(revealAfterImages); revealAfterImages = setTimeout(revealCurrent, 80);
  }, true);
  window.addEventListener('load', () => setTimeout(revealCurrent, 0), { once: true });

  function visibleTarget(row) {
    let target = row;
    for (let parent = row.parentElement; parent && parent !== nav; parent = parent.parentElement) {
      if (parent.matches('details') && !parent.open && target !== parent.querySelector(':scope > summary')) target = parent.querySelector(':scope > summary');
    }
    return target;
  }
  function selectItem(item) {
    const row = nav.querySelector('.slide-link.current');
    preservedPage = item.matches('.slide-link') ? item.dataset.page : row?.dataset.page;
    if (item.matches('.slide-link') && item !== row) {
      host.goTo(slides.findIndex(slide => String(slide.page) === item.dataset.page));
    }
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
  }
  // Every visible heading and page is a separate keyboard selection.
  window.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"], [role="separator"], #notes, video, dialog, [role="dialog"]')) return;
    if (document.querySelector('#overview:not([hidden])')) return;
    if (document.fullscreenElement) {
      const directions = { ArrowUp: -1, ArrowLeft: -1, PageUp: -1, ArrowDown: 1, ArrowRight: 1, PageDown: 1, ' ': 1 };
      if (!(event.key in directions) && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : host.getIndex() + directions[event.key];
      host.goTo(Math.max(0, Math.min(slides.length - 1, index)));
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const row = nav.querySelector('.slide-link.current');
    const current = groups.find(item => item.rows.includes(row));
    if (!current) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const focused = event.target.closest('#nav summary, #nav .slide-link');
    const selected = visibleTarget(focused || row);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      preservedPage = row.dataset.page;
      const details = selected.closest('details');
      if (!details) return;
      if (event.key === 'ArrowLeft') {
        if (details.open) {
          details.open = false;
          selectItem(details.querySelector(':scope > summary'));
        } else {
          const parent = details.parentElement.closest('details');
          selectItem((parent || details).querySelector(':scope > summary'));
        }
      } else if (!details.open) {
        details.open = true;
        selectItem(details.querySelector(':scope > summary'));
      } else if (selected.matches('summary')) {
        const child = details.querySelector(':scope > details > summary, :scope > .slide-link');
        if (child) selectItem(child);
      }
      return;
    }
    const visible = [...nav.querySelectorAll('summary, .slide-link')].filter(item => visibleTarget(item) === item);
    const position = visible.indexOf(selected);
    const next = visible[position + (event.key === 'ArrowUp' ? -1 : 1)];
    if (!next) return;
    selectItem(next);
  }, true);
  const hint = document.querySelector('.bottom .hint');
  if (hint) {
    hint.setAttribute('aria-label', '快捷键：上下选择目录，左键收起章节或返回上级，右键展开章节，F 全屏，全屏时方向键逐页翻页，G 总览');
    const item = hint.querySelector('.hint-item');
    if (item) item.textContent = '↑↓ 选择　← 收起　→ 展开';
  }
  nav.addEventListener('keydown', event => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      event.stopPropagation();
      host.goTo(event.key === 'Home' ? 0 : slides.length - 1);
    }
  });
})();
