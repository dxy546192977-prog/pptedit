#!/usr/bin/env node

import { createHash } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_FILES = ["bootstrap.js", "editor.js", "editor.css"];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(skillRoot, "assets", "h5-editor");
const nextConfigWrapperMjsSource = path.join(
  skillRoot,
  "assets",
  "h5-editor-server",
  "next-config-wrapper.mjs",
);
const nextConfigWrapperCjsSource = path.join(
  skillRoot,
  "assets",
  "h5-editor-server",
  "next-config-wrapper.cjs",
);
const NEXT_CONFIG_CANDIDATES = [
  "next.config.ts",
  "next.config.mts",
  "next.config.mjs",
  "next.config.js",
  "next.config.cjs",
];

function usage(message) {
  if (message) console.error(message);
  console.error(
    "Usage: node scripts/install-h5-editor.mjs --target <project-root> [--check|--apply]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  let target = null;
  let mode = "check";
  let explicitMode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target") {
      target = argv[i + 1];
      i += 1;
    } else if (arg === "--check" || arg === "--apply") {
      const nextMode = arg.slice(2);
      if (explicitMode && explicitMode !== nextMode) usage("Choose only one of --check or --apply.");
      explicitMode = nextMode;
      mode = nextMode;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      usage(`Unknown argument: ${arg}`);
    }
  }
  if (!target) usage("--target is required.");
  return { target: path.resolve(target), mode };
}

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function compareFile(source, target) {
  const sourceBytes = await readFile(source);
  try {
    const targetBytes = await readFile(target);
    return {
      status: digest(sourceBytes) === digest(targetBytes) ? "identical" : "update",
      sourceBytes,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "add", sourceBytes };
    throw error;
  }
}

async function findNextConfig(target) {
  for (const file of NEXT_CONFIG_CANDIDATES) {
    const absolute = path.join(target, file);
    const info = await lstat(absolute).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (info?.isSymbolicLink()) {
      throw new Error(`Refusing to use a symbolic-link Next.js config: ${absolute}`);
    }
    if (info?.isFile()) return absolute;
  }
  return null;
}

async function detectNextProject(target) {
  if (await findNextConfig(target)) return true;
  try {
    const packageJson = JSON.parse(await readFile(path.join(target, "package.json"), "utf8"));
    return Boolean(packageJson?.dependencies?.next || packageJson?.devDependencies?.next);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function assertSafeDestination(target, destination) {
  const relative = path.relative(target, destination);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the target project: ${destination}`);
  }
  let current = target;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${current}`);
    }
  }
}

