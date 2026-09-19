import { moveInTree } from './navigation-tree.js';

// Use the same save/apply path as sidebar sorting; never rearrange only the DOM.
export function installOverviewDrag({ slides, getTree, persist, onApplied }) {
  const overview = document.getElementById('overview');
  const grid = overview?.querySelector('#grid, .grid');
  if (!grid || grid.dataset.dragEnhanced) return;
  grid.dataset.dragEnhanced = 'true';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = '拖动页面调整顺序 · 点击打开 · Esc 取消拖动';
  grid.before(status);
  const line = document.createElement('div');
  line.style.cssText = 'position:fixed;width:2px;background:#029d4c;pointer-events:none;z-index:2147483647';
  line.hidden = true;
  overview.append(line);
  let drag, saving = false, suppressUntil = 0;
  const card = target => target.closest?.('.thumb[data-page]');
  function cleanup() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    clearTimeout(drag.hold);
    drag.row.style.opacity = drag.opacity;
    try { drag.row.releasePointerCapture(drag.id); } catch {}
    drag = null;
    line.hidden = true;
  }
  function locate() {
    if (!drag?.active) return;
    const bounds = overview.getBoundingClientRect();
    if (drag.y < bounds.top + 55) overview.scrollTop -= 12;
    if (drag.y > bounds.bottom - 55) overview.scrollTop += 12;
    const rows = [...grid.querySelectorAll('.thumb[data-page]')];
    const nearest = rows.map(row => {
      const r = row.getBoundingClientRect();
      return { row, r, distance: Math.hypot(Math.max(r.left-drag.x,0,drag.x-r.right), Math.max(r.top-drag.y,0,drag.y-r.bottom)) };
    }).sort((a,b) => a.distance-b.distance)[0];
    drag.target = null;
    line.hidden = true;
    if (nearest && drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
      drag.target = nearest.row;
      drag.after = drag.x > nearest.r.left + nearest.r.width / 2;
      line.hidden = nearest.row === drag.row;
      line.style.left = (drag.after ? nearest.r.right : nearest.r.left) + 'px';
      line.style.top = nearest.r.top + 'px';
      line.style.height = nearest.r.height + 'px';
    }
    drag.raf = requestAnimationFrame(locate);
  }
  function begin() {
    drag.active = true;
    drag.row.setPointerCapture(drag.id);
    drag.row.style.opacity = '.4';
    locate();
  }
  grid.addEventListener('pointerdown', event => {
    const row = card(event.target);
    if (!row || saving || drag || event.button !== 0) return;
    drag = { row, id:event.pointerId, x:event.clientX, y:event.clientY, startX:event.clientX, startY:event.clientY, opacity:row.style.opacity, touch:event.pointerType !== 'mouse' };
    if (drag.touch) drag.hold = setTimeout(begin, 320);
  });
  grid.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x-drag.startX,drag.y-drag.startY)>6) {
      if (drag.touch) { cleanup(); return; }
      begin();
    }
    if (drag?.active) event.preventDefault();
  });
  grid.addEventListener('pointerup', async event => {
    if (!drag || drag.id !== event.pointerId) return;
    const { row, target, after, active } = drag;
    if (active) suppressUntil = Date.now()+400;
    cleanup();
    if (!active || !target || target === row) return;
    const previousOrder = slides.map(slide=>slide.page);
    const moving = Number(row.dataset.page), anchor = Number(target.dataset.page);
    const order = previousOrder.filter(page=>page!==moving);
    order.splice(order.indexOf(anchor)+Number(after),0,moving);
    if (order.every((page,i)=>page===previousOrder[i])) return;
    const tree = moveInTree(getTree(), order, moving, anchor, after);
    saving = true;
    status.textContent = '正在保存演讲顺序…';
    try {
      const result = await persist({ order, previousOrder, navigation:tree });
      onApplied({ order, tree, result });
      status.textContent = '演讲顺序已保存';
    } catch (error) { status.textContent = `排序失败：${error.message}`; }
    finally { saving = false; }
  });
  grid.addEventListener('click', event => {
    if (Date.now()<suppressUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  grid.addEventListener('dragstart', event => { if(card(event.target)) event.preventDefault(); });
  grid.addEventListener('touchmove', event => { if(drag?.active) event.preventDefault(); }, {passive:false});
  grid.addEventListener('pointercancel', cleanup);
  grid.addEventListener('lostpointercapture', cleanup);
  window.addEventListener('blur', cleanup);
  window.addEventListener('keydown', event => {
    if(event.key === 'Escape' && drag) {
      suppressUntil = Date.now()+400;
      cleanup(); event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
}
