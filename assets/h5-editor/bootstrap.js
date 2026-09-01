/**
 * Bootstrap: use ?edit=1 or a host-provided /edit entry to enable the editor.
 * Add to any static H5 page before </body>:
 *   <script src="/h5-editor/bootstrap.js"></script>
 */
(function () {
  var bootstrapScript = document.currentScript;
  var assetBase = bootstrapScript && bootstrapScript.src
    ? new URL(".", bootstrapScript.src).href
    : new URL("/h5-editor/", location.origin).href;
  var saveEndpoint = bootstrapScript && bootstrapScript.getAttribute("data-h5ve-save-endpoint");
  var p = new URLSearchParams(location.search);
  var suffixEdit = /\/edit\/?$/.test(location.pathname);
  var wantEdit = p.get("edit") === "1" || suffixEdit;

  function installResponsiveFrameFill() {
    var frameFillRaf = 0;
    var parentObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleFrameFill) : null;
    var observedParents = typeof WeakSet === "function" ? new WeakSet() : null;

    function gridTrackCount(value) {
      var tokens = [];
      var depth = 0;
      var token = "";
      String(value || "").split("").forEach(function (character) {
        if (/\s/.test(character) && depth === 0) {
          if (token) tokens.push(token);
          token = "";
          return;
        }
        if (character === "(") depth += 1;
        else if (character === ")") depth = Math.max(0, depth - 1);
        token += character;
      });
      if (token) tokens.push(token);
      return tokens.filter(function (track) {
        var size = Number.parseFloat(track);
        return Number.isFinite(size) && size > 0;
      }).length;
    }

    function syncFrameFill() {
      frameFillRaf = 0;
      var elements = Array.prototype.slice.call(
        document.querySelectorAll('[data-h5ve-width-mode="fill"][data-h5ve-width-fill-layout="grid"]'),
      );
      var entries = elements.map(function (element) {
        var preferred = Number(element.getAttribute("data-h5ve-width-fill-grid-start")) ||
          Number(element.style.gridColumnStart) || 1;
        element.style.removeProperty("grid-column-start");
        element.style.removeProperty("grid-column-end");
        return { element: element, parent: element.parentElement, preferred: preferred };
      });
      var parentColumns = new Map();
      entries.forEach(function (entry) {
        if (!entry.parent || parentColumns.has(entry.parent)) return;
        var parentStyle = getComputedStyle(entry.parent);
        var display = parentStyle.display;
        var count = display === "grid" || display === "inline-grid"
          ? Math.max(1, gridTrackCount(parentStyle.gridTemplateColumns))
          : 0;
        parentColumns.set(entry.parent, count);
        if (parentObserver && observedParents && !observedParents.has(entry.parent)) {
          observedParents.add(entry.parent);
          parentObserver.observe(entry.parent);
        }
      });
      entries.forEach(function (entry) {
        var count = parentColumns.get(entry.parent) || 0;
        if (!count) return;
        var start = Math.max(1, Math.min(count, entry.preferred));
        if (entry.element.getAttribute("data-h5ve-width-fill-grid-start") !== String(entry.preferred)) {
          entry.element.setAttribute("data-h5ve-width-fill-grid-start", String(entry.preferred));
        }
        entry.element.style.gridColumnStart = String(start);
        entry.element.style.gridColumnEnd = "-1";
      });
    }

    function scheduleFrameFill() {
      if (frameFillRaf) return;
      frameFillRaf = requestAnimationFrame(syncFrameFill);
    }

    function startFrameFill() {
      syncFrameFill();
      if (typeof MutationObserver === "function") {
        new MutationObserver(scheduleFrameFill).observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: [
            "data-h5ve-width-mode",
            "data-h5ve-width-fill-layout",
            "data-h5ve-width-fill-grid-start",
          ],
        });
      }
      window.addEventListener("resize", scheduleFrameFill, { passive: true });
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startFrameFill, { once: true });
    } else {
      startFrameFill();
    }
  }

  installResponsiveFrameFill();

  function installSkippedSlidePreview() {
    var deck = document.getElementById("deck");
    if (!deck) return false;
    var slides = Array.prototype.slice.call(deck.querySelectorAll(":scope > .slide"));
    var visible = slides.filter(function (slide) {
      return slide.getAttribute("data-h5ve-slide-hidden") !== "1";
    });
    if (!visible.length || visible.length === slides.length) return false;

    document.documentElement.classList.add("h5ve-skip-preview");
    var style = document.createElement("style");
    style.setAttribute("data-h5ve-skip-preview", "");
    style.textContent = "html.h5ve-skip-preview #deck>.slide[data-h5ve-slide-hidden='1']{display:none!important}";
    document.head.appendChild(style);

    var stage = document.getElementById("stage");
    var status = document.querySelector("[data-h5ve-live-status]");
    var nav = document.querySelector("[data-h5ve-slide-nav]");
    var startX = 0;
    var startY = 0;
    var physicalIndex = 0;
    var width = Number(stage && stage.getAttribute("data-h5ve-width")) || Number(visible[0].offsetWidth) || innerWidth || 1;

    function nearestVisible(index, direction) {
      var bounded = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
      if (visible.indexOf(slides[bounded]) >= 0) return bounded;
      var step = direction < 0 ? -1 : 1;
      for (var cursor = bounded + step; cursor >= 0 && cursor < slides.length; cursor += step) {
        if (visible.indexOf(slides[cursor]) >= 0) return cursor;
      }
      for (var fallback = bounded - step; fallback >= 0 && fallback < slides.length; fallback -= step) {
        if (visible.indexOf(slides[fallback]) >= 0) return fallback;
      }
      return slides.indexOf(visible[0]);
    }

    function syncChromeNumbers() {
      visible.forEach(function (slide, index) {
        var pageSlot = slide.querySelector("[data-h5ve-page-number]");
        if (!pageSlot) return;
        pageSlot.textContent = String(index + 1).padStart(2, "0") + " / " + visible.length;
      });
    }

    function renderNav() {
      if (!nav) return;
      nav.innerHTML = "";
      visible.forEach(function (slide, index) {
        var rawIndex = slides.indexOf(slide);
        var button = document.createElement("button");
        button.type = "button";
        button.className = "dot";
        button.setAttribute("data-i", String(rawIndex));
        button.setAttribute("aria-label", "Page " + (index + 1));
        button.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopImmediatePropagation();
          goTo(rawIndex);
        });
        nav.appendChild(button);
      });
    }

    function syncPresentation(index) {
      physicalIndex = nearestVisible(index, index >= physicalIndex ? 1 : -1);
      var activeSlide = slides[physicalIndex];
      var visibleIndex = visible.indexOf(activeSlide);
      deck.style.width = (visible.length * width) + "px";
      deck.style.transform = "translate3d(" + (-visibleIndex * width) + "px,0,0)";
      slides.forEach(function (slide, rawIndex) {
        slide.setAttribute("aria-hidden", rawIndex === physicalIndex ? "false" : "true");
        slide.querySelectorAll("video").forEach(function (video) {
          if (rawIndex !== physicalIndex) {
            video.pause();
            try { video.currentTime = 0; } catch (error) { /* media may not be ready */ }
          } else if (video.paused) {
            video.play().catch(function () {});
          }
        });
      });
      if (status) status.textContent = "第 " + (visibleIndex + 1) + " 页，共 " + visible.length + " 页";
      if (nav) {
        nav.querySelectorAll(".dot").forEach(function (dot) {
          dot.classList.toggle("active", Number(dot.getAttribute("data-i")) === physicalIndex);
        });
      }
      window.__currentSlideIndex = physicalIndex;
      try {
        if (window.__playSlide) window.__playSlide(physicalIndex);
      } catch (error) { /* optional host hook */ }
      history.replaceState(null, "", location.pathname + location.search + "#" + (physicalIndex + 1));
      return physicalIndex;
    }

    function goTo(index) {
      return syncPresentation(nearestVisible(index, index >= physicalIndex ? 1 : -1));
    }

    function step(delta) {
      var position = visible.indexOf(slides[physicalIndex]);
      var next = Math.max(0, Math.min(visible.length - 1, position + delta));
      return goTo(slides.indexOf(visible[next]));
    }

    document.addEventListener("keydown", function (event) {
      if (event.target && event.target.closest && event.target.closest("input, textarea, select, [contenteditable='true']")) return;
      var forward = ["ArrowRight", "ArrowDown", "PageDown", " "].indexOf(event.key) >= 0;
      var backward = ["ArrowLeft", "ArrowUp", "PageUp"].indexOf(event.key) >= 0;
      if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Home") goTo(slides.indexOf(visible[0]));
      else if (event.key === "End") goTo(slides.indexOf(visible[visible.length - 1]));
      else step(forward ? 1 : -1);
    }, true);

    document.addEventListener("touchstart", function (event) {
      if (!event.changedTouches || !event.changedTouches[0]) return;
      startX = event.changedTouches[0].clientX;
      startY = event.changedTouches[0].clientY;
    }, { capture: true, passive: true });
    document.addEventListener("touchend", function (event) {
      if (!event.changedTouches || !event.changedTouches[0]) return;
      var dx = event.changedTouches[0].clientX - startX;
      var dy = event.changedTouches[0].clientY - startY;
      if (Math.abs(dx) <= 52 || Math.abs(dx) <= Math.abs(dy) * 1.25) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      step(dx < 0 ? 1 : -1);
    }, { capture: true, passive: false });

    renderNav();
    syncChromeNumbers();
    var hashIndex = Number(location.hash.slice(1));
    var hostIndex = Number(window.__currentSlideIndex);
    physicalIndex = nearestVisible((hashIndex > 0 ? hashIndex : Number.isFinite(hostIndex) ? hostIndex + 1 : 1) - 1, 1);
    window.__h5veSkippedSlidePreview = {
      goTo: goTo,
      step: step,
      getIndex: function () { return physicalIndex; },
      getTotal: function () { return visible.length; },
    };
    window.__pptGoSlide = goTo;
    window.__pptSyncDeckTransform = goTo;
    requestAnimationFrame(function () { syncPresentation(physicalIndex); });
    return true;
  }

  // ── 单页自愈（防止多页 deck 编辑态经 localStorage 粘到本单页）──
  try {
    if (!wantEdit && localStorage.getItem("h5ve-enabled") === "1") {
      localStorage.removeItem("h5ve-enabled");
    }
    if (!document.getElementById("deck")) {
      try { delete window.__currentSlideIndex; } catch (e) { window.__currentSlideIndex = undefined; }
    }
  } catch (e) { /* localStorage 不可用时忽略 */ }

  if (!wantEdit) {
    installSkippedSlidePreview();
    return;
  }
  var s = document.createElement("script");
  s.src = new URL("editor.js?v=0.1.0", assetBase).href;
  if (saveEndpoint) s.setAttribute("data-h5ve-save-endpoint", new URL(saveEndpoint, location.href).href);
  s.setAttribute("data-h5ve-runtime", "");
  s.defer = true;
  document.head.appendChild(s);
})();