function patchNextConfig(source, helperKind) {
  if (/\bwithH5Editor\s*\(/.test(source)) return source;

  if (helperKind === "cjs") {
    const exportMatch =
      source.match(/module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?/) ||
      source.match(/module\.exports\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!exportMatch) return null;
    const importLine = 'const { withH5Editor } = require("./h5-editor.next-config.cjs");\n';
    const withImport = source.startsWith("#!")
      ? source.replace(/^(#![^\n]*\n)/, `$1${importLine}`)
      : importLine + source;
    return withImport.replace(exportMatch[0], `module.exports = withH5Editor(${exportMatch[1]});`);
  }

  const exportMatch =
    source.match(/export\s+default\s+([A-Za-z_$][\w$]*)\s*;?/) ||
    source.match(/export\s+default\s+(\{[\s\S]*\})\s*;?\s*$/);
  if (!exportMatch) return null;
  const importLine = 'import { withH5Editor } from "./h5-editor.next-config.mjs";\n';
  const withImport = source.startsWith("#!")
    ? source.replace(/^(#![^\n]*\n)/, `$1${importLine}`)
    : importLine + source;
  return withImport.replace(exportMatch[0], `export default withH5Editor(${exportMatch[1]});`);
}

async function planNextEditRoute(target, isNextProject) {
  if (!isNextProject) return null;
  const configPath = await findNextConfig(target);
  if (!configPath) {
    const destination = path.join(target, "next.config.mjs");
    const source =
      'import { withH5Editor } from "./h5-editor.next-config.mjs";\n\n' +
      "export default withH5Editor({});\n";
    return {
      status: "add",
      file: "Next.js /edit route",
      configPath: destination,
      configSource: source,
      helperKind: "mjs",
    };
  }

  const current = await readFile(configPath, "utf8");
  const helperKind = configPath.endsWith(".cjs") || /module\.exports\s*=/.test(current) ? "cjs" : "mjs";
  if (/\bwithH5Editor\s*\(/.test(current)) {
    const helperSource = helperKind === "cjs" ? nextConfigWrapperCjsSource : nextConfigWrapperMjsSource;
    const helperDestination = path.join(
      target,
      helperKind === "cjs" ? "h5-editor.next-config.cjs" : "h5-editor.next-config.mjs",
    );
    const comparison = await compareFile(helperSource, helperDestination);
    return {
      status: comparison.status,
      file: "Next.js /edit route",
      configPath,
      configSource: current,
      helperKind,
    };
  }
  const patched = patchNextConfig(current, helperKind);
  if (!patched) {
    const instruction = helperKind === "cjs"
      ? 'const { withH5Editor } = require("./h5-editor.next-config.cjs"); then export withH5Editor(yourConfig).'
      : 'import { withH5Editor } from "./h5-editor.next-config.mjs"; then export default withH5Editor(yourConfig).';
    return {
      status: "manual",
      file: "Next.js /edit route",
      configPath,
      configSource: current,
      helperKind,
      error:
        `Cannot safely update ${path.basename(configPath)} automatically. ` + instruction,
    };
  }
  return {
    status: "update",
    file: "Next.js /edit route",
    configPath,
    configSource: patched,
    helperKind,
  };
}

async function main() {
  const { target: requestedTarget, mode } = parseArgs(process.argv.slice(2));
  const targetInfo = await stat(requestedTarget).catch(() => null);
  if (!targetInfo?.isDirectory()) usage(`Target directory does not exist: ${requestedTarget}`);
  const target = await realpath(requestedTarget);
  await access(sourceDir).catch(() => usage(`Skill assets are missing: ${sourceDir}`));

  const destinationDir = path.join(target, "public", "h5-editor");
  const managedFiles = PUBLIC_FILES.map((file) => ({
    file: `public/h5-editor/${file}`,
    source: path.join(sourceDir, file),
    destination: path.join(destinationDir, file),
  }));
  const editRoutePlan = await planNextEditRoute(target, await detectNextProject(target));

  const results = [];
  for (const managed of managedFiles) {
    const { file, source, destination } = managed;
    const comparison = await compareFile(source, destination);
    results.push({ file, source, destination, ...comparison });
  }

  const changed = results.filter((result) => result.status !== "identical");
  results.forEach((result) => console.log(`${result.status.padEnd(9)} ${result.file}`));
  if (editRoutePlan) console.log(`${editRoutePlan.status.padEnd(9)} ${editRoutePlan.file}`);

  const routeChanged = editRoutePlan && editRoutePlan.status !== "identical";
  const manualRoute = editRoutePlan?.status === "manual";

  if (mode === "check") {
    if (manualRoute) console.error(editRoutePlan.error);
    if (changed.length || routeChanged) {
      const total = changed.length + (routeChanged ? 1 : 0);
      console.error(`H5 editor differs in ${total} item(s). Run again with --apply to sync.`);
      process.exitCode = 1;
    } else {
      console.log("H5 editor is up to date.");
    }
    return;
  }

  for (const result of changed) {
    await assertSafeDestination(target, result.destination);
    await mkdir(path.dirname(result.destination), { recursive: true });
    await copyFile(result.source, result.destination);
  }
  if (routeChanged) {
    const helperSource =
      editRoutePlan.helperKind === "cjs" ? nextConfigWrapperCjsSource : nextConfigWrapperMjsSource;
    const helperDestination = path.join(
      target,
      editRoutePlan.helperKind === "cjs" ? "h5-editor.next-config.cjs" : "h5-editor.next-config.mjs",
    );
    await assertSafeDestination(target, helperDestination);
    await copyFile(helperSource, helperDestination);
    if (!manualRoute) {
      await assertSafeDestination(target, editRoutePlan.configPath);
      await writeFile(editRoutePlan.configPath, editRoutePlan.configSource, "utf8");
    }
  }
  console.log(
    `Applied ${changed.length} managed H5 editor file(s)` +
      `${routeChanged && !manualRoute ? " and the Next.js /edit route" : ""} to ${target}.`,
  );
  if (manualRoute) {
    console.error(editRoutePlan.error);
    console.error("The editor assets and Next.js helper were installed; only the config wrapper remains manual.");
    process.exitCode = 1;
  }
}

await main();
