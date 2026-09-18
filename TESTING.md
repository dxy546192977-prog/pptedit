# Testing

PPTedit uses Node.js syntax checks plus integration tests for the installer, Next.js redirect helper, demo save contract, and asset boundary.

```bash
npm run check
npm test
```

The demo should also be checked in preview and edit modes at desktop and mobile viewport sizes. New editor behavior should include a focused regression assertion in `scripts/test-install-h5-editor.mjs` or a dedicated test file.

## Browser regression: nested groups and layer drag sorting

`scripts/test-layer-nested-group-browser.mjs` drives the editor in headless Chromium and covers:

- `⌘G` on a multi-selection inside an existing group creates a nested sub-group without pulling in unselected siblings.
- Click drill-down: first click selects the outermost group, each further click on the same spot steps one level deeper; `Shift`-click on a selected element (or its descendant) toggles that element off.
- `⌘⇧G` from a leaf dissolves only the innermost owning group; geometry is preserved at every step.
- Layer panel drag: dropping into a group (`inside` band), out to the root, and into the ambiguous gap below a nested block where the pointer X chooses the depth; invalid drops (a group onto its own child), no-op drops and `Esc` cancel leave the DOM untouched.

```bash
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs node scripts/test-layer-nested-group-browser.mjs
```

The script starts its own static server and needs no `channel: "chrome"`; it uses `keyboard.down/up` for modifier clicks because `mouse.click({ modifiers })` does not set `shiftKey` reliably in headless Chromium.

## Preview sidebar drag (cross-level) — live E2E

`scripts/test-preview-nav-drag-live.mjs` drives the **preview** sidebar (`#nav`, `assets/preview-nav-drag.js`)
against a real deck: out-of-chapter (left-biased gap), into-chapter-as-first (header hover), before-sibling,
into-chapter-end (right-biased gap), to-root, noop, Escape, post-drag click suppression, narrow sidebar, and a
drag-back restore. It writes through `/reorder` and asserts the deck ends in its original order.
Requires the deck served on :8775 and `serve-svg-editor.py` on :48766; chapter keys are deck-specific.

## Page-number reconciliation (order/level changes)

Runtime numbers (sidebar rows, chapter ranges, counter, stage SVG, editor thumbnails) are always computed
from the current position of a stable page id. `assets/preview-page-numbers.js` re-runs `reconcile()` on
`pptedit-order-changed` and on structural sidebar rebuilds, then `audit()`s that visible numbers are exactly
01..N with no duplicates/gaps (`host.auditPageNumbers()`); on drift it clears render stamps and re-renders.

On disk, each SVG's baked `<text id="page-number">` is rewritten by the editor server after `/reorder` and
`/delete-page` (only affected files; idempotent; backed up). `POST /renumber {fix}` audits (and optionally
fixes) the whole deck; the preview runs a read-only audit after load and repairs only if drift is found.
New revisions for rewritten files are returned and propagated to open editor frames so their next `/save`
does not 409. `python3 scripts/test-renumber.py` covers the text rewrite and page-id canonicalisation
(`"28.2"` string ids are coerced to numbers on both server and client).
