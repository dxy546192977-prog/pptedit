/* Offline rehearsal player. Host supplies slides, show(index), and a generated manifest. */
(() => {
  'use strict';
  const config = window.PPT_NARRATION_HOST;
  if (!config || document.querySelector('#narration-play[data-narration-bound="true"]')) return;
  const { getSlides, getIndex, goTo } = config;
  const bottom = document.querySelector('.bottom');
  const notes = document.getElementById('notes');
  if (!bottom || !notes) return;
  let manifest = window.PPT_NARRATION || { slides: {} };
  let liveState = null;
  const button = document.getElementById('narration-play') || document.createElement('button');
  button.dataset.narrationBound = 'true';
  button.id = 'narration-play';
  button.type = 'button';
  const icon = name => {
    const paths = {
      play: '<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
      pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
      settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
      restart: '<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>'
    };
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths[name] + '</svg>';
  };
  button.innerHTML = icon('play') + '<span>播放讲稿</span>';
  button.title = '自然男声讲稿试听 · AI 合成';
  bottom.classList.add('has-narration');
  const player = document.createElement('div');
  player.className = 'narration-player';
  player.setAttribute('role', 'group');
  player.setAttribute('aria-label', '讲稿试听');
  const hint = bottom.querySelector('.hint');
  if (hint) hint.after(player);
  else bottom.prepend(player);
  const panel = document.createElement('div');
  panel.className = 'narration-controls';
  panel.innerHTML = '<div class="narration-timeline"><input data-seek type="range" min="0" max="1000" value="0" aria-label="讲稿播放进度"><span data-time>00:00 / 00:00</span></div><button type="button" data-settings aria-label="播放设置" aria-expanded="false" aria-controls="narration-options" title="播放设置">' + icon('settings') + '</button><div id="narration-options" class="narration-options" hidden><div class="narration-options-heading">播放设置</div><label>语速 <select data-rate aria-label="讲稿播放速度"><option value="0.85">0.85×</option><option value="1" selected>1× 正常</option><option value="1.15">1.15×</option></select></label><label class="narration-continuous">连续播放<input data-continuous type="checkbox" role="switch"><span class="narration-switch" aria-hidden="true"></span></label><button type="button" data-restart title="从头播放本页">' + icon('restart') + '<span>从头播放本页</span></button></div>';
  panel.prepend(button);
  player.append(panel);
  const status = document.createElement('span');
  status.dataset.status = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-atomic', 'true');
  player.append(status);
  const settings = panel.querySelector('[data-settings]');
  const options = panel.querySelector('.narration-options');
  const closeSettings = () => { options.hidden = true; settings.setAttribute('aria-expanded', 'false'); };
  settings.onclick = () => {
    options.hidden = !options.hidden;
    settings.setAttribute('aria-expanded', String(!options.hidden));
  };
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target)) closeSettings();
  });
  panel.addEventListener('focusout', event => {
    if (!panel.contains(event.relatedTarget)) closeSettings();
  });
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.preservesPitch = true;
  const seek = panel.querySelector('[data-seek]');
  const time = panel.querySelector('[data-time]');
  const restart = panel.querySelector('[data-restart]');
  const rate = panel.querySelector('[data-rate]');
  const continuous = panel.querySelector('[data-continuous]');
  let active = -1;
  let activeNotes = null;
  let activeVersion = null;
  let record = null;
  let serial = 0;
  const format = seconds => {
    const n = Math.max(0, Math.round(Number(seconds) || 0));
    return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  };
  function updateClock() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : record?.duration || 0;
    time.textContent = format(audio.currentTime) + ' / ' + format(duration);
    seek.value = duration > 0 ? Math.round(audio.currentTime / duration * 1000) : 0;
    seek.style.setProperty('--progress', (Number(seek.value) / 10) + '%');
    seek.setAttribute('aria-valuetext', format(audio.currentTime) + '，共 ' + format(duration));
    button.innerHTML = icon(audio.paused ? 'play' : 'pause') + '<span>' + (audio.paused ? '播放讲稿' : '暂停讲稿') + '</span>';
    button.setAttribute('aria-label', audio.paused ? '播放当前页讲稿' : '暂停当前页讲稿');
    button.setAttribute('aria-pressed', String(!audio.paused));
  }
  function syncPage() {
    const next = getIndex();
    const nextNotes = JSON.stringify(getSlides()[next]?.notes);
    const page = String(getSlides()[next]?.page);
    const job = liveState?.jobs?.[page];
    const savedNotes = liveState?.sourceNotes?.[page];
    const nextVersion = JSON.stringify([manifest.slides[page]?.file, job, savedNotes, liveState?.watcherError, liveState?.voiceReady]);
    if (next === active && nextNotes === activeNotes && nextVersion === activeVersion) return;
    serial++;
    audio.pause();
    active = next;
    activeNotes = nextNotes;
    activeVersion = nextVersion;
    record = manifest.slides[String(getSlides()[active]?.page)];
    audio.removeAttribute('src');
    audio.load();
    if (liveState?.voiceReady === false) {
      record = null;
      status.textContent = '声线待确定；改稿会自动加入生成队列';
    } else if (liveState?.watcherError) {
      record = null;
      status.textContent = '正在等待讲稿保存完成';
    } else if (job?.state === 'queued' || job?.state === 'generating') {
      record = null;
      status.textContent = job.state === 'queued' ? '讲稿已保存，等待本地生成…' : '正在本地生成本页语音…';
    } else if (job?.state === 'error') {
      record = null;
      status.textContent = job.message || '本地语音生成失败';
    } else if (savedNotes && JSON.stringify(savedNotes) !== nextNotes) {
      record = null;
      status.textContent = '讲稿已更新，请刷新页面读取最新内容';
    } else if (record && JSON.stringify(record.notes) !== JSON.stringify(getSlides()[active].notes)) {
      record = null;
      status.textContent = '讲稿已修改，请重新生成本页音频';
    } else if (!record) {
      status.textContent = '本页讲稿音频尚未生成';
    }
    button.disabled = restart.disabled = seek.disabled = !record;
    if (record) {
      audio.src = record.file;
      audio.playbackRate = Number(rate.value);
      status.textContent = '';
    }
    updateClock();
  }
  async function play() {
    syncPage();
    if (!record) return;
    const request = ++serial;
    // Keep page demo media from competing with the narration.
    document.querySelectorAll('video').forEach(video => video.pause());
    if (audio.ended) audio.currentTime = 0;
    try {
      await audio.play();
      if (request === serial) status.textContent = '';
    } catch (error) {
      if (request === serial) status.textContent = '播放失败，请重试或检查本地音频文件';
    }
    updateClock();
  }
  button.onclick = () => {
    if (audio.paused) play();
    else { serial++; audio.pause(); }
  };
  restart.onclick = () => { audio.currentTime = 0; play(); };
  seek.oninput = () => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(seek.value) / 1000 * audio.duration;
    updateClock();
  };
  rate.onchange = () => { audio.playbackRate = Number(rate.value); };
  panel.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !options.hidden) {
      closeSettings();
      settings.focus();
    }
  });
  audio.addEventListener('timeupdate', updateClock);
  audio.addEventListener('pause', updateClock);
  audio.addEventListener('play', updateClock);
  document.addEventListener('play', event => {
    if (event.target.tagName === 'VIDEO' && !audio.paused) event.target.pause();
  }, true);
  audio.addEventListener('loadedmetadata', updateClock);
  audio.addEventListener('error', () => { status.textContent = '无法读取本页音频，请检查 narration 文件夹'; updateClock(); });
  audio.addEventListener('ended', () => {
    updateClock();
    if (continuous.checked && active + 1 < getSlides().length) {
      goTo(active + 1);
      syncPage();
      play();
    }
  });
  // Host navigation changes the current title, including repeated identical titles.
  const observer = new MutationObserver(syncPage);
  for (const id of ['current-title', 'notes-content']) {
    observer.observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });
  }
  window.addEventListener('pagehide', () => audio.pause());
  // Script loading also works for local file previews without a fetch/CORS dependency.
  let refreshing = false;
  function refreshCache() {
    if (refreshing || document.hidden || !config.liveUpdates) return;
    refreshing = true;
    const script = document.createElement('script');
    script.src = 'narration/live.js?v=' + Date.now();
    const finish = () => { refreshing = false; script.remove(); };
    script.onload = () => {
      const incoming = window.PPT_NARRATION_LIVE;
      if (incoming?.manifest?.slides) {
        liveState = incoming;
        manifest = incoming.manifest;
        syncPage();
      }
      finish();
    };
    script.onerror = finish;
    document.head.append(script);
  }
  const refreshTimer = setInterval(refreshCache, 2000);
  document.addEventListener('visibilitychange', refreshCache);
  window.addEventListener('pagehide', () => clearInterval(refreshTimer));
  syncPage();
  refreshCache();
})();
