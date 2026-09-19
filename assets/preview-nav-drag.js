/**
 * 预览侧栏页面拖拽排序（含跨层级）。
 *
 * 设计要点
 * - Pointer Events 驱动，而非 HTML5 DnD：触屏（iPad / 手机横屏）同样可用；没有 dragover 节流
 *   和 ghost 图像的兼容坑。鼠标按下移动 >6px 或触屏长按 320ms 进入拖动。
 * - 所有放置意图归约为一个「插入点」{ parent, before, depth }：
 *     parent : 目标 <details>（章节）或 nav 根；before : 插到该子节点之前（null = 追加到末尾）。
 *   再由 navigation-tree.moveToTreePosition 转成 { parentKey, index } 写回树。
 * - 组块边界歧义（拖到某章节最后一个子项下方）按指针 X 选深度：靠左 = 放到章节外，靠右 = 放进章节末尾。
 * - 章节标题行中段 = 「放进该章节」（折叠章节悬停 480ms 自动展开）。
 * - 指示线是 nav 内部的 absolute 元素，随滚动、被 overflow 裁切，不会被侧栏遮住。
 * - 小屏：≤650px 侧栏隐藏，自然无拖拽；≤1100px 侧栏收窄时缩进按实际 CSS 量取，不写死。
 */
