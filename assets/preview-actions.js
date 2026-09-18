/* Consolidate existing controls without replacing their host event handlers. */
(() => {
  const bar = document.querySelector('.bottom');
  const toolbar = document.querySelector('.toolbar');
  if (!bar || !toolbar || bar.classList.contains('unified-actions')) return;
  bar.classList.add('unified-actions');
  const style = document.createElement('style');
  style.textContent = `
    .toolbar{min-height:64px;padding-block:12px}
    .bottom.unified-actions{align-items:center;gap:20px;margin:0 28px 14px;padding:12px 14px;border:1px solid #2b3830;border-radius:12px;background:#151e18;position:relative;flex-wrap:wrap}
    .bottom.unified-actions .hint{display:none}
    .page-navigation{display:flex;align-items:center;gap:8px;flex-shrink:0}
    .page-navigation button{display:flex;align-items:center;justify-content:center;width:32px;height:36px;padding:6px;border:0;color:#9baaa1}
    .page-navigation .counter{min-width:54px;text-align:center;font-size:12px}
    .unified-actions .narration-player{order:0;flex:1;min-width:200px;max-width:420px;margin:0 auto 0 0;padding:0 0 0 20px;border:0;border-left:1px solid #314439}
    .unified-actions [data-settings]{display:none}
    .unified-actions .narration-controls>select[data-rate]{flex-shrink:0;max-width:94px;height:36px;padding:0 7px;border:1px solid #314439;border-radius:7px;background:#1b261f;color:#c3d5c9;font:inherit;color-scheme:dark;cursor:pointer}
    .unified-actions #copy-svg{height:38px;border:1px solid #46614f;border-radius:8px;padding:0 14px;color:#d7ebde;background:#213329}
    .action-overflow{position:relative;flex-shrink:0}
    .action-overflow>button{display:flex;align-items:center;gap:7px;height:38px;border:0;color:#9baaa1;padding:0 9px}
    .action-menu{position:absolute;bottom:calc(100% + 20px);right:0;width:220px;max-height:60dvh;overflow:auto;padding:8px;border:1px solid #3a4b40;border-radius:12px;background:#1b261f;box-shadow:0 12px 40px #0008;z-index:60}
    .action-menu[hidden]{display:none}
    .action-menu>button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;padding:10px 12px;float:none!important;font-size:13px!important}
    .action-menu .menu-shortcuts{border-top:1px solid #314439;margin:6px 4px 0;padding:10px 8px 4px;font-size:11px;color:#82998a}
    .unified-actions #copy-status:not(:empty){flex-basis:100%}
    @media(max-width:1000px){.bottom.unified-actions{margin-inline:18px;gap:10px}.unified-actions .narration-player{padding-left:10px}}
    @media(max-width:760px){.bottom.unified-actions{margin-inline:12px;padding:10px;gap:8px}.unified-actions .narration-player{order:2;flex:1 0 100%;max-width:none;padding:10px 0 0;border-left:0;border-top:1px solid #314439}.page-navigation{margin-right:auto}.unified-actions #copy-svg{margin-left:0}.unified-actions #copy-status{order:3}}
    /* ≤600px 收纳态：栏内只剩 翻页 / 播放讲稿 / 更多；被收进菜单的控件按菜单项排版 */
    @media(max-width:600px){
      .bottom.unified-actions.is-compact{gap:8px 10px}
      .bottom.unified-actions.is-compact .narration-player{order:0;flex:1 1 auto;min-width:0;padding:0;border:0}
      .bottom.unified-actions.is-compact .narration-timeline{display:none}
      .bottom.unified-actions.is-compact .narration-controls>select[data-rate]{display:none}
      .bottom.unified-actions.is-compact .page-navigation{margin-right:0}
      .bottom.unified-actions.is-compact .action-overflow{margin-left:auto}
      .action-menu>.is-in-menu{display:flex;align-items:center;gap:10px;width:100%;margin:0;padding:10px 12px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:13px}
      .action-menu>#copy-svg.is-in-menu{height:auto;color:inherit;justify-content:flex-start}
      .action-menu>.preview-mode-switch.is-in-menu{gap:2px;padding:6px;margin:4px 0;border:1px solid #ffffff18}
      .action-menu>.preview-mode-switch.is-in-menu button{flex:1;justify-content:center;padding:9px 0}
      .action-menu>.preview-mode-switch.is-in-menu button>span{position:static;width:auto;height:auto;margin:0;clip:auto;clip-path:none}
    }
  `;
  document.head.append(style);
  const navigation = document.createElement('div');
  navigation.className = 'page-navigation';
  navigation.setAttribute('role', 'group');
  navigation.setAttribute('aria-label', '页面切换');
  ['prev', 'counter', 'next'].forEach(id => navigation.append(document.getElementById(id)));
  bar.prepend(navigation);
  const overflow = document.createElement('div');
  overflow.className = 'action-overflow';
  overflow.innerHTML = '<button type="button" aria-expanded="false" aria-controls="preview-action-menu">更多 <span aria-hidden="true">···</span></button><div class="action-menu" id="preview-action-menu" aria-label="更多操作" hidden></div>';
  const trigger = overflow.querySelector('button');
  const menu = overflow.querySelector('.action-menu');
  const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
  trigger.onclick = () => { menu.hidden = !menu.hidden; trigger.setAttribute('aria-expanded', String(!menu.hidden)); };
  ['show-overview', 'fullscreen', 'show-notes'].forEach(id => {
    const control = document.getElementById(id);
    if (control) menu.append(control);
  });
  const settings = document.querySelector('[data-settings]');
  const rate = document.querySelector('[data-rate]');
  if (rate && settings) {
    const label = rate.closest('label');
    settings.before(rate);
    rate.title = '播放倍速';
    rate.setAttribute('aria-label', '播放倍速');
    label?.remove();
  }
  if (settings) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = '播放设置';
    control.dataset.menuSettings = '';  // 图标选择器用稳定标记，不依赖 :last-of-type（收纳态会插入其它按钮）
    control.onclick = () => { settings.click(); document.querySelector('[data-continuous]')?.focus(); };
    menu.append(control);
  }
  const shortcuts = document.createElement('div');
  shortcuts.className = 'menu-shortcuts';
  shortcuts.textContent = '↑↓ 翻页　← 收起　→ 展开　F 全屏　G 总览';
  menu.append(shortcuts);
  bar.insertBefore(overflow, document.getElementById('copy-status'));
  const reference = document.getElementById('layout-reference-open');
  if (reference) bar.insertBefore(reference, overflow);
  // 极小屏（手机竖屏）：操作栏只保留「翻页 / 播放讲稿 / 更多」，其余低频功能收进菜单，
  // 避免折成三四行占掉 1/3 屏。切回宽屏时原位还回，功能一个不少。
  const compact = window.matchMedia('(max-width: 600px)');
  const anchors = new Map();
  const collapsible = () => [
    document.getElementById('copy-svg'),
    document.getElementById('layout-reference-open'),
    document.querySelector('.preview-mode-switch'),
  ].filter(Boolean);
  const applyCompact = () => {
    const nodes = collapsible();
    if (compact.matches) {
      bar.classList.add('is-compact');
      // 记录「原父级 + 当时的兄弟序列」而不是 nextSibling：多个节点共享同一个 nextSibling
      // 时，逐个还回会倒序；按原序列找第一个仍在原父级里的后继节点才能稳定复位。
      const snapshot = [...bar.children];
      nodes.forEach(node => {
        if (node.parentElement === menu) return;
        anchors.set(node, { parent: node.parentElement, siblings: snapshot.slice(snapshot.indexOf(node) + 1) });
        node.classList.add('is-in-menu');
        menu.insertBefore(node, shortcuts);
      });
    } else {
      bar.classList.remove('is-compact');
      // 按原 DOM 顺序还回，保证多个节点之间的相对次序也和收纳前一致。
      const restoreOrder = [...anchors.keys()].filter(node => nodes.includes(node));
      restoreOrder.forEach(node => {
        const anchor = anchors.get(node);
        if (!anchor || node.parentElement !== menu) return;
        node.classList.remove('is-in-menu');
        const next = anchor.siblings.find(sibling => sibling.parentElement === anchor.parent);
        if (next) anchor.parent.insertBefore(node, next);
        else anchor.parent.append(node);
        anchors.delete(node);
      });
      close();
    }
  };
  applyCompact();
  compact.addEventListener('change', applyCompact);
  // 其他脚本（如 preview-edit-mode）可能在本脚本之后才把模式切换插进栏里，再补一次。
  new MutationObserver(() => { if (compact.matches) applyCompact(); }).observe(bar, { childList: true });
  menu.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button) return;
    // 菜单里的「预览 / 编辑」是一组两态按钮，点它不关菜单，让用户看到状态切换。
    if (button.closest('.preview-mode-switch')) return;
    close();
  });
  document.addEventListener('pointerdown', event => { if (!overflow.contains(event.target)) close(); });
  overflow.addEventListener('focusout', event => { if (!overflow.contains(event.relatedTarget)) close(); });
  overflow.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { close(); trigger.focus(); }
  });
})();
