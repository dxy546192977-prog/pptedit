/* Audio-aligned character highlighting and seeking. No duration interpolation fallback. */
(() => {
  function create(container, onSeek) {
    let timed = [], active = null, frame = 0, media = null, phrases = new Map(), activePhrase = null;
    function update(time, follow = true) {
      let lo = 0, hi = timed.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (timed[mid].start <= time) lo = mid + 1; else hi = mid; }
      const candidate = timed[lo - 1];
      const next = candidate && time < candidate.end ? candidate.node : null;
      const phrase = candidate ? phrases.get(candidate.node) : null;
      if (phrase !== activePhrase) {
        activePhrase?.forEach(node => node.classList.remove('current-phrase'));
        activePhrase = phrase;
        activePhrase?.forEach(node => node.classList.add('current-phrase'));
      }
      if (next === active) return;
      active?.classList.remove('current-char');
      active = next;
      active?.classList.add('current-char');
      if (!active || !follow) return;
      const box = active.getBoundingClientRect(), viewport = container.getBoundingClientRect();
      if (box.top < viewport.top + 12 || box.bottom > viewport.bottom - 12) {
        container.scrollTo({ top: container.scrollTop + box.top - viewport.top - viewport.height * .4, behavior: 'smooth' });
      }
    }
    function stop() { cancelAnimationFrame(frame); frame = 0; container.dataset.reading = "false"; }
    function tick() { update(media.currentTime, true); if (!media.paused && !media.ended) frame = requestAnimationFrame(tick); }
    function start(audio) { stop(); media = audio; container.dataset.reading = "true"; frame = requestAnimationFrame(tick); }
    function render(slide, alignment, canPlay) {
      active = null; timed = []; phrases = new Map(); activePhrase = null;
      container.dataset.charAligned = String(Boolean(alignment));
      const paragraphs = (slide.notes || []).map((text, p) => {
        const paragraph = document.createElement('p');
        paragraph.className = 'note-paragraph';
        paragraph.tabIndex = canPlay ? 0 : -1;
        let charIndex = 0, phrase = [];
        for (const part of text.split(/(\*\*.*?\*\*)/g)) {
          const bold = part.startsWith('**') && part.endsWith('**');
          const parent = bold ? document.createElement('strong') : paragraph;
          const content = bold ? part.slice(2, -2) : part;
          for (const char of Array.from(content)) {
            const node = document.createElement('span');
            node.className = 'note-char'; node.textContent = char;
            phrase.push(node); phrases.set(node, phrase);
            if (/[，。！？；!?;]/.test(char) || /[,.]/.test(char) && !/\d/.test(text.replace(/\*\*/g, '')[charIndex + 1] || '')) phrase = [];
            const pair = alignment?.chars?.[p]?.[charIndex++];
            if (pair) {
              node.dataset.start = pair[0]; node.dataset.end = pair[1];
              node.tabIndex = -1;
              node.setAttribute('role', 'button');
              node.setAttribute('aria-label', `从“${char}”开始朗读`);
              timed.push({node, start: pair[0], end: pair[1]});
            }
            parent.append(node);
          }
          if (bold) paragraph.append(parent);
        }
        const seek = event => {
          if (event.type === 'click' && window.getSelection?.()?.toString()) return;
          const target = event.target.closest('.note-char');
          let node = target?.hasAttribute('data-start') ? target : null;
          if (!node && target) {
            const chars = [...paragraph.querySelectorAll('.note-char')];
            const index = chars.indexOf(target);
            node = chars.slice(index + 1).find(char => char.hasAttribute('data-start')) ||
              chars.slice(0, index).reverse().find(char => char.hasAttribute('data-start'));
          }
          node ||= paragraph.querySelector('.note-char[data-start]');
          if (node) { node.focus({preventScroll: true}); onSeek(Number(node.dataset.start)); }
          else if (canPlay) onSeek(null);
        };
        paragraph.addEventListener('click', seek);
        paragraph.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); seek(event); }
          if (['ArrowLeft', 'ArrowRight'].includes(event.key) && event.target.matches('.note-char')) {
            event.preventDefault(); event.stopPropagation();
            const index = timed.findIndex(item => item.node === event.target);
            const next = timed[index + (event.key === 'ArrowRight' ? 1 : -1)];
            next?.node.focus({preventScroll: true});
          }
        });
        return paragraph;
      });
      container.replaceChildren(...paragraphs);
    }
    return { render, update, start, stop };
  }
  window.PPT_NARRATION_CHARACTERS = { create };
})();
