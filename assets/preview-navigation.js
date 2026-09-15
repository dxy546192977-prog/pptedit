/* Visual page navigation built on the host's existing slide buttons and handlers. */
(() => {
  const nav = document.getElementById('nav');
  const identity = document.querySelector('.sidebar .identity');
  const host = window.PPT_NARRATION_HOST;
  if (!nav || !identity || !host || nav.dataset.enhanced) return;
  nav.dataset.enhanced = 'true';
  const slides = host.getSlides();
  const slideByPage = new Map(slides.map(slide => [String(slide.page), slide]));
  const switcher = document.createElement('div');
  switcher.className = 'nav-view-switch';
  switcher.setAttribute('role', 'group');
  switcher.setAttribute('aria-label', '目录显示方式');
  switcher.innerHTML = '<button type="button" data-view="thumbnails" aria-pressed="true">缩略图</button><button type="button" data-view="outline" aria-pressed="false">大纲</button>';
  identity.append(switcher);
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
    } else if (child.classList.contains('slide-link') && group) {
      const slide = slideByPage.get(child.dataset.page);
      if (!slide) continue;
      const image = document.createElement('img');
      image.className = 'nav-thumbnail';
      image.src = slide.file;
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
      group.details.append(child);
      group.rows.push(child);
    }
  }
  const pageLabel = value => String(value).padStart(2, '0');
  // The host supplies nested sections; leaf values identify chapter start pages.
  const hierarchy = JSON.parse(nav.dataset.chapterGroups || '[]');
  function nestChapters() {
    function build(section) {
      if (typeof section !== 'object') return groups.find(g => g.rows[0]?.dataset.page === String(section))?.details;
      const children = (section.children || []).map(build).filter(Boolean);
      if (!children.length) return null;
      const details = document.createElement('details');
      details.className = 'nav-chapter nav-section';
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
    const rows = new Map([...nav.querySelectorAll('.slide-link')].map(row => [row.dataset.page, row]));
    groups.length = 0;
    nav.replaceChildren();
    let current;
    for (const slide of slides) {
      const page = String(slide.page);
      if (!current || chapterTemplates.has(page)) {
        const details = document.createElement('details');
        details.className = 'nav-chapter';
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
    preservedPage = null;
  });
  function revealCurrent() {
    const row = nav.querySelector('.slide-link.current');
    if (!row) return;
    for (const details of nav.querySelectorAll('details')) {
      const active = details.contains(row);
      details.classList.toggle('current-chapter', active);
      if (active && row.dataset.page !== preservedPage && !document.fullscreenElement) details.open = true;
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
    for (const button of switcher.children) button.setAttribute('aria-pressed', String(button.dataset.view === nav.dataset.view));
    // Hidden outline thumbnails should not consume image loading bandwidth.
    revealCurrent();
  }
  let savedView;
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
