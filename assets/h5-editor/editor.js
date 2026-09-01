/**
 * PPTedit — lightweight in-browser editor for static HTML pages.
 * Activate with ?edit=1, a host-provided /edit URL suffix, or localStorage h5ve-enabled=1
 * UI: Figma-inspired workbench with separate slide and layer columns plus a compact right inspector.
 */
(function h5VisualEditor() {
  const EDITOR_SCRIPT = document.currentScript;
  const ASSET_BASE_URL = EDITOR_SCRIPT?.src
    ? new URL(".", EDITOR_SCRIPT.src)
    : new URL("/h5-editor/", location.origin);
  const SAVE_ENDPOINT_URL = (() => {
    try {
      const candidate = new URL(EDITOR_SCRIPT?.dataset.h5veSaveEndpoint || "/api/h5-editor/save/", location.href);
      return candidate.origin === location.origin ? candidate.href : new URL("/api/h5-editor/save/", location.origin).href;
    } catch {
      return new URL("/api/h5-editor/save/", location.origin).href;
    }
  })();
  const PARAM = new URLSearchParams(location.search);
  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Storage can be unavailable in sandboxed or privacy-restricted contexts. */
    }
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage can be unavailable in sandboxed or privacy-restricted contexts. */
    }
  }

  const FORCE_ON =
    PARAM.get("edit") === "1" || /\/edit\/?$/.test(location.pathname) || safeStorageGet("h5ve-enabled") === "1";
  if (!FORCE_ON) return;

  const DEFAULT_INSPECTOR_W = 288;
  const SLIDES_PANEL_W = 152;
  const DEFAULT_LEFT_PANEL_W = 248;
  const MIN_INSPECTOR_W = 260;
  const MAX_INSPECTOR_W = 440;
  const MIN_LEFT_PANEL_W = 196;
  const MAX_LEFT_PANEL_W = 420;
  const ELEMENTS_MIN_VIEWPORT = 860;
  const NOTES_H = 136;
  const NOTES_GAP = 12;

  function readStoredPanelWidth(key, fallback, min, max) {
    const stored = safeStorageGet(key);
    if (stored == null || stored === "") return fallback;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  }

  const state = {
    selected: [],
    primary: null,
    dragging: false,
    didDrag: false,
    dragCopyPending: false,
    dragDuplicated: false,
    dragStart: { x: 0, y: 0 },
    dragBases: [],
    resizing: false,
    resizeDir: null,
    resizeStart: { x: 0, y: 0 },
    resizeBase: null,
    rotating: false,
    rotateStartAngle: 0,
    rotateBaseAngle: 0,
    rotateCenter: { x: 0, y: 0 },
    rotateItems: [],
    marqueeing: false,
    marqueePending: false,
    marqueeStart: { x: 0, y: 0 },
    marqueeAdditive: false,
    marqueeBaseSelection: [],
    didMarquee: false,
    suppressClickUntil: 0,
    picking: true,
    history: [],
    historyMeta: [],
    historyIndex: -1,
    revision: null,
    revisionPromise: null,
    conflictRevision: null,
    recoveryDraft: null,
    scale: 1,
    fitScale: 1,
    canvasScale: null,
    zoomMode: "fit",
    panX: 0,
    panY: 0,
    spacePressed: false,
    panning: false,
    panStart: { x: 0, y: 0 },
    panBase: { x: 0, y: 0 },
    deckNavSync: false,
    currentSlideIndex: null,
    initialSlideIndex: 0,
    designWidth: 1920,
    designHeight: 1080,
    initialHostState: null,
    layerQuery: "",
    cornerRadiiExpanded: false,
    frameSpacingExpanded: false,
    leftPanelWidth: readStoredPanelWidth("h5ve-left-panel-width", DEFAULT_LEFT_PANEL_W, MIN_LEFT_PANEL_W, MAX_LEFT_PANEL_W),
    inspectorWidth: readStoredPanelWidth("h5ve-inspector-width", DEFAULT_INSPECTOR_W, MIN_INSPECTOR_W, MAX_INSPECTOR_W),
  };

  let editorRoot, sidebar, panel, selectionLayer, handle, marqueeEl, toast, slidesPanel, elementsPanel, notesPanel, notesTextarea;
  let imageDropOverlay, contextMenu;
  let commandPalette, commandInput, commandList, shortcutHelp, versionHistory, versionList, insertMenu;
  let layerSearchInput, layerSearchClear, selectionPath;
  let slideDragPreview = null;
  let layerDragPreview = null;
  let layerDragState = null;
  let layerExpandTimer = 0;
  let layerAutoRevealRaf = 0;
  let layerAutoRevealPending = false;
  let panelFields = {};
  let boxRaf = 0;
  let notesHistoryTimer = 0;
  let autoSaveTimer = 0;
  let historyCommitTimer = 0;
  let autoSaveInFlight = false;
  let autoSavePending = false;
  let commandActiveIndex = 0;
  let panelResizeRaf = 0;
  const originalContentEditable = new WeakMap();
  const collapsedElementLayers = new WeakSet();
  const AUTO_SAVE_DELAY = 900;
  const HISTORY_COMMIT_DELAY = 500;
  const MIN_CANVAS_SCALE = 0.1;
  const MAX_CANVAS_SCALE = 4;
  const RECOVERY_DRAFT_PREFIX = "h5ve-recovery:";

  function isEditorNode(el) {
    if (!el || !(el instanceof Element)) return true;
    return !!el.closest?.(".h5ve-root");
  }

  let continuousScrollOffsetFrame = 0;
  let continuousScrollOffsetStyle = null;
  let continuousScrollOffsetRule = null;
  let continuousScrollOffsetCorrection = 0;
  let continuousScrollCalibrationFrame = 0;
  let continuousScrollCalibrationScale = 0;
  function ensureContinuousScrollOffsetRule() {
    if (continuousScrollOffsetStyle && continuousScrollOffsetRule) return continuousScrollOffsetRule;
    document.documentElement.style.removeProperty("--h5ve-continuous-fixed-offset");
    if (!continuousScrollOffsetStyle) {
      continuousScrollOffsetStyle = document.createElement("style");
      continuousScrollOffsetStyle.className = "h5ve-root h5ve-continuous-offset-style";
      continuousScrollOffsetStyle.textContent = ".h5ve-continuous-fixed{--h5ve-continuous-fixed-offset:0px}";
      document.head.appendChild(continuousScrollOffsetStyle);
    }
    continuousScrollOffsetRule = continuousScrollOffsetStyle.sheet?.cssRules?.[0]?.style || null;
    return continuousScrollOffsetRule;
  }
  function writeContinuousScrollOffset() {
    const scale = Math.max(0.001, Number(state.scale) || 1);
    const offset = window.scrollY / scale + continuousScrollOffsetCorrection;
    const rule = ensureContinuousScrollOffsetRule();
    if (rule) rule.setProperty("--h5ve-continuous-fixed-offset", `${offset}px`);
  }
  function syncContinuousScrollOffset() {
    const root = document.documentElement;
    if (!root.classList.contains("h5ve-continuous-mode")) {
      root.style.removeProperty("--h5ve-continuous-fixed-offset");
      continuousScrollOffsetStyle?.remove();
      continuousScrollOffsetStyle = null;
      continuousScrollOffsetRule = null;
      continuousScrollOffsetCorrection = 0;
      continuousScrollCalibrationScale = 0;
      return;
    }
    writeContinuousScrollOffset();
  }
  function calibrateContinuousScrollOffset() {
    if (!document.documentElement.classList.contains("h5ve-continuous-mode")) {
      syncContinuousScrollOffset();
      return;
    }
    const nextScale = Math.max(0.001, Number(state.scale) || 1);
    if (Math.abs(nextScale - continuousScrollCalibrationScale) > 0.0001) {
      continuousScrollCalibrationScale = nextScale;
      continuousScrollOffsetCorrection = 0;
    }
    if (continuousScrollCalibrationFrame) cancelAnimationFrame(continuousScrollCalibrationFrame);
    syncContinuousScrollOffset();
    const measure = (remaining) => {
      continuousScrollCalibrationFrame = requestAnimationFrame(() => {
        continuousScrollCalibrationFrame = 0;
        const anchor = [...document.querySelectorAll(".h5ve-continuous-fixed")].find((element) => {
          const top = getComputedStyle(element).top;
          return top !== "auto" && Number.isFinite(parseFloat(top));
        });
        if (!anchor) return;
        const computed = getComputedStyle(anchor);
        const top = parseFloat(computed.top);
        if (computed.top === "auto" || !Number.isFinite(top)) return;
        const scale = Math.max(0.001, Number(state.scale) || 1);
        const delta = top * scale - anchor.getBoundingClientRect().top;
        if (Math.abs(delta) < 0.25) return;
        continuousScrollOffsetCorrection += delta / scale;
        writeContinuousScrollOffset();
        scheduleSelectionBox();
        if (remaining > 1) measure(remaining - 1);
      });
    };
    measure(2);
  }
  function scheduleContinuousScrollOffset() {
    if (continuousScrollOffsetFrame) return;
    continuousScrollOffsetFrame = requestAnimationFrame(() => {
      continuousScrollOffsetFrame = 0;
      syncContinuousScrollOffset();
    });
  }
  function markContinuousFixedElements() {
    if (!document.documentElement.classList.contains("h5ve-continuous-mode")) return;
    document.body.querySelectorAll("*").forEach((element) => {
      if (!isEditorNode(element) && getComputedStyle(element).position === "fixed") {
        element.classList.add("h5ve-continuous-fixed");
      }
    });
  }

  function isLayoutContainer(el) {
    if (!el || !(el instanceof Element)) return false;
    return el.matches("#stage, #deck, .slide");
  }

  function isEditableTarget(el) {
    if (!el || isEditorNode(el)) return false;
    if (isLayoutContainer(el)) return false;
    if (isElementHidden(el) || isElementLocked(el)) return false;
    // 只要是在 #stage 舞台内的任何可见元素都应该是可编辑的
    const stage = getStage();
    if (stage && !stage.contains(el)) return false;

    const tag = el.tagName;
    if (["HTML", "BODY", "SCRIPT", "STYLE", "LINK", "META", "HEAD"].includes(tag))
      return false;
    return true;
  }

  function findEditableTarget(target) {
    let el = target;
    while (el && !isEditableTarget(el)) el = el.parentElement;
    return el && isEditableTarget(el) ? el : null;
  }

  function contentRoot() {
    return document.querySelector("#deck") || document.querySelector("main") || document.body;
  }

  function labelFor(el) {
    const customName = el?.getAttribute?.("data-h5ve-layer-name")?.trim();
    if (customName) return customName;
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/)[0]}` : "";
    const text = (el.textContent || "").trim().slice(0, 24);
    return `${tag}${cls}${text ? ` · ${text}` : ""}`;
  }

  function parseTransform(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === "none") return { x: 0, y: 0 };
    const m = t.match(/matrix\(([^)]+)\)/);
    if (!m) return { x: 0, y: 0 };
    const p = m[1].split(",").map(Number);
    return { x: p[4] || 0, y: p[5] || 0 };
  }

  function normalizeRotation(value) {
    let angle = Number(value) || 0;
    angle = ((angle + 180) % 360 + 360) % 360 - 180;
    return Math.abs(angle) < 0.0001 ? 0 : angle;
  }

  function parseRotation(el) {
    const transform = getComputedStyle(el).transform;
    if (!transform || transform === "none") return 0;
    try {
      const matrix = new DOMMatrixReadOnly(transform);
      return normalizeRotation((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
    } catch (_error) {
      const match = transform.match(/matrix\(([^)]+)\)/);
      if (!match) return 0;
      const values = match[1].split(",").map(Number);
      return normalizeRotation((Math.atan2(values[1] || 0, values[0] || 1) * 180) / Math.PI);
    }
  }

  function applyRotation(el, angle) {
    if (getComputedStyle(el).display === "inline") el.style.display = "inline-block";
    const normalized = normalizeRotation(angle);
    const current = el.style.transform || "";
    const base =
      current === "none"
        ? ""
        : current
            .replace(/rotate(?:3d|X|Y|Z)?\([^)]*\)/gi, "")
            .trim();
    const rotate = normalized ? `rotate(${normalized}deg)` : "";
    const value = `${base} ${rotate}`.trim();
    if (value) {
      el.style.setProperty("transform", value, "important");
      el.style.setProperty("--h5ve-force-transform", value, "important");
    } else {
      el.style.removeProperty("transform");
      el.style.removeProperty("--h5ve-force-transform");
    }
  }

  function applyTransform(el, x, y) {
    if (getComputedStyle(el).display === "inline") el.style.display = "inline-block";
    const current = el.style.transform || "";
    const base =
      current === "none"
        ? ""
        : current
            .replace(/translate(?:3d)?\([^)]*\)/g, "")
            .replace(/translate[XY]\([^)]*\)/g, "")
            .trim();
    const translate = `translate(${x}px, ${y}px)`;
    const val = `${translate} ${base}`.trim();
    el.style.setProperty("transform", val, "important");
    el.style.setProperty("--h5ve-force-transform", val, "important");
  }

  function getInlineOrComputed(el, prop) {
    const inline = el.style[prop];
    if (inline) return inline;
    return getComputedStyle(el)[prop];
  }

  function rgbToHex(rgb) {
    if (!rgb || rgb === "transparent") return "#000000";
    if (rgb.startsWith("#")) return rgb;
    const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return "#000000";
    const h = (n) => Number(n).toString(16).padStart(2, "0");
    return `#${h(m[1])}${h(m[2])}${h(m[3])}`;
  }

  function normalizeHexColor(value, fallback = null) {
    const raw = String(value || "").trim().replace(/^#/, "");
    if (/^[0-9a-f]{3}$/i.test(raw)) {
      return `#${raw
        .split("")
        .map((char) => char + char)
        .join("")}`.toUpperCase();
    }
    if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw}`.toUpperCase();
    return fallback;
  }

  function isTransparentCssColor(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text === "transparent") return true;
    const rgba = text.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)/);
    return rgba ? Number(rgba[1]) <= 0 : false;
  }

  function historySnapshotHtml() {
    const root = contentRoot();
    const clone = root.cloneNode(true);
    clone.querySelectorAll("[data-h5ve-selected],[data-h5ve-editing]").forEach((node) => {
      node.removeAttribute("data-h5ve-selected");
      if (node.hasAttribute("data-h5ve-editing")) node.removeAttribute("contenteditable");
      node.removeAttribute("data-h5ve-editing");
    });
    clone.querySelectorAll(".h5ve-current-slide,.h5ve-rotating").forEach((node) => {
      node.classList.remove("h5ve-current-slide", "h5ve-rotating");
      if (!node.getAttribute("class")) node.removeAttribute("class");
    });
    clone.querySelectorAll("[style]").forEach((node) => {
      node.style.removeProperty("--h5ve-force-transform");
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });
    return clone.innerHTML;
  }

  function pushHistory(options = {}) {
    const snap = historySnapshotHtml();
    if (state.history[state.historyIndex] === snap) return;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.historyMeta = state.historyMeta.slice(0, state.historyIndex + 1);
    state.history.push(snap);
    state.historyMeta.push({
      time: Date.now(),
      label: options.label || (state.historyIndex < 0 ? "打开页面" : "自动快照"),
      saved: false,
      slideIndex: document.getElementById("deck") ? getCurrentSlideIndex() : null,
    });
    state.historyIndex++;
    updateHistoryControls();
    if (options.autoSave !== false) scheduleAutoSave();
  }

  function commitHistorySoon() {
    clearTimeout(historyCommitTimer);
    historyCommitTimer = setTimeout(pushHistory, HISTORY_COMMIT_DELAY);
  }

  function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    setSaveState("dirty", "等待保存");
    autoSaveTimer = setTimeout(() => saveToDisk({ silent: true, quiet: true }), AUTO_SAVE_DELAY);
  }

  function markDirty() {
    commitHistorySoon();
    scheduleAutoSave();
  }

  function setSaveState(kind, label) {
    const status = sidebar?.querySelector(".h5ve-save-state");
    if (!status) return;
    status.dataset.state = kind;
    status.tabIndex = kind === "error" ? 0 : -1;
    status.title = kind === "error" ? "点击查看恢复选项" : "";
    const text = status.querySelector(".h5ve-save-label");
    if (text) text.textContent = label;
  }

  function showAutoSaveStatus(saved, failed = false) {
    if (failed) {
      setSaveState("error", "保存失败");
      return;
    }
    setSaveState(saved ? "saved" : "saving", saved ? "已保存" : "保存中…");
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  const EDITOR_COMMANDS = [
    { id: "add-text", label: "新增文本", detail: "在当前页中心新建文字", shortcut: "T" },
    { id: "add-rectangle", label: "新增矩形", detail: "新建可调整填充和描边的矢量矩形", shortcut: "R" },
    { id: "add-ellipse", label: "新增椭圆", detail: "新建可缩放的矢量圆形", shortcut: "O" },
    { id: "add-line", label: "新增线条", detail: "新建 1px 可编辑线条", shortcut: "L" },
    { id: "add-frame", label: "新增框架", detail: "新建可容纳子元素的自由框架", shortcut: "F" },
    { id: "toggle-mode", label: "切换选择 / 预览", detail: "在编辑与演示之间切换", shortcut: "⇧D" },
    { id: "undo", label: "撤销", detail: "回到上一个编辑状态", shortcut: "⌘Z" },
    { id: "redo", label: "重做", detail: "恢复被撤销的编辑", shortcut: "⌘⇧Z" },
    { id: "versions", label: "查看版本与恢复", detail: "查看本次会话快照和未保存草稿", shortcut: "" },
    { id: "zoom-fit", label: "画布适配窗口", detail: "完整显示当前幻灯片并重置平移", shortcut: "⌘0" },
    { id: "zoom-actual", label: "画布显示 100%", detail: "按设计稿实际像素查看", shortcut: "⌘1" },
    { id: "duplicate-slide", label: "复制当前幻灯片", detail: "在当前页后创建一份可独立编辑的副本", shortcut: "⌘⇧D" },
    { id: "toggle-slide-skip", label: "隐藏 / 恢复当前幻灯片", detail: "隐藏页在编辑态保留，实际预览时自动跳过", shortcut: "" },
    { id: "search-layers", label: "搜索当前页图层", detail: "按名称、文字、标签或 class 定位元素", shortcut: "⌘F" },
    { id: "duplicate", label: "复制选中元素", detail: "原位复制并轻微偏移", shortcut: "⌘D" },
    { id: "auto-layout", label: "添加自适应布局", detail: "根据元素位置自动推断横向或纵向布局", shortcut: "⇧A" },
    { id: "group", label: "编组选中元素", detail: "将多选元素组成一个稳定框架", shortcut: "⌘G" },
    { id: "ungroup", label: "解组", detail: "释放组内元素并保持视觉位置", shortcut: "⌘⇧G" },
    { id: "save", label: "立即保存", detail: "将当前编辑写回 HTML", shortcut: "⌘S" },
    { id: "copy-screenshot", label: "复制当前页截图", detail: "复制 2× 高清 PNG，可直接粘贴到文档", shortcut: "" },
    { id: "download-screenshot", label: "下载当前页截图", detail: "将 2× 高清 PNG 下载到浏览器默认位置", shortcut: "" },
    { id: "export", label: "复制当前页 SVG", detail: "复制可编辑 SVG 到剪贴板，去 Figma 直接粘贴", shortcut: "" },
    { id: "export-download", label: "下载当前页 SVG", detail: "将可编辑 SVG 文件下载到浏览器默认位置", shortcut: "" },
    { id: "shortcuts", label: "查看快捷键", detail: "打开完整的键盘操作说明", shortcut: "?" },
  ];

  function updateHistoryControls() {
    const canUndo = state.historyIndex > 0;
    const canRedo = state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;
    document.querySelectorAll(".h5ve-root [data-action='undo'], .h5ve-root [data-command='undo']").forEach((button) => {
      button.disabled = !canUndo;
      button.setAttribute("aria-disabled", canUndo ? "false" : "true");
    });
    document.querySelectorAll(".h5ve-root [data-action='redo'], .h5ve-root [data-command='redo']").forEach((button) => {
      button.disabled = !canRedo;
      button.setAttribute("aria-disabled", canRedo ? "false" : "true");
    });
  }

  function commandButtons() {
    return commandList ? [...commandList.querySelectorAll("[data-command]")] : [];
  }

  function visibleCommandButtons() {
    return commandButtons().filter((button) => !button.hidden && !button.disabled);
  }

  function updateCommandActive(nextIndex = 0) {
    const visible = visibleCommandButtons();
    if (!visible.length) return;
    commandActiveIndex = Math.max(0, Math.min(nextIndex, visible.length - 1));
    commandButtons().forEach((button) => button.classList.remove("active"));
    visible[commandActiveIndex].classList.add("active");
    visible[commandActiveIndex].scrollIntoView({ block: "nearest" });
  }

  function filterCommands(query = "") {
    const needle = query.trim().toLowerCase();
    commandButtons().forEach((button) => {
      button.hidden = !!needle && !button.textContent.toLowerCase().includes(needle);
    });
    updateHistoryControls();
    updateCommandActive(0);
  }

  function closeCommandPalette() {
    if (!commandPalette) return;
    commandPalette.hidden = true;
    commandInput?.blur();
  }

  function openCommandPalette() {
    if (!commandPalette) return;
    shortcutHelp.hidden = true;
    closeVersionHistory();
    commandPalette.hidden = false;
    commandInput.value = "";
    filterCommands("");
    requestAnimationFrame(() => commandInput.focus({ preventScroll: true }));
  }

  function closeInsertMenu() {
    if (!insertMenu) return;
    insertMenu.hidden = true;
    sidebar?.querySelector('[data-action="insert"]')?.setAttribute("aria-expanded", "false");
  }

  function openInsertMenu() {
    if (!insertMenu) return;
    closeContextMenu();
    closeCommandPalette();
    insertMenu.hidden = false;
    sidebar?.querySelector('[data-action="insert"]')?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => insertMenu.querySelector("button")?.focus({ preventScroll: true }));
  }

  function toggleInsertMenu() {
    if (insertMenu?.hidden) openInsertMenu();
    else closeInsertMenu();
  }

  function closeShortcutHelp() {
    if (shortcutHelp) shortcutHelp.hidden = true;
  }

  function openShortcutHelp() {
    if (!shortcutHelp) return;
    closeCommandPalette();
    closeVersionHistory();
    shortcutHelp.hidden = false;
    requestAnimationFrame(() => shortcutHelp.querySelector("[data-action='close-help']")?.focus({ preventScroll: true }));
  }

  function canonicalDocumentPath() {
    const pagePath = location.pathname.replace(/\/edit\/?$/, "");
    if (pagePath.endsWith(".html")) return pagePath;
    return `${pagePath.replace(/\/$/, "")}/index.html`;
  }

  function recoveryDraftKey() {
    return `${RECOVERY_DRAFT_PREFIX}${canonicalDocumentPath()}`;
  }

  function readRecoveryDraft() {
    try {
      const parsed = JSON.parse(safeStorageGet(recoveryDraftKey()) || "null");
      return parsed?.path === canonicalDocumentPath() && typeof parsed?.html === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  function storeRecoveryDraft(html, reason = "保存失败") {
    const draft = {
      path: canonicalDocumentPath(),
      html,
      time: Date.now(),
      reason,
      revision: state.revision,
      conflictRevision: state.conflictRevision,
    };
    state.recoveryDraft = draft;
    try {
      safeStorageSet(recoveryDraftKey(), JSON.stringify(draft));
    } catch {
      // 页面过大导致 localStorage 配额不足时，仍保留本次会话内存草稿。
    }
    renderVersionHistory();
  }

  function clearRecoveryDraft() {
    state.recoveryDraft = null;
    state.conflictRevision = null;
    try {
      safeStorageRemove(recoveryDraftKey());
    } catch {
      /* localStorage unavailable */
    }
    renderVersionHistory();
  }

  function markCurrentHistorySaved() {
    state.historyMeta.forEach((meta) => {
      if (meta) meta.saved = false;
    });
    const meta = state.historyMeta[state.historyIndex];
    if (meta) {
      meta.saved = true;
      meta.label = "已保存";
      meta.time = Date.now();
    }
    renderVersionHistory();
  }

  function formatVersionTime(time) {
    if (!Number.isFinite(Number(time))) return "刚刚";
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(time));
  }

  function escapeHtmlText(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function renderVersionHistory() {
    if (!versionList) return;
    const draft = state.recoveryDraft || readRecoveryDraft();
    state.recoveryDraft = draft;
    const recovery = draft
      ? `<section class="h5ve-recovery-card">
          <div><strong>未保存的本地草稿</strong><small>${formatVersionTime(draft.time)} · ${escapeHtmlText(draft.reason || "保存失败")}</small></div>
          <div class="h5ve-recovery-actions">
            <button type="button" data-recovery-action="restore">恢复草稿</button>
            <button type="button" data-recovery-action="download">下载备份</button>
            <button type="button" data-recovery-action="discard">丢弃</button>
          </div>
        </section>`
      : "";
    const snapshots = state.history
      .map((_, index) => ({ index, meta: state.historyMeta[index] || {} }))
      .reverse()
      .slice(0, 20)
      .map(({ index, meta }) => `
        <button type="button" class="h5ve-version-item${index === state.historyIndex ? " active" : ""}" data-version-index="${index}">
          <span><strong>${escapeHtmlText(meta.label || "自动快照")}</strong><small>${formatVersionTime(meta.time)}${meta.saved ? " · 磁盘版本" : " · 本次会话"}</small></span>
          <em>${index === state.historyIndex ? "当前" : "恢复"}</em>
        </button>`)
      .join("");
    versionList.innerHTML = `${recovery}<div class="h5ve-version-section-title">本次会话</div>${snapshots || '<div class="h5ve-version-empty">还没有可恢复的快照</div>'}`;
  }

  function closeVersionHistory() {
    if (versionHistory) versionHistory.hidden = true;
  }

  function openVersionHistory() {
    if (!versionHistory) return;
    closeCommandPalette();
    closeShortcutHelp();
    renderVersionHistory();
    versionHistory.hidden = false;
    requestAnimationFrame(() => versionHistory.querySelector("button")?.focus({ preventScroll: true }));
  }

  function restoreRecoveryDraft() {
    const draft = state.recoveryDraft || readRecoveryDraft();
    if (!draft) {
      showToast("没有可恢复的本地草稿");
      return;
    }
    const parsed = new DOMParser().parseFromString(draft.html, "text/html");
    const root = contentRoot();
    const source = root.id
      ? parsed.getElementById(root.id)
      : root === document.body
        ? parsed.body
        : parsed.querySelector(root.tagName.toLowerCase());
    if (!source) {
      showToast("草稿结构与当前页面不一致，已保留为可下载备份");
      return;
    }
    root.innerHTML = source.innerHTML;
    if (state.conflictRevision || draft.conflictRevision) {
      state.revision = state.conflictRevision || draft.conflictRevision;
    }
    selectSingle(null);
    refreshDeckNavigation(getCurrentSlideIndex());
    renderSlidePanel();
    renderElementPanel();
    updateNotesPanel();
    pushHistory({ label: "恢复本地草稿" });
    closeVersionHistory();
    showToast("已恢复本地草稿 · 正在重新保存");
  }

  async function loadDocumentRevision() {
    const pagePath = canonicalDocumentPath();
    if (!pagePath.endsWith(".html")) return null;
    try {
      const revisionUrl = new URL(SAVE_ENDPOINT_URL);
      revisionUrl.searchParams.set("path", pagePath);
      const response = await fetch(revisionUrl.href, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) return null;
      const data = await response.json();
      state.revision = data.revision || null;
      return state.revision;
    } catch {
      return null;
    }
  }

  function runEditorCommand(command) {
    closeCommandPalette();
    if (command === "add-text") addNewTextElement();
    else if (command === "add-rectangle") createCanvasObject("rectangle");
    else if (command === "add-ellipse") createCanvasObject("ellipse");
    else if (command === "add-line") createCanvasObject("line");
    else if (command === "add-frame") createCanvasObject("frame");
    else if (command === "toggle-mode") togglePickMode();
    else if (command === "undo") undo();
    else if (command === "redo") redo();
    else if (command === "versions") openVersionHistory();
    else if (command === "zoom-fit") fitCanvasToViewport();
    else if (command === "zoom-actual") setCanvasScale(1);
    else if (command === "duplicate-slide") duplicateCurrentSlide();
    else if (command === "toggle-slide-skip") toggleCurrentSlideSkip();
    else if (command === "search-layers") focusLayerSearch();
    else if (command === "duplicate") duplicateSelection();
    else if (command === "auto-layout") autoLayoutSelection();
    else if (command === "group") groupSelection();
    else if (command === "ungroup") ungroupSelection();
    else if (command === "save") saveToDisk();
    else if (command === "copy-screenshot") copyCurrentSlideScreenshot();
    else if (command === "download-screenshot") downloadCurrentSlideScreenshot();
    else if (command === "export") exportCurrentSlideSvg();
    else if (command === "export-download") downloadCurrentSlideSvg();
    else if (command === "shortcuts") openShortcutHelp();
  }

  function scheduleSelectionBox() {
    if (boxRaf) return;
    boxRaf = requestAnimationFrame(() => {
      boxRaf = 0;
      updateSelectionBoxes();
    });
  }

  function isPointInRect(x, y, r) {
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function isRectIntersect(r1, r2) {
    return !(
      r2.left > r1.right ||
      r2.right < r1.left ||
      r2.top > r1.bottom ||
      r2.bottom < r1.top
    );
  }

  function sameSelection(next) {
    return (
      state.selected.length === next.length &&
      state.selected.every((el, index) => el === next[index])
    );
  }

  function clearSelectionMarks() {
    state.selected.forEach((el) => {
      if (el?.dataset) delete el.dataset.h5veSelected;
    });
  }

  function endAnyTextEditing() {
    document.querySelectorAll("[data-h5ve-editing='true']").forEach((el) => endTextEdit(el));
  }

  function canvasObjectInsertionPoint(clientPoint) {
    const slide = currentSlide();
    if (!slide) return null;
    const selectedFrame =
      state.selected.length === 1 &&
      state.primary instanceof HTMLElement &&
      isFrameContainer(state.primary) &&
      !isElementLocked(state.primary)
        ? state.primary
        : null;
    const parent = selectedFrame || slide;
    const rect = parent.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const parentWidth = parent.offsetWidth || rect.width / Math.max(state.scale, 0.001);
    const parentHeight = parent.offsetHeight || rect.height / Math.max(state.scale, 0.001);
    const scaleX = rect.width / Math.max(parentWidth, 1);
    const scaleY = rect.height / Math.max(parentHeight, 1);
    const inside =
      clientPoint &&
      clientPoint.x >= rect.left &&
      clientPoint.x <= rect.right &&
      clientPoint.y >= rect.top &&
      clientPoint.y <= rect.bottom;
    const x = ((inside ? clientPoint.x : rect.left + rect.width / 2) - rect.left) / Math.max(scaleX, 0.001);
    const y = ((inside ? clientPoint.y : rect.top + rect.height / 2) - rect.top) / Math.max(scaleY, 0.001);
    return { slide, parent, parentWidth, parentHeight, x, y };
  }

  function canvasObjectSpec(kind) {
    if (kind === "ellipse") return { label: "椭圆", width: 160, height: 160 };
    if (kind === "line") return { label: "线条", width: 240, height: 1 };
    if (kind === "frame") return { label: "框架", width: 320, height: 220 };
    if (kind === "text") return { label: "文本", width: 180, height: 40 };
    return { label: "矩形", width: 200, height: 120 };
  }

  function createCanvasObject(kind, clientPoint) {
    closeInsertMenu();
    const point = canvasObjectInsertionPoint(clientPoint);
    if (!point) {
      showToast("未找到当前幻灯片，无法新增对象");
      return null;
    }
    endAnyTextEditing();
    if (getComputedStyle(point.parent).position === "static") point.parent.style.position = "relative";
    const spec = canvasObjectSpec(kind);
    const el = document.createElement("div");
    el.setAttribute("data-h5ve-layer-name", spec.label);
    el.setAttribute("data-h5ve-object-kind", kind);
    el.style.position = "absolute";
    el.style.boxSizing = "border-box";
    el.style.left = `${Math.max(0, Math.min(point.parentWidth - spec.width, point.x - spec.width / 2))}px`;
    el.style.top = `${Math.max(0, Math.min(point.parentHeight - spec.height, point.y - spec.height / 2))}px`;
    el.style.width = `${spec.width}px`;
    el.style.height = `${spec.height}px`;
    el.style.margin = "0";
    el.style.zIndex = String(nextLayerZIndex(point.parent));

    if (kind === "text") {
      el.textContent = "请输入文字";
      el.style.width = "auto";
      el.style.height = "auto";
      el.style.minWidth = "120px";
      el.style.padding = "4px 8px";
      el.style.fontSize = "24px";
      el.style.fontFamily = "'Noto Sans SC', system-ui, sans-serif";
      el.style.color = "inherit";
      el.style.whiteSpace = "nowrap";
      el.style.textAlign = "left";
    } else if (kind === "line") {
      el.style.backgroundColor = "rgba(255, 255, 255, 0.72)";
      el.style.minHeight = "1px";
    } else if (kind === "frame") {
      el.dataset.h5veFrame = "1";
      el.dataset.h5veFlow = "free";
      el.dataset.h5veWidthMode = "fixed";
      el.dataset.h5veHeightMode = "fixed";
      el.style.backgroundColor = "rgba(255, 255, 255, 0.025)";
      el.style.border = "1px solid rgba(255, 255, 255, 0.28)";
      el.style.overflow = "visible";
    } else {
      el.style.backgroundColor = "rgba(112, 126, 176, 0.32)";
      el.style.border = "1px solid rgba(194, 204, 239, 0.52)";
      el.style.borderRadius = kind === "ellipse" ? "50%" : "0";
    }

    point.parent.appendChild(el);
    selectSingle(el);
    pushHistory({ label: `新增${spec.label}` });
    renderElementPanel();
    scheduleSelectionBox();
    showToast(`已新增${spec.label}· 可直接拖动和缩放`);
    return el;
  }

  function addNewTextElement() {
    const text = createCanvasObject("text");
    if (!text) return;

    // 延迟一帧让浏览器完成 DOM 插入，然后进入编辑模式
    setTimeout(() => {
      startTextEdit(text);
    }, 50);

    showToast("已新增文本 · 请直接输入内容");
  }

  function getDeckSlides() {
    const deck = document.getElementById("deck");
    if (!deck) return [];
    return [...deck.querySelectorAll(":scope > .slide, :scope > section")];
  }

  function isSlideSkipped(slide) {
    return slide?.dataset?.h5veSlideHidden === "1";
  }

  function getPreviewSlideIndexes(slides = getDeckSlides()) {
    return slides.map((slide, index) => (isSlideSkipped(slide) ? -1 : index)).filter((index) => index >= 0);
  }

  function resolvePreviewSlideIndex(slides, requestedIndex, currentIndex = getCurrentSlideIndex()) {
    const previewIndexes = getPreviewSlideIndexes(slides);
    if (!previewIndexes.length) return 0;
    const bounded = Math.max(0, Math.min(Number(requestedIndex) || 0, slides.length - 1));
    if (!isSlideSkipped(slides[bounded])) return bounded;
    const direction = bounded >= currentIndex ? 1 : -1;
    for (let index = bounded + direction; index >= 0 && index < slides.length; index += direction) {
      if (!isSlideSkipped(slides[index])) return index;
    }
    for (let index = bounded - direction; index >= 0 && index < slides.length; index -= direction) {
      if (!isSlideSkipped(slides[index])) return index;
    }
    return previewIndexes[0];
  }

  function adjacentPreviewSlideIndex(slides, currentIndex, delta) {
    const previewIndexes = getPreviewSlideIndexes(slides);
    if (!previewIndexes.length) return currentIndex;
    const currentPosition = previewIndexes.indexOf(currentIndex);
    if (currentPosition < 0) return resolvePreviewSlideIndex(slides, currentIndex + delta, currentIndex);
    const nextPosition = Math.max(0, Math.min(previewIndexes.length - 1, currentPosition + delta));
    return previewIndexes[nextPosition];
  }

  // #stage：16:9 设计舞台（容器查询根）。存在时编辑画布固定 1920×1080 比例
  function getStage() {
    return document.getElementById("stage");
  }

  function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function isViewportSized(width, height) {
    return Math.abs(width - window.innerWidth) <= 2 && Math.abs(height - window.innerHeight) <= 2;
  }

  function resolveCanvasSize() {
    const stage = getStage();
    const firstSlide = getDeckSlides()[0];
    const explicitWidth = positiveNumber(stage?.dataset.h5veWidth);
    const explicitHeight = positiveNumber(stage?.dataset.h5veHeight);
    if (explicitWidth && explicitHeight) {
      return { width: explicitWidth, height: explicitHeight };
    }

    const stageWidth = positiveNumber(stage?.offsetWidth);
    const stageHeight = positiveNumber(stage?.offsetHeight);
    if (stageWidth && stageHeight && !isViewportSized(stageWidth, stageHeight)) {
      return { width: stageWidth, height: stageHeight };
    }

    const slideWidth = positiveNumber(firstSlide?.offsetWidth);
    const slideHeight = positiveNumber(firstSlide?.offsetHeight);
    if (slideWidth && slideHeight && !isViewportSized(slideWidth, slideHeight)) {
      return { width: slideWidth, height: slideHeight };
    }

    return { width: 1920, height: 1080 };
  }

  function captureInitialDeckState() {
    if (!state.initialHostState) {
      const stage = document.getElementById("stage");
      const deck = document.getElementById("deck");
      const nav = document.querySelector("[data-h5ve-slide-nav]");
      state.initialHostState = {
        htmlClass: document.documentElement.getAttribute("class"),
        htmlStyle: document.documentElement.getAttribute("style"),
        bodyClass: document.body?.getAttribute("class") ?? null,
        bodyStyle: document.body?.getAttribute("style") ?? null,
        stageStyle: stage?.getAttribute("style") ?? null,
        deckStyle: deck?.getAttribute("style") ?? null,
        navHtml: nav?.innerHTML ?? null,
      };
    }
    const size = resolveCanvasSize();
    state.designWidth = size.width;
    state.designHeight = size.height;
    const slides = getDeckSlides();
    const hashPage = Number(location.hash.slice(1));
    const requestedIndex = Number.isFinite(hashPage) && hashPage > 0 ? hashPage - 1 : getCurrentSlideIndex();
    state.initialSlideIndex = Math.max(0, Math.min(requestedIndex, Math.max(0, slides.length - 1)));
    state.currentSlideIndex = state.initialSlideIndex;
  }

  function deckBaseWidth() {
    const stage = getStage();
    if (stage) return state.designWidth || stage.offsetWidth || window.innerWidth;
    return window.innerWidth || 1;
  }

  function parseDeckTranslateIndex(transformText) {
    if (!transformText) return null;
    const deck = document.getElementById("deck");
    const slideW = Number(deck?.dataset.h5veSlideW);
    if (slideW > 0) {
      const mPx =
        transformText.match(/translate3d\(([-\d.]+)px/) ||
        transformText.match(/translateX\(([-\d.]+)px/);
      if (mPx) return Math.round(Math.abs(parseFloat(mPx[1])) / slideW);
    }
    const m =
      transformText.match(/translateX\(([-\d.]+)(?:cq|v)w\)/) ||
      transformText.match(/translate3d\(([-\d.]+)(?:cq|v)w/);
    if (m) return Math.round(Math.abs(parseFloat(m[1])) / 100);
    return null;
  }

  function getCurrentSlideIndex() {
    if (document.body.classList.contains("h5ve-active") && Number.isFinite(state.currentSlideIndex)) {
      return state.currentSlideIndex;
    }
    const deck = document.getElementById("deck");
    if (!deck) return 0;
    const inline = deck.style.transform || "";
    const fromInline = parseDeckTranslateIndex(inline);
    if (fromInline !== null) return fromInline;
    if (typeof window.__currentSlideIndex === "number" && Number.isFinite(window.__currentSlideIndex)) {
      return window.__currentSlideIndex;
    }
    const computed = getComputedStyle(deck).transform;
    if (computed && computed !== "none") {
      const m = computed.match(/matrix\(([^)]+)\)/);
      if (m) {
        const parts = m[1].split(",").map(Number);
        const tx = parts[4] || 0;
        const scale = parts[0] || 1;
        const base = deckBaseWidth();
        return Math.max(0, Math.round(Math.abs(tx / scale) / base));
      }
    }
    return 0;
  }

  function isStageEditMode() {
    // 仅「选择模式」用叠层单页；预览/播放模式走 translateX 横滑，与正常 PPT 一致
    return (
      document.body.classList.contains("h5ve-active") &&
      document.body.classList.contains("h5ve-picking") &&
      !!getStage()
    );
  }

  function isH5vePreviewMode() {
    return (
      document.body.classList.contains("h5ve-active") &&
      !document.body.classList.contains("h5ve-picking")
    );
  }

  function resetDeckStageLayout(deck) {
    deck.style.position = "absolute";
    deck.style.inset = "auto";
    deck.style.top = "0";
    deck.style.left = "0";
    deck.style.right = "auto";
    deck.style.bottom = "auto";
    deck.style.height = "100%";
    deck.style.margin = "0";
  }

  function markCurrentStageSlide(slides, idx) {
    slides.forEach((slide, i) => {
      slide.classList.toggle("h5ve-current-slide", i === idx);
    });
  }

  function syncSlideChromeNumbers(root = document) {
    const slides = Array.from(root.querySelectorAll("#deck > .slide, #deck > section"));
    const previewSlides = slides.filter((slide) => !isSlideSkipped(slide));
    const total = previewSlides.length;
    if (!total) return;
    previewSlides.forEach((slide, i) => {
      const pageSlot = slide.querySelector("[data-h5ve-page-number]");
      if (!pageSlot) return;
      pageSlot.textContent = `${String(i + 1).padStart(2, "0")} / ${total}`;
    });
  }

  function stageSlideWidth() {
    const firstSlide = getDeckSlides()[0];
    const slideWidth = positiveNumber(firstSlide?.offsetWidth);
    if (slideWidth) return slideWidth;
    return state.designWidth || deckBaseWidth();
  }

  function applyDeckSlideOffset(deck, idx, slideCount) {
    const slides = getDeckSlides();
    if (isStageEditMode()) {
      resetDeckStageLayout(deck);
      deck.style.display = "block";
      deck.style.width = "100%";
      deck.style.overflow = "hidden";
      deck.style.transform = "none";
      markCurrentStageSlide(slides, idx);
      delete deck.dataset.h5veSlideW;
      return;
    }
    markCurrentStageSlide(slides, -1);
    deck.style.removeProperty("display");
    deck.style.removeProperty("overflow");
    const previewIndexes = getPreviewSlideIndexes(slides);
    if (isH5vePreviewMode() && previewIndexes.length < slides.length) {
      const previewPosition = Math.max(0, previewIndexes.indexOf(idx));
      const slideWidth = stageSlideWidth();
      deck.dataset.h5veSlideW = String(slideWidth);
      deck.style.width = `${previewIndexes.length * slideWidth}px`;
      deck.style.transform = `translate3d(${-previewPosition * slideWidth}px, 0, 0)`;
      return;
    }
    /* 预览横滑：只同步 deck 位移，避免 __pptGoSlide → go → __h5veGoSlide 递归 */
    if (typeof window.__pptSyncDeckTransform === "function") {
      window.__currentSlideIndex = idx;
      window.__pptSyncDeckTransform(idx);
      return;
    }
    if (typeof window.__pptGoSlide === "function") {
      window.__pptGoSlide(idx);
      return;
    }
    const slideWidth = stageSlideWidth();
    deck.dataset.h5veSlideW = String(slideWidth);
    deck.style.width = `${slideCount * slideWidth}px`;
    deck.style.transform = `translate3d(${-idx * slideWidth}px, 0, 0)`;
  }

  function syncSlideUrlHash(idx) {
    if (location.hash && !/^#\d+$/.test(location.hash)) return;
    const next = `${location.pathname}${location.search}#${idx + 1}`;
    history.replaceState(null, "", next);
  }

  function refreshDeckNavigation(targetIdx) {
    const deck = document.getElementById("deck");
    if (!deck) return null;
    const slides = getDeckSlides();
    if (!slides.length) return null;
    let idx = Math.max(
      0,
      Math.min(typeof targetIdx === "number" ? targetIdx : getCurrentSlideIndex(), slides.length - 1),
    );
    if (isH5vePreviewMode()) idx = resolvePreviewSlideIndex(slides, idx, getCurrentSlideIndex());
    syncSlideChromeNumbers();
    state.deckNavSync = true;
    state.currentSlideIndex = idx;
    window.__currentSlideIndex = idx;
    applyDeckSlideOffset(deck, idx, slides.length);
    state.deckNavSync = false;
    syncSlideUrlHash(idx);

    if (state.selected.some((selected) => !slides[idx].contains(selected))) {
      selectSingle(null);
    }

    slides.forEach((slide, i) => {
      slide.setAttribute("aria-hidden", i === idx && !isSlideSkipped(slide) ? "false" : "true");
    });

    const nav = document.querySelector("[data-h5ve-slide-nav]");
    if (nav) {
      nav.innerHTML = "";
      const previewIndexes = getPreviewSlideIndexes(slides);
      previewIndexes.forEach((slideIndex, previewIndex) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "dot";
        b.dataset.i = String(slideIndex);
        b.setAttribute("aria-label", `Page ${previewIndex + 1}`);
        b.addEventListener("click", () => refreshDeckNavigation(slideIndex));
        nav.appendChild(b);
      });
      nav.querySelectorAll(".dot").forEach((dot) => dot.classList.toggle("active", Number(dot.dataset.i) === idx));
    }

    const el = slides[idx];
    if (el) {
      const th =
        el.dataset.theme ||
        (el.classList.contains("light") ? "light" : el.classList.contains("dark") ? "dark" : "dark");
      document.body.classList.toggle("light-bg", th === "light");
      el.querySelectorAll("video").forEach((v) => {
        if (v.paused) v.play().catch(() => {});
      });
      slides.forEach((s, i) => {
        if (i === idx) return;
        s.querySelectorAll("video").forEach((v) => {
          v.pause();
          v.currentTime = 0;
        });
      });
    }

    if (typeof window.__playSlide === "function") {
      try {
        window.__playSlide(idx);
      } catch {
        /* ignore */
      }
    }

    renderSlideControls();
    updateNotesPanel();
    updateSlidePanelActive(idx);
    renderElementPanel();
    renderSelectionPath();
    scheduleSelectionBox();
    return { idx, total: slides.length };
  }

  function hasPageElementSelection() {
    state.selected = state.selected.filter((el) => el?.isConnected);
    return state.selected.length > 0 || !!document.querySelector("[data-h5ve-selected='true']");
  }

  function isSlideNavKey(key) {
    return ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "PageDown", "PageUp", " "].includes(key);
  }

  function slideNavDelta(key) {
    return ["ArrowRight", "PageDown", " ", "ArrowDown"].includes(key) ? 1 : -1;
  }

  /** 未选中页面元素时，四向键统一翻页（预览 / 选择模式均适用） */
  function shouldArrowKeyNavigateSlides(e) {
    if (!document.body.classList.contains("h5ve-active")) return false;
    if (!document.getElementById("deck")) return false;
    if (!isSlideNavKey(e.key)) return false;
    if (e.target?.closest?.(".h5ve-elements")) return false;
    if (isEditorNode(e.target) && !e.target?.closest?.(".h5ve-slides")) return false;
    if (e.target?.isContentEditable) return false;
    if (e.target?.closest?.("textarea, input, select")) return false;
    if (e.key === " " && e.target?.closest?.("button, a, [role='button']")) return false;
    if (document.querySelector("[data-h5ve-editing='true']")) return false;
    const ov = document.querySelector("[data-h5ve-overview]");
    if (ov && ov.style.display === "block") return false;
    if (state.picking && hasPageElementSelection()) return false;
    return true;
  }

  function focusActiveSlideItem() {
    const item = slidesPanel?.querySelector(".h5ve-slide-item.active");
    if (!item) return;
    item.focus({ preventScroll: true });
    item.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  function handleSlideNavKeydown(e) {
    if (!shouldArrowKeyNavigateSlides(e)) return false;
    const keepThumbnailFocus = !!(
      e.target?.closest?.(".h5ve-slides") || document.activeElement?.closest?.(".h5ve-slides")
    );
    e.preventDefault();
    e.stopImmediatePropagation();
    const cur = getCurrentSlideIndex();
    const delta = slideNavDelta(e.key);
    const target = isH5vePreviewMode()
      ? adjacentPreviewSlideIndex(getDeckSlides(), cur, delta)
      : cur + delta;
    refreshDeckNavigation(target);
    if (keepThumbnailFocus) focusActiveSlideItem();
    return true;
  }

  function installDeckNavBridge() {
    const deck = document.getElementById("deck");
    if (!deck || window.__h5veDeckBridge) return;
    window.__h5veDeckBridge = true;
    window.__h5veGoSlide = refreshDeckNavigation;

    document.addEventListener("keydown", (e) => {
      handleSlideNavKeydown(e);
    }, true);
  }

  function renderSlideControls() {
    const bar = document.getElementById("h5ve-slide-bar");
    if (!bar) return;
    const deck = document.getElementById("deck");
    if (!deck) {
      bar.hidden = true;
      return;
    }
    const slides = getDeckSlides();
    const idx = getCurrentSlideIndex();
    const previewIndexes = getPreviewSlideIndexes(slides);
    bar.hidden = false;
    const idxEl = bar.querySelector("#h5ve-slide-idx");
    const totalEl = bar.querySelector("#h5ve-slide-total");
    if (idxEl) {
      const previewPosition = previewIndexes.indexOf(idx);
      idxEl.textContent = String(isH5vePreviewMode() ? Math.max(1, previewPosition + 1) : Math.min(idx + 1, slides.length || 1));
    }
    if (totalEl) totalEl.textContent = String(isH5vePreviewMode() ? previewIndexes.length : slides.length || 0);
    const btn = bar.querySelector('[data-action="delete-slide"]');
    if (btn) btn.disabled = slides.length <= 1;
  }

  function currentSlide() {
    return getDeckSlides()[getCurrentSlideIndex()] || null;
  }

  function getSlideNoteEl(slide, create = false) {
    if (!slide) return null;
    let note = slide.querySelector(":scope > [data-h5ve-speaker-note]");
    if (!note && create) {
      note = document.createElement("aside");
      note.className = "speaker-note";
      note.dataset.h5veSpeakerNote = "";
      slide.appendChild(note);
    }
    return note;
  }

  function readSlideNote(slide) {
    const note = getSlideNoteEl(slide, false);
    return (note?.textContent || "").trim();
  }

  function writeSlideNote(slide, value) {
    if (!slide) return;
    const text = String(value || "").trim();
    const note = getSlideNoteEl(slide, !!text);
    if (!note) return;
    if (text) note.textContent = text;
    else note.remove();
  }

  function updateNotesPanel() {
    if (!notesPanel || !notesTextarea) return;
    const slides = getDeckSlides();
    if (!slides.length) {
      notesPanel.hidden = true;
      return;
    }
    const idx = getCurrentSlideIndex();
    notesPanel.hidden = false;
    const title = notesPanel.querySelector(".h5ve-notes-title");
    if (title) title.textContent = `第 ${idx + 1} / ${slides.length} 页备注`;
    const text = readSlideNote(slides[idx]);
    if (notesTextarea.value !== text) notesTextarea.value = text;
  }

  function positionNotesPanel(left, top, width, height) {
    if (!notesPanel) return;
    notesPanel.style.left = `${Math.round(left)}px`;
    notesPanel.style.top = `${Math.round(top)}px`;
    notesPanel.style.width = `${Math.round(width)}px`;
    notesPanel.style.height = `${Math.round(height)}px`;
  }

  // ── 左侧幻灯片面板（Keynote 式顺序管理）──

  let slideCloneSequence = 0;

  function buildThumb(slide) {
    const stagePage = !!getStage();
    const vw = stagePage ? state.designWidth : window.innerWidth || 1280;
    const vh = stagePage ? state.designHeight : window.innerHeight || 720;
    const thumbW = SLIDES_PANEL_W - 48; // 留出序号列与内边距
    const s = thumbW / vw;

    const box = document.createElement("div");
    box.className = "h5ve-thumb";
    box.style.height = `${Math.round(vh * s)}px`;

    const stage = document.createElement("div");
    stage.className = "h5ve-thumb-stage";
    stage.style.width = `${vw}px`;
    stage.style.height = `${vh}px`;
    stage.style.transform = `scale(${s})`;

    const clone = slide.cloneNode(true);
    clone.querySelectorAll("script, iframe, canvas").forEach((n) => n.remove());
    clone.querySelectorAll("video").forEach((v) => {
      const ph = document.createElement("div");
      ph.style.cssText = `width:100%;height:100%;background:#111 ${v.poster ? `url(${v.poster}) center/cover no-repeat` : ""};`;
      v.replaceWith(ph);
    });
    clone.querySelectorAll("[data-h5ve-selected],[data-h5ve-editing]").forEach((n) => {
      delete n.dataset.h5veSelected;
      delete n.dataset.h5veEditing;
      n.removeAttribute("contenteditable");
    });
    rewriteDuplicateSlideIds(clone, slide);
    clone.style.position = "relative";
    clone.style.left = "0";
    clone.style.top = "0";
    clone.style.margin = "0";

    stage.appendChild(clone);
    box.appendChild(stage);
    return box;
  }

  function clearSlideDragPreview() {
    slideDragPreview?.remove();
    slideDragPreview = null;
  }

  function createSlideDragPreview(item) {
    clearSlideDragPreview();
    const thumb = item.querySelector(".h5ve-thumb")?.cloneNode(true);
    if (!thumb) return null;
    const preview = document.createElement("div");
    preview.className = "h5ve-slide-drag-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.style.width = `${SLIDES_PANEL_W - 48}px`;
    preview.appendChild(thumb);
    document.querySelector(".h5ve-root")?.appendChild(preview);
    slideDragPreview = preview;
    return preview;
  }

  function replaceMappedCssIds(value, idMap) {
    let result = String(value || "");
    idMap.forEach((nextId, oldId) => {
      const oldTokens = new Set([
        oldId,
        typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(oldId) : oldId,
      ]);
      const nextToken =
        typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(nextId) : nextId;
      oldTokens.forEach((oldToken) => {
        const escaped = oldToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        result = result.replace(new RegExp(`#${escaped}(?![\\w-])`, "g"), `#${nextToken}`);
      });
    });
    return result;
  }

  function splitCssSelectorList(value) {
    const selectors = [];
    let token = "";
    let roundDepth = 0;
    let squareDepth = 0;
    let quote = "";
    let escaped = false;
    for (const character of String(value || "")) {
      if (escaped) {
        token += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        token += character;
        escaped = true;
        continue;
      }
      if (quote) {
        token += character;
        if (character === quote) quote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        token += character;
        quote = character;
        continue;
      }
      if (character === "(") roundDepth += 1;
      else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
      else if (character === "[") squareDepth += 1;
      else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
      if (character === "," && roundDepth === 0 && squareDepth === 0) {
        if (token.trim()) selectors.push(token.trim());
        token = "";
      } else {
        token += character;
      }
    }
    if (token.trim()) selectors.push(token.trim());
    return selectors;
  }

  function absolutizeCssUrls(value, baseUrl) {
    return String(value || "").replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (match, quote, rawUrl) => {
      const sourceUrl = rawUrl.trim();
      if (!sourceUrl || /^(?:data:|blob:|#|https?:|\/\/)/i.test(sourceUrl)) return match;
      try {
        return `url("${new URL(sourceUrl, baseUrl).href.replace(/"/g, "%22")}")`;
      } catch {
        return match;
      }
    });
  }

  function duplicateStyleRuleCss(rule, idMap, scopeSelector, baseUrl) {
    if (typeof rule.selectorText === "string" && rule.style) {
      const declarationSource = rule.style.cssText || "";
      const declarationMapped = replaceMappedCssIds(declarationSource, idMap);
      const declarationChanged = declarationMapped !== declarationSource;
      const selectors = splitCssSelectorList(rule.selectorText)
        .map((selector) => ({ selector, mapped: replaceMappedCssIds(selector, idMap) }))
        .filter(({ selector, mapped }) => declarationChanged || mapped !== selector)
        .flatMap(({ selector, mapped }) => {
          const selectorChanged = mapped !== selector;
          const functionalSelector = /:(?:is|where|not|has)\(/i.test(mapped);
          if (selectorChanged && !functionalSelector) return [mapped];
          return [`${scopeSelector}${mapped}`, `${scopeSelector} ${mapped}`];
        });
      if (!selectors.length) return "";
      return `${selectors.join(", ")} { ${absolutizeCssUrls(declarationMapped, baseUrl)} }`;
    }

    if (rule.cssRules) {
      const children = [...rule.cssRules]
        .map((child) => duplicateStyleRuleCss(child, idMap, scopeSelector, baseUrl))
        .filter(Boolean);
      if (!children.length) return "";
      const openingBrace = (rule.cssText || "").indexOf("{");
      if (openingBrace < 0) return "";
      return `${rule.cssText.slice(0, openingBrace).trim()} { ${children.join("\n")} }`;
    }
    return "";
  }

  function collectDuplicateSlideIdCss(source, idMap, scopeValue) {
    const copies = [];
    const scopeSelector = `:where([data-h5ve-style-scope="${scopeValue}"])`;
    [...document.styleSheets].forEach((sheet) => {
      const owner = sheet.ownerNode;
      if (
        owner instanceof Element &&
        (source?.contains(owner) ||
          owner.closest(".h5ve-root") ||
          owner.hasAttribute("data-h5ve-runtime") ||
          /h5-editor\/editor\.css(?:[?#]|$)/.test(owner.getAttribute("href") || ""))
      ) {
        return;
      }
      let rules;
      try {
        rules = [...sheet.cssRules];
      } catch {
        return;
      }
      rules.forEach((rule) => {
        const rewritten = duplicateStyleRuleCss(
          rule,
          idMap,
          scopeSelector,
          sheet.href || document.baseURI,
        );
        if (rewritten) copies.push(rewritten);
      });
    });
    return copies.join("\n");
  }

  function rewriteDuplicateSlideIds(clone, source = null) {
    const nodes = [clone, ...clone.querySelectorAll("*")];
    const idNodes = nodes.filter((node) => node.id);
    if (!idNodes.length) return;
    const suffix = `copy-${Date.now().toString(36)}-${++slideCloneSequence}`;
    clone.dataset.h5veStyleScope = suffix;
    const idMap = new Map();
    idNodes.forEach((node, index) => {
      const oldId = node.id;
      const nextId = `${oldId}--${suffix}-${index + 1}`;
      idMap.set(oldId, nextId);
      node.id = nextId;
    });

    const tokenAttrs = new Set(["aria-labelledby", "aria-describedby", "aria-controls", "headers"]);
    nodes.forEach((node) => {
      [...node.attributes].forEach((attr) => {
        if (attr.name === "id") return;
        let value = attr.value;
        if (tokenAttrs.has(attr.name)) {
          value = value.split(/\s+/).map((token) => idMap.get(token) || token).join(" ");
        } else if (attr.name === "for" && idMap.has(value)) {
          value = idMap.get(value);
        } else {
          idMap.forEach((nextId, oldId) => {
            const escaped = oldId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            value = value
              .replace(new RegExp(`url\\(\\s*([\"']?)#${escaped}\\1\\s*\\)`, "g"), `url(#${nextId})`)
              .replace(new RegExp(`^#${escaped}$`), `#${nextId}`);
          });
        }
        if (value !== attr.value) node.setAttribute(attr.name, value);
      });
    });

    clone.querySelectorAll("style").forEach((styleNode) => {
      styleNode.textContent = replaceMappedCssIds(styleNode.textContent, idMap);
    });

    const copiedCss = collectDuplicateSlideIdCss(source, idMap, suffix);
    if (copiedCss) {
      const styleNode = document.createElement("style");
      styleNode.dataset.h5veDuplicateIdStyles = "";
      styleNode.textContent = copiedCss;
      clone.prepend(styleNode);
    }
  }

  function sanitizeDuplicateSlide(clone, source) {
    const nodes = [clone, ...clone.querySelectorAll("*")];
    nodes.forEach((node) => {
      delete node.dataset.h5veSelected;
      delete node.dataset.h5veEditing;
      node.removeAttribute("contenteditable");
      node.classList.remove("h5ve-current-slide", "h5ve-rotating");
    });
    clone.setAttribute("aria-hidden", "true");
    rewriteDuplicateSlideIds(clone, source);
  }

  function duplicateCurrentSlide() {
    if (!state.picking) {
      showToast("预览模式下无法复制页面 · 按 ⇧D 进入选择模式");
      return null;
    }
    const deck = document.getElementById("deck");
    const source = currentSlide();
    if (!deck || !source) {
      showToast("当前页面不是可复制的 PPT 结构");
      return null;
    }

    endAnyTextEditing();
    selectSingle(null);
    const sourceIndex = getCurrentSlideIndex();
    const clone = source.cloneNode(true);
    sanitizeDuplicateSlide(clone, source);
    source.after(clone);
    clone.querySelectorAll("video, audio").forEach((media) => {
      try {
        media.pause();
        media.currentTime = 0;
      } catch {
        /* 部分媒体尚未加载，导航同步时会再次归零。 */
      }
    });
    try {
      window.__h5veSlideDuplicated?.(clone, source);
    } catch {
      /* 宿主增强钩子失败不应阻断基础复制能力。 */
    }

    syncSlideChromeNumbers();
    refreshDeckNavigation(sourceIndex + 1);
    pushHistory({ label: `复制第 ${sourceIndex + 1} 页` });
    renderSlidePanel();
    renderElementPanel();
    updateNotesPanel();
    focusActiveSlideItem();
    showToast(`已复制第 ${sourceIndex + 1} 页 · 新页面为第 ${sourceIndex + 2} 页 · 可撤销`);
    return clone;
  }

  function toggleSlideSkip(slide, index = getDeckSlides().indexOf(slide)) {
    if (!state.picking) {
      showToast("预览模式下无法修改页面状态 · 按 ⇧D 进入选择模式");
      return false;
    }
    if (!slide) return false;
    const slides = getDeckSlides();
    const willSkip = !isSlideSkipped(slide);
    if (willSkip && getPreviewSlideIndexes(slides).length <= 1) {
      showToast("至少保留 1 页用于预览");
      return false;
    }
    if (willSkip) slide.dataset.h5veSlideHidden = "1";
    else delete slide.dataset.h5veSlideHidden;
    syncSlideChromeNumbers();
    renderSlidePanel();
    renderSlideControls();
    pushHistory({ label: `${willSkip ? "跳过" : "恢复"}第 ${index + 1} 页` });
    showToast(
      willSkip
        ? `第 ${index + 1} 页已隐藏 · 实际预览时会自动跳过`
        : `第 ${index + 1} 页已恢复到预览`,
    );
    return true;
  }

  function toggleCurrentSlideSkip() {
    const slides = getDeckSlides();
    const index = getCurrentSlideIndex();
    return toggleSlideSkip(slides[index], index);
  }

  function reorderSlide(from, to) {
    const deck = document.getElementById("deck");
    const slides = getDeckSlides();
    if (!deck || from === to || !slides[from]) return;
    const moved = slides[from];
    const target = slides[to];
    if (to >= slides.length) deck.appendChild(moved);
    else if (to > from) target.after(moved);
    else deck.insertBefore(moved, target);
    syncSlideChromeNumbers();
    refreshDeckNavigation(Math.min(to, getDeckSlides().length - 1));
    renderSlidePanel();
    pushHistory();
    showToast(`第 ${from + 1} 页已移到第 ${to + 1} 页 · 已自动保存`);
  }

  function updateSlidePanelActive(idx) {
    if (!slidesPanel) return;
    slidesPanel.querySelectorAll(".h5ve-slide-item").forEach((item, i) => {
      item.classList.toggle("active", i === idx);
    });
  }

  function renderSlidePanel() {
    if (!slidesPanel) return;
    const deck = document.getElementById("deck");
    const slides = getDeckSlides();
    if (!deck || !slides.length) {
      slidesPanel.hidden = true;
      return;
    }
    slidesPanel.hidden = false;
    syncSlideChromeNumbers();
    const list = slidesPanel.querySelector(".h5ve-slides-list");
    list.innerHTML = "";
    const cur = getCurrentSlideIndex();
    updateNotesPanel();

    slides.forEach((slide, i) => {
      const item = document.createElement("div");
      const skipped = isSlideSkipped(slide);
      item.className = "h5ve-slide-item" + (i === cur ? " active" : "") + (skipped ? " is-skipped" : "");
      item.draggable = true;
      item.dataset.index = String(i);
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `幻灯片 ${i + 1}${skipped ? "（预览时跳过）" : ""}`);
      item.setAttribute("aria-keyshortcuts", "Meta+Shift+D Delete Backspace");

      const no = document.createElement("span");
      no.className = "h5ve-slide-no";
      no.textContent = String(i + 1);
      item.appendChild(no);
      item.appendChild(buildThumb(slide));

      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "h5ve-slide-skip";
      skip.innerHTML = skipped
        ? '<svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.5 10.5 0 0 1 12 5c6 0 9 7 9 7a16 16 0 0 1-2.1 3.2M6.6 6.6C4.2 8.2 3 12 3 12s3 7 9 7c1.6 0 3-.5 4.2-1.2"/><path d="M9.9 9.9A3 3 0 0 0 14.1 14"/></svg>'
        : '<svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3-7 9-7 9 7 9 7-3 7-9 7-9-7-9-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
      skip.title = skipped ? "恢复这页到预览" : "隐藏这页，预览时跳过";
      skip.setAttribute("aria-label", skip.title);
      skip.setAttribute("aria-pressed", skipped ? "true" : "false");
      skip.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSlideSkip(slide, i);
      });
      item.appendChild(skip);
      if (skipped) {
        const badge = document.createElement("span");
        badge.className = "h5ve-slide-skip-badge";
        badge.textContent = "已跳过";
        item.appendChild(badge);
      }

      item.addEventListener("click", () => {
        if (getCurrentSlideIndex() !== i) selectSingle(null);
        refreshDeckNavigation(i);
        item.focus({ preventScroll: true });
      });
      item.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
          e.preventDefault();
          e.stopPropagation();
          duplicateCurrentSlide();
          return;
        }
        if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          deleteCurrentSlide();
          return;
        }
        handleSlideNavKeydown(e);
      });

      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.effectAllowed = "move";
        const preview = createSlideDragPreview(item);
        if (preview) e.dataTransfer.setDragImage(preview, Math.round((SLIDES_PANEL_W - 48) / 2), 10);
        item.classList.add("dragging");
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("dragging");
        clearSlideDragPreview();
        list.querySelectorAll(".drop-above, .drop-below").forEach((n) =>
          n.classList.remove("drop-above", "drop-below"),
        );
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        item.classList.toggle("drop-above", before);
        item.classList.toggle("drop-below", !before);
      });
      item.addEventListener("dragleave", () => {
        item.classList.remove("drop-above", "drop-below");
      });
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (!Number.isFinite(from)) return;
        const r = item.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        let to = before ? i : i + 1;
        if (from < to) to -= 1; // 移除原位后目标索引前移
        item.classList.remove("drop-above", "drop-below");
        reorderSlide(from, to);
      });

      list.appendChild(item);
    });
  }

  function elementPanelWidth() {
    if (isCompactWorkbench() || !elementsPanel || elementsPanel.hidden || window.innerWidth < ELEMENTS_MIN_VIEWPORT) return 0;
    return state.leftPanelWidth;
  }

  function isCompactWorkbench() {
    return window.innerWidth < 800;
  }

  function inspectorReservedWidth() {
    return isCompactWorkbench() ? 0 : state.inspectorWidth;
  }

  function inspectorReservedHeight() {
    return isCompactWorkbench() ? Math.min(320, Math.round(window.innerHeight * 0.42)) : 0;
  }

  function navigatorReservedWidth(hasDeck = !!document.getElementById("deck")) {
    const slidesWidth = hasDeck && !isCompactWorkbench() ? SLIDES_PANEL_W : 0;
    return slidesWidth + elementPanelWidth();
  }

  function isAtomicLayerElement(el) {
    return el?.matches?.("img, video, canvas, svg, iframe");
  }

  function isElementExplicitlyHidden(el) {
    return el?.dataset?.h5veHidden === "true";
  }

  function isElementHidden(el) {
    return !!el?.closest?.('[data-h5ve-hidden="true"]');
  }

  function isElementExplicitlyLocked(el) {
    return el?.dataset?.h5veLocked === "true";
  }

  function isElementLocked(el) {
    return !!el?.closest?.('[data-h5ve-locked="true"]');
  }

  function hasVisibleCssColor(value) {
    const color = String(value || "").trim().toLowerCase();
    if (!color || color === "transparent") return false;
    if (/^rgba\(/i.test(color)) {
      const channels = color.match(/[\d.]+/g) || [];
      return channels.length < 4 || Number(channels[3]) > 0;
    }
    const slashAlpha = color.match(/^rgb\([^/]+\/\s*([\d.]+)/i);
    return !slashAlpha || Number(slashAlpha[1]) > 0;
  }

  function isThinLineElement(el, rect = el?.getBoundingClientRect?.(), style = el ? getComputedStyle(el) : null) {
    if (!(el instanceof Element) || !rect || !style) return false;
    const minLength = 8;
    const maxThickness = Math.max(4, 8 * Math.max(state.scale, 0.25));
    const horizontal = rect.width >= minLength && rect.height <= maxThickness;
    const vertical = rect.height >= minLength && rect.width <= maxThickness;
    if (!horizontal && !vertical) return false;

    if (el.matches("hr, line, polyline")) return true;
    if (hasVisibleCssColor(style.backgroundColor)) return true;

    return ["Top", "Right", "Bottom", "Left"].some((side) => {
      const width = parseFloat(style[`border${side}Width`]) || 0;
      const borderStyle = style[`border${side}Style`];
      return width > 0 && borderStyle !== "none" && hasVisibleCssColor(style[`border${side}Color`]);
    });
  }

  function toggleLayerVisibility(el) {
    if (!(el instanceof Element)) return;
    endAnyTextEditing();
    if (isElementExplicitlyHidden(el)) {
      const previous = el.dataset.h5vePreviousVisibility;
      if (previous) el.style.visibility = previous;
      else el.style.removeProperty("visibility");
      delete el.dataset.h5vePreviousVisibility;
      delete el.dataset.h5veHidden;
      showToast(`已显示「${elementLayerName(el)}」`);
    } else {
      el.dataset.h5vePreviousVisibility = el.style.visibility || "";
      el.dataset.h5veHidden = "true";
      el.style.visibility = "hidden";
      if (state.selected.some((candidate) => candidate === el || el.contains(candidate))) selectSingle(null);
      showToast(`已隐藏「${elementLayerName(el)}」· 可撤销`);
    }
    pushHistory();
    renderElementPanel();
    scheduleSelectionBox();
  }

  function toggleLayerLock(el) {
    if (!(el instanceof Element)) return;
    endAnyTextEditing();
    if (isElementExplicitlyLocked(el)) {
      delete el.dataset.h5veLocked;
      showToast(`已解锁「${elementLayerName(el)}」`);
    } else {
      el.dataset.h5veLocked = "true";
      showToast(`已锁定「${elementLayerName(el)}」· 画布操作已禁用`);
    }
    pushHistory();
    renderElementPanel();
    if (state.primary) fillPanel(state.primary);
    scheduleSelectionBox();
  }

  function isVisibleLayerElement(el) {
    if (!(el instanceof Element) || isEditorNode(el) || isStructuralChrome(el)) return false;
    if (el.matches("script, style, link, meta, noscript, br, defs, clipPath, mask, linearGradient, radialGradient")) return false;
    const style = getComputedStyle(el);
    const managedHidden = isElementHidden(el);
    if (style.display === "none" || Number(style.opacity) === 0) return false;
    if (style.visibility === "hidden" && !managedHidden) return false;
    // display: contents 本身没有几何框，但仍是有意义的 DOM 容器。
    // 若只按自身 rect 判断，整个子树会从左侧图层中消失。
    if (style.display === "contents") return [...el.children].some(isVisibleLayerElement);
    const rect = el.getBoundingClientRect();
    return (rect.width >= 3 && rect.height >= 3) || isThinLineElement(el, rect, style);
  }

  function layerDirectText(el) {
    return [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function elementLayerName(el) {
    const customName = el.getAttribute("data-h5ve-layer-name");
    if (customName?.trim()) return customName.trim().slice(0, 48);
    const semantic =
      el.getAttribute("aria-label") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      el.getAttribute("data-name");
    if (semantic) return semantic.trim().slice(0, 48);
    const directText = layerDirectText(el);
    if (directText) return directText.slice(0, 48);
    if (el.id) return `#${el.id}`;
    const className = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    if (className) return `.${className}`;
    if (el instanceof HTMLImageElement) {
      const source = (el.currentSrc || el.src || "").split("/").pop();
      if (source) return decodeURIComponent(source).slice(0, 48);
    }
    return el.tagName.toLowerCase();
  }

  function normalizeLayerSearchText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  }

  function layerSearchText(el) {
    const className = typeof el?.className === "string" ? el.className : "";
    return normalizeLayerSearchText([
      elementLayerName(el),
      el?.tagName || "",
      el?.id || "",
      className,
      el?.getAttribute?.("aria-label") || "",
      el?.getAttribute?.("alt") || "",
      el?.getAttribute?.("title") || "",
      el?.getAttribute?.("data-name") || "",
    ].join(" "));
  }

  function focusLayerSearch(selectAll = true) {
    if (!layerSearchInput || !elementsPanel || elementsPanel.hidden) return false;
    layerSearchInput.focus({ preventScroll: true });
    if (selectAll) layerSearchInput.select();
    return true;
  }

  function clearLayerSearch(options = {}) {
    if (!state.layerQuery && !layerSearchInput?.value) {
      if (options.blur) layerSearchInput?.blur();
      return;
    }
    state.layerQuery = "";
    if (layerSearchInput) layerSearchInput.value = "";
    renderElementPanel();
    if (options.blur) layerSearchInput?.blur();
    else focusLayerSearch(false);
  }

  function startLayerRename(row, el) {
    if (!row || !(el instanceof Element) || isElementLocked(el)) {
      if (isElementLocked(el)) showToast("请先解锁元素再重命名");
      return;
    }
    const name = row.querySelector(".h5ve-element-name");
    if (!name || row.querySelector(".h5ve-element-name-input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "h5ve-element-name-input";
    input.value = elementLayerName(el);
    input.setAttribute("aria-label", "重命名图层");
    name.replaceWith(input);
    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      if (commit) {
        const next = input.value.trim().replace(/\s+/g, " ").slice(0, 48);
        if (next) el.setAttribute("data-h5ve-layer-name", next);
        else el.removeAttribute("data-h5ve-layer-name");
        pushHistory();
        showToast(next ? `已重命名为「${next}」` : "已恢复默认图层名");
      }
      renderElementPanel();
      updateStatus();
      if (state.primary === el) fillPanel(el);
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.focus({ preventScroll: true });
    input.select();
  }

  function layerControlIcon(kind, active = false) {
    if (kind === "visibility") {
      return active
        ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2-3 6-3 6 3 6 3-2 3-6 3-6-3-6-3Z"/><circle cx="8" cy="8" r="1.7"/><path d="M2.5 2.5l11 11"/></svg>'
        : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8s2-3 6-3 6 3 6 3-2 3-6 3-6-3-6-3Z"/><circle cx="8" cy="8" r="1.7"/></svg>';
    }
    return active
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5"/><path d="M5.5 7V5.3a2.5 2.5 0 0 1 5 0V7"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5"/><path d="M10.5 7V5.3a2.5 2.5 0 0 0-4.7-1.2"/></svg>';
  }

  function updateElementToolbarState() {
    if (!elementsPanel) return;
    const selected = state.selected.filter((el) => el?.isConnected);
    const movable = selected.some((el) => !isElementLocked(el));
    elementsPanel.querySelectorAll("[data-layer-action]").forEach((button) => {
      button.disabled = button.dataset.layerAction === "rename" ? selected.length !== 1 || isElementLocked(selected[0]) : !movable;
    });
  }

  function elementLayerIcon(el) {
    if (el.dataset?.h5veGroup === "1" || el.children.length > 0) return "G";
    if (el.matches("img, video, canvas")) return "▧";
    if (el.matches("svg")) return "◇";
    if (layerDirectText(el) || el.matches("h1, h2, h3, h4, h5, h6, p, span, strong, em, small")) return "T";
    return "□";
  }

  function elementLayerChildren(parent) {
    if (!(parent instanceof Element) || isAtomicLayerElement(parent)) return [];
    return [...parent.children].filter(isVisibleLayerElement).reverse();
  }

  function clearLayerDropFeedback() {
    clearTimeout(layerExpandTimer);
    layerExpandTimer = 0;
    clearLayerDropTargets();
    elementsPanel?.querySelectorAll(".h5ve-element-item.is-dragging").forEach((row) => {
      row.classList.remove("is-dragging");
      row.removeAttribute("aria-grabbed");
    });
  }

  function clearLayerDropTargets() {
    elementsPanel?.querySelectorAll(
      ".h5ve-element-item.drop-before, .h5ve-element-item.drop-after, .h5ve-element-item.drop-inside",
    ).forEach((row) => row.classList.remove("drop-before", "drop-after", "drop-inside"));
  }

  function clearLayerDragPreview() {
    layerDragPreview?.remove();
    layerDragPreview = null;
  }

  function clearLayerDragState() {
    clearLayerDropFeedback();
    clearLayerDragPreview();
    layerDragState = null;
  }

  function createLayerDragPreview(el, count = 1) {
    clearLayerDragPreview();
    const preview = document.createElement("div");
    preview.className = "h5ve-layer-drag-preview";
    preview.setAttribute("aria-hidden", "true");
    const icon = document.createElement("span");
    icon.className = "h5ve-layer-drag-preview-icon";
    icon.textContent = elementLayerIcon(el);
    const label = document.createElement("span");
    label.textContent = count > 1 ? `${count} 个图层` : elementLayerName(el);
    preview.append(icon, label);
    document.querySelector(".h5ve-root")?.appendChild(preview);
    layerDragPreview = preview;
    return preview;
  }

  function topLevelLayerDragSources(el) {
    const initial = state.selected.includes(el) ? state.selected : [el];
    const candidates = initial.filter(
      (candidate) => candidate instanceof HTMLElement && candidate.isConnected && !isElementLocked(candidate),
    );
    const topLevel = candidates.filter(
      (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)),
    );
    return topLevel.sort((a, b) => {
      if (a === b) return 0;
      const relation = a.compareDocumentPosition(b);
      return relation & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  function canReceiveLayerChildren(target, sources) {
    if (!(target instanceof HTMLElement) || isElementLocked(target) || isElementHidden(target)) return false;
    if (isAtomicLayerElement(target) || isLayoutContainer(target)) return false;
    if (target.matches("input, textarea, select, option, button, a, table, thead, tbody, tfoot, tr, td, th")) return false;
    if (sources.some((source) => source === target || source.contains(target))) return false;
    return target.dataset.h5veGroup === "1" || isFrameContainer(target);
  }

  function layerDropPlacement(event, row, target, sources) {
    const rect = row.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    if (canReceiveLayerChildren(target, sources) && ratio >= 0.24 && ratio <= 0.76) return "inside";
    return ratio < 0.5 ? "before" : "after";
  }

  function isValidLayerDrop(sources, target, placement) {
    if (!sources.length || !(target instanceof HTMLElement)) return false;
    if (sources.some((source) => source === target || source.contains(target))) return false;
    if (placement === "inside") return canReceiveLayerChildren(target, sources);
    const parent = target.parentElement;
    return !!parent && !isElementLocked(parent) && !sources.includes(parent);
  }

  function normalizeLayerSiblingDepth(parent) {
    if (!(parent instanceof Element)) return;
    [...parent.children]
      .filter((child) => child instanceof HTMLElement && !isStructuralChrome(child))
      .forEach((child, index) => {
        child.style.zIndex = String(index + 1);
      });
  }

  function fitLayerGroupWithoutMovingChildren(group) {
    if (!(group instanceof HTMLElement) || group.dataset.h5veGroup !== "1") return;
    const children = [...group.children].filter(
      (child) => child instanceof HTMLElement && !isStructuralChrome(child),
    );
    const snapshots = children.map((child) => ({ child, rect: child.getBoundingClientRect() }));
    fitDomGroupFrame(group);
    snapshots.forEach(({ child, rect }) => pinElementToViewportRect(child, rect));
  }

  function moveLayersByTreeDrop(sources, target, placement) {
    if (!isValidLayerDrop(sources, target, placement)) return false;
    endAnyTextEditing();
    const snapshots = sources.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const oldParents = new Set(sources.map((el) => el.parentElement).filter(Boolean));
    const fragment = document.createDocumentFragment();
    sources.forEach((el) => {
      clearLogicalGroupLink(el);
      fragment.appendChild(el);
    });

    let nextParent = target.parentElement;
    if (placement === "inside") {
      target.appendChild(fragment);
      nextParent = target;
      collapsedElementLayers.delete(target);
    } else if (placement === "before") {
      target.after(fragment);
    } else {
      target.before(fragment);
    }

    snapshots.forEach(({ el, rect }) => pinElementToViewportRect(el, rect));
    oldParents.forEach((parent) => {
      if (parent !== nextParent && parent?.dataset?.h5veGroup === "1" && parent.childElementCount > 0) {
        fitLayerGroupWithoutMovingChildren(parent);
      }
      normalizeLayerSiblingDepth(parent);
    });
    if (nextParent?.dataset?.h5veGroup === "1") fitLayerGroupWithoutMovingChildren(nextParent);
    normalizeLayerSiblingDepth(nextParent);

    setSelection(sources, sources[sources.length - 1]);
    pushHistory();
    renderElementPanel();
    scheduleSelectionBox();
    const action = placement === "inside"
      ? `已移入「${elementLayerName(target)}」`
      : placement === "before"
        ? "已上移图层"
        : "已下移图层";
    showToast(`${action} · 位置不变 · 可撤销`);
    return true;
  }

  function focusAdjacentElementRow(row, delta) {
    const rows = [...elementsPanel.querySelectorAll(".h5ve-element-item")];
    const index = rows.indexOf(row);
    const next = rows[Math.max(0, Math.min(index + delta, rows.length - 1))];
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  function primaryElementRow() {
    if (!elementsPanel || !state.primary) return null;
    return [...elementsPanel.querySelectorAll(".h5ve-element-item")].find((row) => {
      const el = row.__h5veElement;
      return el === state.primary || (isAtomicLayerElement(el) && el.contains(state.primary));
    }) || null;
  }

  function revealPrimaryElementRow() {
    if (
      !layerAutoRevealPending ||
      !elementsPanel ||
      elementsPanel.hidden ||
      state.layerQuery ||
      layerDragState ||
      elementsPanel.querySelector(".h5ve-element-name-input")
    ) return;
    cancelAnimationFrame(layerAutoRevealRaf);
    layerAutoRevealRaf = requestAnimationFrame(() => {
      const list = elementsPanel.querySelector(".h5ve-elements-list");
      const row = primaryElementRow();
      if (!list || !row) return;
      layerAutoRevealPending = false;
      const listRect = list.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const margin = 20;
      if (rowRect.top >= listRect.top + margin && rowRect.bottom <= listRect.bottom - margin) return;
      const centeredTop = list.scrollTop + rowRect.top - listRect.top - (listRect.height - rowRect.height) / 2;
      list.scrollTop = Math.max(0, centeredTop);
    });
  }

  function updateElementPanelSelection() {
    if (!elementsPanel || elementsPanel.hidden) return;
    let matched = 0;
    elementsPanel.querySelectorAll(".h5ve-element-item").forEach((row) => {
      const el = row.__h5veElement;
      const selected = state.selected.some((candidate) => candidate === el || (isAtomicLayerElement(el) && el.contains(candidate)));
      const primary = state.primary === el || (isAtomicLayerElement(el) && el.contains(state.primary));
      row.classList.toggle("selected", selected);
      row.classList.toggle("primary", selected && primary);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) matched++;
    });
    updateElementToolbarState();
    if (state.selected.length > 0 && matched === 0 && elementsPanel.dataset.h5veRendering !== "1") {
      renderElementPanel();
      return;
    }
    if (matched > 0) revealPrimaryElementRow();
  }

  function renderElementPanel() {
    if (!elementsPanel) return;
    const root = currentSlide() || (!document.getElementById("deck") ? contentRoot() : null);
    if (!root) {
      elementsPanel.hidden = true;
      return;
    }
    elementsPanel.hidden = false;
    elementsPanel.style.left = document.getElementById("deck") && !isCompactWorkbench()
      ? "var(--h5ve-slides-panel)"
      : "0px";
    const list = elementsPanel.querySelector(".h5ve-elements-list");
    const count = elementsPanel.querySelector(".h5ve-elements-count");
    if (!list) return;
    const previousScrollTop = list.scrollTop;
    elementsPanel.dataset.h5veRendering = "1";
    list.innerHTML = "";
    const query = normalizeLayerSearchText(state.layerQuery);
    const entries = [];
    const entryByElement = new Map();
    const childrenByParent = new Map();

    function collectChildren(parent, depth, parentLayer = null) {
      if (entries.length >= 500) return;
      const children = elementLayerChildren(parent);
      childrenByParent.set(parent, children);
      children.forEach((el) => {
        if (entries.length >= 500) return;
        const entry = { el, depth, parentLayer };
        entries.push(entry);
        entryByElement.set(el, entry);
        collectChildren(el, depth + 1, el);
      });
    }

    collectChildren(root, 0);
    if (!query && layerAutoRevealPending && state.primary) {
      let selectedEntry = entryByElement.get(state.primary) || null;
      if (!selectedEntry) {
        selectedEntry = entries.find(({ el }) => isAtomicLayerElement(el) && el.contains(state.primary)) || null;
      }
      let parentLayer = selectedEntry?.parentLayer || null;
      while (parentLayer) {
        collapsedElementLayers.delete(parentLayer);
        parentLayer = entryByElement.get(parentLayer)?.parentLayer || null;
      }
    }
    const directMatches = new Set(
      query ? entries.filter(({ el }) => layerSearchText(el).includes(query)).map(({ el }) => el) : entries.map(({ el }) => el),
    );
    const shownLayers = new Set();
    if (query) {
      directMatches.forEach((el) => {
        let current = el;
        while (current && current !== root) {
          shownLayers.add(current);
          current = entryByElement.get(current)?.parentLayer || null;
        }
      });
    } else {
      entries.forEach(({ el }) => shownLayers.add(el));
    }
    elementsPanel.classList.toggle("is-searching", !!query);
    if (layerSearchClear) layerSearchClear.hidden = !query;
    let rendered = 0;

    function appendChildren(parent, depth) {
      if (rendered >= 500) return;
      (childrenByParent.get(parent) || []).forEach((el) => {
        if (rendered >= 500 || !shownLayers.has(el)) return;
        const children = (childrenByParent.get(el) || []).filter((child) => shownLayers.has(child));
        const directMatch = !!query && directMatches.has(el);
        const row = document.createElement("div");
        row.className = "h5ve-element-item";
        row.style.setProperty("--h5ve-layer-depth", String(depth));
        row.tabIndex = 0;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-label", elementLayerName(el));
        row.__h5veElement = el;
        row.classList.toggle("is-hidden", isElementHidden(el));
        row.classList.toggle("is-locked", isElementLocked(el));
        row.classList.toggle("is-search-match", directMatch);
        row.draggable = !query && !isElementLocked(el) && el instanceof HTMLElement;
        if (query) row.title = directMatch ? `匹配「${state.layerQuery.trim()}」` : "匹配图层的上级容器";

        const disclosure = document.createElement(children.length ? "button" : "span");
        if (children.length) disclosure.type = "button";
        disclosure.className = "h5ve-element-disclosure";
        disclosure.tabIndex = -1;
        if (children.length) {
          const expanded = !!query || !collapsedElementLayers.has(el);
          disclosure.textContent = expanded ? "▾" : "▸";
          disclosure.setAttribute("aria-label", expanded ? "收起子元素" : "展开子元素");
          row.setAttribute("aria-expanded", expanded ? "true" : "false");
          disclosure.disabled = !!query;
          disclosure.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (query) return;
            if (collapsedElementLayers.has(el)) collapsedElementLayers.delete(el);
            else collapsedElementLayers.add(el);
            renderElementPanel();
          });
        } else {
          disclosure.setAttribute("aria-hidden", "true");
        }

        const icon = document.createElement("span");
        icon.className = "h5ve-element-icon";
        icon.textContent = elementLayerIcon(el);
        const name = document.createElement("span");
        name.className = "h5ve-element-name";
        name.textContent = elementLayerName(el);
        name.title = "双击重命名";
        const actions = document.createElement("span");
        actions.className = "h5ve-element-actions";
        const visibility = document.createElement("button");
        visibility.type = "button";
        visibility.className = "h5ve-element-control h5ve-element-visibility";
        visibility.classList.toggle("is-active", isElementExplicitlyHidden(el));
        visibility.title = isElementExplicitlyHidden(el) ? "显示元素" : "隐藏元素";
        visibility.setAttribute("aria-label", visibility.title);
        visibility.innerHTML = layerControlIcon("visibility", isElementExplicitlyHidden(el));
        const lock = document.createElement("button");
        lock.type = "button";
        lock.className = "h5ve-element-control h5ve-element-lock";
        lock.classList.toggle("is-active", isElementExplicitlyLocked(el));
        lock.title = isElementExplicitlyLocked(el) ? "解锁元素" : "锁定元素";
        lock.setAttribute("aria-label", lock.title);
        lock.innerHTML = layerControlIcon("lock", isElementExplicitlyLocked(el));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "h5ve-element-delete";
        remove.disabled = isElementLocked(el);
        remove.title = remove.disabled ? "先解锁再删除" : "删除此元素";
        remove.setAttribute("aria-label", `删除 ${name.textContent}`);
        remove.textContent = "×";

        actions.append(visibility, lock, remove);
        row.append(disclosure, icon, name, actions);
        name.addEventListener("dblclick", (event) => {
          event.preventDefault();
          event.stopPropagation();
          startLayerRename(row, el);
        });
        row.addEventListener("click", (event) => {
          if (!state.picking) togglePickMode();
          if (event.shiftKey || event.metaKey || event.ctrlKey) toggleInSelection(el);
          else selectSingle(el);
          row.focus({ preventScroll: true });
        });
        row.addEventListener("keydown", (event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            focusAdjacentElementRow(row, event.key === "ArrowUp" ? -1 : 1);
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey || event.metaKey || event.ctrlKey) toggleInSelection(el);
            else selectSingle(el);
            return;
          }
          if (event.key === "F2") {
            event.preventDefault();
            event.stopPropagation();
            startLayerRename(row, el);
            return;
          }
          if (event.key === "Backspace" || event.key === "Delete") {
            event.preventDefault();
            event.stopPropagation();
            if (!state.selected.includes(el)) selectSingle(el);
            deleteSelected();
          }
        });
        row.addEventListener("dragstart", (event) => {
          if (!row.draggable || !event.dataTransfer) {
            event.preventDefault();
            return;
          }
          if (!state.selected.includes(el)) selectSingle(el);
          const sources = topLevelLayerDragSources(el);
          if (!sources.length) {
            event.preventDefault();
            showToast("锁定元素不能调整层级");
            return;
          }
          layerDragState = { source: el, sources, target: null, placement: null };
          row.classList.add("is-dragging");
          row.setAttribute("aria-grabbed", "true");
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", sources.map(elementLayerName).join(", "));
          const preview = createLayerDragPreview(el, sources.length);
          if (preview) event.dataTransfer.setDragImage(preview, 14, 14);
        });
        row.addEventListener("dragover", (event) => {
          if (!layerDragState || !event.dataTransfer) return;
          const placement = layerDropPlacement(event, row, el, layerDragState.sources);
          if (!isValidLayerDrop(layerDragState.sources, el, placement)) {
            event.dataTransfer.dropEffect = "none";
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          clearLayerDropTargets();
          row.classList.add(`drop-${placement}`);
          layerDragState.target = el;
          layerDragState.placement = placement;
          const listRect = list.getBoundingClientRect();
          if (event.clientY < listRect.top + 30) list.scrollTop -= 16;
          else if (event.clientY > listRect.bottom - 30) list.scrollTop += 16;
        });
        row.addEventListener("dragleave", (event) => {
          if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
          row.classList.remove("drop-before", "drop-after", "drop-inside");
        });
        row.addEventListener("drop", (event) => {
          if (!layerDragState) return;
          const placement = layerDropPlacement(event, row, el, layerDragState.sources);
          if (!isValidLayerDrop(layerDragState.sources, el, placement)) return;
          event.preventDefault();
          event.stopPropagation();
          const sources = layerDragState.sources.slice();
          clearLayerDropFeedback();
          moveLayersByTreeDrop(sources, el, placement);
          clearLayerDragState();
        });
        row.addEventListener("dragend", () => clearLayerDragState());
        visibility.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleLayerVisibility(el);
        });
        lock.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          toggleLayerLock(el);
        });
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!state.picking) togglePickMode();
          if (!state.selected.includes(el)) selectSingle(el);
          deleteSelected();
        });
        list.appendChild(row);
        rendered++;
        if (children.length && (query || !collapsedElementLayers.has(el))) appendChildren(el, depth + 1);
      });
    }

    appendChildren(root, 0);
    if (count) {
      count.textContent = query ? `${directMatches.size}/${entries.length}` : String(entries.length);
      count.title = query ? `匹配 ${directMatches.size} 个，共 ${entries.length} 个图层` : `共 ${entries.length} 个图层`;
    }
    if (!rendered) {
      const empty = document.createElement("div");
      empty.className = "h5ve-elements-empty";
      empty.textContent = query ? `没有匹配「${state.layerQuery.trim()}」的图层` : "当前页没有可选择元素";
      list.appendChild(empty);
    }
    list.scrollTop = query ? 0 : previousScrollTop;
    updateElementPanelSelection();
    delete elementsPanel.dataset.h5veRendering;
  }

  function showPreviewPanel() {
    panel.innerHTML = `
      <div class="h5ve-panel-header">预览</div>
      <div class="h5ve-panel-empty h5ve-panel-empty-state">
        <strong>当前为预览模式</strong>
        <span>页面交互与正常浏览 PPT 相同</span>
        <small>← → 翻页 · ⇧D 切回选择模式</small>
      </div>
    `;
    panelFields = {};
    renderSlideControls();
  }

  function updateStatus() {
    const status = sidebar.querySelector(".h5ve-status");
    if (!status) return;
    if (!state.picking) {
      status.textContent = "预览模式";
      return;
    }
    if (state.selected.length === 0) {
      status.textContent = "未选中";
    } else if (state.selected.length === 1) {
      status.textContent = labelFor(state.selected[0]);
    } else {
      status.textContent = `已选中 ${state.selected.length} 个 · ${labelFor(state.primary)}`;
    }
  }

  function selectionHierarchy(el) {
    const root = currentSlide() || contentRoot();
    if (!(el instanceof Element) || !root?.contains(el)) return [];
    const path = [];
    let cursor = el;
    while (cursor && cursor !== root) {
      if (cursor === el || isVisibleLayerElement(cursor)) path.push(cursor);
      cursor = cursor.parentElement;
    }
    return path.reverse();
  }

  function renderSelectionPath() {
    if (!selectionPath) return;
    const page = Math.max(1, getCurrentSlideIndex() + 1);
    const hierarchy = state.selected.length === 1 ? selectionHierarchy(state.primary) : [];
    selectionPath.innerHTML = "";

    const appendCrumb = (label, el = null, current = false) => {
      if (selectionPath.childElementCount > 0) {
        const separator = document.createElement("span");
        separator.className = "h5ve-selection-path-separator";
        separator.setAttribute("aria-hidden", "true");
        separator.textContent = "›";
        selectionPath.appendChild(separator);
      }
      const crumb = document.createElement("button");
      crumb.type = "button";
      crumb.className = "h5ve-selection-path-crumb";
      crumb.textContent = label;
      crumb.title = el ? `选择「${elementLayerName(el)}」` : `第 ${page} 页画布`;
      if (current) crumb.setAttribute("aria-current", "true");
      crumb.addEventListener("click", () => {
        if (el) selectSingle(el);
        else selectSingle(null);
      });
      selectionPath.appendChild(crumb);
    };

    appendCrumb(`第 ${page} 页`, null, hierarchy.length === 0);
    if (state.selected.length > 1) {
      appendCrumb(`${state.selected.length} 个元素`, null, true);
    } else {
      hierarchy.forEach((el, index) => appendCrumb(elementLayerName(el), el, index === hierarchy.length - 1));
    }
    requestAnimationFrame(() => {
      selectionPath.scrollLeft = selectionPath.scrollWidth;
    });
  }

  function selectionParentElement(el) {
    const root = currentSlide() || contentRoot();
    if (!(el instanceof Element) || !root?.contains(el)) return null;
    let parent = el.parentElement;
    while (parent && parent !== root) {
      if (isVisibleLayerElement(parent)) return parent;
      parent = parent.parentElement;
    }
    return null;
  }

  function selectParentLayer() {
    if (state.selected.length !== 1 || !(state.primary instanceof Element)) {
      selectSingle(null);
      return true;
    }
    const parent = selectionParentElement(state.primary);
    if (parent) {
      selectSingle(parent);
      showToast(`已返回上层· ${elementLayerName(parent)}`);
    } else {
      selectSingle(null);
      showToast("已返回页面画布");
    }
    return true;
  }

  function enterSelectionChild(el) {
    if (!(el instanceof Element)) return false;
    const children = elementLayerChildren(el);
    const child = children.find((candidate) => !isElementLocked(candidate) && !isElementHidden(candidate));
    if (!child) return false;
    selectSingle(child);
    showToast(`已进入子层· ${elementLayerName(child)}`);
    return true;
  }

  function setSelection(els, primary) {
    clearSelectionMarks();
    state.selected = (els || []).filter((el) => el && el.isConnected);
    state.primary =
      primary && state.selected.includes(primary)
        ? primary
        : state.selected[state.selected.length - 1] || null;
    layerAutoRevealPending = !!state.primary && !state.marqueeing;
    state.selected.forEach((el) => {
      el.dataset.h5veSelected = "true";
    });
    fillPanel(state.primary);
    const inspectorPanel = document.getElementById("h5ve-panel");
    if (inspectorPanel) inspectorPanel.scrollTop = 0;
    updateSelectionBoxes();
    updateStatus();
    renderSelectionPath();
    updateElementPanelSelection();
  }

  function selectSingle(el) {
    setSelection(el ? [el] : [], el);
  }

  function toggleInSelection(el) {
    if (state.selected.includes(el)) {
      const next = state.selected.filter((x) => x !== el);
      setSelection(next, next[next.length - 1] || null);
    } else {
      setSelection([...state.selected, el], el);
    }
  }

  function isStructuralChrome(el) {
    if (!(el instanceof Element)) return true;
    return el.matches("script, style, link, meta, [data-h5ve-speaker-note], [data-h5ve-structural]");
  }

  function getDrillDownChildren(el) {
    if (!(el instanceof Element)) return [];
    if (el.dataset?.h5veGroup === "1") {
      return Array.from(el.children).filter((child) => !isStructuralChrome(child));
    }
    return Array.from(el.children).filter((child) => {
      if (!(child instanceof Element) || isStructuralChrome(child)) return false;
      return isVisibleLayerElement(child);
    });
  }

  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function queryGroupMembers(groupId, scope) {
    if (!groupId) return [];
    const root = scope || document.getElementById("deck") || document;
    const sel = `[data-h5ve-group-id="${cssEscape(groupId)}"]`;
    return Array.from(root.querySelectorAll(sel));
  }

  function findDomGroupWrapper(el) {
    if (!(el instanceof Element)) return null;
    if (el.dataset?.h5veGroup === "1") return el;
    return el.closest("[data-h5ve-group='1']");
  }

  function expandDomGroupMembers(el) {
    const wrapper = findDomGroupWrapper(el);
    if (!wrapper || el === wrapper) return null;
    const members = Array.from(wrapper.children).filter(
      (child) => child instanceof Element && !isStructuralChrome(child),
    );
    return members.length > 1 ? members : null;
  }

  function expandByGroupId(el) {
    const dom = expandDomGroupMembers(el);
    if (dom) return dom;
    const id = el?.dataset?.h5veGroupId;
    if (!id) return null;
    const slide = el?.closest?.(".slide") || currentSlide();
    if (!slide) return null;
    const members = queryGroupMembers(id, slide);
    return members.length > 1 ? members : null;
  }

  function collectGroupIdsFromSelection(els) {
    const groupIds = new Set();
    (els || []).forEach((el) => {
      if (!el) return;
      const expanded = expandByGroupId(el);
      if (expanded) {
        expanded.forEach((member) => {
          if (member?.dataset?.h5veGroupId) groupIds.add(member.dataset.h5veGroupId);
        });
      } else if (el?.dataset?.h5veGroupId) {
        groupIds.add(el.dataset.h5veGroupId);
      }
    });
    return groupIds;
  }

  function collectGroupMembers(els) {
    const out = new Set();
    (els || []).forEach((el) => {
      if (!el) return;
      const expanded = expandByGroupId(el);
      if (expanded) expanded.forEach((n) => out.add(n));
      else out.add(el);
    });
    return Array.from(out);
  }

  function drawGuideLines(lines) {
    const layer = selectionLayer;
    // 清除旧线
    layer.querySelectorAll(".h5ve-guide").forEach(l => l.remove());
    lines.forEach(line => {
      const el = document.createElement("div");
      el.className = "h5ve-guide";
      if (line.type === "v") {
        el.style.left = `${line.pos}px`;
        el.style.top = "0";
        el.style.width = "1px";
        el.style.height = "100%";
      } else {
        el.style.top = `${line.pos}px`;
        el.style.left = "0";
        el.style.width = "100%";
        el.style.height = "1px";
      }
      layer.appendChild(el);
    });
  }

  function getSnappingGuides(draggingRect) {
    const slide = currentSlide();
    if (!slide) return { dx: 0, dy: 0, lines: [] };

    const SNAP_THRESHOLD = 5;
    const guides = []; // { type: 'v'|'h', pos: pixel }
    let snapDx = 0;
    let snapDy = 0;

    // 收集参考物
    const references = [];
    // 1. 页面中心和边界
    const sr = slide.getBoundingClientRect();
    references.push({ v: sr.left, h: sr.top });
    references.push({ v: sr.right, h: sr.bottom });
    references.push({ v: sr.left + sr.width / 2, h: sr.top + sr.height / 2 });

    // 2. 其他元素
    slide.querySelectorAll("*").forEach(el => {
      if (isEditableTarget(el) && !state.selected.includes(el) && !state.selected.some(s => s.contains(el))) {
        const r = el.getBoundingClientRect();
        references.push({ v: r.left, h: r.top, cx: r.left + r.width/2, cy: r.top + r.height/2, r: r.right, b: r.bottom });
      }
    });

    const d = draggingRect;
    const dEdgesV = [d.left, d.right, d.left + d.width / 2];
    const dEdgesH = [d.top, d.bottom, d.top + d.height / 2];

    // 垂直吸附
    for (const ref of references) {
      const refV = [ref.v, ref.r, ref.cx].filter(v => v !== undefined);
      for (const rv of refV) {
        for (const dv of dEdgesV) {
          if (Math.abs(dv - rv) < SNAP_THRESHOLD) {
            snapDx = rv - dv;
            guides.push({ type: "v", pos: rv });
            break;
          }
        }
        if (snapDx) break;
      }
    }

    // 水平吸附
    for (const ref of references) {
      const refH = [ref.h, ref.b, ref.cy].filter(h => h !== undefined);
      for (const rh of refH) {
        for (const dh of dEdgesH) {
          if (Math.abs(dh - rh) < SNAP_THRESHOLD) {
            snapDy = rh - dh;
            guides.push({ type: "h", pos: rh });
            break;
          }
        }
        if (snapDy) break;
      }
    }

    return { dx: snapDx, dy: snapDy, lines: guides };
  }

  function rectToLocal(rect, parentRect) {
    return {
      left: (rect.left - parentRect.left) / state.scale,
      top: (rect.top - parentRect.top) / state.scale,
      width: rect.width / state.scale,
      height: rect.height / state.scale,
    };
  }

  function elementVisualBox(el, parentRect) {
    const r = getVisualContentRect(el);
    return rectToLocal(r, parentRect);
  }

  function unionBoxes(boxes) {
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.left + box.width));
    const bottom = Math.max(...boxes.map((box) => box.top + box.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  function absolutizeElement(el, box) {
    const cs = getComputedStyle(el);
    if (cs.display === "inline") el.style.display = "inline-block";
    el.style.position = "absolute";
    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.width}px`;
    el.style.height = `${box.height}px`;
    el.style.margin = "0";
    el.style.transform = "none";
  }

  /** 解组时按解组前的屏幕矩形重新锚定，不让 flex / grid 重排改变位置。 */
  function pinElementToViewportRect(el, targetRect) {
    if (!(el instanceof HTMLElement) || !targetRect) return;
    const originalTransform = el.style.transform;
    el.style.position = "absolute";
    el.style.inset = "auto";
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.left = "0px";
    el.style.top = "0px";
    el.style.margin = "0";
    el.style.flex = "none";
    el.style.gridArea = "auto";
    el.style.boxSizing = "border-box";
    el.style.transform = originalTransform || "none";

    const offsetParent = el.offsetParent instanceof HTMLElement ? el.offsetParent : document.documentElement;
    const parentRect = offsetParent.getBoundingClientRect();
    const parentStyle = getComputedStyle(offsetParent);
    const measuredScaleX = offsetParent.offsetWidth > 0 ? parentRect.width / offsetParent.offsetWidth : state.scale;
    const measuredScaleY = offsetParent.offsetHeight > 0 ? parentRect.height / offsetParent.offsetHeight : state.scale;
    const scaleX = Number.isFinite(measuredScaleX) && measuredScaleX > 0 ? measuredScaleX : state.scale || 1;
    const scaleY = Number.isFinite(measuredScaleY) && measuredScaleY > 0 ? measuredScaleY : state.scale || 1;
    const originLeft = parentRect.left + (parseFloat(parentStyle.borderLeftWidth) || 0) * scaleX;
    const originTop = parentRect.top + (parseFloat(parentStyle.borderTopWidth) || 0) * scaleY;

    let left = (targetRect.left - originLeft) / scaleX + offsetParent.scrollLeft;
    let top = (targetRect.top - originTop) / scaleY + offsetParent.scrollTop;
    let width = targetRect.width / scaleX;
    let height = targetRect.height / scaleY;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;

    const actual = el.getBoundingClientRect();
    left += (targetRect.left - actual.left) / scaleX;
    top += (targetRect.top - actual.top) / scaleY;
    width = Math.max(0.5, width + (targetRect.width - actual.width) / scaleX);
    height = Math.max(0.5, height + (targetRect.height - actual.height) / scaleY);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  }

  function fitDomGroupFrame(wrapper) {
    if (!(wrapper instanceof Element) || wrapper.dataset?.h5veGroup !== "1") return;
    const kids = Array.from(wrapper.children).filter(
      (child) => child instanceof Element && !isStructuralChrome(child),
    );
    if (!kids.length) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const boxes = kids.map((kid) => elementVisualBox(kid, wrapperRect));
    const frame = unionBoxes(boxes);
    kids.forEach((kid, i) => {
      const box = boxes[i];
      absolutizeElement(kid, {
        left: box.left - frame.left,
        top: box.top - frame.top,
        width: box.width,
        height: box.height,
      });
    });
    const t = parseTransform(wrapper);
    const inlineLeft = parseFloat(wrapper.style.left);
    const inlineTop = parseFloat(wrapper.style.top);
    const baseLeft = Number.isFinite(inlineLeft) ? inlineLeft : wrapper.offsetLeft;
    const baseTop = Number.isFinite(inlineTop) ? inlineTop : wrapper.offsetTop;
    wrapper.style.left = `${baseLeft + frame.left}px`;
    wrapper.style.top = `${baseTop + frame.top}px`;
    wrapper.style.width = `${frame.width}px`;
    wrapper.style.height = `${frame.height}px`;
    applyTransform(wrapper, t.x, t.y);
  }

  function unwrapFrameElement(frame) {
    const parent = frame?.parentElement;
    if (!parent || !(frame instanceof Element)) return [];
    const kids = Array.from(frame.children).filter((child) => child instanceof Element && !isStructuralChrome(child));
    if (!kids.length) return [];
    const snapshots = kids.map((kid) => ({ kid, rect: kid.getBoundingClientRect() }));
    snapshots.forEach(({ kid, rect }) => {
      parent.insertBefore(kid, frame);
      pinElementToViewportRect(kid, rect);
    });
    frame.remove();
    return kids;
  }

  function unwrapDomGroup(wrapper) {
    if (wrapper?.dataset?.h5veGroup !== "1") return [];
    return unwrapFrameElement(wrapper);
  }

  function wrapDomGroup(elements) {
    const members = (elements || []).filter((el) => el instanceof Element);
    if (members.length < 2) return null;
    const parent = members[0].parentElement;
    if (!parent || !members.every((el) => el.parentElement === parent)) return null;
    const order = [...parent.children];
    members.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const snapshots = members.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const frame = unionBoxes(snapshots.map(({ rect }) => rect));
    const wrapper = document.createElement("div");
    wrapper.dataset.h5veGroup = "1";
    wrapper.className = "h5ve-group";
    wrapper.style.overflow = "visible";
    parent.insertBefore(wrapper, members[0]);
    pinElementToViewportRect(wrapper, frame);
    snapshots.forEach(({ el, rect }) => {
      clearLogicalGroupLink(el);
      wrapper.appendChild(el);
      pinElementToViewportRect(el, rect);
    });
    return wrapper;
  }

  function clearLogicalGroupLink(el) {
    if (!(el instanceof Element)) return;
    el.removeAttribute("data-h5ve-group-id");
  }

  function clearLogicalGroupById(groupId) {
    if (!groupId) return [];
    const deck = document.getElementById("deck");
    const freed = [];
    queryGroupMembers(groupId, deck).forEach((el) => {
      clearLogicalGroupLink(el);
      freed.push(el);
    });
    return freed;
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function inferAutoLayout(snapshots) {
    const rects = snapshots.map(({ rect }) => rect);
    const pairScores = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        pairScores.push({
          x: overlapX / Math.max(1, Math.min(a.width, b.width)),
          y: overlapY / Math.max(1, Math.min(a.height, b.height)),
        });
      }
    }
    const overlapX = pairScores.reduce((sum, score) => sum + score.x, 0) / Math.max(1, pairScores.length);
    const overlapY = pairScores.reduce((sum, score) => sum + score.y, 0) / Math.max(1, pairScores.length);
    const frame = unionBoxes(rects);
    const averageWidth = rects.reduce((sum, rect) => sum + rect.width, 0) / rects.length;
    const averageHeight = rects.reduce((sum, rect) => sum + rect.height, 0) / rects.length;
    const direction = Math.abs(overlapX - overlapY) > 0.12
      ? overlapX > overlapY ? "vertical" : "horizontal"
      : frame.width / Math.max(averageWidth, 1) >= frame.height / Math.max(averageHeight, 1)
        ? "horizontal"
        : "vertical";
    const ordered = [...snapshots].sort((a, b) => {
      const main = direction === "horizontal" ? a.rect.left - b.rect.left : a.rect.top - b.rect.top;
      if (Math.abs(main) > 0.5) return main;
      return direction === "horizontal" ? a.rect.top - b.rect.top : a.rect.left - b.rect.left;
    });
    const gaps = ordered.slice(1).map((current, index) => {
      const previous = ordered[index];
      return direction === "horizontal"
        ? current.rect.left - previous.rect.right
        : current.rect.top - previous.rect.bottom;
    });
    const gap = Math.max(0, median(gaps.filter((value) => Number.isFinite(value))));
    const crossValues = (kind) => ordered.map(({ rect }) => {
      if (direction === "horizontal") {
        if (kind === "start") return rect.top;
        if (kind === "end") return rect.bottom;
        return rect.top + rect.height / 2;
      }
      if (kind === "start") return rect.left;
      if (kind === "end") return rect.right;
      return rect.left + rect.width / 2;
    });
    const spread = (values) => Math.max(...values) - Math.min(...values);
    const tolerance = Math.max(4, (direction === "horizontal" ? frame.height : frame.width) * 0.01);
    const alignment = spread(crossValues("start")) <= tolerance
      ? "flex-start"
      : spread(crossValues("end")) <= tolerance
        ? "flex-end"
        : spread(crossValues("center")) <= tolerance
          ? "center"
          : "flex-start";
    return { direction, ordered, gap, alignment, frame };
  }

  function wrapAutoLayout(elements) {
    const members = (elements || []).filter((el) => el instanceof HTMLElement);
    if (members.length < 2) return null;
    const parent = members[0].parentElement;
    if (!parent || !members.every((el) => el.parentElement === parent)) return null;
    const snapshots = members.map((el) => ({ el, rect: el.getBoundingClientRect() }));
    const layout = inferAutoLayout(snapshots);
    const first = [...parent.children].find((child) => members.includes(child));
    const wrapper = document.createElement("div");
    wrapper.dataset.h5veGroup = "1";
    wrapper.dataset.h5veFrame = "1";
    wrapper.dataset.h5veAutoLayout = "1";
    wrapper.dataset.h5veFlow = layout.direction;
    wrapper.dataset.h5veWidthMode = "hug";
    wrapper.dataset.h5veHeightMode = "hug";
    wrapper.dataset.h5veLayerName = "自适应布局";
    wrapper.className = "h5ve-group h5ve-auto-layout";
    wrapper.style.overflow = "visible";
    parent.insertBefore(wrapper, first || members[0]);
    pinElementToViewportRect(wrapper, layout.frame);
    const wrapperRect = wrapper.getBoundingClientRect();
    const scaleX = wrapper.offsetWidth > 0 ? wrapperRect.width / wrapper.offsetWidth : state.scale || 1;
    const scaleY = wrapper.offsetHeight > 0 ? wrapperRect.height / wrapper.offsetHeight : state.scale || 1;
    layout.ordered.forEach(({ el, rect }) => {
      clearLogicalGroupLink(el);
      wrapper.appendChild(el);
      if (getComputedStyle(el).display === "inline") el.style.display = "inline-block";
      el.style.position = "relative";
      el.style.inset = "auto";
      el.style.left = "auto";
      el.style.top = "auto";
      el.style.right = "auto";
      el.style.bottom = "auto";
      el.style.width = `${Math.max(0.5, rect.width / Math.max(scaleX, 0.0001))}px`;
      el.style.height = `${Math.max(0.5, rect.height / Math.max(scaleY, 0.0001))}px`;
      el.style.margin = "0";
      el.style.flex = "0 0 auto";
      el.style.alignSelf = "auto";
      el.style.transform = "none";
      el.style.boxSizing = "border-box";
    });
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = layout.direction === "vertical" ? "column" : "row";
    wrapper.style.flexWrap = "nowrap";
    wrapper.style.alignItems = layout.alignment;
    wrapper.style.justifyContent = "flex-start";
    wrapper.style.gap = `${layout.gap / Math.max(layout.direction === "horizontal" ? scaleX : scaleY, 0.0001)}px`;
    wrapper.style.padding = "0";
    wrapper.style.width = "fit-content";
    wrapper.style.height = "fit-content";
    wrapper.style.minWidth = "0";
    wrapper.style.minHeight = "0";
    wrapper.style.maxWidth = "none";
    wrapper.style.maxHeight = "none";
    return { wrapper, layout };
  }

  function autoLayoutSelection() {
    if (!state.picking) {
      showToast("预览模式下无法添加自适应布局 · 按 ⇧D 进入选择模式");
      return;
    }
    const scope = currentSlide() || contentRoot();
    if (!scope) return;
    const members = collectGroupMembers(state.selected).filter((el) => scope.contains(el) && !isElementLocked(el));
    if (members.length < 2) {
      showToast("请先多选至少 2 个元素，再按 ⇧A 添加自适应布局");
      return;
    }
    const result = wrapAutoLayout(members);
    if (!result) {
      showToast("自适应布局要求元素位于同一层 · 请先整理图层层级");
      return;
    }
    selectSingle(result.wrapper);
    pushHistory({ label: "添加自适应布局" });
    renderElementPanel();
    updateStatus();
    showToast(`已创建${result.layout.direction === "vertical" ? "纵向" : "横向"}自适应布局 · 间距 ${Math.round(result.layout.gap / Math.max(state.scale, 0.0001))}`);
  }

  function groupSelection() {
    if (!state.picking) {
      showToast("预览模式下无法编组 · 按 ⇧D 进入选择模式");
      return;
    }
    const slide = currentSlide();
    if (!slide) return;
    const members = collectGroupMembers(state.selected).filter((el) => slide.contains(el) && !isElementLocked(el));
    if (members.length < 2) {
      showToast("请先用 Ctrl / ⌘ / Shift 多选至少 2 个元素，再按 ⌘G 编组");
      return;
    }

    const wrapper = wrapDomGroup(members);
    if (wrapper) {
      selectSingle(wrapper);
      pushHistory();
      renderElementPanel();
      showToast(`已编组为自适应框架 · ⌘⇧G 或侧栏「解组」`);
      updateStatus();
      return;
    }

    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    members.forEach((el) => {
      el.setAttribute("data-h5ve-group-id", id);
    });
    setSelection(members, members[0]);
    pushHistory();
    showToast(`已编组 ${members.length} 个元素（跨容器）· ⌘⇧G 解组`);
    updateStatus();
  }

  function ungroupSelection() {
    if (!state.picking) {
      showToast("预览模式下无法解组 · 按 ⇧D 进入选择模式");
      return;
    }
    if (state.selected.length === 0) {
      showToast("请先选中要解组的元素");
      return;
    }
    if (state.selected.some(isElementLocked)) {
      showToast("选中元素已锁定·请先解锁再解组");
      return;
    }

    const domWrappers = new Set();
    state.selected.forEach((el) => {
      const wrapper = findDomGroupWrapper(el);
      if (wrapper) domWrappers.add(wrapper);
    });
    if (domWrappers.size > 0) {
      const freed = [];
      domWrappers.forEach((wrapper) => {
        freed.push(...unwrapDomGroup(wrapper));
      });
      if (freed.length) {
        selectSingle(freed[0]);
        pushHistory();
        renderElementPanel();
        showToast(`已解组 ${freed.length} 个元素`);
        return;
      }
    }

    const groupIds = collectGroupIdsFromSelection(state.selected);
    if (groupIds.size > 0) {
      const freed = [];
      groupIds.forEach((id) => {
        freed.push(...clearLogicalGroupById(id));
      });
      if (freed.length === 0) {
        showToast("未找到可解组的编组成员");
        return;
      }
      selectSingle(freed[0]);
      pushHistory();
      renderElementPanel();
      showToast(`已解组 ${freed.length} 个元素`);
      return;
    }

    if (state.selected.length === 1 && state.primary?.dataset?.h5veGroup === "1") {
      const kids = unwrapDomGroup(state.primary);
      if (kids.length) {
        selectSingle(kids[0]);
        pushHistory();
        renderElementPanel();
        showToast(`已解组为 ${kids.length} 个子元素`);
        return;
      }
    }

    if (state.selected.length === 1 && state.primary) {
      const kids = getDrillDownChildren(state.primary);
      if (kids.length === 0) {
        showToast("当前元素未编组 · 无法解组");
        return;
      }
      const freed = unwrapFrameElement(state.primary);
      if (freed.length) {
        setSelection(freed, freed[0]);
        pushHistory();
        showToast(`已删除外层框架，释放 ${freed.length} 个子元素`);
        return;
      }
      setSelection(kids, kids[0]);
      showToast(`已下钻选中 ${kids.length} 个子元素`);
      return;
    }

    if (state.selected.length > 1) {
      selectSingle(state.primary || state.selected[0]);
      showToast("当前仅为多选，未编组 · 已改为单选");
      return;
    }

    showToast("当前选区无法解组");
  }

  function handleGroupShortcut(e) {
    const key = e.key.toLowerCase();
    if (!(e.metaKey || e.ctrlKey) || key !== "g") return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (document.querySelector("[data-h5ve-editing='true']")) endAnyTextEditing();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
    return true;
  }

  function handleAutoLayoutShortcut(e) {
    if (
      e.key.toLowerCase() !== "a" ||
      !e.shiftKey ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      isTypingOrEditingTarget(e.target)
    ) return false;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (document.querySelector("[data-h5ve-editing='true']")) endAnyTextEditing();
    autoLayoutSelection();
    return true;
  }

  function isAdditiveSelectionEvent(event) {
    return !!(event?.shiftKey || event?.metaKey || event?.ctrlKey);
  }

  function selectEditableTarget(el, { shiftKey = false } = {}) {
    if (!el) {
      if (!shiftKey) selectSingle(null);
      return;
    }
    const wrapper = findDomGroupWrapper(el);
    const target = wrapper || el;
    if (shiftKey) {
      toggleInSelection(target);
      return;
    }
    const members = expandByGroupId(target);
    if (members) setSelection(members, target);
    else selectSingle(target);
  }

  const RESIZE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  function renderResizeHandles(r) {
    const corner = 8; // corner handle size
    const edge = 6; // edge hit-area thickness
    RESIZE_DIRS.forEach((dir) => {
      const h = document.createElement("div");
      h.className = "h5ve-resize";
      h.dataset.dir = dir;
      const s = h.style;
      if (dir.length === 2) {
        // corners: nw / ne / sw / se
        s.width = `${corner}px`;
        s.height = `${corner}px`;
        s.left = `${(dir.includes("w") ? r.left : r.right) - corner / 2}px`;
        s.top = `${(dir.includes("n") ? r.top : r.bottom) - corner / 2}px`;
      } else if (dir === "n" || dir === "s") {
        s.left = `${r.left + corner}px`;
        s.width = `${Math.max(0, r.width - corner * 2)}px`;
        s.height = `${edge}px`;
        s.top = `${(dir === "n" ? r.top : r.bottom) - edge / 2}px`;
      } else {
        s.top = `${r.top + corner}px`;
        s.height = `${Math.max(0, r.height - corner * 2)}px`;
        s.width = `${edge}px`;
        s.left = `${(dir === "w" ? r.left : r.right) - edge / 2}px`;
      }
      selectionLayer.appendChild(h);
    });
  }

  function renderRotateHandle(r) {
    const centerX = r.left + r.width / 2;
    const line = document.createElement("div");
    line.className = "h5ve-rotate-stem";
    line.style.left = `${centerX}px`;
    line.style.top = `${r.top - 24}px`;
    line.style.height = "24px";
    selectionLayer.appendChild(line);

    const rotate = document.createElement("button");
    rotate.type = "button";
    rotate.className = "h5ve-rotate-handle";
    rotate.setAttribute("aria-label", "旋转元素");
    rotate.title = "拖拽旋转 · Shift 吸附 15°";
    rotate.style.left = `${centerX - 7}px`;
    rotate.style.top = `${r.top - 36}px`;
    rotate.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.6 5.2A5 5 0 1 0 13 10"/><path d="M10.2 2.7h3v3"/></svg>`;
    selectionLayer.appendChild(rotate);
  }

  function getMediaIntrinsicSize(media) {
    if (!media) return null;
    if (media.tagName === "IMG") {
      const width = media.naturalWidth || 0;
      const height = media.naturalHeight || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (media.tagName === "VIDEO") {
      const width = media.videoWidth || 0;
      const height = media.videoHeight || 0;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }

  function findPrimaryMedia(el) {
    if (!el || !(el instanceof Element)) return null;
    if (el.matches("img,video")) return el;
    const media = [...el.querySelectorAll(":scope > img, :scope > video")].filter((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    return media.length === 1 ? media[0] : null;
  }

  function getVisualContentRect(el) {
    const rect = el.getBoundingClientRect();
    const media = findPrimaryMedia(el);
    const intrinsic = getMediaIntrinsicSize(media);
    if (!media || !intrinsic || rect.width <= 0 || rect.height <= 0) return rect;

    const mediaRect = media.getBoundingClientRect();
    const fit = getComputedStyle(media).objectFit;
    if (!["contain", "scale-down"].includes(fit)) return mediaRect;

    const containerRatio = mediaRect.width / mediaRect.height;
    const mediaRatio = intrinsic.width / intrinsic.height;
    let width = mediaRect.width;
    let height = mediaRect.height;

    if (mediaRatio > containerRatio) {
      height = width / mediaRatio;
    } else {
      width = height * mediaRatio;
    }

    return {
      left: mediaRect.left + (mediaRect.width - width) / 2,
      top: mediaRect.top + (mediaRect.height - height) / 2,
      right: mediaRect.left + (mediaRect.width + width) / 2,
      bottom: mediaRect.top + (mediaRect.height + height) / 2,
      width,
      height,
    };
  }

  function getSelectableVisualRect(el) {
    const rect = getVisualContentRect(el);
    if (!isThinLineElement(el, rect)) return rect;
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);
    return {
      left: rect.left - (width - rect.width) / 2,
      top: rect.top - (height - rect.height) / 2,
      right: rect.right + (width - rect.width) / 2,
      bottom: rect.bottom + (height - rect.height) / 2,
      width,
      height,
    };
  }

  function selectionViewportBounds(elements = state.selected) {
    const rects = elements
      .filter((el) => el?.isConnected && !isElementHidden(el))
      .map((el) => getSelectableVisualRect(el))
      .filter((rect) => rect.width > 0 && rect.height > 0);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function renderThinLineHitTargets() {
    const root = currentSlide() || (!document.getElementById("deck") ? contentRoot() : null);
    if (!root || !state.picking) return;
    root.querySelectorAll("*").forEach((el) => {
      if (!isEditableTarget(el)) return;
      const rect = el.getBoundingClientRect();
      if (!isThinLineElement(el, rect)) return;
      const horizontal = rect.width >= rect.height;
      const hitSize = 12;
      const hit = document.createElement("div");
      hit.className = "h5ve-line-hit";
      hit.__h5veElement = el;
      hit.dataset.h5veLineDirection = horizontal ? "horizontal" : "vertical";
      hit.style.left = `${horizontal ? rect.left : rect.left + rect.width / 2 - hitSize / 2}px`;
      hit.style.top = `${horizontal ? rect.top + rect.height / 2 - hitSize / 2 : rect.top}px`;
      hit.style.width = `${horizontal ? Math.max(rect.width, hitSize) : hitSize}px`;
      hit.style.height = `${horizontal ? hitSize : Math.max(rect.height, hitSize)}px`;
      selectionLayer.appendChild(hit);
    });
  }

  function updateSelectionBoxes() {
    selectionLayer.innerHTML = "";
    renderThinLineHitTargets();
    if (state.selected.length === 0) {
      handle.style.display = "none";
      return;
    }

    const visibleSelection = state.selected.filter((el) => !isElementHidden(el));
    const selectedRects = visibleSelection
      .map((el) => getSelectableVisualRect(el))
      .filter((r) => r.width > 0 && r.height > 0);

    if (selectedRects.length === 0) {
      handle.style.display = "none";
      return;
    }

    if (selectedRects.length > 1) {
      const bounds = {
        left: Math.min(...selectedRects.map((r) => r.left)),
        top: Math.min(...selectedRects.map((r) => r.top)),
        right: Math.max(...selectedRects.map((r) => r.right)),
        bottom: Math.max(...selectedRects.map((r) => r.bottom)),
      };
      const groupBox = document.createElement("div");
      groupBox.className = "h5ve-selection-group";
      groupBox.dataset.label = `${state.selected.length} 个元素`;
      groupBox.style.left = `${bounds.left}px`;
      groupBox.style.top = `${bounds.top}px`;
      groupBox.style.width = `${bounds.right - bounds.left}px`;
      groupBox.style.height = `${bounds.bottom - bounds.top}px`;
      selectionLayer.appendChild(groupBox);
      if (visibleSelection.length === state.selected.length && !visibleSelection.some(isElementLocked)) {
        const groupRect = {
          ...bounds,
          width: bounds.right - bounds.left,
          height: bounds.bottom - bounds.top,
        };
        renderResizeHandles(groupRect);
        renderRotateHandle(groupRect);
      }
    }

    state.selected.forEach((el, index) => {
      if (isElementHidden(el)) return;
      const r = getSelectableVisualRect(el);
      const box = document.createElement("div");
      box.className =
        "h5ve-selection" +
        (el === state.primary ? " is-primary" : " is-secondary") +
        (state.selected.length > 1 ? " is-multi" : "") +
        (isElementLocked(el) ? " is-locked" : "");
      box.dataset.h5veSelectionIndex = String(index);
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      if (el === state.primary) box.dataset.label = labelFor(el);
      selectionLayer.appendChild(box);
    });

    if (state.primary && state.selected.length === 1 && !isElementLocked(state.primary) && !isElementHidden(state.primary)) {
      const r = getSelectableVisualRect(state.primary);
      renderResizeHandles(r);
      renderRotateHandle(r);
      handle.style.display = "block";
      handle.style.left = `${r.right + 4}px`;
      handle.style.top = `${r.bottom + 4}px`;
    } else {
      handle.style.display = "none";
    }
  }

  function canEditText(el) {
    return (
      el &&
      [
        "P",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "SPAN",
        "A",
        "BUTTON",
        "LI",
        "LABEL",
        "DIV",
        "TD",
        "TH",
        "CAPTION",
        "BLOCKQUOTE",
        "FIGCAPTION",
        "STRONG",
        "EM",
        "SMALL",
      ].includes(el.tagName) &&
      el.childElementCount <= 2
    );
  }

  function prefersInlineTextEdit(el) {
    if (!canEditText(el)) return false;
    // 无直接文本的 div 更像容器，Enter 应进入子层；其余文本元素保持原有编辑优先级。
    return el.tagName !== "DIV" || !!layerDirectText(el);
  }

  const STANDALONE_TEXT_WIDTH_TAGS = new Set([
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "P",
    "BLOCKQUOTE",
  ]);

  function isStandaloneTextWidthElement(el, computedStyle = null) {
    if (!(el instanceof HTMLElement) || !el.parentElement || isLayoutContainer(el) || isAtomicLayerElement(el)) {
      return false;
    }
    const isInsertedText = el.dataset.h5veObjectKind === "text";
    if (!isInsertedText && !STANDALONE_TEXT_WIDTH_TAGS.has(el.tagName)) return false;
    const style = computedStyle || getComputedStyle(el);
    return ![
      "none",
      "contents",
      "inline",
      "table",
      "inline-table",
      "table-row",
      "table-cell",
      "table-caption",
    ].includes(style.display);
  }

  function isFrameContainer(el) {
    if (
      !(el instanceof HTMLElement) ||
      el.matches("img, video, canvas, svg, iframe, table, tbody, thead, tr") ||
      isLayoutContainer(el)
    ) {
      return false;
    }
    if (el.dataset.h5veFrame === "1") return true;
    if (el.childElementCount === 0 || isStandaloneTextWidthElement(el)) return false;
    return ![
      "none",
      "contents",
      "inline",
      "table",
      "inline-table",
      "table-row",
      "table-cell",
      "table-caption",
    ].includes(getComputedStyle(el).display);
  }

  const WIDTH_MODE_BOX_TAGS = new Set([
    "DIV",
    "ARTICLE",
    "SECTION",
    "ASIDE",
    "HEADER",
    "FOOTER",
    "MAIN",
    "NAV",
    "FIGURE",
    "FIGCAPTION",
    "LI",
  ]);

  function canUseWidthMode(el) {
    if (isFrameContainer(el)) return true;
    if (!(el instanceof HTMLElement) || !el.parentElement || isLayoutContainer(el)) return false;
    const style = getComputedStyle(el);
    if (
      [
        "none",
        "contents",
        "inline",
        "table",
        "inline-table",
        "table-row",
        "table-cell",
        "table-caption",
      ].includes(style.display)
    ) {
      return false;
    }
    if (isStandaloneTextWidthElement(el, style)) return true;
    if (!WIDTH_MODE_BOX_TAGS.has(el.tagName) || isAtomicLayerElement(el)) return false;
    if (["fixed", "fill"].includes(el.dataset.h5veWidthMode)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    const hasModuleRole = ["listitem", "group", "region", "article"].includes(role);
    const hasLayoutBox = ["flex", "inline-flex", "grid", "inline-grid"].includes(style.display);
    const hasVisibleSurface =
      hasVisibleCssColor(style.backgroundColor) ||
      ((parseFloat(style.borderTopWidth) || 0) > 0 && hasVisibleCssColor(style.borderTopColor)) ||
      [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].some(
        (value) => (parseFloat(value) || 0) > 0,
      );
    return hasModuleRole || hasLayoutBox || hasVisibleSurface;
  }

  function canUseHeightMode(el) {
    return isFrameContainer(el) || isStandaloneTextWidthElement(el);
  }

  function frameFlowMode(el) {
    const explicit = el?.dataset?.h5veFlow;
    if (["free", "vertical", "horizontal", "grid"].includes(explicit)) return explicit;
    const style = getComputedStyle(el);
    if (style.display === "grid" || style.display === "inline-grid") return "grid";
    if (style.display === "flex" || style.display === "inline-flex") {
      return style.flexDirection.startsWith("column") ? "vertical" : "horizontal";
    }
    return "free";
  }

  function frameDimensionMode(el, axis) {
    const key = axis === "width" ? "h5veWidthMode" : "h5veHeightMode";
    const explicit = el?.dataset?.[key];
    if (explicit === "hug") return "hug";
    if (axis === "width" && explicit === "fill") return "fill";
    return "fixed";
  }

  const FRAME_FILL_WIDTH_STYLE_PROPS = [
    "width",
    "maxWidth",
    "minWidth",
    "boxSizing",
    "flexGrow",
    "flexShrink",
    "flexBasis",
    "alignSelf",
    "justifySelf",
    "left",
    "right",
    "gridColumnStart",
    "gridColumnEnd",
  ];

  function cssPropertyName(property) {
    return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function setManagedSizeStyle(el, property, value) {
    const priority = isStandaloneTextWidthElement(el) ? "important" : "";
    el.style.setProperty(cssPropertyName(property), value, priority);
  }

  function applyStandaloneTextAutoHeight(el) {
    if (!isStandaloneTextWidthElement(el)) return;
    el.dataset.h5veHeightMode = "hug";
    setManagedSizeStyle(el, "height", "auto");
    setManagedSizeStyle(el, "maxHeight", "none");
    setManagedSizeStyle(el, "minHeight", "0px");
  }

  function rememberFrameFillWidthStyles(el) {
    if (!(el instanceof HTMLElement) || el.dataset.h5veWidthFillRestore) return;
    const snapshot = {};
    FRAME_FILL_WIDTH_STYLE_PROPS.forEach((property) => {
      const cssName = cssPropertyName(property);
      snapshot[property] = {
        value: el.style.getPropertyValue(cssName),
        priority: el.style.getPropertyPriority(cssName),
      };
    });
    el.dataset.h5veWidthFillRestore = JSON.stringify(snapshot);
  }

  function clearFrameFillWidthStyles(el) {
    if (!(el instanceof HTMLElement)) return;
    const layout = el.dataset.h5veWidthFillLayout;
    let restored = false;
    if (el.dataset.h5veWidthFillRestore) {
      try {
        const snapshot = JSON.parse(el.dataset.h5veWidthFillRestore);
        FRAME_FILL_WIDTH_STYLE_PROPS.forEach((property) => {
          const cssName = cssPropertyName(property);
          const entry = snapshot[property];
          const value = typeof entry === "string" ? entry : typeof entry?.value === "string" ? entry.value : "";
          const priority = typeof entry === "object" && entry ? entry.priority || "" : "";
          if (value) el.style.setProperty(cssName, value, priority);
          else el.style.removeProperty(cssName);
        });
        restored = true;
      } catch (_error) {
        // 兼容早期草稿：无法读取备份时，只清理编辑器填充模式写入的属性。
      }
    }
    if (!restored) {
      if (layout === "flex-row") {
        el.style.removeProperty("flex-grow");
        el.style.removeProperty("flex-shrink");
        el.style.removeProperty("flex-basis");
      } else if (layout === "flex-column") {
        el.style.removeProperty("align-self");
      } else if (layout === "grid") {
        el.style.removeProperty("justify-self");
        el.style.removeProperty("grid-column-start");
        el.style.removeProperty("grid-column-end");
      } else if (layout === "absolute") {
        el.style.removeProperty("right");
      }
    }
    delete el.dataset.h5veWidthFillRestore;
    delete el.dataset.h5veWidthFillLayout;
    delete el.dataset.h5veWidthFillGridStart;
  }

  function splitCssTrackList(value) {
    const tokens = [];
    let depth = 0;
    let token = "";
    for (const character of String(value || "")) {
      if (/\s/.test(character) && depth === 0) {
        if (token) tokens.push(token);
        token = "";
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      token += character;
    }
    if (token) tokens.push(token);
    return tokens;
  }

  function gridFillColumnStart(el, parent, parentStyle) {
    const tracks = splitCssTrackList(parentStyle.gridTemplateColumns)
      .map((track) => Number.parseFloat(track))
      .filter((size) => Number.isFinite(size) && size > 0);
    if (tracks.length <= 1) return 1;
    const parentRect = parent.getBoundingClientRect();
    const elementRect = el.getBoundingClientRect();
    const scale = parent.offsetWidth > 0 ? parentRect.width / parent.offsetWidth : state.scale || 1;
    const borderLeft = Number.parseFloat(parentStyle.borderLeftWidth) || 0;
    const paddingLeft = Number.parseFloat(parentStyle.paddingLeft) || 0;
    const contentLeft = parentRect.left + (borderLeft + paddingLeft) * scale;
    const localLeft = (elementRect.left - contentLeft) / Math.max(scale, 0.0001) + parent.scrollLeft;
    const gap = Number.parseFloat(parentStyle.columnGap) || 0;
    let cursor = 0;
    for (let index = 0; index < tracks.length; index += 1) {
      const boundary = cursor + tracks[index] + gap / 2;
      if (localLeft < boundary) return index + 1;
      cursor += tracks[index] + gap;
    }
    return tracks.length;
  }

  function applyFrameFillWidth(el) {
    if (!(el instanceof HTMLElement)) return;
    clearFrameFillWidthStyles(el);
    rememberFrameFillWidthStyles(el);
    const style = getComputedStyle(el);
    const parent = el.parentElement;
    const parentStyle = parent ? getComputedStyle(parent) : null;
    const parentDisplay = parentStyle?.display || "";
    const parentIsFlex = parentDisplay === "flex" || parentDisplay === "inline-flex";
    const parentIsGrid = parentDisplay === "grid" || parentDisplay === "inline-grid";

    el.style.boxSizing = "border-box";
    setManagedSizeStyle(el, "maxWidth", "100%");
    setManagedSizeStyle(el, "minWidth", "0px");

    if (style.position === "absolute" || style.position === "fixed") {
      const translation = parseTransform(el);
      el.style.left = `${el.offsetLeft}px`;
      el.style.right = `${translation.x}px`;
      setManagedSizeStyle(el, "width", "auto");
      el.dataset.h5veWidthFillLayout = "absolute";
    } else if (parentIsGrid) {
      const columnStart = gridFillColumnStart(el, parent, parentStyle);
      setManagedSizeStyle(el, "width", "auto");
      el.style.justifySelf = "stretch";
      el.style.gridColumnStart = String(columnStart);
      el.style.gridColumnEnd = "-1";
      el.dataset.h5veWidthFillLayout = "grid";
      el.dataset.h5veWidthFillGridStart = String(columnStart);
    } else if (parentIsFlex && !parentStyle.flexDirection.startsWith("column")) {
      setManagedSizeStyle(el, "width", "auto");
      el.style.flexGrow = "1";
      el.style.flexShrink = "1";
      el.style.flexBasis = "0px";
      el.dataset.h5veWidthFillLayout = "flex-row";
    } else if (parentIsFlex) {
      setManagedSizeStyle(el, "width", "auto");
      el.style.alignSelf = "stretch";
      el.dataset.h5veWidthFillLayout = "flex-column";
    } else {
      setManagedSizeStyle(el, "width", "100%");
      el.dataset.h5veWidthFillLayout = "block";
    }
    applyStandaloneTextAutoHeight(el);
  }

  function syncDimensionModeControl(el, axis, mode) {
    if (state.selected.length !== 1 || state.primary !== el) return;
    const control = panel?.querySelector(`[data-dimension-axis="${axis}"]`);
    if (!control) return;
    control.value = mode;
    control.dataset.dimensionMode = mode;
    control.classList.toggle("is-active", mode !== "fixed");
    control.classList.toggle("is-fill", mode === "fill");
  }

  function setFrameDimensionFixedValue(el, axis, value) {
    if (axis === "width" ? !canUseWidthMode(el) : !canUseHeightMode(el)) return;
    const dataKey = axis === "width" ? "h5veWidthMode" : "h5veHeightMode";
    if (axis === "width") {
      clearFrameFillWidthStyles(el);
      setManagedSizeStyle(el, "maxWidth", "none");
      setManagedSizeStyle(el, "minWidth", "0px");
    } else if (isStandaloneTextWidthElement(el)) {
      setManagedSizeStyle(el, "maxHeight", "none");
      setManagedSizeStyle(el, "minHeight", "0px");
    }
    el.dataset[dataKey] = "fixed";
    setManagedSizeStyle(el, axis, `${Math.max(1, value)}px`);
    syncDimensionModeControl(el, axis, "fixed");
  }

  function freezeFrameDimension(el, axis) {
    if (axis === "width" ? !canUseWidthMode(el) : !canUseHeightMode(el)) return;
    const rect = el.getBoundingClientRect();
    const value = (axis === "width" ? rect.width : rect.height) / Math.max(state.scale, 0.0001);
    setFrameDimensionFixedValue(el, axis, value);
  }

  function keepFrameTopLeft(el, beforeRect) {
    const afterRect = el.getBoundingClientRect();
    translateElement(el, beforeRect.left - afterRect.left, beforeRect.top - afterRect.top);
  }

  function setFrameFlow(el, mode) {
    if (!isFrameContainer(el) || isElementLocked(el)) return;
    const before = el.getBoundingClientRect();
    el.dataset.h5veFlow = mode;
    if (mode === "vertical" || mode === "horizontal") {
      el.style.display = "flex";
      el.style.flexDirection = mode === "vertical" ? "column" : "row";
      el.style.flexWrap = "nowrap";
      el.style.removeProperty("grid-template-columns");
    } else if (mode === "grid") {
      el.style.display = "grid";
      el.style.removeProperty("flex-direction");
      el.style.removeProperty("flex-wrap");
      if (!el.style.gridTemplateColumns) el.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    } else {
      el.style.display = "block";
      el.style.removeProperty("flex-direction");
      el.style.removeProperty("flex-wrap");
      el.style.removeProperty("grid-template-columns");
    }
    keepFrameTopLeft(el, before);
    fillPanel(el);
    scheduleSelectionBox();
    pushHistory();
    renderElementPanel();
    showToast(`布局流向已设为${mode === "vertical" ? "纵向" : mode === "horizontal" ? "横向" : mode === "grid" ? "网格" : "自由"}`);
  }

  function setFrameDimensionMode(el, axis, mode) {
    const canSetDimension = axis === "width" ? canUseWidthMode(el) : canUseHeightMode(el);
    if (!canSetDimension || isElementLocked(el)) return;
    if (mode === "fill" && axis !== "width") return;
    const before = el.getBoundingClientRect();
    const dataKey = axis === "width" ? "h5veWidthMode" : "h5veHeightMode";
    const styleProp = axis;
    const maxProp = axis === "width" ? "maxWidth" : "maxHeight";
    const minProp = axis === "width" ? "minWidth" : "minHeight";
    if (axis === "width" && mode !== "fill") clearFrameFillWidthStyles(el);
    if (mode === "hug") {
      el.dataset[dataKey] = "hug";
      if (isStandaloneTextWidthElement(el)) {
        setManagedSizeStyle(el, styleProp, axis === "width" ? "fit-content" : "auto");
        setManagedSizeStyle(el, maxProp, axis === "width" ? "100%" : "none");
        setManagedSizeStyle(el, minProp, "0px");
        if (axis === "width") el.style.flexBasis = "auto";
        applyStandaloneTextAutoHeight(el);
      } else {
        const inFlowChildren = [...el.children].filter((child) => {
          const position = getComputedStyle(child).position;
          return position !== "absolute" && position !== "fixed";
        });
        if (inFlowChildren.length > 0) {
          el.style[styleProp] = "fit-content";
          el.style[maxProp] = "none";
          el.style[minProp] = "0px";
          if (axis === "width") el.style.flexBasis = "auto";
        } else {
          const measured = axis === "width" ? el.scrollWidth : el.scrollHeight;
          el.style[styleProp] = `${Math.max(1, measured)}px`;
        }
      }
    } else if (mode === "fill") {
      el.dataset[dataKey] = "fill";
      applyFrameFillWidth(el);
    } else {
      const value = (axis === "width" ? before.width : before.height) / Math.max(state.scale, 0.0001);
      setFrameDimensionFixedValue(el, axis, value);
    }
    keepFrameTopLeft(el, before);
    fillPanel(el);
    scheduleSelectionBox();
    pushHistory();
    const modeLabel = mode === "hug" ? "适应内容" : mode === "fill" ? "填充父级" : "固定尺寸";
    showToast(`${axis === "width" ? "宽度" : "高度"}已设为${modeLabel}`);
  }

  function setFrameGap(el, value) {
    if (!isFrameContainer(el) || isElementLocked(el)) return;
    el.style.gap = `${Math.max(0, Number(value) || 0)}px`;
    scheduleSelectionBox();
    markDirty();
  }

  function setFrameSpacingValues(el, values) {
    if (!isFrameContainer(el) || isElementLocked(el)) return;
    Object.entries(values).forEach(([property, rawValue]) => {
      const value = Number(rawValue);
      if (!Number.isFinite(value)) return;
      const normalized = property.startsWith("padding") ? Math.max(0, value) : value;
      el.style[property] = `${normalized}px`;
    });
    syncPanelGeometry(el);
    scheduleSelectionBox();
    markDirty();
  }

  function spacingAxisIcon(kind, axis) {
    const innerLines =
      axis === "x"
        ? '<path d="M8 7v10M16 7v10"/>'
        : '<path d="M7 8h10M7 16h10"/>';
    const outerMarks =
      axis === "x"
        ? '<path d="M2 7v10M22 7v10"/>'
        : '<path d="M7 2h10M7 22h10"/>';
    return `<svg class="h5ve-spacing-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/>${kind === "margin" ? outerMarks : innerLines}</svg>`;
  }

  function setFrameClip(el, clipped) {
    if (!isFrameContainer(el) || isElementLocked(el)) return;
    el.style.overflow = clipped ? "hidden" : "visible";
    pushHistory();
    scheduleSelectionBox();
  }

  function isAspectLocked(el) {
    return el?.dataset?.h5veAspectLocked === "true";
  }

  function aspectLockButtonMarkup(locked) {
    const label = locked ? "解除宽高比锁定" : "锁定宽高比";
    const icon = locked
      ? '<svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
      : '<svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M16 10V7a4 4 0 0 0-7.6-1.7"/></svg>';
    return `<button type="button" id="h5ve-f-aspect" class="h5ve-aspect-lock ${locked ? "is-active" : ""}" aria-pressed="${locked}" aria-label="${label}" title="${label}">${icon}<span>比例</span></button>`;
  }

  function textAlignmentIcon(align) {
    const paths = {
      left: "M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7",
      center: "M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7",
      right: "M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7",
    };
    return `<svg class="h5ve-text-align-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${paths[align] || paths.left}"/></svg>`;
  }

  const FONT_WEIGHT_CHOICES = [
    [100, "极细"],
    [200, "纤细"],
    [300, "细体"],
    [400, "常规"],
    [500, "中等"],
    [600, "半粗"],
    [700, "粗体"],
    [800, "特粗"],
    [900, "黑体"],
  ];

  function numericFontWeight(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (normalized === "normal") return 400;
    if (normalized === "bold") return 700;
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(1000, parsed)) : 400;
  }

  function fontWeightSelectMarkup(id, value, options = {}) {
    const { mixed = false, label = "字重" } = options;
    const current = numericFontWeight(value);
    const choices = FONT_WEIGHT_CHOICES.slice();
    if (!choices.some(([weight]) => weight === current)) choices.push([current, "自定义"]);
    choices.sort((first, second) => first[0] - second[0]);
    return `<div class="h5ve-font-weight-control"><span>${label}</span><select id="${id}" aria-label="${label}">${mixed ? '<option value="" selected>混合</option>' : ""}${choices
      .map(([weight, name]) => `<option value="${weight}" ${!mixed && weight === current ? "selected" : ""}>${weight} · ${name}</option>`)
      .join("")}</select></div>`;
  }

  function elementAspectRatio(el, width, height) {
    const stored = Number(el?.dataset?.h5veAspectRatio);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const mediaRatio = getMediaAspectRatio(el, width, height);
    if (mediaRatio && mediaRatio > 0) return mediaRatio;
    return width > 0 && height > 0 ? width / height : null;
  }

  function setAspectLocked(el, locked) {
    if (!(el instanceof HTMLElement) || isElementLocked(el)) return;
    if (locked) {
      const cs = getComputedStyle(el);
      const width = parseFloat(cs.width) || el.offsetWidth;
      const height = parseFloat(cs.height) || el.offsetHeight;
      const ratio = elementAspectRatio(el, width, height);
      if (!ratio) return;
      el.dataset.h5veAspectLocked = "true";
      el.dataset.h5veAspectRatio = String(ratio);
    } else {
      delete el.dataset.h5veAspectLocked;
      delete el.dataset.h5veAspectRatio;
    }
    fillPanel(el);
    pushHistory();
    showToast(locked ? "已锁定宽高比例 · Shift 拖拽可临时解除" : "已解除宽高比例锁定");
  }

  function bindPanelNumberScrub(el) {
    panel.querySelectorAll("[data-scrub-field]").forEach((label) => {
      const key = label.dataset.scrubField;
      const input = panelFields[key];
      if (!input || input.disabled) return;
      let active = false;
      let moved = false;
      let startX = 0;
      let startValue = 0;

      const finish = (event) => {
        if (!active) return;
        active = false;
        window.removeEventListener("pointermove", drag, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("mouseup", finish, true);
        if (event?.pointerId != null && label.hasPointerCapture?.(event.pointerId)) label.releasePointerCapture(event.pointerId);
        label.classList.remove("is-scrubbing");
        document.documentElement.classList.remove("h5ve-number-scrubbing");
        document.body.style.userSelect = "";
        if (moved) pushHistory({ label: `调整${label.getAttribute("aria-label") || label.title || label.textContent.trim() || "数值"}` });
      };

      const drag = (event) => {
        if (!active) return;
        event.preventDefault();
        const units = Math.trunc((event.clientX - startX) / 2);
        if (!units && !moved) return;
        moved = true;
        const nativeStep = Number(input.step);
        const fieldStep = Number.isFinite(nativeStep) && nativeStep > 0 ? nativeStep : 1;
        const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
        const declaredMin = Number(input.min);
        const minimum = input.min !== "" && Number.isFinite(declaredMin) ? declaredMin : ["w", "h", "fs"].includes(key) ? 1 : key === "gap" ? 0 : -Infinity;
        const next = Math.max(minimum, startValue + units * fieldStep * multiplier);
        input.value = Number.isInteger(next) ? String(next) : next.toFixed(1);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };

      label.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || input.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        active = true;
        moved = false;
        startX = event.clientX;
        const scrubStart = Number(input.dataset.scrubStart);
        startValue = input.value === "" && Number.isFinite(scrubStart) ? scrubStart : Number(input.value) || 0;
        label.setPointerCapture?.(event.pointerId);
        label.classList.add("is-scrubbing");
        document.documentElement.classList.add("h5ve-number-scrubbing");
        document.body.style.userSelect = "none";
        window.addEventListener("pointermove", drag, true);
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("mouseup", finish, true);
      });
      label.addEventListener("pointermove", drag);
      label.addEventListener("pointerup", finish);
      label.addEventListener("pointercancel", finish);
      label.addEventListener("dblclick", (event) => {
        event.preventDefault();
        input.focus({ preventScroll: true });
        input.select?.();
      });
    });
  }

  function fillMultiSelectionPanel() {
    const selected = state.selected.filter((candidate) => candidate?.isConnected);
    const targets = selected.filter((candidate) => !isElementLocked(candidate) && !isElementHidden(candidate));
    const readableTargets = targets.length > 0 ? targets : selected;
    const commonNumber = (getter, tolerance = 0.01) => {
      const values = readableTargets.map((candidate) => Number(getter(candidate))).map((value) => (Number.isFinite(value) ? value : 0));
      const value = values[0] || 0;
      return { value, mixed: values.some((candidate) => Math.abs(candidate - value) > tolerance) };
    };
    const commonString = (getter) => {
      const values = readableTargets.map((candidate) => String(getter(candidate) ?? ""));
      const value = values[0] || "";
      return { value, mixed: values.some((candidate) => candidate !== value) };
    };
    const commonBoolean = (getter) => {
      const values = readableTargets.map((candidate) => !!getter(candidate));
      const value = values[0] || false;
      return { value, mixed: values.some((candidate) => candidate !== value) };
    };
    const numberValue = (common, precision = 1) => {
      if (common.mixed) return "";
      const factor = 10 ** precision;
      return String(Math.round(common.value * factor) / factor);
    };
    const numberInput = (id, label, common, options = {}) => {
      const { min = "", max = "", step = "1", precision = 1, title = label } = options;
      return `<div class="h5ve-number-control"><span data-scrub-field="${id}" title="${title}">${label}</span><input type="number" id="h5ve-f-${id}" ${min !== "" ? `min="${min}"` : ""} ${max !== "" ? `max="${max}"` : ""} step="${step}" value="${numberValue(common, precision)}" data-scrub-start="${numberValue({ value: common.value, mixed: false }, precision)}" placeholder="${common.mixed ? "混合" : ""}" aria-label="${title}"></div>`;
    };
    const pressedState = (common) => (common.mixed ? "mixed" : String(common.value));
    const activeClass = (common) => `${common.value && !common.mixed ? "is-active" : ""} ${common.mixed ? "is-mixed" : ""}`;

    const width = commonNumber((candidate) => parseFloat(getComputedStyle(candidate).width) || candidate.getBoundingClientRect().width / Math.max(state.scale, 0.0001));
    const height = commonNumber((candidate) => parseFloat(getComputedStyle(candidate).height) || candidate.getBoundingClientRect().height / Math.max(state.scale, 0.0001));
    const rotation = commonNumber(parseRotation);
    const opacity = commonNumber((candidate) => {
      const value = parseFloat(getInlineOrComputed(candidate, "opacity"));
      return (Number.isFinite(value) ? value : 1) * 100;
    });
    const radius = commonNumber((candidate) => {
      const style = getComputedStyle(candidate);
      const values = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(
        (value) => parseFloat(value) || 0,
      );
      return values.every((value) => Math.abs(value - values[0]) < 0.01) ? values[0] : Number.NaN;
    });
    if (readableTargets.some((candidate) => {
      const style = getComputedStyle(candidate);
      const values = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(
        (value) => parseFloat(value) || 0,
      );
      return values.some((value) => Math.abs(value - values[0]) >= 0.01);
    })) radius.mixed = true;

    const fillColor = commonString((candidate) => rgbToHex(getInlineOrComputed(candidate, "backgroundColor")));
    const fillVisible = commonBoolean((candidate) => !isTransparentCssColor(getInlineOrComputed(candidate, "backgroundColor")));
    const strokeColor = commonString((candidate) => rgbToHex(getComputedStyle(candidate).borderTopColor));
    const strokeWidth = commonNumber((candidate) => parseFloat(getComputedStyle(candidate).borderTopWidth) || 0);
    const strokeVisible = commonBoolean((candidate) => {
      const style = getComputedStyle(candidate);
      return (parseFloat(style.borderTopWidth) || 0) > 0 && style.borderTopStyle !== "none" && !isTransparentCssColor(style.borderTopColor);
    });
    const allText = readableTargets.length > 0 && readableTargets.every(canEditText);
    const fontSize = allText ? commonNumber((candidate) => parseFloat(getInlineOrComputed(candidate, "fontSize")) || 16) : null;
    const lineHeight = allText
      ? commonNumber((candidate) => {
          const style = getComputedStyle(candidate);
          const size = parseFloat(style.fontSize) || 16;
          return Number.isFinite(parseFloat(style.lineHeight)) ? parseFloat(style.lineHeight) / Math.max(size, 1) : 1.2;
        })
      : null;
    const letterSpacing = allText ? commonNumber((candidate) => parseFloat(getComputedStyle(candidate).letterSpacing) || 0) : null;
    const textColor = allText ? commonString((candidate) => rgbToHex(getInlineOrComputed(candidate, "color"))) : null;
    const fontWeight = allText ? commonNumber((candidate) => numericFontWeight(getComputedStyle(candidate).fontWeight)) : null;
    const bold = allText ? commonBoolean((candidate) => numericFontWeight(getComputedStyle(candidate).fontWeight) >= 600) : null;
    const italic = allText ? commonBoolean((candidate) => ["italic", "oblique"].includes(getComputedStyle(candidate).fontStyle)) : null;
    const underline = allText ? commonBoolean((candidate) => getComputedStyle(candidate).textDecorationLine.includes("underline")) : null;
    const textAlign = allText ? commonString((candidate) => getComputedStyle(candidate).textAlign || "left") : null;
    const disabled = targets.length === 0;
    const excludedCount = selected.length - targets.length;

    panel.innerHTML = `
      <div class="h5ve-panel-header">属性</div>
      <div class="h5ve-multi-summary"><strong>${selected.length} 个元素</strong><span>共同属性可批量编辑${excludedCount ? ` · ${excludedCount} 个已锁定或隐藏` : ""}</span></div>
      <div class="h5ve-field"><label>对齐与分布</label>
        <div class="h5ve-align-row">
          <button type="button" class="h5ve-align-btn" data-align="left" title="左对齐"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1.5 1v12" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="3" width="9" height="3" rx="0.5" fill="currentColor"/><rect x="3.5" y="8" width="5.5" height="3" rx="0.5" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="h-center" title="水平居中"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="3" width="9" height="3" rx="0.5" fill="currentColor"/><rect x="4.25" y="8" width="5.5" height="3" rx="0.5" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="right" title="右对齐"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M12.5 1v12" stroke="currentColor" stroke-width="1.5"/><rect x="1.5" y="3" width="9" height="3" rx="0.5" fill="currentColor"/><rect x="5" y="8" width="5.5" height="3" rx="0.5" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="top" title="顶对齐"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 1.5h12" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="8" y="3.5" width="3" height="5.5" rx="0.5" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="v-center" title="垂直居中"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 7h12" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="2.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="8" y="4.25" width="3" height="5.5" rx="0.5" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="bottom" title="底对齐"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 12.5h12" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="1.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="8" y="5" width="3" height="5.5" rx="0.5" fill="currentColor"/></svg></button>
        </div>
        <div class="h5ve-align-row h5ve-align-row-distribute">
          <button type="button" class="h5ve-align-btn" data-align="distribute-v" title="垂直等距分布" ${selected.length < 3 ? "disabled" : ""}><svg width="14" height="14" viewBox="0 0 14 14"><rect x="2" y="1.5" width="10" height="2" rx="1" fill="currentColor"/><rect x="4" y="6" width="6" height="2" rx="1" fill="currentColor"/><rect x="2" y="10.5" width="10" height="2" rx="1" fill="currentColor"/></svg></button>
          <button type="button" class="h5ve-align-btn" data-align="distribute-h" title="水平等距分布" ${selected.length < 3 ? "disabled" : ""}><svg width="14" height="14" viewBox="0 0 14 14"><rect x="1.5" y="2" width="2" height="10" rx="1" fill="currentColor"/><rect x="6" y="4" width="2" height="6" rx="1" fill="currentColor"/><rect x="10.5" y="2" width="2" height="10" rx="1" fill="currentColor"/></svg></button>
        </div>
      </div>
      <section class="h5ve-inspector-section" aria-labelledby="h5ve-multi-geometry-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-multi-geometry-title">尺寸与旋转</span><small>批量设置</small></div>
        <div class="h5ve-field-row">${numberInput("w", "W", width, { min: 1, title: "宽度" })}${numberInput("h", "H", height, { min: 1, title: "高度" })}</div>
        <div class="h5ve-multi-single-row">${numberInput("rotation", "°", rotation, { step: 0.1, title: "旋转角度" })}</div>
      </section>
      ${
        allText
          ? `<div class="h5ve-field"><label>文字样式 · 全部为文字</label>
        <div class="h5ve-text-style-row" role="group" aria-label="批量文字样式">
          <button type="button" data-multi-text-style="bold" class="${activeClass(bold)}" aria-pressed="${pressedState(bold)}" title="粗体"><strong>B</strong></button>
          <button type="button" data-multi-text-style="italic" class="${activeClass(italic)}" aria-pressed="${pressedState(italic)}" title="斜体"><em>I</em></button>
          <button type="button" data-multi-text-style="underline" class="${activeClass(underline)}" aria-pressed="${pressedState(underline)}" title="下划线"><u>U</u></button>
          <span class="h5ve-text-style-separator"></span>
          <button type="button" data-multi-text-align="left" class="${!textAlign.mixed && ["left", "start"].includes(textAlign.value) ? "is-active" : ""}" aria-pressed="${!textAlign.mixed && ["left", "start"].includes(textAlign.value)}" aria-label="左对齐" title="左对齐">${textAlignmentIcon("left")}</button>
          <button type="button" data-multi-text-align="center" class="${!textAlign.mixed && textAlign.value === "center" ? "is-active" : ""}" aria-pressed="${!textAlign.mixed && textAlign.value === "center"}" aria-label="居中对齐" title="居中对齐">${textAlignmentIcon("center")}</button>
          <button type="button" data-multi-text-align="right" class="${!textAlign.mixed && ["right", "end"].includes(textAlign.value) ? "is-active" : ""}" aria-pressed="${!textAlign.mixed && ["right", "end"].includes(textAlign.value)}" aria-label="右对齐" title="右对齐">${textAlignmentIcon("right")}</button>
        </div>
        <div class="h5ve-field-row h5ve-multi-text-size-row">${numberInput("fs", "字号", fontSize, { min: 1, title: "字号" })}${fontWeightSelectMarkup("h5ve-f-font-weight", fontWeight.value, { mixed: fontWeight.mixed })}</div>
        <div class="h5ve-field-row h5ve-text-metric-row">${numberInput("lineHeight", "行高", lineHeight, { min: 0.5, step: 0.05, precision: 2, title: "行高" })}${numberInput("letterSpacing", "字距", letterSpacing, { step: 0.1, title: "字距" })}</div>
      </div>`
          : ""
      }
      <section class="h5ve-inspector-section h5ve-appearance-section" aria-labelledby="h5ve-multi-appearance-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-multi-appearance-title">外观</span><small>${readableTargets.length} 个对象</small></div>
        <div class="h5ve-appearance-grid">
          <label class="h5ve-compact-property"><span class="h5ve-scrub-label" data-scrub-field="opacity" title="批量调整透明度">透明度</span>${numberInput("opacity", "%", opacity, { min: 0, max: 100, title: "透明度百分比" })}</label>
          <label class="h5ve-compact-property"><span class="h5ve-scrub-label" data-scrub-field="radius" title="批量调整圆角">圆角</span>${numberInput("radius", "R", radius, { min: 0, title: "统一圆角" })}</label>
        </div>
      </section>
      ${
        allText
          ? `<section class="h5ve-inspector-section" aria-labelledby="h5ve-multi-text-color-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-multi-text-color-title">文字颜色</span><small>${textColor.mixed ? "混合" : "单色"}</small></div>
        <div class="h5ve-color-control ${textColor.mixed ? "is-mixed" : ""}" data-color-control="multi-text" style="--h5ve-swatch-color:${textColor.value || "#737373"}">
          <label class="h5ve-color-swatch" title="批量设置文字颜色"><input type="color" id="h5ve-f-color" value="${textColor.value || "#737373"}" aria-label="文字颜色"><span></span></label>
          <input type="text" id="h5ve-f-color-hex" class="h5ve-hex-input" value="${textColor.mixed ? "" : textColor.value}" placeholder="${textColor.mixed ? "混合" : ""}" aria-label="文字颜色 HEX">
        </div>
      </section>`
          : ""
      }
      <section class="h5ve-inspector-section" aria-labelledby="h5ve-multi-fill-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-multi-fill-title">填充</span><small>${fillColor.mixed || fillVisible.mixed ? "混合" : "单色"}</small></div>
        <div class="h5ve-color-control ${fillColor.mixed || fillVisible.mixed ? "is-mixed" : ""} ${!fillVisible.value && !fillVisible.mixed ? "is-disabled" : ""}" data-color-control="multi-fill" style="--h5ve-swatch-color:${fillColor.value || "#737373"}">
          <label class="h5ve-color-swatch" title="批量设置填充颜色"><input type="color" id="h5ve-f-bg" value="${fillColor.value || "#737373"}" aria-label="填充颜色"><span></span></label>
          <input type="text" id="h5ve-f-bg-hex" class="h5ve-hex-input" value="${fillColor.mixed ? "" : fillColor.value}" placeholder="${fillColor.mixed ? "混合" : ""}" aria-label="填充颜色 HEX">
          <button type="button" class="h5ve-visibility-toggle ${fillVisible.mixed ? "is-mixed" : ""}" id="h5ve-f-fill-toggle" aria-label="批量切换填充" aria-pressed="${pressedState(fillVisible)}" title="批量切换填充"><svg class="h5ve-control-icon" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
        </div>
      </section>
      <section class="h5ve-inspector-section" aria-labelledby="h5ve-multi-stroke-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-multi-stroke-title">描边</span><small>${strokeColor.mixed || strokeWidth.mixed || strokeVisible.mixed ? "混合" : "内侧"}</small></div>
        <div class="h5ve-color-control h5ve-stroke-control ${strokeColor.mixed || strokeWidth.mixed || strokeVisible.mixed ? "is-mixed" : ""} ${!strokeVisible.value && !strokeVisible.mixed ? "is-disabled" : ""}" data-color-control="multi-stroke" style="--h5ve-swatch-color:${strokeColor.value || "#737373"}">
          <label class="h5ve-color-swatch" title="批量设置描边颜色"><input type="color" id="h5ve-f-border-color" value="${strokeColor.value || "#737373"}" aria-label="描边颜色"><span></span></label>
          <input type="text" id="h5ve-f-border-color-hex" class="h5ve-hex-input" value="${strokeColor.mixed ? "" : strokeColor.value}" placeholder="${strokeColor.mixed ? "混合" : ""}" aria-label="描边颜色 HEX">
          <div class="h5ve-number-control h5ve-stroke-width"><span data-scrub-field="borderWidth" title="批量调整描边宽度">W</span><input type="number" id="h5ve-f-border-width" min="0" step="0.5" value="${numberValue(strokeWidth, 1)}" data-scrub-start="${numberValue({ value: strokeWidth.value, mixed: false }, 1)}" placeholder="${strokeWidth.mixed ? "混合" : ""}" aria-label="描边宽度"></div>
          <button type="button" class="h5ve-visibility-toggle ${strokeVisible.mixed ? "is-mixed" : ""}" id="h5ve-f-stroke-toggle" aria-label="批量切换描边" aria-pressed="${pressedState(strokeVisible)}" title="批量切换描边"><svg class="h5ve-control-icon" viewBox="0 0 24 24"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
        </div>
      </section>
      <div class="h5ve-panel-empty h5ve-multi-tip">混合值会保留现状；输入新值后所有可编辑对象一起更新。</div>
    `;

    panelFields = {
      w: panel.querySelector("#h5ve-f-w"),
      h: panel.querySelector("#h5ve-f-h"),
      rotation: panel.querySelector("#h5ve-f-rotation"),
      fs: panel.querySelector("#h5ve-f-fs"),
      fontWeight: panel.querySelector("#h5ve-f-font-weight"),
      lineHeight: panel.querySelector("#h5ve-f-lineHeight"),
      letterSpacing: panel.querySelector("#h5ve-f-letterSpacing"),
      color: panel.querySelector("#h5ve-f-color"),
      colorHex: panel.querySelector("#h5ve-f-color-hex"),
      bg: panel.querySelector("#h5ve-f-bg"),
      bgHex: panel.querySelector("#h5ve-f-bg-hex"),
      fillToggle: panel.querySelector("#h5ve-f-fill-toggle"),
      borderColor: panel.querySelector("#h5ve-f-border-color"),
      borderColorHex: panel.querySelector("#h5ve-f-border-color-hex"),
      borderWidth: panel.querySelector("#h5ve-f-border-width"),
      strokeToggle: panel.querySelector("#h5ve-f-stroke-toggle"),
      radius: panel.querySelector("#h5ve-f-radius"),
      opacity: panel.querySelector("#h5ve-f-opacity"),
    };

    const updateTargets = (apply, historyLabel = "批量修改属性") => {
      if (!targets.length) return;
      targets.forEach(apply);
      scheduleSelectionBox();
      markDirty();
      return historyLabel;
    };
    const bindNumber = (field, apply) => {
      field?.addEventListener("input", () => {
        if (field.value === "") return;
        const value = Number(field.value);
        if (!Number.isFinite(value)) return;
        updateTargets((candidate) => apply(candidate, value));
      });
    };
    bindNumber(panelFields.w, (candidate, value) => {
      if (value <= 0) return;
      ensureResizable(candidate);
      if (canUseWidthMode(candidate)) setFrameDimensionFixedValue(candidate, "width", value);
      else candidate.style.width = `${value}px`;
    });
    bindNumber(panelFields.h, (candidate, value) => {
      if (value <= 0) return;
      ensureResizable(candidate);
      if (canUseHeightMode(candidate)) setFrameDimensionFixedValue(candidate, "height", value);
      else candidate.style.height = `${value}px`;
    });
    bindNumber(panelFields.rotation, (candidate, value) => applyRotation(candidate, value));
    bindNumber(panelFields.opacity, (candidate, value) => {
      candidate.style.opacity = String(Math.max(0, Math.min(100, value)) / 100);
    });
    bindNumber(panelFields.radius, (candidate, value) => {
      candidate.style.borderRadius = `${Math.max(0, value)}px`;
    });
    bindNumber(panelFields.borderWidth, (candidate, value) => {
      const widthValue = Math.max(0, value);
      candidate.style.borderStyle = widthValue > 0 ? "solid" : "none";
      candidate.style.borderWidth = `${widthValue}px`;
    });
    bindNumber(panelFields.fs, (candidate, value) => {
      if (value > 0) candidate.style.fontSize = `${value}px`;
    });
    bindNumber(panelFields.lineHeight, (candidate, value) => {
      candidate.style.lineHeight = String(Math.max(0.5, value));
    });
    bindNumber(panelFields.letterSpacing, (candidate, value) => {
      candidate.style.letterSpacing = `${value}px`;
    });
    panelFields.fontWeight?.addEventListener("change", () => {
      if (!panelFields.fontWeight.value) return;
      const value = numericFontWeight(panelFields.fontWeight.value);
      updateTargets((candidate) => {
        candidate.style.fontWeight = String(value);
      });
      const boldButton = panel.querySelector('[data-multi-text-style="bold"]');
      boldButton?.classList.toggle("is-active", value >= 600);
      boldButton?.classList.remove("is-mixed");
      boldButton?.setAttribute("aria-pressed", String(value >= 600));
      pushHistory({ label: "批量调整字重" });
    });

    const bindMultiColor = (input, hexInput, apply) => {
      if (!input || !hexInput) return;
      const control = input.closest("[data-color-control]");
      const commit = (raw, fallback = input.value) => {
        const normalized = normalizeHexColor(raw, fallback);
        if (!normalized) return false;
        input.value = normalized;
        hexInput.value = normalized;
        hexInput.placeholder = "";
        control?.classList.remove("is-mixed", "is-disabled");
        control?.style.setProperty("--h5ve-swatch-color", normalized);
        updateTargets((candidate) => apply(candidate, normalized));
        return true;
      };
      input.addEventListener("input", () => commit(input.value));
      hexInput.addEventListener("input", () => {
        if (normalizeHexColor(hexInput.value)) commit(hexInput.value);
      });
      hexInput.addEventListener("change", () => {
        if (!commit(hexInput.value, null)) hexInput.value = input.value.toUpperCase();
      });
    };
    bindMultiColor(panelFields.color, panelFields.colorHex, (candidate, value) => {
      candidate.style.color = value;
    });
    bindMultiColor(panelFields.bg, panelFields.bgHex, (candidate, value) => {
      candidate.style.backgroundColor = value;
    });
    bindMultiColor(panelFields.borderColor, panelFields.borderColorHex, (candidate, value) => {
      const currentWidth = Math.max(1, Number(panelFields.borderWidth?.value) || 1);
      candidate.style.borderStyle = "solid";
      candidate.style.borderWidth = `${currentWidth}px`;
      candidate.style.borderColor = value;
    });

    panelFields.fillToggle?.addEventListener("click", () => {
      const visible = panelFields.fillToggle.getAttribute("aria-pressed") !== "true";
      const colorValue = panelFields.bg?.value || fillColor.value || "#737373";
      updateTargets((candidate) => {
        candidate.style.backgroundColor = visible ? colorValue : "transparent";
      });
      panelFields.fillToggle.setAttribute("aria-pressed", String(visible));
      panelFields.fillToggle.classList.remove("is-mixed");
      panelFields.fillToggle.closest("[data-color-control]")?.classList.toggle("is-disabled", !visible);
      pushHistory({ label: visible ? "批量显示填充" : "批量隐藏填充" });
    });
    panelFields.strokeToggle?.addEventListener("click", () => {
      const visible = panelFields.strokeToggle.getAttribute("aria-pressed") !== "true";
      const widthValue = Math.max(1, Number(panelFields.borderWidth?.value) || strokeWidth.value || 1);
      const colorValue = panelFields.borderColor?.value || strokeColor.value || "#737373";
      updateTargets((candidate) => {
        candidate.style.borderStyle = visible ? "solid" : "none";
        if (visible) {
          candidate.style.borderWidth = `${widthValue}px`;
          candidate.style.borderColor = colorValue;
        }
      });
      if (visible && panelFields.borderWidth) panelFields.borderWidth.value = String(widthValue);
      panelFields.strokeToggle.setAttribute("aria-pressed", String(visible));
      panelFields.strokeToggle.classList.remove("is-mixed");
      panelFields.strokeToggle.closest("[data-color-control]")?.classList.toggle("is-disabled", !visible);
      pushHistory({ label: visible ? "批量显示描边" : "批量隐藏描边" });
    });
    panel.querySelectorAll("[data-multi-text-style]").forEach((button) => {
      button.addEventListener("click", () => {
        const active = button.getAttribute("aria-pressed") !== "true";
        const action = button.dataset.multiTextStyle;
        updateTargets((candidate) => {
          if (action === "bold") candidate.style.fontWeight = active ? "700" : "400";
          if (action === "italic") candidate.style.fontStyle = active ? "italic" : "normal";
          if (action === "underline") candidate.style.textDecoration = active ? "underline" : "none";
        });
        button.classList.toggle("is-active", active);
        button.classList.remove("is-mixed");
        button.setAttribute("aria-pressed", String(active));
        if (action === "bold" && panelFields.fontWeight) panelFields.fontWeight.value = active ? "700" : "400";
        pushHistory({ label: "批量修改文字样式" });
      });
    });
    panel.querySelectorAll("[data-multi-text-align]").forEach((button) => {
      button.addEventListener("click", () => {
        const align = button.dataset.multiTextAlign;
        updateTargets((candidate) => {
          candidate.style.textAlign = align;
        });
        panel.querySelectorAll("[data-multi-text-align]").forEach((candidate) => {
          const active = candidate === button;
          candidate.classList.toggle("is-active", active);
          candidate.setAttribute("aria-pressed", String(active));
        });
        pushHistory({ label: "批量修改文字对齐" });
      });
    });
    panel.querySelectorAll(".h5ve-align-btn").forEach((button) => {
      button.addEventListener("click", () => applyLayoutAction(button.dataset.align));
    });
    if (disabled) {
      panel.classList.add("h5ve-panel-readonly");
      panel.querySelectorAll("input, textarea, select, button").forEach((control) => {
        control.disabled = true;
      });
    }
    bindPanelNumberScrub(state.primary);
    renderSlideControls();
  }

  function fillPanel(el) {
    panel.classList.remove("h5ve-panel-readonly");
    if (!el) {
      panel.innerHTML = `
        <div class="h5ve-panel-header">属性</div>
        <div class="h5ve-panel-empty h5ve-panel-empty-state">
          <strong>选择一个元素</strong>
          <span>在画布或左侧元素列表中选择，即可调整尺寸、位置和样式。</span>
          <small>Ctrl / ⌘ / Shift 多选与追加框选 · 双击文字编辑 · ⌘K 快速操作</small>
        </div>`;
      panelFields = {};
      renderSlideControls();
      return;
    }

    if (state.selected.length > 1) {
      fillMultiSelectionPanel();
      return;
    }

    const isText = canEditText(el);

    const t = parseTransform(el);
    const cs = getComputedStyle(el);
    const isFrame = isFrameContainer(el);
    const isStandaloneTextWidth = !isFrame && isStandaloneTextWidthElement(el, cs);
    const canWidthMode = canUseWidthMode(el);
    const flowMode = isFrame ? frameFlowMode(el) : "free";
    const widthMode = canWidthMode ? frameDimensionMode(el, "width") : "fixed";
    const heightMode = isFrame ? frameDimensionMode(el, "height") : "fixed";
    const frameGap = isFrame ? parseFloat(cs.gap) || 0 : 0;
    const spacingValue = (value) => Math.round((parseFloat(value) || 0) * 10) / 10;
    const framePadding = {
      top: isFrame ? spacingValue(cs.paddingTop) : 0,
      right: isFrame ? spacingValue(cs.paddingRight) : 0,
      bottom: isFrame ? spacingValue(cs.paddingBottom) : 0,
      left: isFrame ? spacingValue(cs.paddingLeft) : 0,
    };
    const frameMargin = {
      top: isFrame ? spacingValue(cs.marginTop) : 0,
      right: isFrame ? spacingValue(cs.marginRight) : 0,
      bottom: isFrame ? spacingValue(cs.marginBottom) : 0,
      left: isFrame ? spacingValue(cs.marginLeft) : 0,
    };
    const spacingPair = (first, second) => ({ value: first, mixed: Math.abs(first - second) > 0.01 });
    const paddingX = spacingPair(framePadding.left, framePadding.right);
    const paddingY = spacingPair(framePadding.top, framePadding.bottom);
    const marginX = spacingPair(frameMargin.left, frameMargin.right);
    const marginY = spacingPair(frameMargin.top, frameMargin.bottom);
    const spacingAxisAttrs = (pair) =>
      `value="${pair.mixed ? "" : pair.value}" data-scrub-start="${pair.value}" ${pair.mixed ? 'placeholder="混合"' : ""}`;
    const frameClipped = isFrame
      ? ["hidden", "clip"].includes(cs.overflowX) || ["hidden", "clip"].includes(cs.overflowY)
      : false;
    const w = parseFloat(cs.width) || 0;
    const h = parseFloat(cs.height) || 0;
    const fs = parseFloat(getInlineOrComputed(el, "fontSize")) || 16;
    const textColorValue = getInlineOrComputed(el, "color");
    const backgroundColorValue = getInlineOrComputed(el, "backgroundColor");
    const color = rgbToHex(textColorValue);
    const bg = rgbToHex(backgroundColorValue);
    const parsedOpacity = parseFloat(getInlineOrComputed(el, "opacity"));
    const opacity = Number.isFinite(parsedOpacity) ? parsedOpacity : 1;
    const aspectLocked = isAspectLocked(el);
    const rotation = parseRotation(el);
    const fontWeight = numericFontWeight(cs.fontWeight);
    const fontItalic = cs.fontStyle === "italic" || cs.fontStyle === "oblique";
    const textUnderlined = cs.textDecorationLine.includes("underline");
    const textAlign = cs.textAlign || "left";
    const lineHeight = Number.isFinite(parseFloat(cs.lineHeight)) ? parseFloat(cs.lineHeight) / Math.max(fs, 1) : 1.2;
    const letterSpacing = Number.isFinite(parseFloat(cs.letterSpacing)) ? parseFloat(cs.letterSpacing) : 0;
    const borderWidth = parseFloat(cs.borderTopWidth) || 0;
    const borderColorValue = cs.borderTopColor;
    const borderColor = rgbToHex(borderColorValue);
    const cornerRadii = {
      tl: parseFloat(cs.borderTopLeftRadius) || 0,
      tr: parseFloat(cs.borderTopRightRadius) || 0,
      br: parseFloat(cs.borderBottomRightRadius) || 0,
      bl: parseFloat(cs.borderBottomLeftRadius) || 0,
    };
    const cornerRadiusValues = Object.values(cornerRadii);
    const hasUniformCornerRadius = cornerRadiusValues.every(
      (value) => Math.abs(value - cornerRadiusValues[0]) < 0.01,
    );
    const borderRadius = hasUniformCornerRadius ? cornerRadiusValues[0] : null;
    const fillEnabled = !isTransparentCssColor(backgroundColorValue);
    const strokeEnabled = borderWidth > 0 && cs.borderTopStyle !== "none" && !isTransparentCssColor(borderColorValue);

    panel.innerHTML = `
      <div class="h5ve-panel-header">属性</div>
      <div class="h5ve-field"><label>元素</label><input type="text" id="h5ve-f-tag" readonly value="${escapeHtmlText(labelFor(el))}"></div>
      ${
        isText
          ? `<div class="h5ve-field"><label>文案</label><textarea id="h5ve-f-text">${escapeHtmlText(el.innerText || "")}</textarea></div>
        <div class="h5ve-field"><label>文字样式</label>
          <div class="h5ve-text-style-row" role="group" aria-label="文字样式">
            <button type="button" data-text-style="bold" class="${fontWeight >= 600 ? "is-active" : ""}" aria-pressed="${fontWeight >= 600}" title="粗体"><strong>B</strong></button>
            <button type="button" data-text-style="italic" class="${fontItalic ? "is-active" : ""}" aria-pressed="${fontItalic}" title="斜体"><em>I</em></button>
            <button type="button" data-text-style="underline" class="${textUnderlined ? "is-active" : ""}" aria-pressed="${textUnderlined}" title="下划线"><u>U</u></button>
            <span class="h5ve-text-style-separator"></span>
            <button type="button" data-text-align="left" class="${textAlign === "left" || textAlign === "start" ? "is-active" : ""}" aria-pressed="${textAlign === "left" || textAlign === "start"}" aria-label="左对齐" title="左对齐">${textAlignmentIcon("left")}</button>
            <button type="button" data-text-align="center" class="${textAlign === "center" ? "is-active" : ""}" aria-pressed="${textAlign === "center"}" aria-label="居中对齐" title="居中对齐">${textAlignmentIcon("center")}</button>
            <button type="button" data-text-align="right" class="${textAlign === "right" || textAlign === "end" ? "is-active" : ""}" aria-pressed="${textAlign === "right" || textAlign === "end"}" aria-label="右对齐" title="右对齐">${textAlignmentIcon("right")}</button>
          </div>
          <div class="h5ve-field-row h5ve-text-metric-row">
            <div class="h5ve-number-control"><span data-scrub-field="fs" title="左右拖拽调整字号">字号</span><input type="number" id="h5ve-f-fs" min="1" value="${Math.round(fs)}" aria-label="字号"></div>
            ${fontWeightSelectMarkup("h5ve-f-font-weight", fontWeight)}
          </div>
          <div class="h5ve-field-row h5ve-text-metric-row">
            <div class="h5ve-number-control"><span data-scrub-field="lineHeight" title="行高">行高</span><input type="number" id="h5ve-f-line-height" min="0.5" step="0.05" value="${Math.round(lineHeight * 100) / 100}"></div>
            <div class="h5ve-number-control"><span data-scrub-field="letterSpacing" title="字距">字距</span><input type="number" id="h5ve-f-letter-spacing" step="0.1" value="${Math.round(letterSpacing * 10) / 10}"></div>
          </div>
        </div>
        ${el.matches("a") ? `<div class="h5ve-field"><label>链接</label><input type="url" id="h5ve-f-href" value="${escapeHtmlText(el.getAttribute("href") || "")}" placeholder="https://"></div>` : ""}`
          : ""
      }
      <div class="h5ve-field"><label>位置</label>
        <div class="h5ve-field-row">
          <div class="h5ve-number-control"><span data-scrub-field="x" title="左右拖拽调整 X">X</span><input type="number" id="h5ve-f-x" value="${Math.round(t.x)}"></div>
          <div class="h5ve-number-control"><span data-scrub-field="y" title="左右拖拽调整 Y">Y</span><input type="number" id="h5ve-f-y" value="${Math.round(t.y)}"></div>
        </div>
      </div>
      <div class="h5ve-field"><label>居中</label>
        <div class="h5ve-center-row">
          <div class="h5ve-center-scope"><span>画布</span><div class="h5ve-center-buttons">
            <button type="button" class="h5ve-align-btn" data-align="h-center" data-align-scope="canvas" title="水平居中到整个画布" aria-label="水平居中到整个画布"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="3" width="9" height="3" rx="0.5" fill="currentColor"/><rect x="4.25" y="8" width="5.5" height="3" rx="0.5" fill="currentColor"/></svg></button>
            <button type="button" class="h5ve-align-btn" data-align="v-center" data-align-scope="canvas" title="垂直居中到整个画布" aria-label="垂直居中到整个画布"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 7h12" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="2.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="8" y="4.25" width="3" height="5.5" rx="0.5" fill="currentColor"/></svg></button>
          </div></div>
          <div class="h5ve-center-scope"><span>模块</span><div class="h5ve-center-buttons">
            <button type="button" class="h5ve-align-btn" data-align="h-center" data-align-scope="module" title="在上级模块内水平居中" aria-label="在上级模块内水平居中"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1v12" stroke="currentColor" stroke-width="1.5"/><rect x="2.5" y="3" width="9" height="3" rx="0.5" fill="currentColor"/><rect x="4.25" y="8" width="5.5" height="3" rx="0.5" fill="currentColor"/></svg></button>
            <button type="button" class="h5ve-align-btn" data-align="v-center" data-align-scope="module" title="在上级模块内垂直居中" aria-label="在上级模块内垂直居中"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 7h12" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="2.5" width="3" height="9" rx="0.5" fill="currentColor"/><rect x="8" y="4.25" width="3" height="5.5" rx="0.5" fill="currentColor"/></svg></button>
          </div></div>
        </div>
      </div>
      <div class="h5ve-field"><label>旋转</label>
        <div class="h5ve-number-control"><span data-scrub-field="rotation" title="左右拖拽调整角度">°</span><input type="number" id="h5ve-f-rotation" step="0.1" value="${Math.round(rotation * 10) / 10}"></div>
      </div>
      ${
        isFrame
          ? `<div class="h5ve-layout-card">
        <div class="h5ve-layout-title"><span>布局</span><small>框架</small></div>
        <div class="h5ve-field h5ve-layout-field"><label>流向</label>
          <div class="h5ve-flow-row" role="group" aria-label="框架布局流向">
            <button type="button" class="h5ve-flow-btn ${flowMode === "free" ? "is-active" : ""}" data-flow="free" title="自由布局" aria-label="自由布局"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="5" height="5" rx="1"/><rect x="15" y="5" width="5" height="5" rx="1"/><rect x="6" y="15" width="5" height="5" rx="1"/><rect x="16" y="15" width="4" height="4" rx="1"/></svg><span>自由</span></button>
            <button type="button" class="h5ve-flow-btn ${flowMode === "vertical" ? "is-active" : ""}" data-flow="vertical" title="纵向自动布局" aria-label="纵向自动布局"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="4" rx="1"/><rect x="5" y="10" width="14" height="4" rx="1"/><path d="M12 16v5m-3-3 3 3 3-3"/></svg><span>纵向</span></button>
            <button type="button" class="h5ve-flow-btn ${flowMode === "horizontal" ? "is-active" : ""}" data-flow="horizontal" title="横向自动布局" aria-label="横向自动布局"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="4" height="14" rx="1"/><rect x="10" y="5" width="4" height="14" rx="1"/><path d="M16 12h5m-3-3 3 3-3 3"/></svg><span>横向</span></button>
            <button type="button" class="h5ve-flow-btn ${flowMode === "grid" ? "is-active" : ""}" data-flow="grid" title="网格布局" aria-label="网格布局"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg><span>网格</span></button>
          </div>
        </div>
        <div class="h5ve-field h5ve-layout-field"><label>尺寸</label>
          <div class="h5ve-size-row">
            <div class="h5ve-dimension-grid">
              <div class="h5ve-dimension-control"><span data-scrub-field="w" title="左右拖拽调整宽度">W</span><input type="number" id="h5ve-f-w" value="${Math.round(w)}"><select class="h5ve-dimension-mode ${widthMode !== "fixed" ? "is-active" : ""} ${widthMode === "fill" ? "is-fill" : ""}" data-dimension-axis="width" data-dimension-mode="${widthMode}" aria-label="宽度模式" title="宽度模式：固定 / 适应内容 / 填充父级"><option value="fixed" ${widthMode === "fixed" ? "selected" : ""}>固定</option><option value="hug" ${widthMode === "hug" ? "selected" : ""}>适应</option><option value="fill" ${widthMode === "fill" ? "selected" : ""}>填充</option></select></div>
              <div class="h5ve-dimension-control"><span data-scrub-field="h" title="左右拖拽调整高度">H</span><input type="number" id="h5ve-f-h" value="${Math.round(h)}"><select class="h5ve-dimension-mode ${heightMode === "hug" ? "is-active" : ""}" data-dimension-axis="height" data-dimension-mode="${heightMode}" aria-label="高度模式" title="高度模式：固定 / 适应内容"><option value="fixed" ${heightMode === "fixed" ? "selected" : ""}>固定</option><option value="hug" ${heightMode === "hug" ? "selected" : ""}>适应</option></select></div>
            </div>
            ${aspectLockButtonMarkup(aspectLocked)}
          </div>
        </div>
        <div class="h5ve-field h5ve-layout-field h5ve-spacing-field">
          <div class="h5ve-spacing-block">
            <div class="h5ve-spacing-head">
              <span>内间距</span>
              <button type="button" id="h5ve-f-spacing-mode" class="h5ve-spacing-mode ${state.frameSpacingExpanded ? "is-active" : ""}" aria-expanded="${state.frameSpacingExpanded}" aria-controls="h5ve-spacing-detail" aria-label="${state.frameSpacingExpanded ? "收起四边间距" : "分别设置四边间距"}" title="${state.frameSpacingExpanded ? "收起四边间距" : "分别设置四边间距"}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4"/></svg>
              </button>
            </div>
            <div class="h5ve-spacing-axis-grid">
              <div class="h5ve-number-control"><span data-scrub-field="paddingX" aria-label="左右内间距" title="左右内间距">${spacingAxisIcon("padding", "x")}</span><input type="number" id="h5ve-f-padding-x" min="0" step="1" ${spacingAxisAttrs(paddingX)} aria-label="左右内间距"></div>
              <div class="h5ve-number-control"><span data-scrub-field="paddingY" aria-label="上下内间距" title="上下内间距">${spacingAxisIcon("padding", "y")}</span><input type="number" id="h5ve-f-padding-y" min="0" step="1" ${spacingAxisAttrs(paddingY)} aria-label="上下内间距"></div>
            </div>
          </div>
          <div class="h5ve-spacing-block">
            <div class="h5ve-spacing-head"><span>外间距</span><small>可为负值</small></div>
            <div class="h5ve-spacing-axis-grid">
              <div class="h5ve-number-control"><span data-scrub-field="marginX" aria-label="左右外间距" title="左右外间距">${spacingAxisIcon("margin", "x")}</span><input type="number" id="h5ve-f-margin-x" step="1" ${spacingAxisAttrs(marginX)} aria-label="左右外间距"></div>
              <div class="h5ve-number-control"><span data-scrub-field="marginY" aria-label="上下外间距" title="上下外间距">${spacingAxisIcon("margin", "y")}</span><input type="number" id="h5ve-f-margin-y" step="1" ${spacingAxisAttrs(marginY)} aria-label="上下外间距"></div>
            </div>
          </div>
          <div class="h5ve-spacing-detail" id="h5ve-spacing-detail" ${state.frameSpacingExpanded ? "" : "hidden"}>
            <div class="h5ve-spacing-side-group">
              <span>内间距·四边</span>
              <div class="h5ve-spacing-side-grid">
                <div class="h5ve-number-control"><span data-scrub-field="paddingTop" title="上内间距">上</span><input type="number" id="h5ve-f-padding-top" min="0" value="${framePadding.top}" aria-label="上内间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="paddingRight" title="右内间距">右</span><input type="number" id="h5ve-f-padding-right" min="0" value="${framePadding.right}" aria-label="右内间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="paddingBottom" title="下内间距">下</span><input type="number" id="h5ve-f-padding-bottom" min="0" value="${framePadding.bottom}" aria-label="下内间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="paddingLeft" title="左内间距">左</span><input type="number" id="h5ve-f-padding-left" min="0" value="${framePadding.left}" aria-label="左内间距"></div>
              </div>
            </div>
            <div class="h5ve-spacing-side-group">
              <span>外间距·四边</span>
              <div class="h5ve-spacing-side-grid">
                <div class="h5ve-number-control"><span data-scrub-field="marginTop" title="上外间距">上</span><input type="number" id="h5ve-f-margin-top" value="${frameMargin.top}" aria-label="上外间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="marginRight" title="右外间距">右</span><input type="number" id="h5ve-f-margin-right" value="${frameMargin.right}" aria-label="右外间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="marginBottom" title="下外间距">下</span><input type="number" id="h5ve-f-margin-bottom" value="${frameMargin.bottom}" aria-label="下外间距"></div>
                <div class="h5ve-number-control"><span data-scrub-field="marginLeft" title="左外间距">左</span><input type="number" id="h5ve-f-margin-left" value="${frameMargin.left}" aria-label="左外间距"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="h5ve-field h5ve-layout-field h5ve-frame-options">
          <label><span class="h5ve-scrub-label" data-scrub-field="gap" title="左右拖拽调整间距">间距</span><input type="number" id="h5ve-f-gap" min="0" value="${Math.round(frameGap)}"></label>
          <label class="h5ve-checkbox-label"><input type="checkbox" id="h5ve-f-clip" ${frameClipped ? "checked" : ""}><span>裁剪内容</span></label>
        </div>
      </div>`
          : `<div class="h5ve-field"><label>尺寸</label>
        <div class="h5ve-size-row">
          ${
            canWidthMode
              ? `<div class="h5ve-dimension-grid">
            <div class="h5ve-dimension-control"><span data-scrub-field="w" title="左右拖拽调整宽度">W</span><input type="number" id="h5ve-f-w" value="${Math.round(w)}"><select class="h5ve-dimension-mode ${widthMode !== "fixed" ? "is-active" : ""} ${widthMode === "fill" ? "is-fill" : ""}" data-dimension-axis="width" data-dimension-mode="${widthMode}" aria-label="宽度模式" title="${isStandaloneTextWidth ? "宽度模式：固定 / 适应内容 / 填充父级" : "宽度模式：固定 / 填充父级"}"><option value="fixed" ${widthMode === "fixed" ? "selected" : ""}>固定</option>${isStandaloneTextWidth ? `<option value="hug" ${widthMode === "hug" ? "selected" : ""}>适应</option>` : ""}<option value="fill" ${widthMode === "fill" ? "selected" : ""}>填充</option></select></div>
            <div class="h5ve-number-control"><span data-scrub-field="h" title="左右拖拽调整高度">H</span><input type="number" id="h5ve-f-h" value="${Math.round(h)}"></div>
          </div>`
              : `<div class="h5ve-field-row">
            <div class="h5ve-number-control"><span data-scrub-field="w" title="左右拖拽调整宽度">W</span><input type="number" id="h5ve-f-w" value="${Math.round(w)}"></div>
            <div class="h5ve-number-control"><span data-scrub-field="h" title="左右拖拽调整高度">H</span><input type="number" id="h5ve-f-h" value="${Math.round(h)}"></div>
          </div>`
          }
          ${aspectLockButtonMarkup(aspectLocked)}
        </div>
      </div>`
      }
      <section class="h5ve-inspector-section h5ve-appearance-section" aria-labelledby="h5ve-appearance-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-appearance-title">外观</span></div>
        <div class="h5ve-appearance-grid">
          <label class="h5ve-compact-property"><span class="h5ve-scrub-label" data-scrub-field="opacity" title="左右拖拽调整透明度">透明度</span>
            <div class="h5ve-number-control"><span>%</span><input type="number" id="h5ve-f-opacity" min="0" max="100" step="1" value="${Math.round(opacity * 100)}" aria-label="透明度百分比"></div>
          </label>
          <div class="h5ve-compact-property h5ve-corner-property">
            <div class="h5ve-compact-property-head">
              <span class="h5ve-scrub-label" data-scrub-field="radius" title="左右拖拽统一调整四个圆角">圆角</span>
              <button type="button" id="h5ve-f-corner-mode" class="h5ve-corner-mode ${state.cornerRadiiExpanded ? "is-active" : ""}" aria-expanded="${state.cornerRadiiExpanded}" aria-controls="h5ve-corner-detail" aria-label="${state.cornerRadiiExpanded ? "收起独立圆角" : "分别设置四个圆角"}" title="${state.cornerRadiiExpanded ? "收起独立圆角" : "分别设置四个圆角"}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/></svg>
              </button>
            </div>
            <div class="h5ve-number-control"><span>R</span><input type="number" id="h5ve-f-radius" min="0" value="${borderRadius == null ? "" : Math.round(borderRadius)}" placeholder="混合" aria-label="统一圆角像素"></div>
          </div>
        </div>
        <div class="h5ve-corner-detail ${state.cornerRadiiExpanded ? "is-expanded" : ""}" id="h5ve-corner-detail" ${state.cornerRadiiExpanded ? "" : "hidden"}>
          <label class="h5ve-corner-field"><span class="h5ve-scrub-label" data-scrub-field="radiusTL" title="左右拖拽调整左上圆角">左上</span><div class="h5ve-number-control"><span>⌜</span><input type="number" id="h5ve-f-radius-tl" min="0" value="${Math.round(cornerRadii.tl)}" aria-label="左上圆角像素"></div></label>
          <label class="h5ve-corner-field"><span class="h5ve-scrub-label" data-scrub-field="radiusTR" title="左右拖拽调整右上圆角">右上</span><div class="h5ve-number-control"><span>⌝</span><input type="number" id="h5ve-f-radius-tr" min="0" value="${Math.round(cornerRadii.tr)}" aria-label="右上圆角像素"></div></label>
          <label class="h5ve-corner-field"><span class="h5ve-scrub-label" data-scrub-field="radiusBL" title="左右拖拽调整左下圆角">左下</span><div class="h5ve-number-control"><span>⌞</span><input type="number" id="h5ve-f-radius-bl" min="0" value="${Math.round(cornerRadii.bl)}" aria-label="左下圆角像素"></div></label>
          <label class="h5ve-corner-field"><span class="h5ve-scrub-label" data-scrub-field="radiusBR" title="左右拖拽调整右下圆角">右下</span><div class="h5ve-number-control"><span>⌟</span><input type="number" id="h5ve-f-radius-br" min="0" value="${Math.round(cornerRadii.br)}" aria-label="右下圆角像素"></div></label>
        </div>
      </section>
      ${
        isText
          ? `<section class="h5ve-inspector-section" aria-labelledby="h5ve-text-color-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-text-color-title">文字颜色</span><small>单色</small></div>
        <div class="h5ve-color-control" data-color-control="text" style="--h5ve-swatch-color:${color}">
          <label class="h5ve-color-swatch" title="打开文字颜色选择器"><input type="color" id="h5ve-f-color" value="${color}" aria-label="文字颜色"><span aria-hidden="true"></span></label>
          <input type="text" id="h5ve-f-color-hex" class="h5ve-hex-input" value="${color.toUpperCase()}" inputmode="text" spellcheck="false" aria-label="文字颜色 HEX">
        </div>
      </section>`
          : ""
      }
      <section class="h5ve-inspector-section" aria-labelledby="h5ve-fill-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-fill-title">填充</span><small>单色</small></div>
        <div class="h5ve-color-control ${fillEnabled ? "" : "is-disabled"}" data-color-control="fill" style="--h5ve-swatch-color:${bg}">
          <label class="h5ve-color-swatch" title="打开填充颜色选择器"><input type="color" id="h5ve-f-bg" value="${bg}" aria-label="填充颜色"><span aria-hidden="true"></span></label>
          <input type="text" id="h5ve-f-bg-hex" class="h5ve-hex-input" value="${bg.toUpperCase()}" inputmode="text" spellcheck="false" aria-label="填充颜色 HEX">
          <button type="button" class="h5ve-visibility-toggle" id="h5ve-f-fill-toggle" aria-label="${fillEnabled ? "隐藏填充" : "显示填充"}" aria-pressed="${fillEnabled}" title="${fillEnabled ? "隐藏填充" : "显示填充"}">
            <svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
          </button>
        </div>
      </section>
      <section class="h5ve-inspector-section" aria-labelledby="h5ve-stroke-title">
        <div class="h5ve-inspector-section-head"><span id="h5ve-stroke-title">描边</span><small>内侧</small></div>
        <div class="h5ve-color-control h5ve-stroke-control ${strokeEnabled ? "" : "is-disabled"}" data-color-control="stroke" style="--h5ve-swatch-color:${borderColor}">
          <label class="h5ve-color-swatch" title="打开描边颜色选择器"><input type="color" id="h5ve-f-border-color" value="${borderColor}" aria-label="描边颜色"><span aria-hidden="true"></span></label>
          <input type="text" id="h5ve-f-border-color-hex" class="h5ve-hex-input" value="${borderColor.toUpperCase()}" inputmode="text" spellcheck="false" aria-label="描边颜色 HEX">
          <div class="h5ve-number-control h5ve-stroke-width"><span data-scrub-field="borderWidth" title="左右拖拽调整描边宽度">W</span><input type="number" id="h5ve-f-border-width" min="0" step="0.5" value="${Math.round(borderWidth * 10) / 10}" aria-label="描边宽度"></div>
          <button type="button" class="h5ve-visibility-toggle" id="h5ve-f-stroke-toggle" aria-label="${strokeEnabled ? "隐藏描边" : "显示描边"}" aria-pressed="${strokeEnabled}" title="${strokeEnabled ? "隐藏描边" : "显示描边"}">
            <svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>
          </button>
        </div>
      </section>
    `;

    panelFields = {
      text: panel.querySelector("#h5ve-f-text"),
      x: panel.querySelector("#h5ve-f-x"),
      y: panel.querySelector("#h5ve-f-y"),
      w: panel.querySelector("#h5ve-f-w"),
      h: panel.querySelector("#h5ve-f-h"),
      gap: panel.querySelector("#h5ve-f-gap"),
      paddingX: panel.querySelector("#h5ve-f-padding-x"),
      paddingY: panel.querySelector("#h5ve-f-padding-y"),
      marginX: panel.querySelector("#h5ve-f-margin-x"),
      marginY: panel.querySelector("#h5ve-f-margin-y"),
      paddingTop: panel.querySelector("#h5ve-f-padding-top"),
      paddingRight: panel.querySelector("#h5ve-f-padding-right"),
      paddingBottom: panel.querySelector("#h5ve-f-padding-bottom"),
      paddingLeft: panel.querySelector("#h5ve-f-padding-left"),
      marginTop: panel.querySelector("#h5ve-f-margin-top"),
      marginRight: panel.querySelector("#h5ve-f-margin-right"),
      marginBottom: panel.querySelector("#h5ve-f-margin-bottom"),
      marginLeft: panel.querySelector("#h5ve-f-margin-left"),
      spacingMode: panel.querySelector("#h5ve-f-spacing-mode"),
      clip: panel.querySelector("#h5ve-f-clip"),
      aspect: panel.querySelector("#h5ve-f-aspect"),
      rotation: panel.querySelector("#h5ve-f-rotation"),
      fs: panel.querySelector("#h5ve-f-fs"),
      fontWeight: panel.querySelector("#h5ve-f-font-weight"),
      lineHeight: panel.querySelector("#h5ve-f-line-height"),
      letterSpacing: panel.querySelector("#h5ve-f-letter-spacing"),
      href: panel.querySelector("#h5ve-f-href"),
      color: panel.querySelector("#h5ve-f-color"),
      colorHex: panel.querySelector("#h5ve-f-color-hex"),
      bg: panel.querySelector("#h5ve-f-bg"),
      bgHex: panel.querySelector("#h5ve-f-bg-hex"),
      fillToggle: panel.querySelector("#h5ve-f-fill-toggle"),
      borderColor: panel.querySelector("#h5ve-f-border-color"),
      borderColorHex: panel.querySelector("#h5ve-f-border-color-hex"),
      borderWidth: panel.querySelector("#h5ve-f-border-width"),
      strokeToggle: panel.querySelector("#h5ve-f-stroke-toggle"),
      radius: panel.querySelector("#h5ve-f-radius"),
      radiusTL: panel.querySelector("#h5ve-f-radius-tl"),
      radiusTR: panel.querySelector("#h5ve-f-radius-tr"),
      radiusBR: panel.querySelector("#h5ve-f-radius-br"),
      radiusBL: panel.querySelector("#h5ve-f-radius-bl"),
      cornerMode: panel.querySelector("#h5ve-f-corner-mode"),
      opacity: panel.querySelector("#h5ve-f-opacity"),
    };

    const bindColorControl = (input, hexInput, applyColor) => {
      if (!input || !hexInput) return;
      const control = input.closest("[data-color-control]");
      const commit = (value, fallback = input.value) => {
        const normalized = normalizeHexColor(value, fallback);
        if (!normalized) return false;
        input.value = normalized;
        hexInput.value = normalized;
        control?.style.setProperty("--h5ve-swatch-color", normalized);
        applyColor(normalized);
        return true;
      };
      input.addEventListener("input", () => commit(input.value));
      hexInput.addEventListener("input", () => {
        if (normalizeHexColor(hexInput.value)) commit(hexInput.value);
      });
      hexInput.addEventListener("change", () => {
        if (!commit(hexInput.value, null)) hexInput.value = input.value.toUpperCase();
      });
    };

    const setVisibilityToggleState = (button, control, visible, labels) => {
      if (!button) return;
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", visible ? labels.hide : labels.show);
      button.title = visible ? labels.hide : labels.show;
      control?.classList.toggle("is-disabled", !visible);
    };

    panelFields.text?.addEventListener("input", () => {
      el.innerText = panelFields.text.value;
      syncPanelGeometry(el);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.x?.addEventListener("input", () => {
      applyTransform(el, Number(panelFields.x.value) || 0, Number(panelFields.y?.value) || 0);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.y?.addEventListener("input", () => {
      applyTransform(el, Number(panelFields.x?.value) || 0, Number(panelFields.y.value) || 0);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.rotation?.addEventListener("input", () => {
      applyRotation(el, Number(panelFields.rotation.value) || 0);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.w?.addEventListener("input", () => {
      const v = Number(panelFields.w.value);
      if (!v || v <= 0) return;
      ensureResizable(el);
      if (canWidthMode) setFrameDimensionFixedValue(el, "width", v);
      else el.style.width = `${v}px`;
      if (isAspectLocked(el)) {
        const ratio = elementAspectRatio(el, w, h);
        if (ratio) {
          const nextHeight = Math.max(1, v / ratio);
          if (canUseHeightMode(el)) setFrameDimensionFixedValue(el, "height", nextHeight);
          else el.style.height = `${nextHeight}px`;
          if (panelFields.h) panelFields.h.value = String(Math.round(nextHeight * 10) / 10);
        }
      }
      syncPanelGeometry(el);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.h?.addEventListener("input", () => {
      const v = Number(panelFields.h.value);
      if (!v || v <= 0) return;
      ensureResizable(el);
      if (canUseHeightMode(el)) setFrameDimensionFixedValue(el, "height", v);
      else el.style.height = `${v}px`;
      if (isAspectLocked(el)) {
        const ratio = elementAspectRatio(el, w, h);
        if (ratio) {
          const nextWidth = Math.max(1, v * ratio);
          if (canWidthMode) setFrameDimensionFixedValue(el, "width", nextWidth);
          else el.style.width = `${nextWidth}px`;
          if (panelFields.w) panelFields.w.value = String(Math.round(nextWidth * 10) / 10);
        }
      }
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.fs?.addEventListener("input", () => {
      const value = Number(panelFields.fs.value);
      if (!Number.isFinite(value) || value <= 0) return;
      el.style.fontSize = `${value}px`;
      syncPanelGeometry(el);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.fontWeight?.addEventListener("change", () => {
      const value = numericFontWeight(panelFields.fontWeight.value);
      el.style.fontWeight = String(value);
      const boldButton = panel.querySelector('[data-text-style="bold"]');
      boldButton?.classList.toggle("is-active", value >= 600);
      boldButton?.setAttribute("aria-pressed", String(value >= 600));
      syncPanelGeometry(el);
      scheduleSelectionBox();
      pushHistory({ label: "调整字重" });
    });
    panelFields.lineHeight?.addEventListener("input", () => {
      el.style.lineHeight = String(Math.max(0.5, Number(panelFields.lineHeight.value) || 1.2));
      syncPanelGeometry(el);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.letterSpacing?.addEventListener("input", () => {
      el.style.letterSpacing = `${Number(panelFields.letterSpacing.value) || 0}px`;
      syncPanelGeometry(el);
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.href?.addEventListener("input", () => {
      const href = safeEditableHref(panelFields.href.value);
      if (href == null) {
        panelFields.href.setCustomValidity("仅支持 http、https、mailto、tel、页面内锚点和相对地址");
        return;
      }
      panelFields.href.setCustomValidity("");
      el.setAttribute("href", href);
      markDirty();
    });
    bindColorControl(panelFields.color, panelFields.colorHex, (value) => {
      el.style.color = value;
      markDirty();
    });
    bindColorControl(panelFields.bg, panelFields.bgHex, (value) => {
      if (panelFields.fillToggle?.getAttribute("aria-pressed") !== "false") el.style.backgroundColor = value;
      scheduleSelectionBox();
      markDirty();
    });
    bindColorControl(panelFields.borderColor, panelFields.borderColorHex, (value) => {
      if (panelFields.strokeToggle?.getAttribute("aria-pressed") !== "false") {
        el.style.borderStyle = "solid";
        el.style.borderColor = value;
      }
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.fillToggle?.addEventListener("click", () => {
      const visible = panelFields.fillToggle.getAttribute("aria-pressed") !== "true";
      el.style.backgroundColor = visible ? panelFields.bg.value : "transparent";
      setVisibilityToggleState(panelFields.fillToggle, panelFields.fillToggle.closest("[data-color-control]"), visible, {
        hide: "隐藏填充",
        show: "显示填充",
      });
      scheduleSelectionBox();
      markDirty();
      pushHistory({ label: visible ? "显示填充" : "隐藏填充" });
    });
    panelFields.strokeToggle?.addEventListener("click", () => {
      const visible = panelFields.strokeToggle.getAttribute("aria-pressed") !== "true";
      const currentWidth = Math.max(0, Number(panelFields.borderWidth?.value) || 0);
      if (visible && currentWidth === 0 && panelFields.borderWidth) panelFields.borderWidth.value = "1";
      el.style.borderStyle = visible ? "solid" : "none";
      el.style.borderWidth = `${visible ? Math.max(1, currentWidth) : currentWidth}px`;
      el.style.borderColor = panelFields.borderColor?.value || borderColor;
      setVisibilityToggleState(panelFields.strokeToggle, panelFields.strokeToggle.closest("[data-color-control]"), visible, {
        hide: "隐藏描边",
        show: "显示描边",
      });
      scheduleSelectionBox();
      markDirty();
      pushHistory({ label: visible ? "显示描边" : "隐藏描边" });
    });
    panelFields.borderWidth?.addEventListener("input", () => {
      const value = Math.max(0, Number(panelFields.borderWidth.value) || 0);
      el.style.borderStyle = value > 0 ? "solid" : "none";
      el.style.borderWidth = `${value}px`;
      setVisibilityToggleState(panelFields.strokeToggle, panelFields.strokeToggle?.closest("[data-color-control]"), value > 0, {
        hide: "隐藏描边",
        show: "显示描边",
      });
      scheduleSelectionBox();
      markDirty();
    });
    panelFields.radius?.addEventListener("input", () => {
      const value = Math.max(0, Number(panelFields.radius.value) || 0);
      el.style.borderRadius = `${value}px`;
      [panelFields.radiusTL, panelFields.radiusTR, panelFields.radiusBR, panelFields.radiusBL].forEach((input) => {
        if (input) input.value = String(value);
      });
      scheduleSelectionBox();
      markDirty();
    });
    const cornerFieldMap = {
      radiusTL: "borderTopLeftRadius",
      radiusTR: "borderTopRightRadius",
      radiusBR: "borderBottomRightRadius",
      radiusBL: "borderBottomLeftRadius",
    };
    const syncUniformCornerField = () => {
      const values = [panelFields.radiusTL, panelFields.radiusTR, panelFields.radiusBR, panelFields.radiusBL].map(
        (input) => Math.max(0, Number(input?.value) || 0),
      );
      const uniform = values.every((value) => Math.abs(value - values[0]) < 0.01);
      panelFields.radius.value = uniform ? String(values[0]) : "";
      panelFields.radius.placeholder = uniform ? "" : "混合";
    };
    Object.entries(cornerFieldMap).forEach(([key, property]) => {
      panelFields[key]?.addEventListener("input", () => {
        const value = Math.max(0, Number(panelFields[key].value) || 0);
        panelFields[key].value = String(value);
        el.style[property] = `${value}px`;
        syncUniformCornerField();
        scheduleSelectionBox();
        markDirty();
      });
    });
    panelFields.cornerMode?.addEventListener("click", () => {
      state.cornerRadiiExpanded = !state.cornerRadiiExpanded;
      fillPanel(el);
      requestAnimationFrame(() => {
        if (state.cornerRadiiExpanded) panelFields.radiusTL?.focus({ preventScroll: true });
      });
    });
    panel.querySelectorAll("[data-text-style]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.textStyle;
        const active = button.classList.toggle("is-active");
        button.setAttribute("aria-pressed", String(active));
        if (action === "bold") {
          el.style.fontWeight = active ? "700" : "400";
          if (panelFields.fontWeight) panelFields.fontWeight.value = active ? "700" : "400";
        }
        if (action === "italic") el.style.fontStyle = active ? "italic" : "normal";
        if (action === "underline") el.style.textDecoration = active ? "underline" : "none";
        scheduleSelectionBox();
        markDirty();
      });
    });
    panel.querySelectorAll("[data-text-align]").forEach((button) => {
      button.addEventListener("click", () => {
        const align = button.dataset.textAlign;
        el.style.textAlign = align;
        panel.querySelectorAll("[data-text-align]").forEach((candidate) => {
          const active = candidate === button;
          candidate.classList.toggle("is-active", active);
          candidate.setAttribute("aria-pressed", String(active));
        });
        scheduleSelectionBox();
        markDirty();
      });
    });
    panel.querySelectorAll(".h5ve-align-btn").forEach((button) => {
      button.addEventListener("click", () => applyLayoutAction(button.dataset.align, button.dataset.alignScope));
    });
    panelFields.opacity?.addEventListener("input", () => {
      const value = Math.max(0, Math.min(100, Number(panelFields.opacity.value) || 0));
      panelFields.opacity.value = String(value);
      el.style.opacity = String(value / 100);
      markDirty();
    });
    panel.querySelectorAll("[data-flow]").forEach((button) => {
      button.addEventListener("click", () => setFrameFlow(el, button.dataset.flow));
    });
    panel.querySelectorAll("[data-dimension-axis]").forEach((control) => {
      control.addEventListener("change", () => {
        const axis = control.dataset.dimensionAxis;
        setFrameDimensionMode(el, axis, control.value);
      });
    });
    panelFields.gap?.addEventListener("input", () => setFrameGap(el, panelFields.gap.value));
    panelFields.gap?.addEventListener("change", () => pushHistory());
    const spacingAxisFields = {
      paddingX: { properties: ["paddingLeft", "paddingRight"], sideKeys: ["paddingLeft", "paddingRight"], min: 0, label: "左右内间距" },
      paddingY: { properties: ["paddingTop", "paddingBottom"], sideKeys: ["paddingTop", "paddingBottom"], min: 0, label: "上下内间距" },
      marginX: { properties: ["marginLeft", "marginRight"], sideKeys: ["marginLeft", "marginRight"], min: -Infinity, label: "左右外间距" },
      marginY: { properties: ["marginTop", "marginBottom"], sideKeys: ["marginTop", "marginBottom"], min: -Infinity, label: "上下外间距" },
    };
    const normalizeSpacingInput = (input, minimum) => {
      const text = String(input?.value ?? "").trim();
      if (!text || text === "-" || text === ".") return null;
      const value = Number(text);
      if (!Number.isFinite(value)) return null;
      const normalized = Number.isFinite(minimum) ? Math.max(minimum, value) : value;
      input.value = String(normalized);
      return normalized;
    };
    const syncSpacingAxisField = (axisKey, sideKeys) => {
      const axisInput = panelFields[axisKey];
      const sideValues = sideKeys.map((key) => Number(panelFields[key]?.value));
      if (!axisInput || sideValues.some((value) => !Number.isFinite(value))) return;
      const uniform = Math.abs(sideValues[0] - sideValues[1]) < 0.01;
      axisInput.value = uniform ? String(sideValues[0]) : "";
      axisInput.placeholder = uniform ? "" : "混合";
      axisInput.dataset.scrubStart = String(sideValues[0]);
    };
    Object.entries(spacingAxisFields).forEach(([key, config]) => {
      panelFields[key]?.addEventListener("input", () => {
        const value = normalizeSpacingInput(panelFields[key], config.min);
        if (value == null) return;
        setFrameSpacingValues(el, Object.fromEntries(config.properties.map((property) => [property, value])));
        config.sideKeys.forEach((sideKey) => {
          if (panelFields[sideKey]) panelFields[sideKey].value = String(value);
        });
      });
      panelFields[key]?.addEventListener("change", () => pushHistory({ label: `调整${config.label}` }));
    });
    const spacingSideFields = {
      paddingTop: { property: "paddingTop", axisKey: "paddingY", sideKeys: ["paddingTop", "paddingBottom"], min: 0, label: "上内间距" },
      paddingRight: { property: "paddingRight", axisKey: "paddingX", sideKeys: ["paddingLeft", "paddingRight"], min: 0, label: "右内间距" },
      paddingBottom: { property: "paddingBottom", axisKey: "paddingY", sideKeys: ["paddingTop", "paddingBottom"], min: 0, label: "下内间距" },
      paddingLeft: { property: "paddingLeft", axisKey: "paddingX", sideKeys: ["paddingLeft", "paddingRight"], min: 0, label: "左内间距" },
      marginTop: { property: "marginTop", axisKey: "marginY", sideKeys: ["marginTop", "marginBottom"], min: -Infinity, label: "上外间距" },
      marginRight: { property: "marginRight", axisKey: "marginX", sideKeys: ["marginLeft", "marginRight"], min: -Infinity, label: "右外间距" },
      marginBottom: { property: "marginBottom", axisKey: "marginY", sideKeys: ["marginTop", "marginBottom"], min: -Infinity, label: "下外间距" },
      marginLeft: { property: "marginLeft", axisKey: "marginX", sideKeys: ["marginLeft", "marginRight"], min: -Infinity, label: "左外间距" },
    };
    Object.entries(spacingSideFields).forEach(([key, config]) => {
      panelFields[key]?.addEventListener("input", () => {
        const value = normalizeSpacingInput(panelFields[key], config.min);
        if (value == null) return;
        setFrameSpacingValues(el, { [config.property]: value });
        syncSpacingAxisField(config.axisKey, config.sideKeys);
      });
      panelFields[key]?.addEventListener("change", () => pushHistory({ label: `调整${config.label}` }));
    });
    panelFields.spacingMode?.addEventListener("click", () => {
      state.frameSpacingExpanded = !state.frameSpacingExpanded;
      fillPanel(el);
      requestAnimationFrame(() => {
        if (state.frameSpacingExpanded) panelFields.paddingTop?.focus({ preventScroll: true });
      });
    });
    panelFields.clip?.addEventListener("change", () => setFrameClip(el, panelFields.clip.checked));
    panelFields.aspect?.addEventListener("click", () => setAspectLocked(el, !isAspectLocked(el)));
    const readOnlyReason = isElementLocked(el) ? "locked" : isElementHidden(el) ? "hidden" : "";
    if (readOnlyReason) {
      panel.classList.add("h5ve-panel-readonly");
      const notice = document.createElement("div");
      notice.className = "h5ve-panel-readonly-notice";
      notice.textContent = readOnlyReason === "locked" ? "元素已锁定·在图层列表解锁后编辑" : "元素已隐藏·在图层列表显示后编辑";
      panel.querySelector(".h5ve-panel-header")?.after(notice);
      panel.querySelectorAll("input, textarea, select, button").forEach((control) => {
        control.disabled = true;
      });
    }
    bindPanelNumberScrub(el);
    renderSlideControls();
  }

  function moveSelection(dx, dy) {
    const targets = collectGroupMembers(state.selected).filter((el) => !isElementLocked(el));
    if (targets.length === 0) return;
    targets.forEach((el) => {
      const t = parseTransform(el);
      applyTransform(el, t.x + dx, t.y + dy);
    });
    if (state.primary && panelFields.x && panelFields.y) {
      const t = parseTransform(state.primary);
      panelFields.x.value = Math.round(t.x);
      panelFields.y.value = Math.round(t.y);
    }
    scheduleSelectionBox();
  }

  function translateElement(el, dx, dy) {
    if ((!dx && !dy) || isElementLocked(el)) return;
    const t = parseTransform(el);
    applyTransform(el, t.x + dx / state.scale, t.y + dy / state.scale);
  }

  function containingModuleFor(el, canvas) {
    let candidate = el?.parentElement || null;
    while (candidate && candidate !== canvas) {
      if (isFrameContainer(candidate)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function alignSelection(mode, scope = "selection") {
    if (state.selected.length === 0) return;

    if (state.selected.length === 1) {
      if (mode !== "h-center" && mode !== "v-center") return;
      const selected = state.selected[0];
      if (!selected?.isConnected || isElementLocked(selected) || isElementHidden(selected)) return;
      const canvas = currentSlide() || getStage() || contentRoot();
      const alignmentTarget = scope === "module" ? containingModuleFor(selected, canvas) : canvas;
      if (!alignmentTarget) {
        showToast("当前元素没有可用的上级模块");
        return;
      }
      const targetRect = alignmentTarget.getBoundingClientRect?.();
      const elementRect = getSelectableVisualRect(selected);
      if (!targetRect || !elementRect || targetRect.width <= 0 || targetRect.height <= 0) return;
      const dx = mode === "h-center" ? targetRect.left + targetRect.width / 2 - (elementRect.left + elementRect.width / 2) : 0;
      const dy = mode === "v-center" ? targetRect.top + targetRect.height / 2 - (elementRect.top + elementRect.height / 2) : 0;
      translateElement(selected, dx, dy);
      syncPanelGeometry(selected);
      scheduleSelectionBox();
      const targetLabel = scope === "module" ? "模块" : "画布";
      pushHistory({ label: mode === "h-center" ? `水平居中到${targetLabel}` : `垂直居中到${targetLabel}` });
      return;
    }

    const rects = state.selected.map((el) => ({ el, r: el.getBoundingClientRect() }));
    const left = Math.min(...rects.map(({ r }) => r.left));
    const right = Math.max(...rects.map(({ r }) => r.right));
    const top = Math.min(...rects.map(({ r }) => r.top));
    const bottom = Math.max(...rects.map(({ r }) => r.bottom));
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;

    rects.forEach(({ el, r }) => {
      let dx = 0;
      let dy = 0;
      if (mode === "left") dx = left - r.left;
      else if (mode === "h-center") dx = cx - (r.left + r.width / 2);
      else if (mode === "right") dx = right - r.right;
      else if (mode === "top") dy = top - r.top;
      else if (mode === "v-center") dy = cy - (r.top + r.height / 2);
      else if (mode === "bottom") dy = bottom - r.bottom;
      translateElement(el, dx, dy);
    });
    scheduleSelectionBox();
    pushHistory();
  }

  /** Figma: Distribute spacing — 首尾元素位置不变，中间元素等距排布 */
  function distributeSelection(axis) {
    if (state.selected.length < 3) {
      showToast("等距分布至少需要 3 个元素");
      return;
    }
    const items = state.selected.map((el) => ({ el, r: el.getBoundingClientRect() }));
    if (axis === "h") {
      items.sort((a, b) => a.r.left - b.r.left);
      const first = items[0];
      const last = items[items.length - 1];
      const totalWidth = items.reduce((sum, { r }) => sum + r.width, 0);
      const span = last.r.right - first.r.left;
      const gap = (span - totalWidth) / (items.length - 1);
      let cursor = first.r.right + gap;
      for (let i = 1; i < items.length - 1; i++) {
        const { el, r } = items[i];
        translateElement(el, cursor - r.left, 0);
        cursor += r.width + gap;
      }
    } else {
      items.sort((a, b) => a.r.top - b.r.top);
      const first = items[0];
      const last = items[items.length - 1];
      const totalHeight = items.reduce((sum, { r }) => sum + r.height, 0);
      const span = last.r.bottom - first.r.top;
      const gap = (span - totalHeight) / (items.length - 1);
      let cursor = first.r.bottom + gap;
      for (let i = 1; i < items.length - 1; i++) {
        const { el, r } = items[i];
        translateElement(el, 0, cursor - r.top);
        cursor += r.height + gap;
      }
    }
    scheduleSelectionBox();
    pushHistory();
  }

  function applyLayoutAction(mode, scope) {
    if (mode === "distribute-h") distributeSelection("h");
    else if (mode === "distribute-v") distributeSelection("v");
    else alignSelection(mode, scope);
  }

  function ensureResizable(el) {
    if (getComputedStyle(el).display === "inline") el.style.display = "inline-block";
  }

  function duplicateSelection() {
    if (state.selected.length === 0) return;
    const duplicable = state.selected.filter((el) => !isElementLocked(el));
    if (duplicable.length === 0) {
      showToast("选中元素已锁定·请先解锁");
      return;
    }
    const newSelection = [];
    duplicable.forEach((el) => {
      const clone = el.cloneNode(true);
      // 偏移 10px 以便肉眼识别
      const t = parseTransform(el);
      applyTransform(clone, t.x + 10, t.y + 10);
      el.parentElement.appendChild(clone);
      newSelection.push(clone);
    });
    setSelection(newSelection);
    pushHistory();
    showToast(`已克隆 ${newSelection.length} 个元素`);
  }

  function cloneSelectionForAltDrag() {
    const selected = state.selected.filter((el) => el?.isConnected && !isElementLocked(el));
    const sources = selected.filter(
      (el) => !selected.some((candidate) => candidate !== el && candidate.contains(el)),
    );
    if (sources.length === 0) return [];

    const groupIds = new Map();
    const cloneMap = new Map();
    const cloneGroupIds = (root) => {
      [root, ...root.querySelectorAll("[data-h5ve-group-id]")].forEach((node) => {
        const id = node.dataset?.h5veGroupId;
        if (!id) return;
        if (!groupIds.has(id)) {
          groupIds.set(id, `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
        }
        node.dataset.h5veGroupId = groupIds.get(id);
      });
    };

    sources.forEach((source) => {
      const clone = source.cloneNode(true);
      clone.querySelectorAll("[data-h5ve-selected],[data-h5ve-editing]").forEach((node) => {
        delete node.dataset.h5veSelected;
        delete node.dataset.h5veEditing;
        node.removeAttribute("contenteditable");
      });
      delete clone.dataset.h5veSelected;
      delete clone.dataset.h5veEditing;
      clone.removeAttribute("contenteditable");
      cloneGroupIds(clone);
      source.after(clone);
      cloneMap.set(source, clone);
    });

    const clones = sources.map((source) => cloneMap.get(source)).filter(Boolean);
    const primary = cloneMap.get(state.primary) || clones[clones.length - 1] || null;
    setSelection(clones, primary);
    renderElementPanel();
    return collectGroupMembers(clones).filter((el) => !isElementLocked(el));
  }

  let localClipboard = null;
  function selectionClipboardHtml() {
    if (!localClipboard?.length) return "";
    return `<div data-h5ve-clipboard="1">${localClipboard.map((item) => item.html).join("")}</div>`;
  }

  const CLIPBOARD_HTML_LIMIT = 1024 * 1024;
  const CLIPBOARD_ELEMENT_LIMIT = 5000;
  const BLOCKED_CLIPBOARD_ELEMENTS = "script, style, iframe, object, embed, link, meta, base, form";
  const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction", "poster"]);

  function unsafeClipboardUrl(value) {
    const normalized = String(value || "").replace(/[\u0000-\u0020]+/g, "").toLowerCase();
    return /^(?:javascript|vbscript):/.test(normalized) || /^data:(?:text\/html|application\/xhtml\+xml)/.test(normalized);
  }

  function safeEditableHref(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "#";
    const normalized = trimmed.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
    if (/^(?:javascript|vbscript|data|file|blob):/.test(normalized)) return null;
    const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
    if (scheme && !["http", "https", "mailto", "tel"].includes(scheme)) return null;
    return trimmed;
  }

  function sanitizeClipboardElement(root) {
    if (!root || root.matches(BLOCKED_CLIPBOARD_ELEMENTS)) return null;
    root.querySelectorAll(BLOCKED_CLIPBOARD_ELEMENTS).forEach((node) => node.remove());
    [root, ...root.querySelectorAll("*")].forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") {
          node.removeAttribute(attribute.name);
          return;
        }
        if (URL_ATTRIBUTES.has(name) && unsafeClipboardUrl(attribute.value)) {
          node.removeAttribute(attribute.name);
        }
      });
      const inlineStyle = node.getAttribute("style") || "";
      if (/(?:-moz-binding|\bbehavior\s*:|url\s*\(\s*['"]?\s*(?:javascript|data:text\/html))/i.test(inlineStyle)) {
        node.removeAttribute("style");
      }
      node.removeAttribute("data-h5ve-selected");
      node.removeAttribute("data-h5ve-editing");
      node.removeAttribute("contenteditable");
    });
    return root;
  }

  function restoreLocalClipboardFromHtml(html) {
    if (!html?.includes?.("data-h5ve-clipboard") || html.length > CLIPBOARD_HTML_LIMIT) return false;
    const template = document.createElement("template");
    template.innerHTML = html;
    if (template.content.querySelectorAll("*").length > CLIPBOARD_ELEMENT_LIMIT) return false;
    const wrapper = template.content.querySelector('[data-h5ve-clipboard="1"]');
    if (!wrapper) return false;
    localClipboard = [...wrapper.children]
      .map(sanitizeClipboardElement)
      .filter(Boolean)
      .map((el) => ({
        html: el.outerHTML,
        style: {
          left: el.style.left,
          top: el.style.top,
          width: el.style.width,
          height: el.style.height,
          transform: el.style.transform,
        },
      }));
    return localClipboard.length > 0;
  }

  function writeSelectionToSystemClipboard() {
    const html = selectionClipboardHtml();
    if (!html || !navigator.clipboard) return;
    const plain = state.selected.map((el) => elementLayerName(el)).join("\n");
    if (navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
      navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      })]).catch(() => {});
    } else if (navigator.clipboard.writeText) {
      navigator.clipboard.writeText(plain).catch(() => {});
    }
  }

  function copySelection(options = {}) {
    if (state.selected.length === 0) return;
    localClipboard = state.selected.map(el => ({
      html: el.outerHTML,
      // 记录相对父容器的原始位置
      style: {
        left: el.style.left,
        top: el.style.top,
        width: el.style.width,
        height: el.style.height,
        transform: el.style.transform
      }
    }));
    if (options.writeSystem) writeSelectionToSystemClipboard();
    updateContextMenuState();
    showToast(`已复制 ${localClipboard.length} 个元素`);
  }

  function pasteToCurrentSlide() {
    if (!localClipboard) return;
    const slide = currentSlide();
    if (!slide) return;
    const newSelection = [];

    localClipboard.forEach(item => {
      const template = document.createElement("template");
      template.innerHTML = item.html;
      const el = sanitizeClipboardElement(template.content.firstElementChild);
      if (!el) return;
      // 稍微偏移一点或保持原位（取决于用户是否在同一页）
      slide.appendChild(el);
      newSelection.push(el);
    });

    setSelection(newSelection);
    pushHistory();
    showToast(`已粘贴 ${newSelection.length} 个元素`);
  }

  function hasImageTransfer(dataTransfer) {
    if (!dataTransfer) return false;
    return [...(dataTransfer.items || [])].some((item) => item.kind === "file" && item.type.startsWith("image/")) ||
      [...(dataTransfer.files || [])].some((file) => file.type.startsWith("image/")) ||
      [...(dataTransfer.types || [])].some((type) => type === "text/uri-list" || type === "text/html");
  }

  function imageSourceFromTransfer(dataTransfer) {
    if (!dataTransfer) return null;
    const html = dataTransfer.getData?.("text/html") || "";
    if (html) {
      const temp = document.createElement("div");
      temp.innerHTML = html;
      const source = temp.querySelector("img")?.getAttribute("src");
      if (source) return source.startsWith("data:") || source.startsWith("blob:") ? source : new URL(source, location.href).href;
    }
    const uri = (dataTransfer.getData?.("text/uri-list") || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    if (!uri) return null;
    try {
      const resolved = new URL(uri, location.href);
      if (resolved.protocol === "data:" && !resolved.href.startsWith("data:image/")) return null;
      if (!["http:", "https:", "data:", "blob:"].includes(resolved.protocol)) return null;
      return resolved.href;
    } catch {
      return null;
    }
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("无法读取图片"));
      reader.readAsDataURL(file);
    });
  }

  function loadImageSize(src) {
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.onload = () => resolve({ width: probe.naturalWidth || 1, height: probe.naturalHeight || 1 });
      probe.onerror = () => reject(new Error("图片格式无法识别"));
      probe.src = src;
    });
  }

  function imageInsertPoint(clientPoint) {
    const slide = currentSlide();
    const rect = slide?.getBoundingClientRect();
    if (!slide || !rect || rect.width <= 0 || rect.height <= 0) return null;
    const inside = clientPoint &&
      clientPoint.x >= rect.left && clientPoint.x <= rect.right &&
      clientPoint.y >= rect.top && clientPoint.y <= rect.bottom;
    return {
      slide,
      rect,
      x: inside ? clientPoint.x : rect.left + rect.width / 2,
      y: inside ? clientPoint.y : rect.top + rect.height / 2,
    };
  }

  function nextLayerZIndex(parent) {
    const values = [...parent.children].map((el) => Number(getComputedStyle(el).zIndex)).filter(Number.isFinite);
    return Math.max(0, ...values) + 1;
  }

  async function insertImageSource(src, name, clientPoint) {
    const point = imageInsertPoint(clientPoint);
    if (!point) {
      showToast("未找到当前幻灯片，无法添加图片");
      return null;
    }
    const intrinsic = await loadImageSize(src);
    const { slide, rect } = point;
    if (getComputedStyle(slide).position === "static") slide.style.position = "relative";
    const scaleX = slide.offsetWidth > 0 ? rect.width / slide.offsetWidth : state.scale || 1;
    const scaleY = slide.offsetHeight > 0 ? rect.height / slide.offsetHeight : state.scale || 1;
    const localWidth = rect.width / Math.max(scaleX, 0.001);
    const localHeight = rect.height / Math.max(scaleY, 0.001);
    const maxWidth = Math.min(520, localWidth * 0.36);
    const maxHeight = Math.min(420, localHeight * 0.46);
    const fit = Math.min(maxWidth / intrinsic.width, maxHeight / intrinsic.height, 1);
    const width = Math.max(48, intrinsic.width * fit);
    const height = Math.max(48, intrinsic.height * fit);
    const centerX = (point.x - rect.left) / Math.max(scaleX, 0.001);
    const centerY = (point.y - rect.top) / Math.max(scaleY, 0.001);

    const image = document.createElement("img");
    image.src = src;
    image.alt = name || "插入图片";
    image.draggable = false;
    image.setAttribute("data-h5ve-layer-name", (name || "图片").replace(/\.[^.]+$/, "").slice(0, 48));
    image.style.position = "absolute";
    image.style.left = `${Math.max(0, Math.min(localWidth - width, centerX - width / 2))}px`;
    image.style.top = `${Math.max(0, Math.min(localHeight - height, centerY - height / 2))}px`;
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.style.objectFit = "contain";
    image.style.zIndex = String(nextLayerZIndex(slide));
    image.style.margin = "0";
    slide.appendChild(image);
    selectSingle(image);
    pushHistory();
    renderElementPanel();
    scheduleSelectionBox();
    showToast(`已添加图片「${elementLayerName(image)}」· 可直接拖动和缩放`);
    return image;
  }

  async function insertImageFile(file, clientPoint) {
    if (!file?.type?.startsWith("image/")) return null;
    if (file.size > 20 * 1024 * 1024) {
      showToast("图片超过 20MB，请压缩后再添加");
      return null;
    }
    try {
      const src = await readImageFile(file);
      return await insertImageSource(src, file.name || "剪贴板图片", clientPoint);
    } catch (error) {
      showToast(`添加图片失败：${error.message}`);
      return null;
    }
  }

  function showImageDropTarget() {
    const rect = currentSlide()?.getBoundingClientRect();
    if (!imageDropOverlay || !rect || rect.width <= 0 || rect.height <= 0) return;
    imageDropOverlay.hidden = false;
    imageDropOverlay.style.left = `${rect.left}px`;
    imageDropOverlay.style.top = `${rect.top}px`;
    imageDropOverlay.style.width = `${rect.width}px`;
    imageDropOverlay.style.height = `${rect.height}px`;
  }

  function hideImageDropTarget() {
    if (imageDropOverlay) imageDropOverlay.hidden = true;
  }

  function renamePrimaryLayer() {
    if (!elementsPanel || state.selected.length !== 1 || !state.primary || isElementLocked(state.primary)) return;
    const row = [...elementsPanel.querySelectorAll(".h5ve-element-item")].find(
      (candidate) => candidate.__h5veElement === state.primary,
    );
    if (row) startLayerRename(row, state.primary);
  }

  function setSelectionLocked(locked) {
    const items = state.selected.filter((el) => el instanceof Element);
    if (!items.length) return;
    items.forEach((el) => {
      if (locked) el.dataset.h5veLocked = "true";
      else delete el.dataset.h5veLocked;
    });
    pushHistory();
    renderElementPanel();
    if (state.primary) fillPanel(state.primary);
    scheduleSelectionBox();
    showToast(`${locked ? "已锁定" : "已解锁"} ${items.length} 个元素`);
  }

  function setSelectionHidden(hidden) {
    const items = state.selected.filter((el) => el instanceof Element);
    if (!items.length) return;
    items.forEach((el) => {
      if (hidden) {
        el.dataset.h5vePreviousVisibility = el.style.visibility || "";
        el.dataset.h5veHidden = "true";
        el.style.visibility = "hidden";
      } else {
        const previous = el.dataset.h5vePreviousVisibility;
        if (previous) el.style.visibility = previous;
        else el.style.removeProperty("visibility");
        delete el.dataset.h5vePreviousVisibility;
        delete el.dataset.h5veHidden;
      }
    });
    if (hidden) selectSingle(null);
    pushHistory();
    renderElementPanel();
    scheduleSelectionBox();
    showToast(`${hidden ? "已隐藏" : "已显示"} ${items.length} 个元素 · 可撤销`);
  }

  function closeContextMenu() {
    if (!contextMenu) return;
    contextMenu.hidden = true;
  }

  function updateContextMenuState() {
    if (!contextMenu) return;
    const selected = state.selected.filter((el) => el?.isConnected);
    const one = selected.length === 1;
    const movable = selected.some((el) => !isElementLocked(el));
    const allLocked = selected.length > 0 && selected.every(isElementExplicitlyLocked);
    const allHidden = selected.length > 0 && selected.every(isElementExplicitlyHidden);
    const setDisabled = (action, disabled) => {
      const button = contextMenu.querySelector(`[data-context-action="${action}"]`);
      if (button) button.disabled = disabled;
    };
    ["copy", "cut", "duplicate", "delete", "front", "forward", "backward", "back", "lock", "visibility", "ungroup"]
      .forEach((action) => setDisabled(action, selected.length === 0));
    setDisabled("cut", !movable);
    setDisabled("duplicate", !movable);
    setDisabled("delete", !movable);
    ["front", "forward", "backward", "back"].forEach((action) => setDisabled(action, !movable));
    setDisabled("rename", !one || isElementLocked(selected[0]));
    setDisabled("group", selected.length < 2 || !movable);
    setDisabled("paste", !localClipboard);
    const lock = contextMenu.querySelector('[data-context-action="lock"] .h5ve-context-label');
    const visibility = contextMenu.querySelector('[data-context-action="visibility"] .h5ve-context-label');
    if (lock) lock.textContent = allLocked ? "解锁" : selected.length > 1 ? "锁定选中" : "锁定";
    if (visibility) visibility.textContent = allHidden ? "显示" : selected.length > 1 ? "隐藏选中" : "隐藏";
  }

  function openContextMenu(x, y) {
    if (!contextMenu) return;
    updateContextMenuState();
    contextMenu.hidden = false;
    contextMenu.style.left = "0px";
    contextMenu.style.top = "0px";
    requestAnimationFrame(() => {
      const rect = contextMenu.getBoundingClientRect();
      contextMenu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
      contextMenu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
      contextMenu.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    });
  }

  function runContextAction(action) {
    if (action === "copy") copySelection({ writeSystem: true });
    else if (action === "cut") {
      copySelection({ writeSystem: true });
      deleteSelected();
    } else if (action === "paste") pasteToCurrentSlide();
    else if (action === "duplicate") duplicateSelection();
    else if (action === "rename") renamePrimaryLayer();
    else if (action === "group") groupSelection();
    else if (action === "ungroup") ungroupSelection();
    else if (["front", "forward", "backward", "back"].includes(action)) moveSelectionDepth(action);
    else if (action === "lock") setSelectionLocked(!state.selected.every(isElementExplicitlyLocked));
    else if (action === "visibility") setSelectionHidden(!state.selected.every(isElementExplicitlyHidden));
    else if (action === "delete") deleteSelected();
    else if (action === "add-text") addNewTextElement();
  }

  function moveSelectionDepth(direction) {
    const movable = collectGroupMembers(state.selected).filter((el) => !isElementLocked(el));
    if (movable.length === 0) {
      if (state.selected.length) showToast("选中元素已锁定·请先解锁");
      return;
    }
    const byParent = new Map();
    movable.forEach((el) => {
      const parent = el.parentElement;
      if (!parent) return;
      if (!byParent.has(parent)) byParent.set(parent, new Set());
      byParent.get(parent).add(el);
    });
    byParent.forEach((selectedSet, parent) => {
      const siblings = [...parent.children].filter(
        (el) => el instanceof Element && !isStructuralChrome(el),
      );
      const domIndex = new Map(siblings.map((el, index) => [el, index]));
      const effectiveZ = (el) => {
        const raw = getComputedStyle(el).zIndex;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : domIndex.get(el) || 0;
      };
      let ordered = siblings.slice().sort((a, b) => effectiveZ(a) - effectiveZ(b) || domIndex.get(a) - domIndex.get(b));
      if (direction === "forward") {
        for (let i = ordered.length - 2; i >= 0; i--) {
          if (selectedSet.has(ordered[i]) && !selectedSet.has(ordered[i + 1])) {
            [ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]];
          }
        }
      } else if (direction === "backward") {
        for (let i = 1; i < ordered.length; i++) {
          if (selectedSet.has(ordered[i]) && !selectedSet.has(ordered[i - 1])) {
            [ordered[i], ordered[i - 1]] = [ordered[i - 1], ordered[i]];
          }
        }
      } else if (direction === "front") {
        ordered = [...ordered.filter((el) => !selectedSet.has(el)), ...ordered.filter((el) => selectedSet.has(el))];
      } else if (direction === "back") {
        ordered = [...ordered.filter((el) => selectedSet.has(el)), ...ordered.filter((el) => !selectedSet.has(el))];
      }
      ordered.forEach((el, index) => {
        if (el instanceof HTMLElement && getComputedStyle(el).position === "static") {
          el.style.position = "relative";
        }
        el.style.zIndex = String(index + 1);
      });
    });
    updateSelectionBoxes();
    pushHistory();
    renderElementPanel();
    const label = direction === "front" ? "已置于顶层" : direction === "back" ? "已置于底层" : direction === "forward" ? "已上移一层" : "已下移一层";
    showToast(`${label}·位置不变`);
  }

  function getMediaAspectRatio(el, fallbackW, fallbackH) {
    const media = findPrimaryMedia(el);
    if (!media || !["IMG", "VIDEO"].includes(media.tagName)) return null;
    const intrinsic = getMediaIntrinsicSize(media);
    if (intrinsic?.width > 0 && intrinsic?.height > 0) return intrinsic.width / intrinsic.height;
    return fallbackW > 0 && fallbackH > 0 ? fallbackW / fallbackH : null;
  }

  function syncPanelGeometry(el) {
    if (!el || el !== state.primary) return;
    const t = parseTransform(el);
    if (panelFields.x) panelFields.x.value = Math.round(t.x);
    if (panelFields.y) panelFields.y.value = Math.round(t.y);
    const cs = getComputedStyle(el);
    if (panelFields.w) panelFields.w.value = Math.round(parseFloat(cs.width) || 0);
    if (panelFields.h) panelFields.h.value = Math.round(parseFloat(cs.height) || 0);
    if (panelFields.rotation) panelFields.rotation.value = String(Math.round(parseRotation(el) * 10) / 10);
  }

  function startRotate(event) {
    const el = state.primary;
    const targets = state.selected.filter((item) => item?.isConnected && !isElementHidden(item));
    if (!el || targets.length === 0 || targets.some(isElementLocked)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = targets.length > 1 ? selectionViewportBounds(targets) : getSelectableVisualRect(el);
    if (!rect) return;
    state.rotating = true;
    state.rotateCenter = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    state.rotateStartAngle = Math.atan2(
      event.clientY - state.rotateCenter.y,
      event.clientX - state.rotateCenter.x,
    );
    state.rotateBaseAngle = targets.length > 1 ? 0 : parseRotation(el);
    state.rotateItems =
      targets.length > 1
        ? targets.map((item) => {
            const itemRect = getSelectableVisualRect(item);
            return {
              el: item,
              centerX: itemRect.left + itemRect.width / 2,
              centerY: itemRect.top + itemRect.height / 2,
              rotation: parseRotation(item),
              ...parseTransform(item),
            };
          })
        : [];
    document.documentElement.classList.add("h5ve-rotating");
    document.body.style.userSelect = "none";
  }

  function performRotate(event) {
    const el = state.primary;
    if (!state.rotating || !el) return;
    const pointerAngle = Math.atan2(
      event.clientY - state.rotateCenter.y,
      event.clientX - state.rotateCenter.x,
    );
    let delta = ((pointerAngle - state.rotateStartAngle) * 180) / Math.PI;
    if (state.rotateItems.length > 0) {
      if (event.shiftKey) delta = Math.round(delta / 15) * 15;
      const radians = (delta * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      state.rotateItems.forEach((item) => {
        applyRotation(item.el, item.rotation);
        applyTransform(item.el, item.x, item.y);
        const current = getSelectableVisualRect(item.el);
        const offsetX = item.centerX - state.rotateCenter.x;
        const offsetY = item.centerY - state.rotateCenter.y;
        const desiredCenterX = state.rotateCenter.x + offsetX * cos - offsetY * sin;
        const desiredCenterY = state.rotateCenter.y + offsetX * sin + offsetY * cos;
        applyRotation(item.el, item.rotation + delta);
        const rotated = getSelectableVisualRect(item.el);
        const currentCenterX = rotated.left + rotated.width / 2;
        const currentCenterY = rotated.top + rotated.height / 2;
        applyTransform(
          item.el,
          item.x + (desiredCenterX - currentCenterX) / state.scale,
          item.y + (desiredCenterY - currentCenterY) / state.scale,
        );
      });
    } else {
      let angle = state.rotateBaseAngle + delta;
      if (event.shiftKey) angle = Math.round(angle / 15) * 15;
      angle = normalizeRotation(angle);
      applyRotation(el, angle);
      if (panelFields.rotation) panelFields.rotation.value = String(Math.round(angle * 10) / 10);
    }
    scheduleSelectionBox();
  }

  function startResize(e, dir) {
    const el = state.primary;
    const targets = state.selected.filter((item) => item?.isConnected && !isElementHidden(item));
    if (!el || targets.length === 0 || targets.some(isElementLocked)) return;
    e.preventDefault();
    e.stopPropagation();
    if (targets.length > 1) {
      const group = selectionViewportBounds(targets);
      if (!group || group.width <= 0 || group.height <= 0) return;
      targets.forEach((item) => {
        ensureResizable(item);
      });
      state.resizing = true;
      state.resizeDir = dir;
      state.resizeStart = { x: e.clientX, y: e.clientY };
      state.resizeBase = {
        multi: true,
        group,
        items: targets.map((item) => {
          const rect = getSelectableVisualRect(item);
          const style = getComputedStyle(item);
          return {
            el: item,
            rect,
            width: parseFloat(style.width) || item.offsetWidth,
            height: parseFloat(style.height) || item.offsetHeight,
            ...parseTransform(item),
          };
        }),
      };
      document.body.style.userSelect = "none";
      return;
    }
    ensureResizable(el);
    if ((dir.includes("e") || dir.includes("w")) && canUseWidthMode(el)) freezeFrameDimension(el, "width");
    if ((dir.includes("n") || dir.includes("s")) && canUseHeightMode(el)) freezeFrameDimension(el, "height");
    const cs = getComputedStyle(el);
    state.resizing = true;
    state.resizeDir = dir;
    state.resizeStart = { x: e.clientX, y: e.clientY };
    const w = parseFloat(cs.width) || el.offsetWidth;
    const h = parseFloat(cs.height) || el.offsetHeight;
    state.resizeBase = {
      w,
      h,
      aspect: elementAspectRatio(el, w, h),
      aspectLocked: isAspectLocked(el),
      ...parseTransform(el),
    };
    document.body.style.userSelect = "none";
  }

  function performMultiResize(event, base, dir) {
    const group = base.group;
    const dx = event.clientX - state.resizeStart.x;
    const dy = event.clientY - state.resizeStart.y;
    const minimum = Math.max(12, 20 * state.scale);
    let left = group.left;
    let top = group.top;
    let right = group.right;
    let bottom = group.bottom;

    if (dir.includes("e")) right = Math.max(left + minimum, group.right + dx);
    if (dir.includes("w")) left = Math.min(right - minimum, group.left + dx);
    if (dir.includes("s")) bottom = Math.max(top + minimum, group.bottom + dy);
    if (dir.includes("n")) top = Math.min(bottom - minimum, group.top + dy);

    let width = right - left;
    let height = bottom - top;
    if (event.shiftKey) {
      const ratio = group.width / group.height;
      const hasX = dir.includes("e") || dir.includes("w");
      const hasY = dir.includes("n") || dir.includes("s");
      if (hasX && hasY) {
        const widthScale = width / group.width;
        const heightScale = height / group.height;
        if (Math.abs(widthScale - 1) >= Math.abs(heightScale - 1)) height = width / ratio;
        else width = height * ratio;
      } else if (hasX) height = width / ratio;
      else if (hasY) width = height * ratio;
      if (dir.includes("w")) left = right - width;
      else right = left + width;
      if (dir.includes("n")) top = bottom - height;
      else bottom = top + height;
    }

    const scaleX = width / group.width;
    const scaleY = height / group.height;
    const hasX = dir.includes("e") || dir.includes("w");
    const hasY = dir.includes("n") || dir.includes("s");
    const shouldWriteWidth = hasX || (event.shiftKey && hasY);
    const shouldWriteHeight = hasY || (event.shiftKey && hasX);
    base.items.forEach((item) => {
      const relativeCenterX = item.rect.left + item.rect.width / 2 - group.left;
      const relativeCenterY = item.rect.top + item.rect.height / 2 - group.top;
      const desiredCenterX = left + relativeCenterX * scaleX;
      const desiredCenterY = top + relativeCenterY * scaleY;
      applyTransform(item.el, item.x, item.y);
      if (shouldWriteWidth) {
        const nextWidth = Math.max(1, item.width * scaleX);
        if (canUseWidthMode(item.el)) setFrameDimensionFixedValue(item.el, "width", nextWidth);
        else item.el.style.width = `${nextWidth}px`;
      }
      if (shouldWriteHeight) {
        const nextHeight = Math.max(1, item.height * scaleY);
        if (canUseHeightMode(item.el)) setFrameDimensionFixedValue(item.el, "height", nextHeight);
        else item.el.style.height = `${nextHeight}px`;
      }
      const current = getSelectableVisualRect(item.el);
      const currentCenterX = current.left + current.width / 2;
      const currentCenterY = current.top + current.height / 2;
      applyTransform(
        item.el,
        item.x + (desiredCenterX - currentCenterX) / state.scale,
        item.y + (desiredCenterY - currentCenterY) / state.scale,
      );
    });
    scheduleSelectionBox();
  }

  function performResize(e) {
    const el = state.primary;
    if (!el || !state.resizeBase) return;
    const dir = state.resizeDir;
    const base = state.resizeBase;
    if (base.multi) {
      performMultiResize(e, base, dir);
      return;
    }
    const dx = (e.clientX - state.resizeStart.x) / state.scale;
    const dy = (e.clientY - state.resizeStart.y) / state.scale;
    const MIN_W = 20;
    const MIN_H = 16;
    const hasX = dir.includes("e") || dir.includes("w");
    const hasY = dir.includes("s") || dir.includes("n");
    let nextW = base.w;
    let nextH = base.h;

    if (dir.includes("e")) nextW = base.w + dx;
    else if (dir.includes("w")) nextW = base.w - dx;
    if (dir.includes("s")) nextH = base.h + dy;
    else if (dir.includes("n")) nextH = base.h - dy;

    nextW = Math.max(MIN_W, nextW);
    nextH = Math.max(MIN_H, nextH);

    const preserveAspect = !!base.aspect && (base.aspectLocked ? !e.shiftKey : e.shiftKey);
    if (preserveAspect && hasX) {
      if (hasY) {
        const scaleFromW = nextW / base.w;
        const scaleFromH = nextH / base.h;
        const scale = Math.abs(scaleFromW - 1) >= Math.abs(scaleFromH - 1) ? scaleFromW : scaleFromH;
        nextW = Math.max(MIN_W, base.w * scale);
        nextH = nextW / base.aspect;
      } else {
        nextH = nextW / base.aspect;
      }
      if (nextH < MIN_H) {
        nextH = MIN_H;
        nextW = nextH * base.aspect;
      }
    } else if (preserveAspect && base.aspect && hasY) {
      nextW = nextH * base.aspect;
      if (nextW < MIN_W) {
        nextW = MIN_W;
        nextH = nextW / base.aspect;
      }
    }

    const shouldWriteWidth = hasX || (preserveAspect && hasY);
    const shouldWriteHeight = hasY || (preserveAspect && hasX);
    if (shouldWriteWidth && canUseWidthMode(el) && frameDimensionMode(el, "width") !== "fixed") {
      freezeFrameDimension(el, "width");
    }
    if (shouldWriteHeight && canUseHeightMode(el) && frameDimensionMode(el, "height") !== "fixed") {
      freezeFrameDimension(el, "height");
    }
    const tx = dir.includes("w") ? base.x + (base.w - nextW) : base.x;
    const ty = dir.includes("n") ? base.y + (base.h - nextH) : base.y;
    if (shouldWriteWidth) setManagedSizeStyle(el, "width", `${nextW}px`);
    if (shouldWriteHeight) setManagedSizeStyle(el, "height", `${nextH}px`);
    if (tx !== base.x || ty !== base.y) applyTransform(el, tx, ty);
    syncPanelGeometry(el);
    scheduleSelectionBox();
  }

  function placeCaretAtPointOrEnd(el, clientX, clientY) {
    const sel = window.getSelection();
    if (!sel) return;
    let range = null;

    if (Number.isFinite(clientX) && Number.isFinite(clientY)) {
      if (typeof document.caretPositionFromPoint === "function") {
        const pos = document.caretPositionFromPoint(clientX, clientY);
        if (pos?.offsetNode && (pos.offsetNode === el || el.contains(pos.offsetNode))) {
          range = document.createRange();
          range.setStart(pos.offsetNode, pos.offset);
          range.collapse(true);
        }
      } else if (typeof document.caretRangeFromPoint === "function") {
        const pointRange = document.caretRangeFromPoint(clientX, clientY);
        if (pointRange && (pointRange.startContainer === el || el.contains(pointRange.startContainer))) {
          range = pointRange;
          range.collapse(true);
        }
      }
    }

    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function startTextEdit(el, pointerEvent) {
    if (!el || !canEditText(el) || isElementLocked(el) || isElementHidden(el)) return;
    if (el.dataset.h5veEditing === "true") {
      el.focus({ preventScroll: true });
      placeCaretAtPointOrEnd(el, pointerEvent?.clientX, pointerEvent?.clientY);
      return;
    }
    originalContentEditable.set(el, el.getAttribute("contenteditable"));
    el.dataset.h5veEditing = "true";
    el.contentEditable = "true";
    document.documentElement.classList.add("h5ve-text-editing");
    el.focus({ preventScroll: true });
    placeCaretAtPointOrEnd(el, pointerEvent?.clientX, pointerEvent?.clientY);
    showToast("画布内文字编辑 · Esc 完成");
  }

  function endTextEdit(el) {
    if (!el || el.dataset.h5veEditing !== "true") return;
    const previous = originalContentEditable.get(el);
    if (previous == null) el.removeAttribute("contenteditable");
    else el.setAttribute("contenteditable", previous);
    originalContentEditable.delete(el);
    delete el.dataset.h5veEditing;
    if (!document.querySelector("[data-h5ve-editing='true']")) {
      document.documentElement.classList.remove("h5ve-text-editing");
    }
    fillPanel(state.primary);
    scheduleSelectionBox();
    pushHistory();
    renderElementPanel();
  }

  function serializeDocument() {
    const clone = document.documentElement.cloneNode(true);
    const initialHost = state.initialHostState || {};
    const restoreAttribute = (element, name, value) => {
      if (!element) return;
      if (value == null) element.removeAttribute(name);
      else element.setAttribute(name, value);
    };
    clone
      .querySelectorAll(
        ".h5ve-root, .h5ve-marquee, .h5ve-selection, .h5ve-handle, .h5ve-toast, " +
          "[data-h5ve-runtime], link[href*='h5-editor/editor.css']",
      )
      .forEach((n) => n.remove());
    clone.querySelectorAll("script[src*='h5-editor/editor.js']").forEach((n) => n.remove());
    clone.querySelectorAll("script[data-h5ve-migration-guard]").forEach((n) => n.remove());
    const nav = clone.querySelector("[data-h5ve-slide-nav]");
    if (nav && initialHost.navHtml != null) nav.innerHTML = initialHost.navHtml;
    syncSlideChromeNumbers(clone);
    const deck = clone.querySelector("#deck");
    if (deck) {
      restoreAttribute(deck, "style", initialHost.deckStyle);
      delete deck.dataset.h5veSlideW;
    }
    const stage = clone.querySelector("#stage");
    if (stage) {
      restoreAttribute(stage, "style", initialHost.stageStyle);
      stage.dataset.h5veWidth = String(state.designWidth);
      stage.dataset.h5veHeight = String(state.designHeight);
    }
    const liveEditing = [...document.querySelectorAll("[data-h5ve-editing='true']")];
    clone.querySelectorAll("[data-h5ve-editing='true']").forEach((n, index) => {
      const previous = originalContentEditable.get(liveEditing[index]);
      if (previous == null) n.removeAttribute("contenteditable");
      else n.setAttribute("contenteditable", previous);
      delete n.dataset.h5veEditing;
    });
    clone.querySelectorAll("[data-h5ve-selected]").forEach((n) => {
      delete n.dataset.h5veSelected;
    });
    clone.querySelectorAll(".h5ve-current-slide").forEach((n) => {
      n.classList.remove("h5ve-current-slide");
      if (!n.getAttribute("class")) n.removeAttribute("class");
    });
    clone.querySelectorAll(".h5ve-continuous-fixed").forEach((n) => {
      n.classList.remove("h5ve-continuous-fixed");
      if (!n.getAttribute("class")) n.removeAttribute("class");
    });
    clone.querySelectorAll("[style]").forEach((n) => {
      const managedTransform = n.style.getPropertyValue("--h5ve-force-transform").trim();
      n.style.removeProperty("--h5ve-force-transform");
      if (
        managedTransform &&
        /^translate\(0(?:px)?,\s*0(?:px)?\)$/i.test(n.style.getPropertyValue("transform").trim())
      ) {
        n.style.removeProperty("transform");
      }
      if (!n.getAttribute("style")) n.removeAttribute("style");
    });
    restoreAttribute(clone, "class", initialHost.htmlClass);
    restoreAttribute(clone, "style", initialHost.htmlStyle);
    const body = clone.querySelector("body");
    restoreAttribute(body, "class", initialHost.bodyClass);
    restoreAttribute(body, "style", initialHost.bodyStyle);
    clone.querySelectorAll("[data-h5ve-anim-original]").forEach((node) => {
      node.setAttribute("data-anim", node.getAttribute("data-h5ve-anim-original") || "");
      node.removeAttribute("data-h5ve-anim-original");
    });
    return "<!DOCTYPE html>\n" + clone.outerHTML;
  }

  function previewUrl() {
    const url = new URL(location.href);
    if (/\/edit\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/edit\/?$/, "") || "/";
    } else {
      url.searchParams.delete("edit");
    }
    return url.toString();
  }

  function exitEditor(event) {
    event?.preventDefault();
    safeStorageRemove("h5ve-enabled");
    location.assign(previewUrl());
  }

  async function saveToDisk(options = {}) {
    const silent = options.silent === true;
    const quiet = options.quiet === true;
    if (quiet && autoSaveInFlight) {
      autoSavePending = true;
      return true;
    }
    autoSaveInFlight = true;
    autoSavePending = false;
    showAutoSaveStatus(false);
    const html = serializeDocument();
    const path = canonicalDocumentPath();
    try {
      if (state.revisionPromise) await state.revisionPromise;
      const res = await fetch(SAVE_ENDPOINT_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, html, revision: state.revision || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = new Error(data.error || res.statusText);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      state.revision = data.revision || state.revision;
      if (!silent) pushHistory({ autoSave: false });
      renderSlidePanel();
      clearRecoveryDraft();
      markCurrentHistorySaved();
      showAutoSaveStatus(true);
      if (!quiet) {
        showToast(silent ? `已保存 ${path}` : `已保存 ${path}`);
      }
      return true;
    } catch (err) {
      if (err.status === 409) state.conflictRevision = err.data?.revision || null;
      storeRecoveryDraft(html, err.status === 409 ? "磁盘版本已变化" : err.message);
      showAutoSaveStatus(false, true);
      if (!quiet) {
        downloadHtml(html);
        showToast(
          err.status === 409
            ? "检测到磁盘版本冲突 · 已保留本地草稿并下载备份"
            : `无法写入服务器，已保留草稿并触发下载 (${err.message})`,
        );
      } else {
        showToast(err.status === 409 ? "自动保存暂停：磁盘版本已变化 · 点击红色状态恢复" : `自动保存失败：${err.message}`);
      }
      return false;
    } finally {
      autoSaveInFlight = false;
      if (quiet && autoSavePending) scheduleAutoSave();
    }
  }

  function downloadHtml(html) {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = canonicalDocumentPath().split("/").pop() || "page.html";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  const XLINK_NS = "http://www.w3.org/1999/xlink";

  function svgNode(tag, attrs = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") {
        node.setAttribute(key, String(value));
      }
    });
    return node;
  }

  function svgNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(3));
  }

  function cssPixels(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }

  function colorParts(value) {
    const text = String(value || "").trim();
    if (!text || text === "transparent") return { color: "none", opacity: 0 };
    const rgba = text.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
    if (!rgba) return { color: text, opacity: 1 };
    const color = `rgb(${Math.round(Number(rgba[1]))}, ${Math.round(Number(rgba[2]))}, ${Math.round(Number(rgba[3]))})`;
    const opacity = rgba[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgba[4])));
    return { color, opacity };
  }

  function applySvgColor(node, attribute, value, opacityAttribute = `${attribute}-opacity`) {
    const parts = colorParts(value);
    if (parts.opacity <= 0) return false;
    node.setAttribute(attribute, parts.color);
    if (parts.opacity < 1) node.setAttribute(opacityAttribute, String(svgNumber(parts.opacity)));
    return true;
  }

  function splitCssList(value) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === "(") depth++;
      else if (value[i] === ")") depth--;
      else if (value[i] === "," && depth === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(value.slice(start).trim());
    return parts.filter(Boolean);
  }

  function makeSvgGradient(backgroundImage, defs, nextId) {
    const background = String(backgroundImage || "");
    const radialMatch = background.match(/^radial-gradient\((.*)\)$/i);
    if (radialMatch) {
      const parts = splitCssList(radialMatch[1]);
      if (parts.length < 2) return null;
      let cx = 50;
      let cy = 50;
      const descriptor = parts[0].match(/^(?:circle|ellipse)?(?:\s+at\s+([\d.]+)%\s+([\d.]+)%)$/i);
      if (descriptor) {
        cx = Number(descriptor[1]);
        cy = Number(descriptor[2]);
        parts.shift();
      }
      const id = nextId("radial-gradient");
      const gradient = svgNode("radialGradient", {
        id,
        cx: `${svgNumber(cx)}%`,
        cy: `${svgNumber(cy)}%`,
        r: "100%",
        fx: `${svgNumber(cx)}%`,
        fy: `${svgNumber(cy)}%`,
      });
      parts.forEach((part, index) => {
        const stopMatch = part.match(/^(.*?)(?:\s+(-?[\d.]+%))?$/);
        const stop = svgNode("stop", {
          offset: stopMatch?.[2] || `${svgNumber((index / Math.max(1, parts.length - 1)) * 100)}%`,
        });
        applySvgColor(stop, "stop-color", stopMatch?.[1] || part, "stop-opacity");
        gradient.appendChild(stop);
      });
      defs.appendChild(gradient);
      return `url(#${id})`;
    }
    const match = background.match(/^linear-gradient\((.*)\)$/i);
    if (!match) return null;
    const parts = splitCssList(match[1]);
    if (parts.length < 2) return null;
    let angle = 180;
    const first = parts[0].match(/^(-?[\d.]+)deg$/i);
    if (first) {
      angle = Number(first[1]);
      parts.shift();
    } else if (/^to\s+/i.test(parts[0])) {
      const direction = parts.shift().toLowerCase();
      if (direction.includes("right") && direction.includes("bottom")) angle = 135;
      else if (direction.includes("right") && direction.includes("top")) angle = 45;
      else if (direction.includes("left") && direction.includes("bottom")) angle = 225;
      else if (direction.includes("left") && direction.includes("top")) angle = 315;
      else if (direction.includes("right")) angle = 90;
      else if (direction.includes("left")) angle = 270;
      else if (direction.includes("top")) angle = 0;
    }
    const radians = (angle * Math.PI) / 180;
    const dx = Math.sin(radians) * 50;
    const dy = -Math.cos(radians) * 50;
    const id = nextId("gradient");
    const gradient = svgNode("linearGradient", {
      id,
      x1: `${svgNumber(50 - dx)}%`,
      y1: `${svgNumber(50 - dy)}%`,
      x2: `${svgNumber(50 + dx)}%`,
      y2: `${svgNumber(50 + dy)}%`,
    });
    parts.forEach((part, index) => {
      const stopMatch = part.match(/^(.*?)(?:\s+(-?[\d.]+%))?$/);
      const stop = svgNode("stop", {
        offset: stopMatch?.[2] || `${svgNumber((index / Math.max(1, parts.length - 1)) * 100)}%`,
      });
      applySvgColor(stop, "stop-color", stopMatch?.[1] || part, "stop-opacity");
      gradient.appendChild(stop);
    });
    defs.appendChild(gradient);
    return `url(#${id})`;
  }

  function exportLayerName(el, fallback) {
    const ownText = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.nodeValue || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 28);
    const semantic = el.getAttribute("aria-label") || el.getAttribute("alt") || ownText;
    return (semantic || el.id || el.classList[0] || fallback || el.tagName.toLowerCase()).trim();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
  }

  async function mediaDataUrl(source, cache) {
    if (!source) return null;
    if (/^data:/i.test(source)) return source;
    const absolute = new URL(source, location.href).href;
    if (!cache.has(absolute)) {
      cache.set(
        absolute,
        fetch(absolute)
          .then((res) => {
            if (!res.ok) throw new Error(`素材读取失败：${res.status}`);
            return res.blob();
          })
          .then(blobToDataUrl)
          .catch((error) => {
            throw new Error(`无法内嵌素材 ${absolute}：${error.message}`);
          }),
      );
    }
    return cache.get(absolute);
  }

  function embeddedSvgMarkup(dataUrl) {
    const match = String(dataUrl || "").match(/^data:image\/svg\+xml((?:;[^,]*)?),(.*)$/i);
    if (!match) return null;
    try {
      if (/;base64(?:;|$)/i.test(match[1])) {
        const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
        return new TextDecoder("utf-8").decode(bytes);
      }
      return decodeURIComponent(match[2]);
    } catch {
      return null;
    }
  }

  function videoFrameDataUrl(video) {
    try {
      if (!video.videoWidth || !video.videoHeight) return null;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d").drawImage(video, 0, 0);
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  function canvasDataUrl(canvas) {
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }

  function directTextLines(textNode, stageRect, scaleX, scaleY) {
    const value = textNode.nodeValue || "";
    if (!value.trim()) return [];
    const lines = [];
    let current = null;
    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char === "\r") continue;
      if (char === "\n") {
        current = null;
        continue;
      }
      const range = document.createRange();
      range.setStart(textNode, index);
      range.setEnd(textNode, index + 1);
      const rect = range.getBoundingClientRect();
      range.detach?.();
      if (!rect.width && !rect.height) continue;
      const top = (rect.top - stageRect.top) * scaleY;
      const left = (rect.left - stageRect.left) * scaleX;
      const right = (rect.right - stageRect.left) * scaleX;
      if (!current || Math.abs(current.top - top) > Math.max(1, rect.height * scaleY * 0.25)) {
        current = { text: char, left, right, top };
        lines.push(current);
      } else {
        current.text += char;
        current.left = Math.min(current.left, left);
        current.right = Math.max(current.right, right);
      }
    }
    return lines;
  }

  function inlineSvgStyles(source, clone) {
    const sourceNodes = [source, ...source.querySelectorAll("*")];
    const cloneNodes = [clone, ...clone.querySelectorAll("*")];
    sourceNodes.forEach((node, index) => {
      const target = cloneNodes[index];
      if (!target || !(node instanceof Element)) return;
      const style = getComputedStyle(node);
      [
        ["fill", style.fill],
        ["stroke", style.stroke],
        ["stroke-width", style.strokeWidth],
        ["stroke-linecap", style.strokeLinecap],
        ["stroke-linejoin", style.strokeLinejoin],
        ["opacity", style.opacity],
        ["font-family", style.fontFamily],
        ["font-size", style.fontSize],
        ["font-weight", style.fontWeight],
      ].forEach(([name, value]) => {
        if (value && value !== "none" && value !== "normal") target.setAttribute(name, value);
      });
      target.removeAttribute("class");
      target.removeAttribute("data-h5ve-selected");
      target.removeAttribute("data-h5ve-editing");
      target.removeAttribute("contenteditable");
    });
  }

  async function buildCurrentSlideSvg() {
    endAnyTextEditing();
    const slide = currentSlide();
    const stage = getStage() || slide || document.documentElement;
    if (!slide && document.getElementById("deck")) throw new Error("未找到当前幻灯片");
    const exportRoot = slide || document.querySelector("main") || document.body;
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) throw new Error("当前画布尺寸不可用");
    const width = state.designWidth || Math.round(stageRect.width);
    const height = state.designHeight || Math.round(stageRect.height);
    const scaleX = width / stageRect.width;
    const scaleY = height / stageRect.height;
    const imageCache = new Map();
    let idCounter = 0;
    const nextId = (prefix) => `h5ve-${prefix}-${++idCounter}`;

    const svg = svgNode("svg", {
      xmlns: SVG_NS,
      "xmlns:xlink": XLINK_NS,
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "shape-rendering": "geometricPrecision",
      "text-rendering": "geometricPrecision",
      "data-h5ve-export": "native-vector",
    });
    svg.appendChild(svgNode("title")).textContent = slide?.getAttribute("aria-label") || `幻灯片 ${getCurrentSlideIndex() + 1}`;
    svg.appendChild(svgNode("desc")).textContent = "原生 SVG 矢量文字与图形；位图素材仅作为独立 image 图层嵌入。";
    const defs = svgNode("defs");
    svg.appendChild(defs);
    const rootClipId = nextId("canvas-clip");
    const rootClip = svgNode("clipPath", { id: rootClipId });
    rootClip.appendChild(svgNode("rect", { x: 0, y: 0, width, height }));
    defs.appendChild(rootClip);
    const canvasGroup = svgNode("g", { id: "slide", "clip-path": `url(#${rootClipId})` });
    svg.appendChild(canvasGroup);

    function mappedRect(el) {
      const rect = el.getBoundingClientRect();
      return {
        raw: rect,
        x: (rect.left - stageRect.left) * scaleX,
        y: (rect.top - stageRect.top) * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      };
    }

    function scaledCornerRadii(style, rect) {
      const scale = Math.min(scaleX, scaleY);
      const radii = {
        tl: Math.max(0, cssPixels(style.borderTopLeftRadius) * scale),
        tr: Math.max(0, cssPixels(style.borderTopRightRadius) * scale),
        br: Math.max(0, cssPixels(style.borderBottomRightRadius) * scale),
        bl: Math.max(0, cssPixels(style.borderBottomLeftRadius) * scale),
      };
      const factors = [
        radii.tl + radii.tr ? rect.width / (radii.tl + radii.tr) : 1,
        radii.bl + radii.br ? rect.width / (radii.bl + radii.br) : 1,
        radii.tl + radii.bl ? rect.height / (radii.tl + radii.bl) : 1,
        radii.tr + radii.br ? rect.height / (radii.tr + radii.br) : 1,
      ];
      const factor = Math.min(1, ...factors.filter(Number.isFinite));
      Object.keys(radii).forEach((key) => {
        radii[key] *= factor;
      });
      return radii;
    }

    function hasRoundedCorners(radii) {
      return Object.values(radii).some((value) => value > 0.01);
    }

    function roundedRectNode(rect, radii) {
      const values = Object.values(radii);
      const uniform = values.every((value) => Math.abs(value - values[0]) < 0.01);
      if (uniform) {
        return svgNode("rect", {
          x: svgNumber(rect.x),
          y: svgNumber(rect.y),
          width: svgNumber(rect.width),
          height: svgNumber(rect.height),
          rx: svgNumber(values[0]),
          ry: svgNumber(values[0]),
        });
      }
      const x = rect.x;
      const y = rect.y;
      const right = x + rect.width;
      const bottom = y + rect.height;
      const d = [
        `M ${svgNumber(x + radii.tl)} ${svgNumber(y)}`,
        `H ${svgNumber(right - radii.tr)}`,
        `Q ${svgNumber(right)} ${svgNumber(y)} ${svgNumber(right)} ${svgNumber(y + radii.tr)}`,
        `V ${svgNumber(bottom - radii.br)}`,
        `Q ${svgNumber(right)} ${svgNumber(bottom)} ${svgNumber(right - radii.br)} ${svgNumber(bottom)}`,
        `H ${svgNumber(x + radii.bl)}`,
        `Q ${svgNumber(x)} ${svgNumber(bottom)} ${svgNumber(x)} ${svgNumber(bottom - radii.bl)}`,
        `V ${svgNumber(y + radii.tl)}`,
        `Q ${svgNumber(x)} ${svgNumber(y)} ${svgNumber(x + radii.tl)} ${svgNumber(y)}`,
        "Z",
      ].join(" ");
      return svgNode("path", { d });
    }

    function addBackground(group, style, rect) {
      const radii = scaledCornerRadii(style, rect);
      const background = roundedRectNode(rect, radii);
      let fill = null;
      if (style.backgroundImage && style.backgroundImage !== "none") {
        fill = makeSvgGradient(style.backgroundImage, defs, nextId);
      }
      if (fill) background.setAttribute("fill", fill);
      else if (!applySvgColor(background, "fill", style.backgroundColor)) background.setAttribute("fill", "none");
      if (background.getAttribute("fill") !== "none") group.appendChild(background);
      return radii;
    }

    function addBorders(group, style, rect) {
      const sides = [
        ["Top", rect.x, rect.y, rect.width, cssPixels(style.borderTopWidth) * scaleY],
        ["Right", rect.x + rect.width - cssPixels(style.borderRightWidth) * scaleX, rect.y, cssPixels(style.borderRightWidth) * scaleX, rect.height],
        ["Bottom", rect.x, rect.y + rect.height - cssPixels(style.borderBottomWidth) * scaleY, rect.width, cssPixels(style.borderBottomWidth) * scaleY],
        ["Left", rect.x, rect.y, cssPixels(style.borderLeftWidth) * scaleX, rect.height],
      ];
      sides.forEach(([side, x, y, w, h]) => {
        if (w <= 0 || h <= 0 || style[`border${side}Style`] === "none") return;
        const border = svgNode("rect", {
          x: svgNumber(x), y: svgNumber(y), width: svgNumber(w), height: svgNumber(h),
        });
        if (applySvgColor(border, "fill", style[`border${side}Color`])) group.appendChild(border);
      });
    }

    async function addBackgroundImage(group, style, rect, radii) {
      const urlMatch = String(style.backgroundImage || "").match(/url\(["']?(.*?)["']?\)/i);
      if (!urlMatch) return;
      const href = await mediaDataUrl(urlMatch[1], imageCache);
      if (!href) return;
      const clipId = nextId("background-clip");
      const clip = svgNode("clipPath", { id: clipId });
      clip.appendChild(roundedRectNode(rect, radii));
      defs.appendChild(clip);
      const image = svgNode("image", {
        x: svgNumber(rect.x), y: svgNumber(rect.y), width: svgNumber(rect.width), height: svgNumber(rect.height),
        preserveAspectRatio: style.backgroundSize === "contain" ? "xMidYMid meet" : "xMidYMid slice",
        "clip-path": `url(#${clipId})`,
      });
      image.setAttribute("href", href);
      image.setAttributeNS(XLINK_NS, "xlink:href", href);
      group.appendChild(image);
    }

    function addTextNode(group, textNode, style) {
      const fontSize = cssPixels(style.fontSize) * scaleY;
      if (!fontSize) return;
      directTextLines(textNode, stageRect, scaleX, scaleY).forEach((line) => {
        const text = svgNode("text", {
          x: svgNumber(line.left),
          y: svgNumber(line.top + fontSize * 0.82),
          "font-family": style.fontFamily,
          "font-size": svgNumber(fontSize),
          "font-weight": style.fontWeight,
          "font-style": style.fontStyle !== "normal" ? style.fontStyle : null,
          "letter-spacing": style.letterSpacing !== "normal" ? svgNumber(cssPixels(style.letterSpacing) * scaleX) : null,
          "text-decoration": style.textDecorationLine !== "none" ? style.textDecorationLine : null,
          "xml:space": "preserve",
        });
        if (!applySvgColor(text, "fill", style.color)) text.setAttribute("fill", "#000");
        const tspan = svgNode("tspan", {
          x: svgNumber(line.left),
          y: svgNumber(line.top + fontSize * 0.82),
        });
        tspan.textContent = line.text;
        text.appendChild(tspan);
        group.appendChild(text);
      });
    }

    async function inlineNestedSvgImages(source, clone) {
      const sourceImages = [...source.querySelectorAll("image")];
      const cloneImages = [...clone.querySelectorAll("image")];
      await Promise.all(sourceImages.map(async (sourceImage, index) => {
        const target = cloneImages[index];
        if (!target) return;
        const href = sourceImage.getAttribute("href") || sourceImage.getAttributeNS(XLINK_NS, "href") || sourceImage.getAttribute("xlink:href");
        if (!href) return;
        const embedded = await mediaDataUrl(href, imageCache);
        target.setAttribute("href", embedded);
        target.setAttributeNS(XLINK_NS, "xlink:href", embedded);
      }));
    }

    function sanitizeImportedSvg(root) {
      if (!root) return null;
      root
        .querySelectorAll("script, style, foreignObject, iframe, object, embed, audio, video")
        .forEach((node) => node.remove());
      [root, ...root.querySelectorAll("*")].forEach((node) => {
        [...node.attributes].forEach((attribute) => {
          const name = attribute.name.toLowerCase();
          const value = attribute.value.trim();
          if (name.startsWith("on") || name === "srcdoc") {
            node.removeAttribute(attribute.name);
            return;
          }
          if (name === "href" || name === "xlink:href") {
            const allowed = node.localName === "image" ? /^data:image\//i.test(value) : value.startsWith("#");
            if (!allowed) node.removeAttribute(attribute.name);
            return;
          }
          const urls = [...value.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi)].map((match) => match[1]);
          if (urls.some((url) => !url.startsWith("#")) || /(?:javascript|vbscript):/i.test(value)) {
            node.removeAttribute(attribute.name);
          }
        });
      });
      return root;
    }

    async function addExistingSvg(group, el, rect) {
      const clone = el.cloneNode(true);
      inlineSvgStyles(el, clone);
      await inlineNestedSvgImages(el, clone);
      sanitizeImportedSvg(clone);
      clone.setAttribute("x", svgNumber(rect.x));
      clone.setAttribute("y", svgNumber(rect.y));
      clone.setAttribute("width", svgNumber(rect.width));
      clone.setAttribute("height", svgNumber(rect.height));
      if (!clone.getAttribute("viewBox")) {
        const sourceWidth = cssPixels(el.getAttribute("width")) || el.clientWidth || rect.raw.width;
        const sourceHeight = cssPixels(el.getAttribute("height")) || el.clientHeight || rect.raw.height;
        clone.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);
      }
      clone.removeAttribute("style");
      group.appendChild(clone);
    }

    function addEmbeddedSvg(group, markup, rect, radii) {
      const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
      if (parsed.querySelector("parsererror")) return false;
      const source = parsed.documentElement;
      if (!source || source.localName !== "svg") return false;
      const imported = document.importNode(source, true);
      sanitizeImportedSvg(imported);
      const sourceWidth = cssPixels(imported.getAttribute("width")) || rect.width;
      const sourceHeight = cssPixels(imported.getAttribute("height")) || rect.height;
      imported.setAttribute("x", svgNumber(rect.x));
      imported.setAttribute("y", svgNumber(rect.y));
      imported.setAttribute("width", svgNumber(rect.width));
      imported.setAttribute("height", svgNumber(rect.height));
      imported.setAttribute("preserveAspectRatio", "xMidYMid meet");
      if (!imported.getAttribute("viewBox")) imported.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);
      if (hasRoundedCorners(radii)) {
        const clipId = nextId("embedded-svg-clip");
        const clip = svgNode("clipPath", { id: clipId });
        clip.appendChild(roundedRectNode(rect, radii));
        defs.appendChild(clip);
        imported.setAttribute("clip-path", `url(#${clipId})`);
      }
      group.appendChild(imported);
      return true;
    }

    async function addMedia(group, el, style, rect, radii) {
      let href = null;
      if (el instanceof HTMLImageElement) href = await mediaDataUrl(el.currentSrc || el.src, imageCache);
      else if (el instanceof HTMLVideoElement) {
        href = el.poster ? await mediaDataUrl(el.poster, imageCache) : videoFrameDataUrl(el);
      } else if (el instanceof HTMLCanvasElement) href = canvasDataUrl(el);
      if (!href) return;
      const svgMarkup = embeddedSvgMarkup(href);
      if (svgMarkup && addEmbeddedSvg(group, svgMarkup, rect, radii)) return;
      const clipId = nextId("media-clip");
      const clip = svgNode("clipPath", { id: clipId });
      clip.appendChild(roundedRectNode(rect, radii));
      defs.appendChild(clip);
      const fit = style.objectFit;
      const image = svgNode("image", {
        x: svgNumber(rect.x), y: svgNumber(rect.y), width: svgNumber(rect.width), height: svgNumber(rect.height),
        preserveAspectRatio: fit === "fill" ? "none" : fit === "contain" ? "xMidYMid meet" : "xMidYMid slice",
        "clip-path": `url(#${clipId})`,
      });
      image.setAttribute("href", href);
      image.setAttributeNS(XLINK_NS, "xlink:href", href);
      group.appendChild(image);
    }

    async function renderElement(el, parentGroup, depth = 0) {
      if (!(el instanceof Element) || isEditorNode(el)) return;
      if (el.matches("script, style, link, meta, noscript, iframe, [data-h5ve-speaker-note]")) return;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
      const rect = mappedRect(el);
      if (rect.width <= 0 || rect.height <= 0) {
        // Grid/flex 中存在只承载绝对定位子元素的零尺寸布局容器。
        // 容器自身无可见画面，但不能把其可见后代一起丢掉。
        for (const child of el.children) await renderElement(child, parentGroup, depth + 1);
        return;
      }
      if (rect.x >= width || rect.y >= height || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return;
      const name = exportLayerName(el, `layer-${depth}`);
      const group = svgNode("g", {
        id: nextId(name.replace(/[^\w\u3400-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "") || "layer"),
        "data-name": name,
        opacity: Number(style.opacity) < 1 ? svgNumber(Number(style.opacity)) : null,
      });
      parentGroup.appendChild(group);
      const radii = addBackground(group, style, rect);
      await addBackgroundImage(group, style, rect, radii);
      addBorders(group, style, rect);

      const tag = el.tagName.toLowerCase();
      if (tag === "svg") {
        await addExistingSvg(group, el, rect);
        return;
      }
      if (["img", "video", "canvas"].includes(tag)) {
        await addMedia(group, el, style, rect, radii);
        return;
      }
      [...el.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .forEach((node) => addTextNode(group, node, style));
      for (const child of el.children) await renderElement(child, group, depth + 1);
    }

    await renderElement(exportRoot, canvasGroup);
    const rasterAssets = [...svg.querySelectorAll("image")];
    const vectorShapes = svg.querySelectorAll("rect, path, line, polyline, polygon, circle, ellipse").length;
    const textLayers = svg.querySelectorAll("text").length;
    const tspanLayers = svg.querySelectorAll("tspan").length;
    const vectorElements = vectorShapes + textLayers + tspanLayers;
    const foreignObjects = svg.querySelectorAll("foreignObject").length;
    const externalImages = rasterAssets.filter((image) => {
      const href = image.getAttribute("href") || image.getAttribute("xlink:href") || "";
      return href && !/^data:/i.test(href);
    }).length;
    const fullCanvasRasters = rasterAssets.filter((image) => {
      const imageWidth = cssPixels(image.getAttribute("width"));
      const imageHeight = cssPixels(image.getAttribute("height"));
      return imageWidth >= width * 0.96 && imageHeight >= height * 0.96;
    }).length;
    const stats = {
      width,
      height,
      textLayers,
      tspanLayers,
      vectorShapes,
      vectorElements,
      rasterAssets: rasterAssets.length,
      foreignObjects,
      externalImages,
      fullCanvasRasters,
    };
    if (foreignObjects) throw new Error("检测到不可编辑的网页容器");
    if (externalImages) throw new Error("检测到未内嵌的外部素材");
    if (!vectorElements) throw new Error("当前页没有可编辑的矢量内容");
    if (fullCanvasRasters && textLayers === 0 && vectorShapes < 3) {
      throw new Error("检测到整页位图，不能伪装成矢量 SVG");
    }
    svg.setAttribute("data-vector-elements", String(vectorElements));
    svg.setAttribute("data-editable-text-layers", String(textLayers));
    svg.setAttribute("data-raster-assets", String(rasterAssets.length));
    return { markup: new XMLSerializer().serializeToString(svg), stats };
  }

  function setSvgExportStats(button, stats) {
    if (!button) return;
    button.dataset.h5veTextLayers = String(stats.textLayers);
    button.dataset.h5veTspanLayers = String(stats.tspanLayers);
    button.dataset.h5veVectorElements = String(stats.vectorElements);
    button.dataset.h5veRasterAssets = String(stats.rasterAssets);
    button.dataset.h5veForeignObjects = String(stats.foreignObjects);
    button.dataset.h5veExternalImages = String(stats.externalImages);
    button.dataset.h5veFullCanvasRasters = String(stats.fullCanvasRasters);
    button.dataset.h5veNativeVector = "true";
  }

  function currentSlideSvgFilename() {
    const base = (canonicalDocumentPath().split("/").pop() || "slide").replace(/\.html?$/i, "");
    const page = String(getCurrentSlideIndex() + 1).padStart(2, "0");
    return `${base}-slide-${page}.svg`;
  }

  function currentSlidePngFilename() {
    return currentSlideSvgFilename().replace(/\.svg$/i, ".png");
  }

  async function inlineScreenshotCssUrls(value, cache) {
    const matches = [...String(value || "").matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
    let result = String(value || "");
    for (const match of matches) {
      const source = match[2]?.trim();
      if (!source || /^(?:data:|blob:|#)/i.test(source)) continue;
      const dataUrl = await mediaDataUrl(new URL(source, document.baseURI).href, cache);
      if (!dataUrl) throw new Error(`无法内嵌截图素材：${source}`);
      result = result.replace(match[0], `url("${dataUrl}")`);
    }
    return result;
  }

  async function prepareScreenshotClone(source, clone, cache, stats) {
    if (!(source instanceof Element) || !(clone instanceof Element)) return;
    const computed = getComputedStyle(source);
    clone.removeAttribute("style");
    for (const property of computed) {
      clone.style.setProperty(property, computed.getPropertyValue(property), computed.getPropertyPriority(property));
    }
    clone.style.setProperty("animation", "none", "important");
    clone.style.setProperty("transition", "none", "important");
    clone.style.setProperty("caret-color", "transparent", "important");
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("data-h5ve-selected");
    clone.removeAttribute("data-h5ve-editing");
    clone.classList.remove("h5ve-current-slide", "h5ve-rotating");

    for (const property of ["background-image", "mask-image", "-webkit-mask-image", "border-image-source"]) {
      const value = clone.style.getPropertyValue(property);
      if (value && value !== "none" && /url\(/i.test(value)) {
        clone.style.setProperty(property, await inlineScreenshotCssUrls(value, cache));
      }
    }

    if (source instanceof HTMLImageElement) {
      const dataUrl = await mediaDataUrl(source.currentSrc || source.src, cache);
      if (!dataUrl) throw new Error(`无法内嵌截图图片：${source.currentSrc || source.src}`);
      clone.setAttribute("src", dataUrl);
      clone.removeAttribute("srcset");
      clone.removeAttribute("sizes");
      stats.imageAssets++;
    } else if (source instanceof HTMLVideoElement || source instanceof HTMLCanvasElement) {
      const dataUrl = source instanceof HTMLCanvasElement
        ? canvasDataUrl(source)
        : (source.poster ? await mediaDataUrl(source.poster, cache) : videoFrameDataUrl(source));
      if (dataUrl) {
        const image = document.createElement("img");
        image.setAttribute("src", dataUrl);
        image.setAttribute("alt", source.getAttribute("aria-label") || "");
        image.setAttribute("style", clone.getAttribute("style") || "");
        clone.replaceWith(image);
        stats.imageAssets++;
      } else {
        clone.remove();
      }
      return;
    } else if (source instanceof SVGImageElement) {
      const href = source.getAttribute("href") || source.getAttribute("xlink:href") || "";
      if (href && !/^(?:data:|blob:|#)/i.test(href)) {
        const dataUrl = await mediaDataUrl(new URL(href, document.baseURI).href, cache);
        if (!dataUrl) throw new Error(`无法内嵌 SVG 截图素材：${href}`);
        clone.setAttribute("href", dataUrl);
        clone.setAttributeNS(XLINK_NS, "xlink:href", dataUrl);
        stats.imageAssets++;
      }
    }

    stats.domElements++;
    const sourceChildren = [...source.children];
    const cloneChildren = [...clone.children];
    for (let index = 0; index < sourceChildren.length; index++) {
      const sourceChild = sourceChildren[index];
      const cloneChild = cloneChildren[index];
      if (!cloneChild) continue;
      if (
        isEditorNode(sourceChild) ||
        sourceChild.matches("script, style, link, meta, noscript, iframe, [data-h5ve-speaker-note]")
      ) {
        cloneChild.remove();
        continue;
      }
      await prepareScreenshotClone(sourceChild, cloneChild, cache, stats);
    }
  }

  async function buildCurrentSlideScreenshotSvg() {
    endAnyTextEditing();
    const slide = currentSlide();
    const stage = getStage() || slide || document.documentElement;
    if (!slide && document.getElementById("deck")) throw new Error("未找到当前幻灯片");
    const source = slide || document.querySelector("main") || document.body;
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width || !stageRect.height) throw new Error("当前画布尺寸不可用");
    const width = state.designWidth || Math.round(stageRect.width);
    const height = state.designHeight || Math.round(stageRect.height);
    const clone = source.cloneNode(true);
    const stats = { width, height, domElements: 0, imageAssets: 0, captureMode: "dom-snapshot" };
    await prepareScreenshotClone(source, clone, new Map(), stats);
    clone.style.setProperty("position", "relative", "important");
    clone.style.setProperty("inset", "auto", "important");
    clone.style.setProperty("left", "0", "important");
    clone.style.setProperty("top", "0", "important");
    clone.style.setProperty("margin", "0", "important");
    clone.style.setProperty("width", `${width}px`, "important");
    clone.style.setProperty("height", `${height}px`, "important");
    clone.style.setProperty("transform", "none", "important");
    clone.style.setProperty("transform-origin", "0 0", "important");
    clone.removeAttribute("aria-hidden");

    const wrapper = document.createElement("div");
    wrapper.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    wrapper.setAttribute("lang", document.documentElement.lang || "zh-CN");
    wrapper.style.cssText = `position:relative;width:${width}px;height:${height}px;overflow:hidden;margin:0;padding:0;`;
    wrapper.appendChild(clone);
    const xhtml = new XMLSerializer().serializeToString(wrapper);
    const markup = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
    return { markup, stats };
  }

  async function svgBuildToPngBlob(buildPromise, pixelRatio = 2) {
    const payload = await buildPromise;
    const width = Math.max(1, Math.round(payload.stats.width));
    const height = Math.max(1, Math.round(payload.stats.height));
    const ratio = Math.max(1, Math.min(3, Number(pixelRatio) || 2));
    const svgBlob = new Blob([payload.markup], { type: "image/svg+xml;charset=utf-8" });
    const objectUrl = payload.stats.captureMode === "dom-snapshot"
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.markup)}`
      : URL.createObjectURL(svgBlob);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      if (typeof image.decode === "function") await image.decode();
      else {
        await new Promise((resolve, reject) => {
          image.onload = resolve;
          image.onerror = () => reject(new Error("截图画面加载失败"));
        });
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("当前浏览器无法创建截图画布");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (result) => result ? resolve(result) : reject(new Error("PNG 生成失败")),
          "image/png",
        );
      });
      return {
        blob,
        stats: {
          ...payload.stats,
          pixelRatio: ratio,
          pixelWidth: canvas.width,
          pixelHeight: canvas.height,
        },
      };
    } finally {
      if (objectUrl.startsWith("blob:")) URL.revokeObjectURL(objectUrl);
    }
  }

  async function copyPngToClipboard(pngPromise) {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
      throw new Error("当前浏览器未开放图片剪贴板权限");
    }
    const pngBlobPromise = pngPromise.then(({ blob }) => blob);
    await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlobPromise })]);
    return pngPromise;
  }

  async function copyCurrentSlideScreenshot() {
    const button = editorRoot?.querySelector('[data-action="screenshot"]');
    const buttonLabel = button?.querySelector("[data-screenshot-label]");
    const originalLabel = buttonLabel?.textContent || button?.textContent || "复制截图";
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      if (buttonLabel) buttonLabel.textContent = "复制中…";
      else button.textContent = "复制中…";
      button.setAttribute("aria-busy", "true");
    }
    const pngPromise = svgBuildToPngBlob(buildCurrentSlideScreenshotSvg());
    try {
      const { blob, stats } = await copyPngToClipboard(pngPromise);
      const filename = currentSlidePngFilename();
      window.__h5veLastScreenshotExport = {
        filename,
        type: blob.type,
        size: blob.size,
        stats,
        destination: "clipboard",
        clipboardTypes: ["image/png"],
      };
      showToast("已复制当前页截图 · 可直接粘贴到文档");
    } catch (error) {
      try {
        const { blob, stats } = await pngPromise;
        const filename = currentSlidePngFilename();
        downloadBlob(blob, filename);
        window.__h5veLastScreenshotExport = {
          filename,
          type: blob.type,
          size: blob.size,
          stats,
          destination: "download-fallback",
          clipboardError: error.message || String(error),
        };
        showToast(`剪贴板写入失败，已下载 ${filename}`);
      } catch (buildError) {
        showToast(`截图生成失败：${buildError.message || error.message}`);
      }
    } finally {
      if (button) {
        button.disabled = false;
        if (buttonLabel) buttonLabel.textContent = originalLabel;
        else button.textContent = originalLabel;
        button.removeAttribute("aria-busy");
      }
    }
  }

  async function downloadCurrentSlideScreenshot() {
    try {
      const { blob, stats } = await svgBuildToPngBlob(buildCurrentSlideScreenshotSvg());
      const filename = currentSlidePngFilename();
      downloadBlob(blob, filename);
      window.__h5veLastScreenshotExport = {
        filename,
        type: blob.type,
        size: blob.size,
        stats,
        destination: "download",
      };
      showToast(`已下载 ${filename}`);
    } catch (error) {
      showToast(`截图下载失败：${error.message}`);
    }
  }

  function legacyCopyText(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } finally {
      textarea.remove();
    }
    return copied;
  }

  async function copySvgBuildToClipboard(buildPromise) {
    let richClipboardError = null;
    if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      const clipboardData = {
        "text/plain": buildPromise.then(({ markup }) => new Blob([markup], { type: "text/plain" })),
        "text/html": buildPromise.then(({ markup }) => new Blob([markup], { type: "text/html" })),
      };
      if (typeof ClipboardItem.supports === "function" && ClipboardItem.supports("image/svg+xml")) {
        clipboardData["image/svg+xml"] = buildPromise.then(
          ({ markup }) => new Blob([markup], { type: "image/svg+xml" }),
        );
      }
      try {
        await navigator.clipboard.write([new ClipboardItem(clipboardData)]);
        return {
          payload: await buildPromise,
          method: "clipboard-write",
          types: Object.keys(clipboardData),
        };
      } catch (error) {
        richClipboardError = error;
      }
    }

    const payload = await buildPromise;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(payload.markup);
        return { payload, method: "clipboard-write-text", types: ["text/plain"] };
      } catch (error) {
        richClipboardError ||= error;
      }
    }
    if (legacyCopyText(payload.markup)) {
      return { payload, method: "exec-command", types: ["text/plain"] };
    }
    throw richClipboardError || new Error("当前浏览器未允许写入剪贴板");
  }

  async function exportCurrentSlideSvg() {
    const button = sidebar?.querySelector('[data-action="export"]');
    const originalLabel = button?.textContent || "复制 SVG";
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      button.textContent = "复制中…";
      button.setAttribute("aria-busy", "true");
    }
    const buildPromise = buildCurrentSlideSvg();
    try {
      const { payload, method, types } = await copySvgBuildToClipboard(buildPromise);
      const filename = currentSlideSvgFilename();
      setSvgExportStats(button, payload.stats);
      window.__h5veLastSvgExport = {
        filename,
        markup: payload.markup,
        stats: payload.stats,
        destination: "clipboard",
        clipboardMethod: method,
        clipboardTypes: types,
      };
      showToast(`已复制 SVG 到剪贴板 · 去 Figma 直接 ⌘V`);
    } catch (error) {
      try {
        const { markup, stats } = await buildPromise;
        const filename = currentSlideSvgFilename();
        downloadBlob(
          new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml;charset=utf-8" }),
          filename,
        );
        setSvgExportStats(button, stats);
        window.__h5veLastSvgExport = { filename, markup, stats, destination: "download-fallback" };
        showToast(`剪贴板复制失败，已下载 ${filename}`);
      } catch (buildError) {
        showToast(`SVG 生成失败：${buildError.message || error.message}`);
      }
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
        button.removeAttribute("aria-busy");
      }
    }
  }

  async function downloadCurrentSlideSvg() {
    try {
      const { markup, stats } = await buildCurrentSlideSvg();
      const filename = currentSlideSvgFilename();
      downloadBlob(
        new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${markup}`], { type: "image/svg+xml;charset=utf-8" }),
        filename,
      );
      window.__h5veLastSvgExport = { filename, markup, stats, destination: "download" };
      showToast(`已下载 ${filename}`);
    } catch (error) {
      showToast(`SVG 下载失败：${error.message}`);
    }
  }

  function deleteSelected() {
    if (!state.picking) {
      showToast("预览模式下无法编辑 · 按 ⇧D 进入选择模式");
      return;
    }
    if (state.selected.length === 0) {
      showToast("请先选中要删除的元素");
      return;
    }
    const snapshot = collectGroupMembers(state.selected).filter((el) => !isElementLocked(el));
    if (snapshot.length === 0) {
      showToast("选中元素已锁定·请先解锁再删除");
      return;
    }
    selectSingle(null);
    snapshot.forEach((el) => el.remove());
    pushHistory();
    renderElementPanel();
    showToast(`已删除 ${snapshot.length} 个元素 · 可撤销`);
  }

  async function deleteCurrentSlide() {
    if (!state.picking) {
      showToast("预览模式下无法编辑 · 按 ⇧D 进入选择模式");
      return;
    }
    const deck = document.getElementById("deck");
    if (!deck) {
      showToast("当前页面不是 PPT 结构（无 #deck）");
      return;
    }
    const slides = getDeckSlides();
    if (slides.length <= 1) {
      showToast("至少保留 1 页，无法删除");
      return;
    }
    const idx = getCurrentSlideIndex();
    const slide = slides[idx];
    if (!slide) {
      showToast("无法定位当前页");
      return;
    }
    const pageNo = idx + 1;
    if (!confirm(`删除第 ${pageNo} 页（共 ${slides.length} 页）？\n删除后将自动保存到文件。`)) return;

    endAnyTextEditing();
    selectSingle(null);
    const nextIdx = idx >= slides.length - 1 ? idx - 1 : idx;
    slide.remove();
    syncSlideChromeNumbers();
    refreshDeckNavigation(nextIdx);
    renderSlidePanel();
    pushHistory();
    const ok = await saveToDisk({ silent: true, quiet: true });
    if (ok) showToast(`第 ${pageNo} 页已删除并已保存到 ${canonicalDocumentPath()}`);
  }

  function restoreHistorySnapshot(message) {
    const restoreIndex = state.historyMeta[state.historyIndex]?.slideIndex;
    contentRoot().innerHTML = state.history[state.historyIndex];
    selectSingle(null);
    refreshDeckNavigation(Number.isInteger(restoreIndex) ? restoreIndex : getCurrentSlideIndex());
    renderSlidePanel();
    renderElementPanel();
    updateNotesPanel();
    updateHistoryControls();
    scheduleAutoSave();
    showToast(message);
  }

  function undo() {
    if (state.historyIndex <= 0) {
      updateHistoryControls();
      showToast("没有可撤销的操作");
      return;
    }
    state.historyIndex--;
    restoreHistorySnapshot("已撤销并自动保存");
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) {
      updateHistoryControls();
      showToast("没有可反撤销的操作");
      return;
    }
    state.historyIndex++;
    restoreHistorySnapshot("已反撤销并自动保存");
  }

  function updatePickButton() {
    const btn = sidebar.querySelector('[data-action="pick"]');
    btn?.classList.toggle("active", state.picking);
    if (btn) {
      btn.textContent = state.picking ? "选择模式" : "预览模式";
      btn.title = state.picking ? "当前为选择模式 · ⇧D 切换预览" : "当前为预览模式 · ⇧D 切换选择";
      btn.setAttribute("aria-label", btn.title);
    }
  }

  function togglePickMode() {
    state.picking = !state.picking;
    document.body.classList.toggle("h5ve-picking", state.picking);
    updatePickButton();
    if (!state.picking) {
      endAnyTextEditing();
      selectSingle(null);
      const cur = getCurrentSlideIndex();
      refreshDeckNavigation(cur);
      showPreviewPanel();
      updateStatus();
      showToast("预览模式 · 与正常看 PPT 相同 · ⇧D 切回选择");
      return;
    }
    refreshDeckNavigation(getCurrentSlideIndex());
    fillPanel(state.primary);
    updateStatus();
    showToast("选择模式已开启 · 点击选中 · Ctrl / ⌘ / Shift 多选");
  }

  function bindUi() {
    editorRoot.querySelector('[data-action="screenshot"]')?.addEventListener("click", copyCurrentSlideScreenshot);
    sidebar.querySelector('[data-action="export"]')?.addEventListener("click", exportCurrentSlideSvg);
    sidebar.querySelector('[data-action="delete"]')?.addEventListener("click", deleteSelected);
    sidebar.querySelector('[data-action="group"]')?.addEventListener("click", groupSelection);
    sidebar.querySelector('[data-action="ungroup"]')?.addEventListener("click", ungroupSelection);
    sidebar.querySelector('[data-action="pick"]')?.addEventListener("click", () => {
      togglePickMode();
      sidebar.querySelector('[data-action="pick"]')?.blur();
    });
    sidebar.querySelector('[data-action="exit"]')?.addEventListener("click", exitEditor);
    sidebar.querySelector('[data-action="commands"]')?.addEventListener("click", openCommandPalette);
    sidebar.querySelector('[data-action="insert"]')?.addEventListener("click", toggleInsertMenu);
    insertMenu?.addEventListener("click", (event) => {
      const item = event.target.closest?.("[data-insert-kind]");
      if (!item) return;
      const kind = item.dataset.insertKind;
      closeInsertMenu();
      if (kind === "text") addNewTextElement();
      else createCanvasObject(kind);
    });
    sidebar.querySelector('[data-action="help"]')?.addEventListener("click", openShortcutHelp);
    sidebar.querySelector('[data-action="versions"]')?.addEventListener("click", openVersionHistory);
    sidebar.querySelector(".h5ve-save-state")?.addEventListener("click", () => {
      if (sidebar.querySelector(".h5ve-save-state")?.dataset.state === "error") openVersionHistory();
    });
    sidebar.querySelector('[data-action="zoom-out"]')?.addEventListener("click", () => stepCanvasZoom(-1));
    sidebar.querySelector('[data-action="zoom-in"]')?.addEventListener("click", () => stepCanvasZoom(1));
    sidebar.querySelector('[data-action="zoom-actual"]')?.addEventListener("click", () => setCanvasScale(1));
    sidebar.querySelector('[data-action="zoom-fit"]')?.addEventListener("click", fitCanvasToViewport);
    sidebar.querySelector('[data-action="pan-left"]')?.addEventListener("click", () => panCanvasHorizontally(-96));
    sidebar.querySelector('[data-action="pan-right"]')?.addEventListener("click", () => panCanvasHorizontally(96));
    editorRoot.querySelectorAll('[data-action="duplicate-slide"]').forEach((button) => {
      button.addEventListener("click", duplicateCurrentSlide);
    });
    layerSearchInput?.addEventListener("input", () => {
      state.layerQuery = layerSearchInput.value;
      renderElementPanel();
    });
    layerSearchInput?.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        clearLayerSearch({ blur: !state.layerQuery });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "Enter") return;
      const row = elementsPanel?.querySelector(".h5ve-element-item.is-search-match") || elementsPanel?.querySelector(".h5ve-element-item");
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Enter" && row.__h5veElement) selectSingle(row.__h5veElement);
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "nearest", behavior: "auto" });
    });
    layerSearchClear?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearLayerSearch();
    });
    elementsPanel?.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-layer-action]");
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.layerAction;
      if (action === "rename") {
        const row = [...elementsPanel.querySelectorAll(".h5ve-element-item")].find(
          (candidate) => candidate.__h5veElement === state.primary,
        );
        if (row && state.primary) startLayerRename(row, state.primary);
        return;
      }
      moveSelectionDepth(action);
    });
    contextMenu?.addEventListener("click", (event) => {
      const button = event.target.closest?.("[data-context-action]");
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.contextAction;
      closeContextMenu();
      runContextAction(action);
    });
    contextMenu?.addEventListener("keydown", (event) => {
      const items = [...contextMenu.querySelectorAll("button:not(:disabled)")];
      const index = Math.max(0, items.indexOf(document.activeElement));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length]?.focus({ preventScroll: true });
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0]?.focus({ preventScroll: true });
      } else if (event.key === "End") {
        event.preventDefault();
        items[items.length - 1]?.focus({ preventScroll: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeContextMenu();
      }
    });
    commandPalette?.addEventListener("click", (event) => {
      if (event.target === commandPalette || event.target.closest?.("[data-action='close-commands']")) {
        closeCommandPalette();
        return;
      }
      const command = event.target.closest?.("[data-command]")?.dataset.command;
      if (command) runEditorCommand(command);
    });
    commandInput?.addEventListener("input", () => filterCommands(commandInput.value));
    commandInput?.addEventListener("keydown", (event) => {
      const visible = visibleCommandButtons();
      if (event.key === "Escape") {
        event.preventDefault();
        closeCommandPalette();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        updateCommandActive((commandActiveIndex + delta + visible.length) % Math.max(visible.length, 1));
        return;
      }
      if (event.key === "Enter" && visible[commandActiveIndex]) {
        event.preventDefault();
        visible[commandActiveIndex].click();
      }
    });
    shortcutHelp?.addEventListener("click", (event) => {
      if (event.target === shortcutHelp || event.target.closest?.("[data-action='close-help']")) closeShortcutHelp();
    });
    versionHistory?.addEventListener("click", (event) => {
      if (event.target === versionHistory || event.target.closest?.("[data-action='close-versions']")) {
        closeVersionHistory();
        return;
      }
      const recoveryAction = event.target.closest?.("[data-recovery-action]")?.dataset.recoveryAction;
      if (recoveryAction === "restore") restoreRecoveryDraft();
      else if (recoveryAction === "download" && state.recoveryDraft) downloadHtml(state.recoveryDraft.html);
      else if (recoveryAction === "discard") {
        clearRecoveryDraft();
        setSaveState("saved", "已保存");
      }
      const item = event.target.closest?.("[data-version-index]");
      if (!item) return;
      const index = Number(item.dataset.versionIndex);
      if (!Number.isInteger(index) || index === state.historyIndex || !state.history[index]) return;
      state.historyIndex = index;
      closeVersionHistory();
      restoreHistorySnapshot("已恢复所选版本并自动保存");
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!insertMenu?.hidden && !event.target?.closest?.(".h5ve-insert-wrap")) closeInsertMenu();
      },
      true,
    );
    updateHistoryControls();
    setSaveState("saved", "已保存");
  }

  function injectUi() {
    const root = document.createElement("div");
    root.className = "h5ve-root";
    root.style.setProperty("--h5ve-slides-panel", document.getElementById("deck") ? `${SLIDES_PANEL_W}px` : "0px");
    root.style.setProperty("--h5ve-left-panel", `${state.leftPanelWidth}px`);
    root.style.setProperty("--h5ve-inspector", `${state.inspectorWidth}px`);
    root.innerHTML = `
      <aside id="h5ve-sidebar" class="h5ve-sidebar">
        <div class="h5ve-side-head">
          <div class="h5ve-brand-row">
            <div class="h5ve-brand-stack">
              <span class="h5ve-brand">PPTedit</span>
              <span class="h5ve-brand-subtitle">本地编辑工作台</span>
            </div>
            <div class="h5ve-head-tools">
              <button type="button" class="h5ve-icon-btn" data-action="versions" aria-label="版本与恢复" title="版本与恢复" data-tooltip="版本与恢复">
                <svg class="h5ve-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>
              </button>
              <button type="button" class="h5ve-icon-btn" data-action="help" aria-label="快捷键帮助" aria-keyshortcuts="?" title="快捷键帮助" data-tooltip="快捷键帮助">
                <svg class="h5ve-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.5 2.5 0 0 1 4.8 1c0 2-2.5 2.2-2.5 4"/><path d="M12 18h.01"/></svg>
              </button>
              <a class="h5ve-icon-btn h5ve-exit-btn" data-action="exit" href="/" aria-label="退出编辑" title="退出编辑" data-tooltip="退出编辑">
                <svg class="h5ve-toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3"/><path d="m17 8 4 4-4 4"/><path d="M9 12h12"/></svg>
              </a>
            </div>
          </div>
          <div class="h5ve-quick-row">
            <div class="h5ve-insert-wrap">
              <button type="button" class="h5ve-insert-trigger" data-action="insert" aria-haspopup="menu" aria-expanded="false"><span>+</span>插入</button>
              <div id="h5ve-insert-menu" class="h5ve-insert-menu" role="menu" aria-label="插入对象" hidden>
                <button type="button" role="menuitem" data-insert-kind="text"><span>T</span><strong>文本</strong><kbd>T</kbd></button>
                <button type="button" role="menuitem" data-insert-kind="rectangle"><span>□</span><strong>矩形</strong><kbd>R</kbd></button>
                <button type="button" role="menuitem" data-insert-kind="ellipse"><span>○</span><strong>椭圆</strong><kbd>O</kbd></button>
                <button type="button" role="menuitem" data-insert-kind="line"><span>─</span><strong>线条</strong><kbd>L</kbd></button>
                <button type="button" role="menuitem" data-insert-kind="frame"><span>#</span><strong>框架</strong><kbd>F</kbd></button>
              </div>
            </div>
            <button type="button" class="h5ve-command-trigger" data-action="commands">
              <span>快速操作</span><kbd>⌘K</kbd>
            </button>
          </div>
          <div class="h5ve-context-row">
            <div class="h5ve-status">未选中</div>
            <div class="h5ve-save-state" data-state="saved"><span class="h5ve-save-dot"></span><span class="h5ve-save-label">已保存</span></div>
          </div>
          <nav class="h5ve-selection-path" aria-label="选中元素层级"></nav>
          <div class="h5ve-actions">
            <button type="button" class="h5ve-btn primary h5ve-screenshot-action" data-action="screenshot" title="复制当前页 2× 高清 PNG，可直接粘贴到文档">
              <svg class="h5ve-action-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M8 6l1.3-2h5.4L16 6"/><circle cx="12" cy="12.5" r="3.2"/></svg>
              <span data-screenshot-label>复制当前页截图</span>
            </button>
            <button type="button" class="h5ve-btn" data-action="export" title="复制当前页原生矢量 SVG，到 Figma 直接粘贴即可编辑">复制 SVG</button>
            <button type="button" class="h5ve-btn h5ve-mode-action active" data-action="pick" title="选择 / 预览 · ⇧D">选择模式</button>
          </div>
        </div>
        <div id="h5ve-panel" class="h5ve-panel-body">
          <div id="h5ve-panel-props">
            <div class="h5ve-panel-header">属性</div>
            <div class="h5ve-panel-empty h5ve-panel-empty-state">
              <strong>选择一个元素</strong>
              <span>在画布或左侧元素列表中选择，即可调整属性。</span>
              <small>Ctrl / ⌘ / Shift 多选 · 修饰键拖拽追加框选</small>
            </div>
          </div>
        </div>
        <div class="h5ve-side-foot">
          <span class="h5ve-side-foot-copy">自动保存 · 空格拖动画布</span>
          <div class="h5ve-zoom-controls" role="toolbar" aria-label="画布缩放">
            <button type="button" data-action="pan-left" aria-label="画布向左移动" title="画布向左移动" disabled>←</button>
            <button type="button" data-action="zoom-out" aria-label="缩小画布" title="缩小 · ⌘−">−</button>
            <button type="button" class="h5ve-zoom-value" data-action="zoom-actual" aria-label="显示 100%" title="显示 100% · ⌘1">100%</button>
            <button type="button" data-action="zoom-in" aria-label="放大画布" title="放大 · ⌘+">+</button>
            <button type="button" data-action="pan-right" aria-label="画布向右移动" title="画布向右移动" disabled>→</button>
            <button type="button" class="h5ve-zoom-fit" data-action="zoom-fit" aria-label="适配窗口" title="适配窗口 · ⌘0">适配</button>
          </div>
        </div>
      </aside>
      <aside id="h5ve-slides" class="h5ve-slides" hidden>
        <div class="h5ve-slides-head">
          <span>幻灯片</span>
          <button type="button" class="h5ve-slides-add" data-action="duplicate-slide" title="复制当前幻灯片 · ⌘⇧D" aria-label="复制当前幻灯片"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><span>复制</span></button>
        </div>
        <div class="h5ve-slides-list"></div>
        <div class="h5ve-slides-foot">拖拽调整顺序 · 自动保存</div>
      </aside>
      <aside id="h5ve-elements" class="h5ve-elements" hidden>
        <div class="h5ve-elements-head">
          <span>元素</span>
          <span class="h5ve-elements-count">0</span>
        </div>
        <div class="h5ve-elements-search">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"></circle><path d="m10.2 10.2 3.1 3.1"></path></svg>
          <input type="search" autocomplete="off" spellcheck="false" placeholder="搜索图层" aria-label="搜索当前页图层" aria-keyshortcuts="Meta+F">
          <button type="button" data-action="clear-layer-search" aria-label="清除图层搜索" title="清除搜索 · Esc" hidden>×</button>
        </div>
        <div class="h5ve-elements-list" role="tree" aria-label="当前页元素"></div>
        <div class="h5ve-elements-actions" role="toolbar" aria-label="图层操作">
          <button type="button" data-layer-action="rename" title="重命名图层 (F2)" aria-label="重命名图层"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m12 8 4 4"/></svg><span>重命名</span></button>
          <button type="button" data-layer-action="back" title="置于底层 (⌘⌥[)" aria-label="置于底层"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v12"/><path d="m8 12 4 4 4-4"/><path d="M5 20h14"/></svg><span>置底</span></button>
          <button type="button" data-layer-action="backward" title="下移一层 (⌘[)" aria-label="下移一层"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v14"/><path d="m8 14 4 4 4-4"/></svg><span>下移</span></button>
          <button type="button" data-layer-action="forward" title="上移一层 (⌘])" aria-label="上移一层"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V6"/><path d="m8 10 4-4 4 4"/></svg><span>上移</span></button>
          <button type="button" data-layer-action="front" title="置于顶层 (⌘⌥])" aria-label="置于顶层"><svg class="h5ve-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V8"/><path d="m8 12 4-4 4 4"/><path d="M5 4h14"/></svg><span>置顶</span></button>
        </div>
        <div class="h5ve-elements-foot">⌘F 搜索 · 双击 / F2 重命名 · 行尾显示与锁定<br>方向键移动选中元素 · ↑↓ 浏览未选中图层</div>
      </aside>
      <div id="h5ve-left-resizer" class="h5ve-panel-resizer h5ve-left-resizer" role="separator" aria-label="调整元素栏宽度" aria-orientation="vertical" tabindex="0"></div>
      <div id="h5ve-right-resizer" class="h5ve-panel-resizer h5ve-right-resizer" role="separator" aria-label="调整属性栏宽度" aria-orientation="vertical" tabindex="0"></div>
      <aside id="h5ve-notes" class="h5ve-notes" hidden>
        <div class="h5ve-notes-title">备注</div>
        <textarea id="h5ve-notes-text" placeholder="这里写当前页讲稿备注；正式 PPT 不会展示。"></textarea>
      </aside>
      <div id="h5ve-selection-layer"></div>
      <div id="h5ve-handle" class="h5ve-handle" style="display:none" title="拖拽移动"></div>
      <div id="h5ve-image-drop" class="h5ve-image-drop" hidden><span>释放以添加图片</span></div>
      <div id="h5ve-toast" class="h5ve-toast"></div>
      <div id="h5ve-context-menu" class="h5ve-context-menu" role="menu" aria-label="元素快捷操作" hidden>
        <button type="button" role="menuitem" data-context-action="add-text"><span class="h5ve-context-label">新增文本</span><kbd>T</kbd></button>
        <button type="button" role="menuitem" data-context-action="copy"><span class="h5ve-context-label">复制</span><kbd>⌘C</kbd></button>
        <button type="button" role="menuitem" data-context-action="cut"><span class="h5ve-context-label">剪切</span><kbd>⌘X</kbd></button>
        <button type="button" role="menuitem" data-context-action="paste"><span class="h5ve-context-label">粘贴</span><kbd>⌘V</kbd></button>
        <button type="button" role="menuitem" data-context-action="duplicate"><span class="h5ve-context-label">创建副本</span><kbd>⌘D</kbd></button>
        <div class="h5ve-context-separator" role="separator"></div>
        <button type="button" role="menuitem" data-context-action="rename"><span class="h5ve-context-label">重命名图层</span><kbd>F2</kbd></button>
        <button type="button" role="menuitem" data-context-action="group"><span class="h5ve-context-label">编组</span><kbd>⌘G</kbd></button>
        <button type="button" role="menuitem" data-context-action="ungroup"><span class="h5ve-context-label">解组 / 释放框架</span><kbd>⌘⇧G</kbd></button>
        <div class="h5ve-context-separator" role="separator"></div>
        <button type="button" role="menuitem" data-context-action="front"><span class="h5ve-context-label">置于顶层</span><kbd>⌘⌥]</kbd></button>
        <button type="button" role="menuitem" data-context-action="forward"><span class="h5ve-context-label">上移一层</span><kbd>⌘]</kbd></button>
        <button type="button" role="menuitem" data-context-action="backward"><span class="h5ve-context-label">下移一层</span><kbd>⌘[</kbd></button>
        <button type="button" role="menuitem" data-context-action="back"><span class="h5ve-context-label">置于底层</span><kbd>⌘⌥[</kbd></button>
        <div class="h5ve-context-separator" role="separator"></div>
        <button type="button" role="menuitem" data-context-action="lock"><span class="h5ve-context-label">锁定</span></button>
        <button type="button" role="menuitem" data-context-action="visibility"><span class="h5ve-context-label">隐藏</span></button>
        <button type="button" class="danger" role="menuitem" data-context-action="delete"><span class="h5ve-context-label">删除</span><kbd>⌫</kbd></button>
      </div>
      <div id="h5ve-command-palette" class="h5ve-command-overlay" hidden>
        <section class="h5ve-command-dialog" role="dialog" aria-modal="true" aria-label="快速操作">
          <div class="h5ve-command-search-row">
            <span class="h5ve-command-search-icon">⌘</span>
            <input class="h5ve-command-input" type="search" placeholder="搜索操作…" autocomplete="off">
            <button type="button" class="h5ve-command-close" data-action="close-commands" aria-label="关闭">Esc</button>
          </div>
          <div class="h5ve-command-list" role="listbox">
            ${EDITOR_COMMANDS.map((command) => `
              <button type="button" class="h5ve-command-item" data-command="${command.id}" role="option">
                <span><strong>${command.label}</strong><small>${command.detail}</small></span>
                ${command.shortcut ? `<kbd>${command.shortcut}</kbd>` : ""}
              </button>`).join("")}
          </div>
          <div class="h5ve-command-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
        </section>
      </div>
      <div id="h5ve-shortcut-help" class="h5ve-command-overlay" hidden>
        <section class="h5ve-shortcut-dialog" role="dialog" aria-modal="true" aria-label="快捷键帮助">
          <header><div><strong>快捷键</strong><span>在画布和元素查看器中均可使用</span></div><button type="button" data-action="close-help" aria-label="关闭">×</button></header>
          <div class="h5ve-shortcut-grid">
            <span>快速操作</span><kbd>⌘K</kbd><span>选择 / 预览</span><kbd>⇧D</kbd>
            <span>撤销 / 重做</span><kbd>⌘Z / ⌘⇧Z</kbd><span>保存</span><kbd>⌘S</kbd>
            <span>自适应布局</span><kbd>⇧A</kbd><span>编组 / 解组</span><kbd>⌘G / ⌘⇧G</kbd>
            <span>多选 / 追加框选</span><kbd>Ctrl / ⌘ / Shift + 鼠标</kbd><span>移动 / 大步移动</span><kbd>←↑→↓ / ⇧+方向键</kbd>
            <span>编辑文字</span><kbd>Enter / F2 / 双击</kbd><span>返回上层</span><kbd>⇧Enter / Esc</kbd>
            <span>进入容器子层</span><kbd>Enter</kbd><span>新增文本</span><kbd>T</kbd>
            <span>删除</span><kbd>Delete</kbd><span>矩形 / 椭圆</span><kbd>R / O</kbd>
            <span>线条 / 框架</span><kbd>L / F</kbd><span>添加图片</span><kbd>拖入 / 粘贴</kbd>
            <span>快捷菜单</span><kbd>右键</kbd><span>搜索当前页图层</span><kbd>⌘F</kbd>
            <span>清除图层搜索</span><kbd>Esc</kbd><span>图层前移 / 后移</span><kbd>⌘] / ⌘[</kbd>
            <span>重命名图层</span><kbd>F2</kbd><span>复制当前页</span><kbd>⌘⇧D</kbd>
            <span>删除缩略图页</span><kbd>Delete</kbd><span></span><span></span>
            <span>放大 / 缩小</span><kbd>⌘+ / ⌘−</kbd><span>适配 / 100%</span><kbd>⌘0 / ⌘1</kbd>
            <span>平移画布</span><kbd>按住空格拖动</kbd><span>光标处缩放</span><kbd>⌘ + 滚轮</kbd>
          </div>
          <footer>未选中画布元素时，方向键用于切换幻灯片。</footer>
        </section>
      </div>
      <div id="h5ve-version-history" class="h5ve-command-overlay" hidden>
        <section class="h5ve-version-dialog" role="dialog" aria-modal="true" aria-label="版本与恢复">
          <header><div><strong>版本与恢复</strong><span>本次会话快照与本地故障草稿</span></div><button type="button" data-action="close-versions" aria-label="关闭">×</button></header>
          <div class="h5ve-version-list"></div>
          <footer>恢复较早版本后，仍可通过“重做”返回后续快照。</footer>
        </section>
      </div>
    `;
    document.documentElement.appendChild(root);
    editorRoot = root;
    sidebar = document.getElementById("h5ve-sidebar");
    sidebar.querySelector('[data-action="exit"]')?.setAttribute("href", previewUrl());
    slidesPanel = document.getElementById("h5ve-slides");
    elementsPanel = document.getElementById("h5ve-elements");
    layerSearchInput = elementsPanel?.querySelector(".h5ve-elements-search input");
    layerSearchClear = elementsPanel?.querySelector('[data-action="clear-layer-search"]');
    selectionPath = sidebar.querySelector(".h5ve-selection-path");
    panel = document.getElementById("h5ve-panel-props");
    document.getElementById("h5ve-slide-bar")?.querySelector('[data-action="delete-slide"]')?.addEventListener("click", () => {
      deleteCurrentSlide();
    });
    selectionLayer = document.getElementById("h5ve-selection-layer");
    handle = document.getElementById("h5ve-handle");
    imageDropOverlay = document.getElementById("h5ve-image-drop");
    contextMenu = document.getElementById("h5ve-context-menu");
    toast = document.getElementById("h5ve-toast");
    commandPalette = document.getElementById("h5ve-command-palette");
    commandInput = commandPalette?.querySelector(".h5ve-command-input");
    commandList = commandPalette?.querySelector(".h5ve-command-list");
    shortcutHelp = document.getElementById("h5ve-shortcut-help");
    versionHistory = document.getElementById("h5ve-version-history");
    versionList = versionHistory?.querySelector(".h5ve-version-list");
    insertMenu = document.getElementById("h5ve-insert-menu");
    notesPanel = document.getElementById("h5ve-notes");
    notesTextarea = document.getElementById("h5ve-notes-text");
    notesTextarea?.addEventListener("input", () => {
      writeSlideNote(currentSlide(), notesTextarea.value);
      clearTimeout(notesHistoryTimer);
      notesHistoryTimer = setTimeout(pushHistory, 700);
    });
    notesTextarea?.addEventListener("blur", pushHistory);
  }

  function clampPanelWidth(side, value) {
    const isLeft = side === "left";
    return Math.round(Math.max(
      isLeft ? MIN_LEFT_PANEL_W : MIN_INSPECTOR_W,
      Math.min(isLeft ? MAX_LEFT_PANEL_W : MAX_INSPECTOR_W, Number(value) || 0),
    ));
  }

  function updatePanelResizerA11y() {
    const left = document.getElementById("h5ve-left-resizer");
    const right = document.getElementById("h5ve-right-resizer");
    if (left) {
      left.setAttribute("aria-valuemin", String(MIN_LEFT_PANEL_W));
      left.setAttribute("aria-valuemax", String(MAX_LEFT_PANEL_W));
      left.setAttribute("aria-valuenow", String(state.leftPanelWidth));
      left.title = `元素栏 ${state.leftPanelWidth}px · 双击重置`;
    }
    if (right) {
      right.setAttribute("aria-valuemin", String(MIN_INSPECTOR_W));
      right.setAttribute("aria-valuemax", String(MAX_INSPECTOR_W));
      right.setAttribute("aria-valuenow", String(state.inspectorWidth));
      right.title = `属性栏 ${state.inspectorWidth}px · 双击重置`;
    }
  }

  function applyWorkbenchPanelWidth(side, value, options = {}) {
    const next = clampPanelWidth(side, value);
    if (side === "left") {
      state.leftPanelWidth = next;
      editorRoot?.style.setProperty("--h5ve-left-panel", `${next}px`);
      if (options.persist) safeStorageSet("h5ve-left-panel-width", String(next));
    } else {
      state.inspectorWidth = next;
      editorRoot?.style.setProperty("--h5ve-inspector", `${next}px`);
      if (options.persist) safeStorageSet("h5ve-inspector-width", String(next));
    }
    updatePanelResizerA11y();
    cancelAnimationFrame(panelResizeRaf);
    panelResizeRaf = requestAnimationFrame(applyCanvasScale);
    if (options.refreshThumbnails && side === "left") renderSlidePanel();
  }

  function bindWorkbenchResizers() {
    const bind = (side) => {
      const resizer = document.getElementById(`h5ve-${side}-resizer`);
      if (!resizer) return;
      let active = false;

      const finish = (event) => {
        if (!active) return;
        active = false;
        if (event?.pointerId != null && resizer.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture(event.pointerId);
        document.documentElement.classList.remove("h5ve-panel-resizing");
        document.body.style.userSelect = "";
        applyWorkbenchPanelWidth(side, side === "left" ? state.leftPanelWidth : state.inspectorWidth, {
          persist: true,
          refreshThumbnails: false,
        });
      };

      resizer.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || isCompactWorkbench()) return;
        event.preventDefault();
        event.stopPropagation();
        active = true;
        resizer.setPointerCapture?.(event.pointerId);
        document.documentElement.classList.add("h5ve-panel-resizing");
        document.body.style.userSelect = "none";
      });
      const move = (event) => {
        if (!active) return;
        event.preventDefault();
        const slidesWidth = document.getElementById("deck") ? SLIDES_PANEL_W : 0;
        const value = side === "left" ? event.clientX - slidesWidth : window.innerWidth - event.clientX;
        applyWorkbenchPanelWidth(side, value);
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", finish);
      resizer.addEventListener("pointercancel", finish);
      // 部分宿主将拖拽续帧派发为 mousemove；窗口级兜底保证分隔线不滞留在拖拽态。
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mouseup", finish, true);
      resizer.addEventListener("dblclick", (event) => {
        event.preventDefault();
        const fallback = side === "left" ? DEFAULT_LEFT_PANEL_W : DEFAULT_INSPECTOR_W;
        applyWorkbenchPanelWidth(side, fallback, { persist: true, refreshThumbnails: false });
        showToast(`${side === "left" ? "元素栏" : "属性栏"}已恢复默认宽度`);
      });
      resizer.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 24 : 8;
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const current = side === "left" ? state.leftPanelWidth : state.inspectorWidth;
        const next = current + (side === "left" ? direction : -direction) * step;
        applyWorkbenchPanelWidth(side, next, { persist: true, refreshThumbnails: false });
      });
    };
    bind("left");
    bind("right");
    updatePanelResizerA11y();
  }

  function bindEvents() {
    document.body.classList.add("h5ve-active", "h5ve-picking");

    // Figma / Keynote 式画布抓手：只在选择模式和中间工作区生效。
    // 输入控件、文字编辑、侧栏与预览模式继续保留各自的空格行为。
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.code !== "Space" || e.repeat || !canUseCanvasPan(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        state.spacePressed = true;
        document.documentElement.classList.add("h5ve-space-pan");
      },
      true,
    );

    document.addEventListener(
      "keyup",
      (e) => {
        if (e.code !== "Space" || !state.spacePressed) return;
        e.preventDefault();
        state.spacePressed = false;
        state.panning = false;
        document.documentElement.classList.remove("h5ve-space-pan", "h5ve-panning");
        document.body.style.userSelect = "";
      },
      true,
    );

    window.addEventListener("blur", endCanvasPan);

    document.addEventListener(
      "wheel",
      (e) => {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const factor = Math.exp(-e.deltaY * 0.002);
          const anchor = isCanvasViewportPoint(e.clientX, e.clientY) && !isEditorNode(e.target)
            ? { x: e.clientX, y: e.clientY }
            : undefined;
          setCanvasScale(state.scale * factor, anchor);
          return;
        }

        // 连续长页放大后没有原生横向滚动容器；在中央画布内将触控板横移
        // 或 Shift + 滚轮映射为画布平移，普通纵向滚动仍用于阅读长页。
        const horizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY)
          ? e.deltaX
          : e.shiftKey
            ? e.deltaY
            : 0;
        if (
          horizontalDelta &&
          isContinuousCanvas() &&
          isCanvasViewportPoint(e.clientX, e.clientY) &&
          !isEditorNode(e.target) &&
          canPanContinuousCanvas()
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          panContinuousCanvasBy(-horizontalDelta);
        }
      },
      { capture: true, passive: false },
    );

    document.addEventListener(
      "copy",
      (e) => {
        if (!state.picking || state.selected.length === 0 || isTypingOrEditingTarget(e.target)) return;
        copySelection();
        e.preventDefault();
        e.clipboardData?.setData("text/html", selectionClipboardHtml());
        e.clipboardData?.setData("text/plain", state.selected.map((el) => elementLayerName(el)).join("\n"));
      },
      true,
    );

    document.addEventListener(
      "cut",
      (e) => {
        if (!state.picking || state.selected.length === 0 || isTypingOrEditingTarget(e.target)) return;
        copySelection();
        e.preventDefault();
        e.clipboardData?.setData("text/html", selectionClipboardHtml());
        e.clipboardData?.setData("text/plain", state.selected.map((el) => elementLayerName(el)).join("\n"));
        deleteSelected();
      },
      true,
    );

    document.addEventListener(
      "paste",
      async (e) => {
        if (!state.picking || isTypingOrEditingTarget(e.target)) return;
        const item = [...(e.clipboardData?.items || [])].find(
          (candidate) => candidate.kind === "file" && candidate.type.startsWith("image/"),
        );
        const file = item?.getAsFile?.();
        if (file) {
          e.preventDefault();
          e.stopImmediatePropagation();
          await insertImageFile(file);
          return;
        }
        const html = e.clipboardData?.getData?.("text/html") || "";
        if (!restoreLocalClipboardFromHtml(html)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        pasteToCurrentSlide();
      },
      true,
    );

    document.addEventListener(
      "dragover",
      (e) => {
        if (!state.picking || !hasImageTransfer(e.dataTransfer) || !isCanvasViewportPoint(e.clientX, e.clientY)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        showImageDropTarget();
      },
      true,
    );
    document.addEventListener(
      "dragleave",
      (e) => {
        const slide = currentSlide();
        if (!slide || !e.relatedTarget || !slide.contains(e.relatedTarget)) hideImageDropTarget();
      },
      true,
    );
    document.addEventListener(
      "drop",
      async (e) => {
        if (!state.picking || !hasImageTransfer(e.dataTransfer) || !isCanvasViewportPoint(e.clientX, e.clientY)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        hideImageDropTarget();
        const file = [...(e.dataTransfer?.files || [])].find((candidate) => candidate.type.startsWith("image/"));
        if (file) {
          await insertImageFile(file, { x: e.clientX, y: e.clientY });
          return;
        }
        const source = imageSourceFromTransfer(e.dataTransfer);
        if (!source) {
          showToast("未识别到可用图片，请尝试复制后粘贴");
          return;
        }
        const filename = (() => {
          try { return decodeURIComponent(new URL(source, location.href).pathname.split("/").pop() || "拖入图片"); }
          catch { return "拖入图片"; }
        })();
        try {
          await insertImageSource(source, filename, { x: e.clientX, y: e.clientY });
        } catch (error) {
          showToast(`添加图片失败：${error.message}`);
        }
      },
      true,
    );
    document.addEventListener("dragend", hideImageDropTarget, true);

    document.addEventListener(
      "keydown",
      (e) => {
        if (handleAutoLayoutShortcut(e)) return;
        if (handleGroupShortcut(e)) return;
      },
      true,
    );

    document.addEventListener(
      "click",
      (e) => {
        if (e.target?.closest?.("[data-ppt-demo]")) return;
        if (e.target?.closest?.("[data-h5ve-editing='true']")) return;
        // 编辑器自身 UI（侧栏/面板/缩略图）的点击始终放行；
        // 画布拖拽后的防误点不能吞掉缩放、适配、保存等工具按钮。
        if (isEditorNode(e.target)) return;
        if (performance.now() < state.suppressClickUntil) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (!state.picking) return;
        // 刚完成一次拖拽移动：吞掉这次 click，避免误把选中切到子元素
        if (state.didDrag) {
          state.didDrag = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        const el = findEditableTarget(e.target);
        e.preventDefault();
        e.stopPropagation();
        if (!el) {
          if (!isAdditiveSelectionEvent(e)) selectSingle(null);
          return;
        }
        selectEditableTarget(el, { shiftKey: isAdditiveSelectionEvent(e) });
      },
      true,
    );

    document.addEventListener(
      "contextmenu",
      (e) => {
        if (performance.now() < state.suppressClickUntil) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (!state.picking || e.target?.closest?.(".h5ve-context-menu")) return;
        const row = e.target?.closest?.(".h5ve-element-item");
        const selectionBox = e.target?.closest?.(".h5ve-selection");
        let target = row?.__h5veElement || null;
        if (!target && selectionBox) {
          target = state.selected[Number(selectionBox.dataset.h5veSelectionIndex)] || state.primary;
        }
        if (!target && !isEditorNode(e.target)) {
          target = findEditableTarget(e.target);
          const wrapper = findDomGroupWrapper(target);
          if (wrapper) target = wrapper;
        }
        const slide = currentSlide();
        const onCanvas = !!slide && (slide.contains(e.target) || selectionBox);
        if (!row && !onCanvas) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (target?.isConnected && !state.selected.includes(target)) selectSingle(target);
        else if (!target && onCanvas) selectSingle(null);
        openContextMenu(e.clientX, e.clientY);
      },
      true,
    );

    document.addEventListener(
      "pointerdown",
      (e) => {
        if (!contextMenu?.hidden && !e.target?.closest?.(".h5ve-context-menu")) closeContextMenu();
      },
      true,
    );

    document.addEventListener(
      "dblclick",
      (e) => {
        if (e.target?.closest?.("[data-ppt-demo]")) return;
        if (e.target?.closest?.("[data-h5ve-editing='true']")) return;
        if (!state.picking || isEditorNode(e.target)) return;
        const el = findEditableTarget(e.target);
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        selectSingle(el);
        if (canEditText(el)) startTextEdit(el, e);
        else enterSelectionChild(el);
      },
      true,
    );

    document.addEventListener(
      "input",
      (e) => {
        const el = e.target?.closest?.("[data-h5ve-editing='true']");
        if (!el) return;
        if (state.primary === el && panelFields.text) panelFields.text.value = el.innerText || "";
        scheduleSelectionBox();
        markDirty();
      },
      true,
    );

    document.addEventListener(
      "keydown",
      (e) => {
        const el = e.target?.closest?.("[data-h5ve-editing='true']");
        if (!el || e.key !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        el.blur();
        selectSingle(el);
      },
      true,
    );

    document.addEventListener(
      "blur",
      (e) => {
        if (e.target?.dataset?.h5veEditing) endTextEdit(e.target);
      },
      true,
    );

    function startMoveDrag(e) {
      const targets = collectGroupMembers(state.selected).filter((el) => !isElementLocked(el));
      if (targets.length === 0) return;
      state.dragging = true;
      state.didDrag = false;
      state.dragCopyPending = !!e.altKey;
      state.dragDuplicated = false;
      state.dragStart = { x: e.clientX, y: e.clientY };
      state.dragBases = targets.map((el) => ({
        el,
        ...parseTransform(el),
      }));
      document.body.style.userSelect = "none";
    }

    function clampMarqueePoint(point) {
      const canvas = getStage() || currentSlide();
      const r = canvas?.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return point;
      return {
        x: Math.max(r.left, Math.min(point.x, r.right)),
        y: Math.max(r.top, Math.min(point.y, r.bottom)),
      };
    }

    function normalizeMarqueeTargets(candidates) {
      const expanded = [];
      const seen = new Set();
      candidates.forEach((candidate) => {
        const wrapper = findDomGroupWrapper(candidate);
        if (wrapper) {
          if (!seen.has(wrapper)) {
            seen.add(wrapper);
            expanded.push(wrapper);
          }
          return;
        }
        const members = expandByGroupId(candidate);
        const targets = members || [candidate];
        targets.forEach((target) => {
          if (!seen.has(target)) {
            seen.add(target);
            expanded.push(target);
          }
        });
      });

      // 普通父子层级只保留更具体的子元素；但逻辑编组内如果父节点
      // 本身就承载主文案（例如 strong 内嵌 em），要保留外层节点，否则会
      // 只选中“周一”而漏掉“8.10”。同组祖先已代表整块，子节点不再重复选中。
      return expanded.filter((el) => {
        const groupId = el.dataset?.h5veGroupId;
        const hasSameGroupAncestor = !!groupId && expanded.some(
          (other) => other !== el && other.dataset?.h5veGroupId === groupId && other.contains(el),
        );
        if (hasSameGroupAncestor) return false;

        const hasIndependentDescendant = expanded.some((other) => {
          if (other === el || !el.contains(other)) return false;
          return !groupId || other.dataset?.h5veGroupId !== groupId;
        });
        return !hasIndependentDescendant;
      });
    }

    function startMarquee(e, origin = { x: e.clientX, y: e.clientY }, additive = isAdditiveSelectionEvent(e)) {
      const start = clampMarqueePoint(origin);
      state.marqueeing = true;
      state.didMarquee = false;
      document.documentElement.classList.add("h5ve-marqueeing");
      state.marqueeStart = start;
      state.marqueeAdditive = additive;
      state.marqueeBaseSelection = additive ? state.selected.slice() : [];
      if (!state.marqueeAdditive) selectSingle(null);
      if (!marqueeEl) {
        marqueeEl = document.createElement("div");
        marqueeEl.className = "h5ve-marquee";
        document.querySelector(".h5ve-root")?.appendChild(marqueeEl);
      }
      marqueeEl.style.display = "block";
      marqueeEl.style.left = `${start.x}px`;
      marqueeEl.style.top = `${start.y}px`;
      marqueeEl.style.width = "0";
      marqueeEl.style.height = "0";
    }

    function performMarquee(e) {
      if (!state.marqueeing) return;
      state.didMarquee = true;
      const current = clampMarqueePoint({ x: e.clientX, y: e.clientY });
      const x1 = Math.min(current.x, state.marqueeStart.x);
      const y1 = Math.min(current.y, state.marqueeStart.y);
      const x2 = Math.max(current.x, state.marqueeStart.x);
      const y2 = Math.max(current.y, state.marqueeStart.y);
      const w = x2 - x1;
      const h = y2 - y1;

      marqueeEl.style.left = `${x1}px`;
      marqueeEl.style.top = `${y1}px`;
      marqueeEl.style.width = `${w}px`;
      marqueeEl.style.height = `${h}px`;

      const slide = currentSlide();
      if (!slide) return;

      const marqueeRect = { left: x1, top: y1, right: x2, bottom: y2 };

      // 扫描舞台，但只挑选「叶子级」可编辑元素（即不含其他可编辑子元素的末端节点）
      const candidates = Array.from(slide.querySelectorAll("*")).filter((el) => {
        if (!isEditableTarget(el)) return false;
        const r = el.getBoundingClientRect();
        if ((r.width < 1 || r.height < 1) && !isThinLineElement(el, r)) return false;
        // 必须完全或大部分在框选范围内（相交即可）
        if (!isRectIntersect(marqueeRect, r)) return false;

        // 关键：跳过「结构性容器」—— 即那些本身只是骨架、内部还包着其他可独立编辑元素的 div
        // 判断标准：如果它内部还有「可编辑且有实际内容(文本/图片)」的子元素，则它是容器，跳过
        const hasEditableChild = Array.from(el.children).some(child => {
          return isEditableTarget(child) && child.getBoundingClientRect().width > 1;
        });
        // 已编组的 group 视为一个整体，可被选中
        if (el.dataset?.h5veGroup === "1") return true;
        // 容器跳过（除非它是图片/视频等媒体本身）
        if (hasEditableChild && !el.matches("img, video")) return false;

        return true;
      });

      const targets = normalizeMarqueeTargets(candidates);

      if (state.marqueeAdditive) {
        const combined = Array.from(new Set([...state.marqueeBaseSelection, ...targets]));
        if (!sameSelection(combined)) setSelection(combined, targets[targets.length - 1]);
      } else if (!sameSelection(targets)) {
        setSelection(targets, targets[targets.length - 1]);
      }
    }

    handle.addEventListener("mousedown", (e) => {
      if (!state.picking || state.selected.length === 0) return;
      e.preventDefault();
      startMoveDrag(e);
    });

    // 按住已选中的元素（含组/容器）直接拖拽移动整个选区；
    // 松手未移动则视为普通点击，仍可下钻选择子元素。
    // 点击空白处或长距离拖拽开始「框选」
    document.addEventListener(
      "mousedown",
      (e) => {
        if (state.spacePressed && e.button === 0 && isCanvasViewportPoint(e.clientX, e.clientY) && !isEditorNode(e.target)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          state.panning = true;
          state.panStart = { x: e.clientX, y: e.clientY };
          state.panBase = { x: state.panX, y: state.panY };
          state.suppressClickUntil = performance.now() + 250;
          document.documentElement.classList.add("h5ve-panning");
          document.body.style.userSelect = "none";
          return;
        }
        if (!state.picking || isEditorNode(e.target)) return;
        const stage = getStage();
        if (stage && !stage.contains(e.target)) return;
        if (e.target?.closest?.("[data-h5ve-editing='true']")) return;
        if (e.button !== 0) return;

        state.didDrag = false;
        state.didMarquee = false;
        const el = findEditableTarget(e.target);

        const additiveSelection = isAdditiveSelectionEvent(e);

        if (!el) {
          // 点击纯空白处：立即启动框选
          startMarquee(e, { x: e.clientX, y: e.clientY }, additiveSelection);
          return;
        }

        if (additiveSelection) {
          // Ctrl / Cmd / Shift + 拖拽：无论起点是空白还是元素，都从按下位置追加框选。
          // 未超过阈值时仍保留为普通的修饰键点击，用于追加或取消单个元素。
          if (e.ctrlKey) e.preventDefault();
          state.marqueePending = true;
          state.marqueeStart = { x: e.clientX, y: e.clientY };
          state.marqueeAdditive = true;
          return;
        }

        const hitSelected = state.selected.some((sel) => sel === el || sel.contains(el));
        if (hitSelected) {
          const wrapper = findDomGroupWrapper(el);
          if (wrapper && state.selected.includes(wrapper)) selectSingle(wrapper);
          startMoveDrag(e);
        } else {
          // 点击未选中元素：不立即 startMarquee，
          // 而是等待 mousemove 判定位移后再决定是「框选」还是「普通点击选择」
          state.marqueePending = true;
          state.marqueeStart = { x: e.clientX, y: e.clientY };
          state.marqueeAdditive = false;
        }
      },
      true,
    );

    selectionLayer.addEventListener("click", (e) => {
      if (!state.picking) return;
      if (performance.now() < state.suppressClickUntil) return;
      if (state.didDrag) {
        state.didDrag = false;
        return;
      }
      const lineHit = e.target.closest?.(".h5ve-line-hit");
      if (lineHit?.__h5veElement) {
        e.preventDefault();
        e.stopPropagation();
        selectEditableTarget(lineHit.__h5veElement, { shiftKey: isAdditiveSelectionEvent(e) });
        return;
      }
      const selectionTarget = e.target.closest?.(".h5ve-selection");
      if (!selectionTarget || e.target.closest?.(".h5ve-resize")) return;
      const el = state.selected[Number(selectionTarget.dataset.h5veSelectionIndex)] || state.primary;
      if (isAdditiveSelectionEvent(e)) {
        e.preventDefault();
        e.stopPropagation();
        toggleInSelection(el);
        return;
      }
      if (!canEditText(el)) return;
      e.preventDefault();
      e.stopPropagation();
      selectSingle(el);
      startTextEdit(el, e);
    });

    selectionLayer.addEventListener("dblclick", (e) => {
      if (!state.picking) return;
      const lineHit = e.target.closest?.(".h5ve-line-hit");
      if (lineHit?.__h5veElement) {
        e.preventDefault();
        e.stopPropagation();
        selectSingle(lineHit.__h5veElement);
        return;
      }
      const selectionTarget = e.target.closest?.(".h5ve-selection");
      if (!selectionTarget) return;

      const el = state.selected[Number(selectionTarget.dataset.h5veSelectionIndex)] || state.primary;
      if (!el) return;

      // 文本元素双击无条件优先进入画布内编辑；不能被尺寸重置逻辑抢占。
      if (canEditText(el)) {
        e.preventDefault();
        e.stopPropagation();
        selectSingle(el);
        startTextEdit(el, e);
        return;
      }

      if (!e.target.closest(".h5ve-resize") && enterSelectionChild(el)) {
        e.preventDefault();
        e.stopPropagation();
      }

    });

    selectionLayer.addEventListener("mousedown", (e) => {
      if (!state.picking) return;
      const rotateTarget = e.target.closest?.(".h5ve-rotate-handle");
      if (rotateTarget) {
        startRotate(e);
        return;
      }
      const resizeTarget = e.target.closest?.(".h5ve-resize");
      if (resizeTarget) {
        startResize(e, resizeTarget.dataset.dir);
        return;
      }
      const selectionTarget = e.target.closest?.(".h5ve-selection");
      if (!selectionTarget || state.selected.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (isAdditiveSelectionEvent(e)) {
        state.didDrag = false;
        state.didMarquee = false;
        state.marqueePending = true;
        state.marqueeStart = { x: e.clientX, y: e.clientY };
        state.marqueeAdditive = true;
        return;
      }
      startMoveDrag(e);
    });

    window.addEventListener("mousemove", (e) => {
      if (state.panning) {
        if (isContinuousCanvas()) {
          state.panX = clampContinuousPanX(state.panBase.x + e.clientX - state.panStart.x);
          state.panY = 0;
        } else {
          state.panX = state.panBase.x + e.clientX - state.panStart.x;
          state.panY = state.panBase.y + e.clientY - state.panStart.y;
        }
        applyCanvasScale();
        return;
      }
      if (state.marqueePending) {
        const dx = e.clientX - state.marqueeStart.x;
        const dy = e.clientY - state.marqueeStart.y;
        if (Math.hypot(dx, dy) > 5) {
          const origin = { ...state.marqueeStart };
          const additive = state.marqueeAdditive;
          state.marqueePending = false;
          startMarquee(e, origin, additive);
          performMarquee(e);
        }
        return;
      }
      if (state.marqueeing) {
        performMarquee(e);
        return;
      }
      if (state.rotating) {
        performRotate(e);
        return;
      }
      if (state.resizing) {
        performResize(e);
        return;
      }
      if (!state.dragging || state.dragBases.length === 0) return;
      const rawDx = e.clientX - state.dragStart.x;
      const rawDy = e.clientY - state.dragStart.y;
      if (!state.didDrag && Math.hypot(rawDx, rawDy) < 3) return;
      if (!state.didDrag) {
        state.didDrag = true;
        if (state.dragCopyPending) {
          const clones = cloneSelectionForAltDrag();
          if (clones.length > 0) {
            state.dragBases = clones.map((el) => ({ el, ...parseTransform(el) }));
            state.dragDuplicated = true;
          }
        }
      }
      const dx = rawDx / state.scale;
      const dy = rawDy / state.scale;

      // 智能吸附：仅在单选或主选元素拖拽时触发，提升性能
      let finalDx = dx;
      let finalDy = dy;
      if (state.primary) {
        const currentRect = state.primary.getBoundingClientRect();
        const snap = getSnappingGuides(currentRect);
        if (snap.lines.length > 0) {
          finalDx += snap.dx / state.scale;
          finalDy += snap.dy / state.scale;
          drawGuideLines(snap.lines);
        } else {
          drawGuideLines([]);
        }
      }

      state.dragBases.forEach(({ el, x, y }) => {
        applyTransform(el, x + finalDx, y + finalDy);
      });
      if (state.primary && panelFields.x && panelFields.y) {
        const t = parseTransform(state.primary);
        panelFields.x.value = Math.round(t.x);
        panelFields.y.value = Math.round(t.y);
      }
      scheduleSelectionBox();
    });

    window.addEventListener("mouseup", () => {
      if (state.panning) {
        state.panning = false;
        state.suppressClickUntil = performance.now() + 250;
        document.documentElement.classList.remove("h5ve-panning");
        document.body.style.userSelect = "";
      }
      drawGuideLines([]); // 清除吸附线
      state.marqueePending = false;
      if (state.marqueeing) {
        state.marqueeing = false;
        document.documentElement.classList.remove("h5ve-marqueeing");
        if (marqueeEl) marqueeEl.style.display = "none";
        if (state.didMarquee) {
          state.suppressClickUntil = performance.now() + 250;
          const count = state.selected.length;
          showToast(
            count > 0
              ? `已框选 ${count} 个元素 · 可一起拖动、编组或方向键移动`
              : "框选区域内没有可编辑元素",
          );
        }
        state.didMarquee = false;
        state.marqueeBaseSelection = [];
      }
      if (state.resizing) {
        state.resizing = false;
        state.resizeDir = null;
        state.resizeBase = null;
        document.body.style.userSelect = "";
        pushHistory();
        if (state.primary) fillPanel(state.primary);
      }
      if (state.rotating) {
        state.rotating = false;
        state.rotateStartAngle = 0;
        state.rotateBaseAngle = 0;
        state.rotateItems = [];
        document.documentElement.classList.remove("h5ve-rotating");
        document.body.style.userSelect = "";
        pushHistory({ label: "旋转元素" });
        if (state.primary) fillPanel(state.primary);
      }
      if (state.dragging) {
        state.dragging = false;
        state.dragBases = [];
        state.dragCopyPending = false;
        document.body.style.userSelect = "";
        pushHistory({ label: state.dragDuplicated ? "拖拽复制元素" : "移动元素" });
        if (state.dragDuplicated) showToast("已复制并移动元素 · 可撤销");
        state.dragDuplicated = false;
      }
    });

    markContinuousFixedElements();
    window.addEventListener("scroll", scheduleContinuousScrollOffset, { capture: true, passive: true });
    window.addEventListener("scrollend", calibrateContinuousScrollOffset, { capture: true, passive: true });
    window.addEventListener("scroll", scheduleSelectionBox, { capture: true, passive: true });
    window.addEventListener("scroll", closeContextMenu, { capture: true, passive: true });
    window.addEventListener("resize", () => {
      scheduleSelectionBox();
      closeContextMenu();
    });

    window.addEventListener(
      "keydown",
      (e) => {
        const key = e.key.toLowerCase();
        const isArrowKey = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key);
        const focusedInElementViewer = !!e.target?.closest?.(".h5ve-elements");
        const isTypingTarget = !!(
          e.target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target?.tagName)
        );
        const selectParentShortcut = !!(
          e.key === "Enter" &&
          e.shiftKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          state.picking &&
          state.selected.length === 1
        );
        const zoomShortcut = canvasZoomShortcut(e);

        // 编辑模式统一接管浏览器缩放快捷键：即使焦点在侧栏输入框，
        // 也只改变中间 PPT 画布，不放大整个工作台和左右功能区。
        if (zoomShortcut) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (zoomShortcut === "in") stepCanvasZoom(1);
          else if (zoomShortcut === "out") stepCanvasZoom(-1);
          else if (zoomShortcut === "fit") fitCanvasToViewport();
          else setCanvasScale(1);
          return;
        }

        if (e.key === "Escape" && contextMenu && !contextMenu.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeContextMenu();
          return;
        }
        if (e.key === "Escape" && insertMenu && !insertMenu.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeInsertMenu();
          return;
        }
        if (contextMenu && !contextMenu.hidden && e.target?.closest?.(".h5ve-context-menu")) return;

        if (e.key === "Escape" && commandPalette && !commandPalette.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeCommandPalette();
          return;
        }
        if (e.key === "Escape" && shortcutHelp && !shortcutHelp.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeShortcutHelp();
          return;
        }
        if (e.key === "Escape" && versionHistory && !versionHistory.hidden) {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeVersionHistory();
          return;
        }
        if (
          e.key === "Escape" &&
          state.layerQuery &&
          e.target?.closest?.(".h5ve-elements") &&
          !e.target?.classList?.contains("h5ve-element-name-input")
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          clearLayerSearch();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && key === "k" && !isTypingTarget) {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (commandPalette?.hidden) openCommandPalette();
          else closeCommandPalette();
          return;
        }
        if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTypingTarget) {
          e.preventDefault();
          e.stopImmediatePropagation();
          openShortcutHelp();
          return;
        }
        if (
          (e.metaKey || e.ctrlKey) &&
          !e.shiftKey &&
          !e.altKey &&
          key === "f" &&
          state.picking &&
          elementsPanel &&
          !elementsPanel.hidden &&
          (!isTypingTarget || e.target === layerSearchInput)
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          focusLayerSearch();
          return;
        }

        // 元素查看器只在画布没有选中元素时接管方向键。
        // 一旦画布存在选中项，即使焦点仍留在左侧列表，四向键也必须优先移动元素。
        if (
          focusedInElementViewer &&
          !(isArrowKey && state.picking && hasPageElementSelection()) &&
          !selectParentShortcut
        ) return;
        if (isTypingTarget) return;

        // Figma 式层级穿行：Shift + Enter 选择直接父层。
        // 文字编辑、输入框和搜索会在上方提前返回，不触发父层选择。
        if (selectParentShortcut) {
          e.preventDefault();
          e.stopImmediatePropagation();
          selectParentLayer();
          return;
        }

        // Esc 继续作为返回父容器的兼容快捷键。搜索和浮层已在上方优先处理。
        if (
          e.key === "Escape" &&
          state.picking &&
          state.selected.length > 0 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          selectParentLayer();
          return;
        }

        // ⇧D 切换选择模式（类似 Figma Dev Mode）
        if (e.shiftKey && key === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          togglePickMode();
          return;
        }

        if ((e.metaKey || e.ctrlKey) && key === "z" && e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          redo();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && key === "z" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          undo();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && key === "s") {
          e.preventDefault();
          saveToDisk();
          return;
        }

        if ((e.metaKey || e.ctrlKey) && e.shiftKey && key === "d") {
          e.preventDefault();
          e.stopPropagation();
          duplicateCurrentSlide();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && key === "d") {
          e.preventDefault();
          duplicateSelection();
          return;
        }

        // 层级控制
        if ((e.metaKey || e.ctrlKey) && key === "]") {
          e.preventDefault();
          moveSelectionDepth(e.altKey ? "front" : "forward");
          return;
        }
        if ((e.metaKey || e.ctrlKey) && key === "[") {
          e.preventDefault();
          moveSelectionDepth(e.altKey ? "back" : "backward");
          return;
        }

        // T 键新增文本 (Figma 式快捷键)
        if (key === "t" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          addNewTextElement();
          return;
        }
        if (["r", "o", "l", "f"].includes(key) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          const kind = { r: "rectangle", o: "ellipse", l: "line", f: "frame" }[key];
          createCanvasObject(kind);
          return;
        }

        if (!state.picking || state.selected.length === 0) return;

        if (
          state.selected.length === 1 &&
          prefersInlineTextEdit(state.primary) &&
          (e.key === "Enter" || e.key === "F2") &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault();
          e.stopPropagation();
          startTextEdit(state.primary);
          return;
        }

        if (
          state.selected.length === 1 &&
          e.key === "Enter" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          enterSelectionChild(state.primary)
        ) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          e.stopPropagation();
          deleteSelected();
          return;
        }

        // 有选中时：Shift+方向键 = 大步移动；单独方向键 = 1px 移动
        const step = e.shiftKey ? 10 : 1;
        let moved = false;
        if (e.key === "ArrowLeft") {
          moveSelection(-step, 0);
          moved = true;
        }
        if (e.key === "ArrowRight") {
          moveSelection(step, 0);
          moved = true;
        }
        if (e.key === "ArrowUp") {
          moveSelection(0, -step);
          moved = true;
        }
        if (e.key === "ArrowDown") {
          moveSelection(0, step);
          moved = true;
        }
        if (moved) {
          e.preventDefault();
          e.stopPropagation();
          pushHistory();
          return;
        }

      },
      true,
    );
  }

  let resizeTimer = 0;

  function isTypingOrEditingTarget(target) {
    return !!(
      target?.isContentEditable ||
      target?.closest?.("input, textarea, select, [contenteditable='true'], [data-h5ve-editing='true']")
    );
  }

  function canvasZoomShortcut(event) {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
    const key = String(event.key || "").toLowerCase();
    const code = String(event.code || "");
    if (key === "+" || key === "=" || code === "NumpadAdd") return "in";
    if (key === "-" || key === "_" || code === "NumpadSubtract") return "out";
    if (!event.shiftKey && (key === "0" || code === "Digit0" || code === "Numpad0")) return "fit";
    if (!event.shiftKey && (key === "1" || code === "Digit1" || code === "Numpad1")) return "actual";
    return null;
  }

  function canvasViewportBounds() {
    const hasDeck = !!document.getElementById("deck");
    const left = navigatorReservedWidth(hasDeck);
    return {
      left,
      top: 0,
      right: Math.max(left, window.innerWidth - inspectorReservedWidth()),
      bottom: Math.max(0, window.innerHeight - inspectorReservedHeight()),
    };
  }

  function isCanvasViewportPoint(x, y) {
    const bounds = canvasViewportBounds();
    return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  }

  function canUseCanvasPan(e) {
    return !!(
      (getStage() || canPanContinuousCanvas()) &&
      state.picking &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isEditorNode(e.target) &&
      !isTypingOrEditingTarget(e.target) &&
      !document.querySelector("[data-h5ve-editing='true']")
    );
  }

  function isContinuousCanvas() {
    return document.documentElement.classList.contains("h5ve-continuous-mode");
  }

  function continuousCanvasOverflow(scale = state.scale) {
    if (!isContinuousCanvas()) return 0;
    const hasDeck = !!document.getElementById("deck");
    const availableWidth = Math.max(
      160,
      window.innerWidth - inspectorReservedWidth() - navigatorReservedWidth(hasDeck),
    );
    return Math.max(0, window.innerWidth * (Number(scale) || 1) - availableWidth);
  }

  function canPanContinuousCanvas() {
    return continuousCanvasOverflow() > 0.5;
  }

  function clampContinuousPanX(value, scale = state.scale) {
    const halfOverflow = continuousCanvasOverflow(scale) / 2;
    return Math.max(-halfOverflow, Math.min(halfOverflow, Number(value) || 0));
  }

  function panContinuousCanvasBy(deltaX) {
    if (!canPanContinuousCanvas()) return false;
    state.panX = clampContinuousPanX(state.panX + deltaX);
    state.panY = 0;
    applyCanvasScale();
    return true;
  }

  function canvasHorizontalOverflow(scale = state.scale) {
    if (isContinuousCanvas()) return continuousCanvasOverflow(scale);
    if (!getStage()) return 0;
    const metrics = canvasMetrics(scale);
    return Math.max(0, metrics.width - metrics.availW);
  }

  function clampCanvasHorizontalPan(value, scale = state.scale) {
    const halfOverflow = canvasHorizontalOverflow(scale) / 2;
    return Math.max(-halfOverflow, Math.min(halfOverflow, Number(value) || 0));
  }

  function panCanvasHorizontally(deltaX) {
    if (canvasHorizontalOverflow() <= 0.5) return false;
    state.panX = clampCanvasHorizontalPan(state.panX + deltaX);
    if (isContinuousCanvas()) state.panY = 0;
    applyCanvasScale();
    return true;
  }

  function endCanvasPan() {
    state.spacePressed = false;
    state.panning = false;
    document.documentElement.classList.remove("h5ve-space-pan", "h5ve-panning");
    document.body.style.userSelect = "";
  }

  function canvasMetrics(scale) {
    const hasDeck = !!document.getElementById("deck");
    const leftW = navigatorReservedWidth(hasDeck);
    const inspectorW = inspectorReservedWidth();
    const inspectorH = inspectorReservedHeight();
    const PAD = 20;
    const availW = Math.max(160, window.innerWidth - inspectorW - leftW - PAD * 2);
    const notesReserve = notesPanel && !isCompactWorkbench() ? NOTES_H + NOTES_GAP : 0;
    const availH = Math.max(120, window.innerHeight - inspectorH - PAD * 2 - notesReserve);
    const width = state.designWidth * scale;
    const height = state.designHeight * scale;
    return {
      leftW,
      availW,
      availH,
      width,
      height,
      left: leftW + PAD + (availW - width) / 2,
      top: PAD + (availH - height) / 2,
    };
  }

  function clampCanvasScale(value) {
    return Math.max(MIN_CANVAS_SCALE, Math.min(MAX_CANVAS_SCALE, Number(value) || state.fitScale || 1));
  }

  function updateZoomControls() {
    const value = sidebar?.querySelector(".h5ve-zoom-value");
    if (value) value.textContent = `${Math.round(state.scale * 100)}%`;
    const fit = sidebar?.querySelector('[data-action="zoom-fit"]');
    fit?.classList.toggle("active", state.zoomMode === "fit");
    const canPan = canvasHorizontalOverflow() > 0.5;
    sidebar?.querySelectorAll('[data-action="pan-left"], [data-action="pan-right"]').forEach((button) => {
      button.disabled = !canPan;
    });
  }

  function setCanvasScale(nextScale, anchor) {
    const stage = getStage();
    if (!stage) {
      state.zoomMode = "custom";
      state.canvasScale = clampCanvasScale(nextScale);
      applyCanvasScale();
      return;
    }
    const oldScale = state.scale || state.fitScale || 1;
    const oldRect = stage.getBoundingClientRect();
    const bounds = canvasViewportBounds();
    const point = anchor || {
      x: (bounds.left + bounds.right) / 2,
      y: (bounds.top + bounds.bottom - (notesPanel && !notesPanel.hidden ? NOTES_H : 0)) / 2,
    };
    const designX = (point.x - oldRect.left) / oldScale;
    const designY = (point.y - oldRect.top) / oldScale;
    const scale = clampCanvasScale(nextScale);
    const metrics = canvasMetrics(scale);
    state.zoomMode = "custom";
    state.canvasScale = scale;
    state.panX = point.x - designX * scale - metrics.left;
    state.panY = point.y - designY * scale - metrics.top;
    applyCanvasScale();
  }

  function stepCanvasZoom(direction) {
    const factor = direction > 0 ? 1.2 : 1 / 1.2;
    setCanvasScale(state.scale * factor);
  }

  function fitCanvasToViewport() {
    state.zoomMode = "fit";
    state.canvasScale = null;
    state.panX = 0;
    state.panY = 0;
    applyCanvasScale();
    showToast("画布已适配窗口");
  }

  function applyCanvasScale() {
    const hasDeck = !!document.getElementById("deck");
    const leftW = navigatorReservedWidth(hasDeck);
    const inspectorW = inspectorReservedWidth();
    const inspectorH = inspectorReservedHeight();
    const stage = getStage();
    document.documentElement.classList.add("h5ve-host");

    if (stage) {
	      // 设计舞台：不缩放 body，把 #stage 的真实设计尺寸等比 fit 进中间区域。
	      // stage 保持设计稿坐标尺寸，再用 transform:scale 缩放。
	      // 这样 stage 作为容器查询根的宽恒为设计稿宽，cqw 永远以设计稿宽解析，
	      //    PPT 里 clamp(下限px, Ncqw, 上限px) / max(下限px, Ncqw) 的固定 px 边界
	      //    会跟随 transform 一起等比缩放，小屏下不再被固定下限顶住而溢出舞台。
	      const designWidth = state.designWidth;
	      const designHeight = state.designHeight;
	      const PAD = 20;
	      const availW = Math.max(160, window.innerWidth - inspectorW - leftW - PAD * 2);
	      const notesReserve = notesPanel && !isCompactWorkbench() ? NOTES_H + NOTES_GAP : 0;
	      const availH = Math.max(120, window.innerHeight - inspectorH - PAD * 2 - notesReserve);
	      const fitScale = Math.min(availW / designWidth, availH / designHeight);
	      state.fitScale = fitScale;
	      const s = state.zoomMode === "fit" ? fitScale : clampCanvasScale(state.canvasScale || fitScale);
	      const w = Math.round(designWidth * s); // 缩放后的屏幕尺寸（仅用于居中定位与备注面板）
	      const h = Math.round(designHeight * s);
	      const stageLeft = leftW + PAD + (availW - w) / 2 + state.panX;
	      const stageTop = PAD + (availH - h) / 2 + state.panY;
	      if (!state.stageBg) {
	        const bg = getComputedStyle(document.body).backgroundColor;
	        state.stageBg = !bg || bg === "rgba(0, 0, 0, 0)" ? "#050505" : bg;
	      }
	      stage.style.position = "fixed";
	      stage.style.left = `${stageLeft}px`;
	      stage.style.top = `${stageTop}px`;
	      // stage 用设计稿真实尺寸，缩放交给 transform
	      stage.style.width = `${designWidth}px`;
	      stage.style.height = `${designHeight}px`;
      stage.style.right = "auto";
      stage.style.bottom = "auto";
      stage.style.transformOrigin = "top left";
      stage.style.transform = `scale(${s})`;
      stage.style.background = state.stageBg;
      stage.style.boxShadow = "0 12px 48px rgba(0, 0, 0, 0.55)";
      stage.style.borderRadius = `${Math.round(4 / s)}px`; // 抵消 scale，保持视觉圆角约 4px
	      stage.style.overflow = "hidden";
	      stage.style.containerType = "size";
      document.documentElement.classList.add("h5ve-stage-mode");
	      // stage 编辑模式下 body 无 transform，但 #stage 被 transform:scale(s) 缩放；
	      // state.scale 必须反映 stage 实际屏幕像素 / 设计稿像素，
	      // 这样拖拽/resize 时 dx/state.scale 才能正确换算回设计稿坐标。
	      state.scale = s;
	      document.documentElement.style.setProperty("--h5ve-scale", "1"); // body 不缩放
	      document.documentElement.style.setProperty("--h5ve-offset", "0px");
	      const notesLeft = Math.max(leftW + 12, Math.min(stageLeft, window.innerWidth - inspectorW - 232));
	      const notesWidth = Math.max(220, Math.min(w, window.innerWidth - inspectorW - notesLeft - 12));
	      const notesTop = Math.min(stageTop + h + NOTES_GAP, window.innerHeight - NOTES_H - 12);
	      positionNotesPanel(notesLeft, notesTop, notesWidth, NOTES_H);
	      const _targetIdx = getCurrentSlideIndex();
	      requestAnimationFrame(() => {
	        refreshDeckNavigation(_targetIdx);
	      });
	    } else {
	      const availableWidth = Math.max(160, window.innerWidth - inspectorW - leftW);
	      const fitScale = Math.max(MIN_CANVAS_SCALE, availableWidth / window.innerWidth);
	      state.fitScale = fitScale;
	      state.scale = state.zoomMode === "fit" ? fitScale : clampCanvasScale(state.canvasScale || fitScale);
	      state.panX = clampContinuousPanX(state.panX, state.scale);
	      state.panY = 0;
	      const canvasOffset = leftW + (availableWidth - window.innerWidth * state.scale) / 2;
	      document.documentElement.style.setProperty("--h5ve-scale", String(state.scale));
	      document.documentElement.style.setProperty("--h5ve-offset", `${canvasOffset + state.panX}px`);
        if (document.documentElement.classList.contains("h5ve-continuous-mode")) {
          const naturalHeight = Math.max(document.body.scrollHeight, document.body.offsetHeight);
          const scaledHeight = Math.max(window.innerHeight, Math.ceil(naturalHeight * state.scale));
          document.documentElement.style.setProperty("--h5ve-continuous-scroll-height", `${scaledHeight}px`);
        } else {
          document.documentElement.style.removeProperty("--h5ve-continuous-scroll-height");
        }
	      positionNotesPanel(
	        leftW + 20,
	        window.innerHeight - NOTES_H - 20,
	        Math.max(220, window.innerWidth - inspectorW - leftW - 40),
	        NOTES_H,
	      );
	    }
	    calibrateContinuousScrollOffset();
	    scheduleSelectionBox();
	    updateNotesPanel();
	    updateZoomControls();
	  }

  function scheduleCanvasScale() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(applyCanvasScale, 120);
  }

  let initialLayoutSettleTimer = 0;
  let initialContinuousHashAligned = false;

  function alignInitialContinuousHash() {
    if (initialContinuousHashAligned || !document.documentElement.classList.contains("h5ve-continuous-mode")) return;
    const rawHash = location.hash.slice(1);
    if (!rawHash) return;
    let id = rawHash;
    try { id = decodeURIComponent(rawHash); } catch { /* malformed hash: keep raw id */ }
    const target = document.getElementById(id);
    if (!target) return;
    initialContinuousHashAligned = true;
    requestAnimationFrame(() => target.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" }));
  }

  function settleInitialCanvasLayout() {
    const refit = () => {
      // 仅在用户仍处于「适配窗口」时自愈；不覆盖手动缩放和平移。
      if (state.zoomMode !== "fit") return;
      state.panX = 0;
      state.panY = 0;
      applyCanvasScale();
      alignInitialContinuousHash();
    };

    requestAnimationFrame(() => requestAnimationFrame(refit));
    clearTimeout(initialLayoutSettleTimer);
    initialLayoutSettleTimer = setTimeout(refit, 240);
  }

  function sanitizeInitialLayout() {
    const root = contentRoot();
    root.querySelectorAll("[data-anim]").forEach(el => {
      if (el.dataset.anim) {
        el.dataset.h5veAnimOriginal = el.dataset.anim;
        el.dataset.anim = "";
      }
    });
  }

  function init() {
    const isContinuousDocument = !document.getElementById("stage") && !document.getElementById("deck");
    document.documentElement.classList.toggle("h5ve-continuous-mode", isContinuousDocument);
    captureInitialDeckState();
    state.revisionPromise = loadDocumentRevision();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("editor.css?v=0.1.0", ASSET_BASE_URL).href;
    link.dataset.h5veRuntime = "";
    link.addEventListener("load", settleInitialCanvasLayout, { once: true });
    document.head.appendChild(link);

    injectUi();
    bindWorkbenchResizers();
    bindUi();
    bindEvents();
    installDeckNavBridge();
    renderSlideControls();
    renderSlidePanel();
    renderElementPanel();
    sanitizeInitialLayout();
    applyCanvasScale();
    refreshDeckNavigation(state.initialSlideIndex);
    settleInitialCanvasLayout();
    window.addEventListener("resize", scheduleCanvasScale);
    window.visualViewport?.addEventListener("resize", scheduleCanvasScale);
    if (document.readyState !== "complete") {
      window.addEventListener("load", settleInitialCanvasLayout, { once: true });
    }
    document.fonts?.ready.then(settleInitialCanvasLayout).catch(() => {});
    pushHistory({ autoSave: false, label: "打开页面" });
    state.recoveryDraft = readRecoveryDraft();
    safeStorageSet("h5ve-enabled", "1");
    if (state.recoveryDraft) {
      setSaveState("error", "有本地草稿");
      showToast("发现上次未保存草稿 · 点击红色状态查看恢复选项");
    } else {
      showToast("编辑模式已开启 · ⇧D 切换选择 · Ctrl / ⌘ / Shift 多选");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
