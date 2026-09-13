/* Resizable speaker notes; preserve the slide's design aspect ratio. */
(() => {
  const notes = document.getElementById('notes');
  const area = document.querySelector('.stage-area');
  const stage = document.getElementById('stage');
  if (!notes || !area || !stage || document.getElementById('notes-resizer')) return;
  const handle = document.createElement('div');
  handle.id = 'notes-resizer';
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', '调整讲述备注高度');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-controls', 'notes-content');
  handle.title = '向上拖动展开备注；双击恢复默认高度';
  notes.prepend(handle);
  let requested;
  try { const value = Number(localStorage.getItem('pptedit.notesHeight')); if (value > 0) requested = value; } catch {}
  const bounds = () => ({ min: 100, max: Math.max(100, Math.min(innerHeight * .65, notes.parentElement.clientHeight - 220)) });
  function sizeNotes(value) {
    const { min, max } = bounds();
    const height = Math.round(Math.max(min, Math.min(max, value)));
    notes.style.height = height + 'px';
    handle.setAttribute('aria-valuemin', min);
    handle.setAttribute('aria-valuemax', Math.round(max));
    handle.setAttribute('aria-valuenow', height);
  }
  function fit() {
    if (document.fullscreenElement === stage) { stage.style.width = ''; stage.style.height = ''; return; }
    const css = getComputedStyle(area);
    const w = Math.max(0, area.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
    const h = Math.max(0, area.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom));
    const width = Math.min(w, h * 16 / 9);
    stage.style.width = width + 'px';
    stage.style.height = width * 9 / 16 + 'px';
  }
  function persist() { try { localStorage.setItem('pptedit.notesHeight', requested); } catch {} }
  let drag;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag = { y: event.clientY, height: notes.getBoundingClientRect().height };
    handle.setPointerCapture(event.pointerId);
    document.documentElement.classList.add('notes-resizing');
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    sizeNotes(drag.height + drag.y - event.clientY);
    requested = parseFloat(notes.style.height);
  });
  function finish() { if (!drag) return; drag = null; document.documentElement.classList.remove('notes-resizing'); if (requested) persist(); }
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('dblclick', () => { requested = undefined; try { localStorage.removeItem('pptedit.notesHeight'); } catch {} sizeNotes(innerHeight * .18); });
  handle.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { min, max } = bounds();
    sizeNotes(event.key === 'Home' ? min : event.key === 'End' ? max : notes.offsetHeight + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 50 : 20));
    requested = parseFloat(notes.style.height); persist();
  });
  sizeNotes(requested || innerHeight * .18);
  new ResizeObserver(fit).observe(area);
  window.addEventListener('resize', () => sizeNotes(requested || innerHeight * .18));
  document.addEventListener('fullscreenchange', fit);
})();