export function installNavDrag({ nav, slides, host, getTree, persist, onApplied, setStatus }) {
  if (!nav || nav.dataset.dragEnhanced) return () => {};
  nav.dataset.dragEnhanced = 'true';
  nav.style.position ||= 'relative';

  const line = document.createElement('div');
  line.className = 'nav-drop-line';
  line.hidden = true;
  const ghost = document.createElement('div');
  ghost.className = 'nav-drag-ghost';
  ghost.hidden = true;
  document.body.append(ghost);

  const HOLD_MS = 320, MOVE_PX = 6, EXPAND_MS = 480;
  // 自动滚动：窄边带 + 低速 + 二次方缓入 + 进入边带 120ms 后才起步。
  // 过宽/过快会让指针停在目标章节头上时列表仍在脚下跑，落点漂到章节末尾。
  // 边带内二次方缓入：贴近内侧 ~1px/帧（便于瞄准），压到边缘/越界 14px/帧（快速长距离移动）。
  const EDGE = 40, SCROLL_MAX = 14, SCROLL_ARM_MS = 120;
  // 侧栏里相邻层级的真实缩进只有 ~7px（行本身不缩进，只有 details 缩进），无法靠它区分深度。
  // 指示线与指针 X 判定都改用显式刻度：每层 INDENT px，从 nav 内边距起算。
  const INDENT = 22, BASE = 12;
  const depthLeft = depth => BASE + depth * INDENT;
  let drag = null;            // { page, row, pointerId, startX, startY, active, plan, raf, expandTimer, expandTarget, lastX, lastY }
  let suppressClickUntil = 0;
  let saving = false;

  const rowOf = target => target?.closest?.('#nav .slide-link, #nav details');
  const summaryOf = target => target?.closest?.('#nav details > summary');
  const childrenOf = parent => [...parent.children].filter(el => el.matches('details, .slide-link'));
  const isOpen = details => details === nav || details.open;
  const depthOf = el => { let d = 0; for (let p = el.parentElement; p && p !== nav; p = p.parentElement) if (p.matches('details')) d++; return d; };
  const childDepth = parent => parent === nav ? 0 : depthOf(parent) + 1;
  const titleOf = parent => parent === nav ? '根级' : parent.querySelector(':scope > summary strong')?.textContent?.trim() || '章节';

  /** 当前可见的、可作为参照的行：summary 或 slide-link（跳过折叠章节的内部、跳过被拖动行本身）。 */
  function visibleItems() {
    const out = [];
    const walk = parent => {
      for (const el of childrenOf(parent)) {
        if (el === drag.row) continue;
        if (el.matches('details')) {
          const s = el.querySelector(':scope > summary');
          if (s) out.push({ el: s, kind: 'summary', details: el, parent });
          if (el.open) walk(el);
        } else out.push({ el, kind: 'page', parent });
      }
    };
    walk(nav);
    return out.filter(item => item.el && item.el.getBoundingClientRect().height > 0);
  }

  /** gap 的候选父级链：从最深（before 所在层）到最浅（沿祖先链一路向上，只在 before 为 null 时才可能向上冒泡）。 */
  function gapCandidates(parent, before) {
    const list = [{ parent, before }];
    if (before) return list;
    // 「追加到 parent 末尾」与「插到 parent 之后（其父级里）」在屏幕上是同一条缝，按 X 区分深度。
    let cursor = parent;
    while (cursor !== nav) {
      const up = cursor.parentElement.closest('details') || nav;
      const siblings = childrenOf(up).filter(el => el !== drag.row);
      const next = siblings[siblings.indexOf(cursor) + 1] || null;
      list.push({ parent: up, before: next });
      if (next) break;
      cursor = up;
    }
    return list;
  }

  function pickByX(candidates, x) {
    // 候选按深度从深到浅；选择「指针 X 落在其刻度起点右侧」的最深一个（留 10px 容差）。
    const navLeft = nav.getBoundingClientRect().left;
    for (const c of candidates) if (x >= navLeft + depthLeft(childDepth(c.parent)) - 10) return c;
    return candidates[candidates.length - 1];
  }

  function resolve(x, y) {
    const items = visibleItems();
    if (!items.length) return null;
    const navRect = nav.getBoundingClientRect();
    // 指针横向离开侧栏（拖到舞台上）：不给落点，松手即取消。
    if (x < navRect.left || x > navRect.right) return null;
    // 指针纵向越界：把 Y 夹到列表可见边缘，落点跟随边缘那一行，行为可预期；滚动由 autoScroll 负责。
    y = Math.min(navRect.bottom - 1, Math.max(navRect.top + 1, y));
    let hovered = null, ratio = 0.5;
    for (const item of items) {
      const r = item.el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) { hovered = item; ratio = (y - r.top) / Math.max(1, r.height); break; }
    }
    let plan;
    if (!hovered) {
      // 落在行间空白或列表尾部：取最近的上一行的下方 / 首行上方。
      const above = [...items].reverse().find(item => item.el.getBoundingClientRect().bottom <= y);
      if (!above) plan = { parent: items[0].parent, before: items[0].kind === 'summary' ? items[0].details : items[0].el, edgeY: items[0].el.getBoundingClientRect().top };
      else plan = gapBelow(above, x);
    } else if (hovered.kind === 'summary') {
      // 标题行：上 30% = 插到该章节之前（同级）；其余 70% = 放进该章节、作为第一项。
      // 「指着章节头」的直觉是把页面放到这一组的开头，而不是末尾；末尾请用最后一行下方的缝（右偏）。
      const r = hovered.el.getBoundingClientRect();
      if (ratio < 0.3) plan = { parent: hovered.parent, before: hovered.details, edgeY: r.top };
      else {
        const first = childrenOf(hovered.details).find(el => el !== drag.row) || null;
        plan = { parent: hovered.details, before: first, inside: true, hostEl: hovered.details, edgeY: r.bottom };
      }
    } else {
      const r = hovered.el.getBoundingClientRect();
      if (ratio < 0.5) plan = { parent: hovered.parent, before: hovered.el, edgeY: r.top };
      else plan = gapBelow(hovered, x);
    }
    if (!plan) return null;
    // 无变化：放回原位（同一父级，且插入点恰为原来的下一个兄弟）
    plan.noop = plan.parent === drag.origin.parent && plan.before === drag.origin.next;
    plan.depth = childDepth(plan.parent);
    plan.navRect = navRect;
    return plan;

    function gapBelow(item, px) {
      const r = item.el.getBoundingClientRect();
      if (item.kind === 'summary' && item.details.open) {
        // 展开章节的标题下方 = 章节开头
        return { parent: item.details, before: childrenOf(item.details).find(el => el !== drag.row) || null, edgeY: r.bottom };
      }
      const anchor = item.kind === 'summary' ? item.details : item.el;
      const parent = item.parent;
      const siblings = childrenOf(parent).filter(el => el !== drag.row);
      const next = siblings[siblings.indexOf(anchor) + 1] || null;
      const chosen = pickByX(gapCandidates(parent, next), px);
      return { ...chosen, edgeY: r.bottom };
    }
  }

  function render(plan) {
    nav._dragPlan = plan; // 调试/测试可读：当前解析出的插入计划
    nav.querySelectorAll('.nav-drop-inside').forEach(el => el.classList.remove('nav-drop-inside'));
    if (!plan || plan.noop) { line.hidden = true; nav.classList.toggle('nav-drop-noop', !!plan?.noop); return; }
    nav.classList.remove('nav-drop-noop');
    if (plan.inside) {
      // 章节头高亮 + 在其正下方画出「第一项」的插入线，落点一目了然；折叠章节悬停后自动展开。
      plan.hostEl.classList.add('nav-drop-inside');
      scheduleExpand(plan.hostEl);
    } else cancelExpand();
    const left = depthLeft(plan.depth) + nav.scrollLeft;
    const top = plan.edgeY - plan.navRect.top + nav.scrollTop;
    const width = plan.navRect.width - depthLeft(plan.depth) - BASE;
    Object.assign(line.style, { left: `${Math.round(left)}px`, top: `${Math.round(top) - 1}px`, width: `${Math.max(40, Math.round(width))}px` });
    line.dataset.label = plan.depth ? `→ ${titleOf(plan.parent)}` : '→ 根级';
    line.hidden = false;
  }

  function scheduleExpand(details) {
    if (!drag || drag.expandTarget === details) return;
    cancelExpand();
    if (details.open) return;
    drag.expandTarget = details;
    drag.expandTimer = setTimeout(() => { if (drag && !details.open) { details.open = true; } }, EXPAND_MS);
  }
  function cancelExpand() { if (!drag) return; clearTimeout(drag.expandTimer); drag.expandTimer = 0; drag.expandTarget = null; }

  function autoScroll() {
    if (!drag?.active) return;
    const r = nav.getBoundingClientRect();
    const { lastX: x, lastY: y } = drag;
    const insideX = x >= r.left && x <= r.right;
    // 距边缘的归一化深度 0..1（越界按 1 算），二次方缓入，最高 SCROLL_MAX px/帧。
    const depth = !insideX ? 0 : y < r.top + EDGE ? Math.min(1, (r.top + EDGE - y) / EDGE) : y > r.bottom - EDGE ? Math.min(1, (y - r.bottom + EDGE) / EDGE) : 0;
    const now = performance.now();
    if (depth > 0) {
      drag.edgeSince ||= now;
      if (now - drag.edgeSince >= SCROLL_ARM_MS) nav.scrollTop += (y < r.top + EDGE ? -1 : 1) * Math.max(1, Math.round(SCROLL_MAX * depth * depth));
    } else drag.edgeSince = 0;
    drag.plan = resolve(x, y);
    render(drag.plan);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function begin() {
    drag.active = true;
    drag.row.classList.add('is-dragging');
    nav.classList.add('is-page-sorting');
    document.documentElement.classList.add('nav-page-sorting');
    const all = childrenOf(drag.row.parentElement);
    drag.origin = { parent: drag.row.parentElement, next: all[all.indexOf(drag.row) + 1] ?? null };

    if (drag.row.matches('.slide-link')) {
      ghost.textContent = `${slides.findIndex(s => String(s.page) === drag.page) + 1}  ${drag.row.querySelector('.nav-slide-title')?.textContent || ''}`.trim();
    } else {
      ghost.textContent = `章节：${drag.row.querySelector(':scope > summary strong')?.textContent || ''}`.trim();
    }

    ghost.hidden = false;
    nav.append(line);
    setStatus?.('拖动调整顺序与层级 · 向左提升 · 松开放置');
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function cleanup() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    cancelExpand();
    drag.row.classList.remove('is-dragging');
    try { drag.row.releasePointerCapture(drag.pointerId); } catch {}
    nav.classList.remove('is-page-sorting', 'nav-drop-noop');
    document.documentElement.classList.remove('nav-page-sorting');
    nav.querySelectorAll('.nav-drop-inside').forEach(el => el.classList.remove('nav-drop-inside'));
    line.hidden = true; line.remove();
    ghost.hidden = true;
    drag = null;
  }

  async function commit(plan) {
    // cleanup() 会把 drag 置空，所有依赖 drag 的量必须先算完。
    const row = drag.row;
    const moving = row.matches('.slide-link') ? Number(drag.page) : row.dataset.chapterKey;
    const parentKey = plan.parent === nav ? null : plan.parent.dataset.chapterKey;
    const siblings = childrenOf(plan.parent).filter(el => el !== row);
    const index = plan.before ? siblings.indexOf(plan.before) : siblings.length;
    cleanup();
    if (saving) return;
    saving = true;
    setStatus?.('正在保存顺序…');
    try {
      const previousOrder = slides.map(slide => slide.page);
      const tree = getTree();
      const result = (await import('./navigation-tree.js')).moveToTreePosition(tree, moving, parentKey, index);
      if (!result) throw new Error('目标位置无效，请刷新后重试');
      // 跨层级移动可能不改变扁平顺序（如从子章节末尾挪到父级紧随其后），只比顺序会漏掉结构变化。
      const sameOrder = result.order.every((page, i) => page === previousOrder[i]);
      const sameTree = JSON.stringify(result.tree) === JSON.stringify((await import('./navigation-tree.js')).normalizeTree(tree, previousOrder));
      if (sameOrder && sameTree) { setStatus?.(''); return; }
      const saved = await persist({ order: result.order, previousOrder, navigation: result.tree });
      onApplied?.({ ...result, result: saved });
      const n = saved?.renumber?.updated?.length || 0;
      setStatus?.(n ? `顺序已保存 · 已校对 ${n} 页页码` : '顺序已保存 · 可继续拖动');
    } catch (error) {
      setStatus?.(`排序失败：${error.message}`);
    } finally { saving = false; }
  }

  nav.addEventListener('pointerdown', event => {
    if (drag || saving || event.button !== 0) return;
    if (event.target.closest('.nav-chapter-edit, dialog')) return;
    const row = rowOf(event.target);
    if (!row) return;
    // 如果点的是 summary，确保它是 handle 而不是为了展开章节
    if (row.matches('details') && !event.target.closest('summary')) return;

    drag = {
      page: row.dataset.page,
      row,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      plan: null,
      raf: 0,
      expandTimer: 0,
      expandTarget: null,
      touch: event.pointerType !== 'mouse'
    };
    if (drag.touch) {
      drag.holdTimer = setTimeout(() => { if (drag && !drag.active) { row.setPointerCapture(event.pointerId); begin(); } }, HOLD_MS);
    }
  });

  nav.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX; drag.lastY = event.clientY;
    if (!drag.active) {
      const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (drag.touch) { if (moved > MOVE_PX * 1.5) { clearTimeout(drag.holdTimer); drag = null; } return; } // 触屏：先滑动就是滚动
      if (moved < MOVE_PX) return;
      drag.row.setPointerCapture(event.pointerId);
      begin();
    }
    event.preventDefault();
  });
  const finish = event => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    clearTimeout(drag.holdTimer);
    if (!drag.active) { drag = null; return; }
    suppressClickUntil = performance.now() + 300;
    const plan = drag.plan;
    if (event?.type === 'pointerup' && plan && !plan.noop) {
      commit(plan).catch(error => { cleanup(); setStatus?.(`排序失败：${error.message}`); });
    } else { cleanup(); setStatus?.(''); }
  };
  nav.addEventListener('pointerup', finish);
  nav.addEventListener('pointercancel', finish);
  window.addEventListener('blur', () => finish());
  window.addEventListener('keydown', event => { if (event.key === 'Escape' && drag?.active) { event.preventDefault(); event.stopImmediatePropagation(); finish(); } }, true);
  // 缩略图 <img> 默认可原生拖拽，会抢走 pointer 事件序列。
  nav.addEventListener('dragstart', event => { if (rowOf(event.target)) event.preventDefault(); });
  // 拖动结束后的那次 click 不要触发翻页 / 展开章节。
  nav.addEventListener('click', event => { if (performance.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  // 触屏：拖动进行中禁止页面滚动（非 passive 才能 preventDefault）。
  nav.addEventListener('touchmove', event => { if (drag?.active) event.preventDefault(); }, { passive: false });
  // 幽灵标签跟随指针
  // 幽灵标签放在指针右下 26px：避开指示线右端的目标章节名 chip（chip 在线上方 20px）。
  window.addEventListener('pointermove', event => { if (drag?.active) { ghost.style.transform = `translate(${event.clientX + 16}px, ${event.clientY + 26}px)`; } }, { passive: true });

  return () => { cleanup(); ghost.remove(); delete nav.dataset.dragEnhanced; };
}
