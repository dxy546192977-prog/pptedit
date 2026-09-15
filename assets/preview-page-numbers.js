/* Stable page IDs route content; presentation positions are the visible numbers. */
(() => {
  const host = window.PPT_NARRATION_HOST;
  if (!host) return;
  const label = n => String(n).padStart(2, '0');
  const position = id => host.getSlides().findIndex(s => String(s.page) === String(id)) + 1;
  host.normalizeSvg = (text, id) => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const number = doc.querySelector('[id="page-number"]');
    if (number) number.textContent = label(position(id));
    return new XMLSerializer().serializeToString(doc.documentElement);
  };
  const rendered = new WeakMap();
  async function updateImage(img, id) {
    const src = img.getAttribute('src');
    const stamp = `${id}:${position(id)}:${src}`;
    if (!src || rendered.get(img) === stamp) return;
    rendered.set(img, stamp);
    try {
      const response = await fetch(src, { cache: 'no-cache' });
      if (!response.ok) return;
      const text = await response.text();
      if (img.getAttribute('src') !== src || rendered.get(img) !== stamp) return;
      const next = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(host.normalizeSvg(text, id));
      rendered.set(img, `${id}:${position(id)}:${next}`);
      img.src = next;
    } catch (error) { console.warn('页码同步失败', id, error); }
  }
  function update() {
    const slides = host.getSlides();
    const current = slides[host.getIndex()];
    const identity = document.querySelector('.sidebar .identity p');
    if (identity) identity.textContent = identity.textContent.replace(/\d+\s*页/, `${slides.length} 页`);
    for (const row of document.querySelectorAll('.slide-link, .thumb')) {
      const id = row.dataset.page;
      const slide = slides.find(s => String(s.page) === id);
      if (!slide) continue;
      const number = position(id);
      const text = row.querySelector('.nav-slide-number') || (row.matches('.slide-link') ? row.querySelector('span') : null);
      if (text) text.textContent = label(number);
      const caption = row.matches('.thumb') && row.querySelector('p');
      if (caption) caption.textContent = `${label(number)}  /  ${slide.title}`;
      row.title = `第 ${number} 页 · ${slide.title}`;
      row.setAttribute('aria-label', row.title);
      const img = row.querySelector('img');
      if (img) void updateImage(img, id);
    }
    for (const group of document.querySelectorAll('.nav-chapter')) {
      const rows = [...group.querySelectorAll('.slide-link')];
      const range = group.querySelector(':scope > summary .nav-chapter-range');
      if (range && rows.length) range.textContent = `${label(position(rows[0].dataset.page))}–${label(position(rows.at(-1).dataset.page))}`;
    }
    if (current) {
      const counter = document.getElementById('counter');
      const value = `${label(host.getIndex() + 1)} / ${slides.length}`;
      if (counter && counter.textContent !== value) counter.textContent = value;
      const img = document.getElementById('slide');
      if (img) { img.alt = `${label(host.getIndex() + 1)} · ${current.title}`; void updateImage(img, current.page); }
    }
  }
  const canvas = document.getElementById('slide');
  if (canvas) new MutationObserver(update).observe(canvas, { attributes: true, attributeFilter: ['src'] });
  window.addEventListener('pptedit-order-changed', update);
  update();
})();
