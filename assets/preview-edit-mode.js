/* Keep the preview and each edited page alive so returning does not discard undo. */
(() => {
  const bar = document.querySelector('.bottom');
  const host = window.PPT_NARRATION_HOST;
  const config = window.PPTEDIT_PREVIEW_CONFIG;
  if (!bar || !host || !config || document.querySelector('.preview-mode-switch')) return;
  // Page IDs identify SVGs; array positions define the presentation order.
  for (const row of document.querySelectorAll('.slide-link, .thumb')) {
    row.onclick = () => {
      const overview = document.getElementById('overview');
      if (row.classList.contains('thumb') && overview) overview.hidden = true;
      host.goTo(host.getSlides().findIndex(slide => slide.page === Number(row.dataset.page)));
    };
  }
  const mode = document.createElement('div');
  mode.className = 'preview-mode-switch';
  mode.setAttribute('role', 'group');
  mode.setAttribute('aria-label', '页面模式');
  mode.innerHTML = '<button type="button" aria-pressed="true">预览</button><button type="button" aria-pressed="false">编辑</button>';
  bar.prepend(mode);
  const [previewButton, editButton] = mode.children;
  const status = document.createElement('p');
  status.className = 'preview-mode-status';
  status.setAttribute('role', 'status');
  mode.after(status);
  const overlay = document.createElement('div');
  overlay.className = 'pptedit-overlay';
  overlay.hidden = true;
  overlay.innerHTML = '<header><strong>PPTedit · 编辑模式</strong><button type="button">保存并返回预览</button></header><div class="pptedit-frame-area"></div>';
  document.body.append(overlay);
  const frames = new Map();
  let active;
  let pending;
  let transitionTimer;
  let previousFocus;
  let request = 0;
  const origin = new URL(config.url).origin;
  const heading = overlay.querySelector('strong');
  const returnButton = overlay.querySelector('button');
  function cancelPending(message = '') {
    clearTimeout(transitionTimer);
    if (pending && pending !== active) {
      if (pending.ready) pending.frame.hidden = true;
      else { pending.frame.remove(); frames.delete(pending.page); }
    }
    pending = undefined;
    if (active) {
      active.frame.inert = false;
      active.frame.style.opacity = '';
      active.frame.style.pointerEvents = '';
      active.frame.contentWindow.postMessage({ type: 'pptedit-active' }, origin);
    }
    heading.textContent = message || (active ? `PPTedit · 第 ${active.page} 页 · ${active.title}` : 'PPTedit · 编辑模式');
    returnButton.textContent = active ? '保存并返回预览' : '返回预览';
  }
  function prepare(record) {
    record.frame.contentWindow.postMessage({ type: 'pptedit-prepare', request }, origin);
  }
  function commit(record) {
    clearTimeout(transitionTimer);
    active = record;
    pending = undefined;
    for (const item of frames.values()) {
      item.frame.hidden = item !== active;
      item.frame.style.opacity = '';
      item.frame.style.pointerEvents = '';
      item.frame.inert = item !== active;
    }
    const next = host.getSlides().findIndex(slide => slide.page === active.page);
    if (next !== host.getIndex()) host.goTo(next);
    heading.textContent = `PPTedit · 第 ${active.page} 页 · ${active.title}`;
    returnButton.textContent = '保存并返回预览';
    active.frame.contentWindow.postMessage({ type: 'pptedit-active' }, origin);
  }
  const setMode = editing => {
    previewButton.setAttribute('aria-pressed', String(!editing));
    editButton.setAttribute('aria-pressed', String(editing));
    overlay.hidden = !editing;
    document.querySelector('.app').inert = editing;
    if (!editing) previousFocus?.focus();
  };
  async function showSavedPreview(record, svg) {
    if (typeof svg !== 'string' || !svg.trim()) {
      heading.textContent = '未收到已保存的画面，请重新保存并返回预览';
      return;
    }
    try {
      const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const image = new Image();
      image.src = src;
      await image.decode();
      if (active !== record || pending || overlay.hidden) return;
      const canvas = document.getElementById('slide');
      if (!canvas) throw new Error('预览画布不存在');
      canvas.src = src;
      for (const img of document.querySelectorAll(`[data-page="${record.page}"] img`)) img.src = src;
      setMode(false);
    } catch {
      heading.textContent = '已保存，但预览更新失败，请重试；编辑内容已保留';
    }
  }
  editButton.onclick = async (targetPage) => {
    if (pending) return;
    const serial = ++request;
    editButton.disabled = true;
    status.textContent = '正在连接编辑器…';
    try {
      if (overlay.hidden) {
        const response = await fetch(config.url + '/health', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('编辑服务未就绪');
      }
      if (serial !== request) return;
      const slide = host.getSlides().find(item => item.page === targetPage) || host.getSlides()[host.getIndex()];
      if (document.getElementById('narration-play')?.getAttribute('aria-pressed') === 'true') document.getElementById('narration-play').click();
      document.querySelectorAll('video').forEach(video => video.pause());
      if (overlay.hidden) previousFocus = document.activeElement;
      pending = frames.get(slide.page);
      if (!pending) {
        const frame = document.createElement('iframe');
        frame.title = '编辑第 ' + slide.page + ' 页：' + slide.title;
        frame.onload = () => {
          const chapters = {};
          for (const group of document.querySelectorAll('.nav-chapter')) {
            const first = group.querySelector('.slide-link');
            const title = group.querySelector('.nav-chapter-text');
            if (first && title) chapters[first.dataset.page] = [...title.children].map(item => item.textContent).filter(Boolean).join(' · ');
          }
          frame.contentWindow.postMessage({
            type: 'pptedit-manifest', page: slide.page,
            slides: host.getSlides().map(({page, title, file}) => ({page, title, file})), chapters
          }, origin);
        };
        frame.src = config.url + '/editor.html?edit=1&page=' + slide.page + '#token=' + encodeURIComponent(config.token) + '&parent=' + encodeURIComponent(/^https?:/.test(location.protocol) ? location.origin : 'null');
        frame.allow = 'clipboard-write';
        frame.style.opacity = '0';
        frame.style.pointerEvents = 'none';
        overlay.querySelector('.pptedit-frame-area').append(frame);
        pending = { frame, page: slide.page, title: slide.title, ready: false };
        frames.set(slide.page, pending);
      }
      pending.frame.hidden = false;
      pending.frame.style.opacity = '0';
      pending.frame.style.pointerEvents = 'none';
      pending.frame.inert = true;
      if (active) active.frame.inert = true;
      heading.textContent = `正在打开第 ${slide.page} 页…`;
      returnButton.textContent = '取消切换';
      setMode(true);
      transitionTimer = setTimeout(() => cancelPending('页面加载超时，已保留当前页，请重试'), 15000);
      if (pending.ready) prepare(pending);
      status.textContent = '';
    } catch {
      cancelPending('编辑器连接失败，请重试');
      status.textContent = '编辑服务未启动，请运行制作源中的「启动PPTedit编辑器.cmd」后重试';
    } finally { editButton.disabled = false; }
  };
  overlay.querySelector('button').onclick = () => {
    if (pending) { ++request; cancelPending(); if (!active) setMode(false); return; }
    if (active?.ready) active.frame.contentWindow.postMessage({ type: 'pptedit-return' }, origin);
    else { ++request; setMode(false); }
  };
  previewButton.onclick = () => setMode(false);
  addEventListener('message', event => {
    const record = frames.get(event.data?.page);
    if (event.origin !== origin || !record || event.source !== record.frame.contentWindow) return;
    if (event.data.type === 'pptedit-manifest-request') record.frame.onload();
    if (event.data.type === 'pptedit-ready') {
      record.ready = true;
      if (record === pending) prepare(record);
    }
    if (event.data.type === 'pptedit-painted' && record === pending && event.data.request === request) commit(record);
    if (event.data.type === 'pptedit-error' && record === pending) cancelPending('页面加载失败，已保留当前页，请重试');
    if (record !== active || pending) return;
    if (event.data.type === 'pptedit-reordered') {
      const slides = host.getSlides();
      const byPage = new Map(slides.map(slide => [slide.page, slide]));
      const order = event.data.order;
      if (!Array.isArray(order) || order.length !== slides.length || new Set(order).size !== slides.length || order.some(p => !byPage.has(p))) return;
      slides.splice(0, slides.length, ...order.map(p => byPage.get(p)));
      dispatchEvent(new Event('pptedit-order-changed'));
      for (const p of order) {
        const thumb = document.querySelector(`.thumb[data-page="${p}"]`);
        if (thumb) thumb.parentNode.append(thumb);
      }
      for (const item of frames.values()) item.frame.contentWindow.postMessage({ type: 'pptedit-order', order }, origin);
      host.goTo(slides.findIndex(slide => slide.page === active.page));
    }
    if (event.data.type === 'pptedit-navigate') {
      const next = host.getSlides().findIndex(slide => slide.page === event.data.targetPage);
      if (next < 0) return;
      editButton.onclick(event.data.targetPage);
    }
    if (event.data.type === 'pptedit-preview') void showSavedPreview(record, event.data.svg);
    if (event.data.type === 'pptedit-error') { status.textContent = '编辑器加载失败，请返回预览后重试'; }
  });
  // The parent still has its preview keyboard handler; never let it flip a hidden slide.
  addEventListener('keydown', event => { if (!overlay.hidden) event.stopImmediatePropagation(); }, true);
})();
