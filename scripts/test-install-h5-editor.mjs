#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const installer = path.join(scriptDir, "install-h5-editor.mjs");
const wrapper = await import(
  pathToFileURL(path.join(skillRoot, "assets", "h5-editor-server", "next-config-wrapper.mjs"))
);
const require = createRequire(import.meta.url);
const cjsWrapper = require(path.join(skillRoot, "assets", "h5-editor-server", "next-config-wrapper.cjs"));
const editorSource = await readFile(path.join(skillRoot, "assets", "h5-editor", "editor.js"), "utf8");
const editorCssSource = await readFile(path.join(skillRoot, "assets", "h5-editor", "editor.css"), "utf8");
const bootstrapSource = await readFile(path.join(skillRoot, "assets", "h5-editor", "bootstrap.js"), "utf8");

assert.match(editorSource, /axis === "width" && explicit === "fill"/);
assert.match(editorSource, /<option value="fill"/);
assert.match(editorSource, /function canUseWidthMode\(el\)/);
assert.match(editorSource, /function isStandaloneTextWidthElement\(el, computedStyle = null\)/);
assert.match(editorSource, /const STANDALONE_TEXT_WIDTH_TAGS = new Set/);
assert.match(editorSource, /setManagedSizeStyle\(el, "width", "100%"\)/);
assert.match(editorSource, /setManagedSizeStyle\(el, styleProp, axis === "width" \? "fit-content" : "auto"\)/);
assert.match(editorSource, /applyStandaloneTextAutoHeight\(el\)/);
assert.match(editorSource, /function syncDimensionModeControl\(el, axis, mode\)/);
assert.match(editorSource, /hasModuleRole \|\| hasLayoutBox \|\| hasVisibleSurface/);
assert.match(editorSource, /"宽度模式：固定 \/ 适应内容 \/ 填充父级"/);
assert.match(editorSource, /isStandaloneTextWidth \? `<option value="hug"/);
assert.match(editorSource, /value: el\.style\.getPropertyValue\(cssName\)/);
assert.match(editorSource, /priority: el\.style\.getPropertyPriority\(cssName\)/);
assert.match(editorSource, /const shouldWriteWidth = hasX \|\| \(preserveAspect && hasY\)/);
assert.match(editorSource, /const shouldWriteHeight = hasY \|\| \(event\.shiftKey && hasX\)/);
assert.match(editorSource, /el\.style\.gridColumnEnd = "-1"/);
assert.match(editorSource, /el\.style\.flexGrow = "1"/);
assert.match(editorSource, /function textAlignmentIcon\(align\)/);
assert.match(editorSource, /class="h5ve-text-align-icon"/);
assert.match(editorSource, /data-text-align="left"[^>]+aria-label="左对齐"/);
assert.match(editorSource, /data-multi-text-align="right"[^>]+aria-label="右对齐"/);
assert.doesNotMatch(editorSource, /data-(?:multi-)?text-align="(?:left|center|right)"[^>]*>[LCR]<\/button>/);
assert.match(editorSource, /function isAdditiveSelectionEvent\(event\)/);
assert.match(editorSource, /event\?\.shiftKey \|\| event\?\.metaKey \|\| event\?\.ctrlKey/);
assert.match(editorSource, /const additiveSelection = isAdditiveSelectionEvent\(e\)/);
assert.match(editorSource, /state\.marqueeAdditive = true/);
assert.match(editorSource, /Ctrl \/ ⌘ \/ Shift 多选 · 修饰键拖拽追加框选/);
assert.match(editorSource, /const FONT_WEIGHT_CHOICES = \[/);
assert.match(editorSource, /function fontWeightSelectMarkup\(id, value, options = \{\}\)/);
assert.match(editorSource, /fontWeightSelectMarkup\("h5ve-f-font-weight"/);
assert.match(editorSource, /candidate\.style\.fontWeight = String\(value\)/);
assert.match(editorSource, /el\.style\.fontWeight = String\(value\)/);
assert.match(editorCssSource, /\.h5ve-font-weight-control/);
assert.match(editorSource, /const inspectorPanel = document\.getElementById\("h5ve-panel"\)/);
assert.match(editorSource, /if \(inspectorPanel\) inspectorPanel\.scrollTop = 0/);
assert.match(editorSource, /if \(style\.display === "contents"\) return \[\.\.\.el\.children\]\.some\(isVisibleLayerElement\)/);
assert.match(editorSource, /function selectionHierarchy\(el\) \{\s+const root = currentSlide\(\) \|\| contentRoot\(\)/);
assert.match(editorSource, /function selectionParentElement\(el\) \{\s+const root = currentSlide\(\) \|\| contentRoot\(\)/);
assert.match(editorSource, /function setFrameSpacingValues\(el, values\)/);
assert.match(editorSource, /id="h5ve-f-padding-x"/);
assert.match(editorSource, /id="h5ve-f-margin-y"/);
assert.match(editorSource, /id="h5ve-f-spacing-mode"/);
assert.match(editorSource, /paddingX: \{ properties: \["paddingLeft", "paddingRight"\]/);
assert.match(editorSource, /marginY: \{ properties: \["marginTop", "marginBottom"\]/);
assert.match(editorCssSource, /\.h5ve-spacing-axis-grid/);
assert.match(editorCssSource, /\.h5ve-spacing-detail\[hidden\]/);
assert.match(editorCssSource, /\.h5ve-inspector-section\s*\{[^}]*margin:\s*0;[^}]*max-width:\s*none;/s);
assert.match(editorCssSource, /\.h5ve-inspector-section::before,[\s\S]*content:\s*none;/);
assert.match(bootstrapSource, /function installResponsiveFrameFill\(\)/);
assert.match(bootstrapSource, /Math\.min\(count, entry\.preferred\)/);
assert.match(bootstrapSource, /p\.get\("edit"\) === "1"/);
assert.match(bootstrapSource, /new URL\("\.\", bootstrapScript\.src\)/);
assert.match(bootstrapSource, /data-h5ve-runtime/);
assert.match(editorSource, /PARAM\.get\("edit"\) === "1"/);
assert.match(editorSource, /candidate\.origin === location\.origin/);
assert.match(editorSource, /credentials: "same-origin"/);
assert.match(editorSource, /function safeStorageGet\(key\)/);
assert.match(editorSource, /const managedTransform = n\.style\.getPropertyValue\("--h5ve-force-transform"\)/);
assert.match(editorSource, /managedTransform &&/);
assert.match(editorSource, /function sanitizeClipboardElement\(root\)/);
assert.match(editorSource, /function sanitizeImportedSvg\(root\)/);
assert.match(editorSource, /function escapeHtmlText\(value\)/);
assert.match(editorSource, /\[data-h5ve-runtime\]/);
assert.match(editorSource, /node\.setAttribute\("data-anim", node\.getAttribute\("data-h5ve-anim-original"\)/);
assert.match(editorSource, /querySelectorAll\(":scope > \.slide, :scope > section"\)/);
assert.match(editorSource, /document\.querySelector\("\[data-h5ve-slide-nav\]"\)/);
assert.match(editorSource, /slide\.querySelector\("\[data-h5ve-page-number\]"\)/);
assert.match(editorSource, /\[data-h5ve-speaker-note\], \[data-h5ve-structural\]/);
assert.doesNotMatch(editorSource, /aside\.speaker-note, \.chrome, \.foot/);
assert.match(bootstrapSource, /document\.querySelector\("\[data-h5ve-slide-nav\]"\)/);
assert.match(bootstrapSource, /slide\.querySelector\("\[data-h5ve-page-number\]"\)/);
assert.match(bootstrapSource, /document\.querySelector\("\[data-h5ve-live-status\]"\)/);
assert.match(editorSource, /function replaceMappedCssIds\(value, idMap\)/);
assert.match(editorSource, /styleNode\.dataset\.h5veDuplicateIdStyles/);
assert.match(editorSource, /rewriteDuplicateSlideIds\(clone, slide\)/);
assert.match(editorSource, /escapeHtmlText\(labelFor\(el\)\)/);
assert.match(editorSource, /function safeEditableHref\(value\)/);
assert.match(editorSource, /\["http", "https", "mailto", "tel"\]\.includes\(scheme\)/);
assert.doesNotMatch(
  editorSource,
  /matches\("script, style, link, meta, noscript, iframe, \.speaker-note, #nav, #overview"\)/,
);

const wrapped = wrapper.withH5Editor({
  trailingSlash: true,
  async rewrites() {
    return [{ source: "/legacy", destination: "/current" }];
  },
  async redirects() {
    return [{ source: "/gone", destination: "/current", permanent: true }];
  },
});
const redirects = await wrapped.redirects();
assert.deepEqual(redirects, [
  {
    source: "/:path*/:page([^/]+\\.html)/edit/",
    destination: "/:path*/:page?edit=1",
    permanent: false,
  },
  {
    source: "/:page([^/]+\\.html)/edit/",
    destination: "/:page?edit=1",
    permanent: false,
  },
  {
    source: "/:path*/:page([^/]+\\.html)/edit",
    destination: "/:path*/:page?edit=1",
    permanent: false,
  },
  {
    source: "/:page([^/]+\\.html)/edit",
    destination: "/:page?edit=1",
    permanent: false,
  },
  { source: "/gone", destination: "/current", permanent: true },
]);
assert.deepEqual(await wrapped.rewrites(), [{ source: "/legacy", destination: "/current" }]);

const cjsWrapped = cjsWrapper.withH5Editor({
  async redirects() {
    return [{ source: "/old", destination: "/new", permanent: true }];
  },
});
const cjsRedirects = await cjsWrapped.redirects();
assert.equal(cjsRedirects.length, 5);
assert.deepEqual(cjsRedirects.at(-1), { source: "/old", destination: "/new", permanent: true });

const functionalConfig = wrapper.withH5Editor(async (phase) => ({
  phase,
  reactStrictMode: true,
  async redirects() {
    return [{ source: "/function-old", destination: "/function-new", permanent: true }];
  },
}));
const resolvedFunctionalConfig = await functionalConfig("phase-production-build");
assert.equal(resolvedFunctionalConfig.phase, "phase-production-build");
assert.equal(resolvedFunctionalConfig.reactStrictMode, true);
assert.equal((await resolvedFunctionalConfig.redirects()).length, 5);
assert.deepEqual((await resolvedFunctionalConfig.redirects()).at(-1), {
  source: "/function-old",
  destination: "/function-new",
  permanent: true,
});

const staticExportConfig = { output: "export", trailingSlash: true };
assert.strictEqual(wrapper.withH5Editor(staticExportConfig), staticExportConfig);
const functionalStaticExport = wrapper.withH5Editor(async () => ({ output: "export", images: { unoptimized: true } }));
const resolvedStaticExport = await functionalStaticExport("phase-production-build");
assert.equal(resolvedStaticExport.output, "export");
assert.equal(resolvedStaticExport.images.unoptimized, true);
assert.equal("redirects" in resolvedStaticExport, false);

const fixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-install-"));
try {
  await mkdir(path.join(fixture, "pages"), { recursive: true });
  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ dependencies: { next: "latest" } }),
    "utf8",
  );
  await writeFile(
    path.join(fixture, "next.config.mjs"),
    "export default { trailingSlash: true, async redirects() { return [{ source: '/profile/edit', destination: '/profile?edit=1', permanent: false }]; } };\n",
    "utf8",
  );

  const initialCheck = spawnSync(process.execPath, [installer, "--target", fixture, "--check"], {
    encoding: "utf8",
  });
  assert.equal(initialCheck.status, 1);
  assert.match(initialCheck.stderr, /Run again with --apply to sync\./);

  const apply = spawnSync(process.execPath, [installer, "--target", fixture, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  const config = await readFile(path.join(fixture, "next.config.mjs"), "utf8");
  assert.match(config, /export default withH5Editor\(\{ trailingSlash: true/);
  await readFile(path.join(fixture, "public", "h5-editor", "editor.js"), "utf8");
  await assert.rejects(
    readFile(path.join(fixture, "src", "app", "api", "h5-editor", "publish", "route.ts"), "utf8"),
    (error) => error?.code === "ENOENT",
  );

  const check = spawnSync(process.execPath, [installer, "--target", fixture, "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.match(check.stdout, /H5 editor is up to date\./);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const cjsFixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-cjs-install-"));
try {
  await writeFile(
    path.join(cjsFixture, "package.json"),
    JSON.stringify({ devDependencies: { next: "latest" } }),
    "utf8",
  );
  await writeFile(path.join(cjsFixture, "next.config.cjs"), "module.exports = { reactStrictMode: true };\n", "utf8");
  const apply = spawnSync(process.execPath, [installer, "--target", cjsFixture, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  const config = await readFile(path.join(cjsFixture, "next.config.cjs"), "utf8");
  assert.match(config, /require\("\.\/h5-editor\.next-config\.cjs"\)/);
  assert.match(config, /module\.exports = withH5Editor\(\{ reactStrictMode: true \}\);/);
} finally {
  await rm(cjsFixture, { recursive: true, force: true });
}

const staticFixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-static-install-"));
try {
  await mkdir(path.join(staticFixture, "src", "app"), { recursive: true });
  const apply = spawnSync(process.execPath, [installer, "--target", staticFixture, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(apply.status, 0, apply.stderr || apply.stdout);
  await readFile(path.join(staticFixture, "public", "h5-editor", "bootstrap.js"), "utf8");
  await assert.rejects(
    readFile(path.join(staticFixture, "next.config.mjs"), "utf8"),
    (error) => error?.code === "ENOENT",
  );
} finally {
  await rm(staticFixture, { recursive: true, force: true });
}

const manualConfigFixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-manual-config-"));
try {
  await writeFile(
    path.join(manualConfigFixture, "package.json"),
    JSON.stringify({ dependencies: { next: "latest" } }),
    "utf8",
  );
  const manualConfig = "export default (phase) => ({ phase, reactStrictMode: true });\n";
  await writeFile(path.join(manualConfigFixture, "next.config.mjs"), manualConfig, "utf8");
  const apply = spawnSync(process.execPath, [installer, "--target", manualConfigFixture, "--apply"], {
    encoding: "utf8",
  });
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /only the config wrapper remains manual/i);
  assert.match(apply.stderr, /import \{ withH5Editor \}/);
  await readFile(path.join(manualConfigFixture, "public", "h5-editor", "editor.js"), "utf8");
  await readFile(path.join(manualConfigFixture, "h5-editor.next-config.mjs"), "utf8");
  assert.equal(await readFile(path.join(manualConfigFixture, "next.config.mjs"), "utf8"), manualConfig);
} finally {
  await rm(manualConfigFixture, { recursive: true, force: true });
}

const symlinkFixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-symlink-install-"));
const outsideFixture = await mkdtemp(path.join(os.tmpdir(), "h5-editor-symlink-outside-"));
try {
  await mkdir(path.join(symlinkFixture, "public"), { recursive: true });
  await symlink(outsideFixture, path.join(symlinkFixture, "public", "h5-editor"), "dir");
  const apply = spawnSync(process.execPath, [installer, "--target", symlinkFixture, "--apply"], {
    encoding: "utf8",
  });
  assert.notEqual(apply.status, 0);
  assert.match(apply.stderr, /symbolic link/i);
  assert.deepEqual(await readdir(outsideFixture), []);
} finally {
  await rm(symlinkFixture, { recursive: true, force: true });
  await rm(outsideFixture, { recursive: true, force: true });
}

console.log("H5 editor installer and /edit redirect tests passed.");
