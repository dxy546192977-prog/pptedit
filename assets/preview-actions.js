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
  menu.addEventListener('click', event => { if (event.target.closest('button')) close(); });
  document.addEventListener('pointerdown', event => { if (!overflow.contains(event.target)) close(); });
  overflow.addEventListener('focusout', event => { if (!overflow.contains(event.relatedTarget)) close(); });
  overflow.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { close(); trigger.focus(); }
  });
})();
