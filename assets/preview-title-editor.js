(() => {
  const host = window.PPT_NARRATION_HOST;
  const title = document.getElementById('current-title');
  if (!host || !title || document.querySelector('.page-title-dialog')) return;
  title.setAttribute('role', 'button');
  title.tabIndex = 0;
  title.title = '修改页面标题';
  title.setAttribute('aria-label', '修改页面标题');
  const dialog = document.createElement('dialog');
  dialog.className = 'page-title-dialog';
  dialog.setAttribute('aria-label', '修改页面标题');
  dialog.innerHTML = '<form><h3>修改页面标题</h3><label>页面标题<input name="title" maxlength="300" required autocomplete="off"></label><p role="status"></p><footer><button type="button" data-cancel>取消</button><button type="submit">保存标题</button></footer></form>';
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  const status = dialog.querySelector('[role="status"]');
  const save = dialog.querySelector('[type="submit"]');
  let slide, previousTitle, saving = false;
  function open() {
    slide = host.getSlides()[host.getIndex()];
    previousTitle = slide.title;
    input.value = previousTitle;
    status.textContent = '';
    dialog.showModal(); input.focus(); input.select();
  }
  title.addEventListener('click', open);
  title.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); open(); }
  });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.querySelector('[data-cancel]').onclick = () => { if (!saving) dialog.close(); };
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) { status.textContent = '请输入页面标题'; return; }
    if (saving) return;
    if (value === previousTitle) { dialog.close(); return; }
    saving = true; save.disabled = true; input.disabled = true;
    status.textContent = '正在保存…';
    try {
      const config = window.PPTEDIT_PREVIEW_CONFIG;
      if (!config?.url) throw Error('未连接本地编辑服务');
      const response = await fetch(new URL('/rename-page', config.url), {
        method: 'POST', headers: {'Content-Type': 'application/json', 'X-PPTedit-Token': config.token},
        body: JSON.stringify({page: slide.page, previousTitle, title: value})
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || '保存失败');
      slide.title = result.title;
      document.querySelectorAll('[data-page]').forEach(node => {
        if (String(node.dataset.page) !== String(slide.page)) return;
        const label = node.querySelector('.nav-slide-title');
        if (label) label.textContent = result.title;
        if (node.classList.contains('slide-link')) {
          node.title = '第 ' + slide.page + ' 页 · ' + result.title;
          node.setAttribute('aria-label', node.title);
        }
        if (node.classList.contains('thumb')) node.querySelector('p').textContent = String(slide.page).padStart(2, '0') + '  /  ' + result.title;
        const image = node.querySelector('img');
        if (image) image.alt = result.title;
      });
      host.goTo(host.getIndex());
      dialog.close(); title.focus();
    } catch (error) { status.textContent = error.message || '保存失败，请检查本地编辑服务'; }
    finally { saving = false; save.disabled = false; input.disabled = false; }
  };
})();
