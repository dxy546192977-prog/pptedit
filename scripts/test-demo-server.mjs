#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(scriptDir, "..", "demo", "server.mjs");
const child = spawn(process.execPath, [serverPath], {
  env: { ...process.env, PORT: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const baseUrl = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Demo server did not start. ${stderr}`)), 5000);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const match = chunk.match(/PPTedit demo: (http:\/\/127\.0\.0\.1:\d+)\/demo\//);
    if (!match) return;
    clearTimeout(timeout);
    resolve(match[1]);
  });
  child.once("exit", (code) => {
    clearTimeout(timeout);
    reject(new Error(`Demo server exited early with code ${code}. ${stderr}`));
  });
});

function requestStatusWithHost(target, host) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: { Host: host },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
  });
}

try {
  const pageResponse = await fetch(`${baseUrl}/demo/`);
  assert.equal(pageResponse.status, 200);
  const originalHtml = await pageResponse.text();
  assert.match(originalHtml, /PPTedit Demo/);

  assert.equal(await requestStatusWithHost(`${baseUrl}/demo/`, "evil.invalid"), 403);
  assert.equal(await requestStatusWithHost(`${baseUrl}/demo/`, "%"), 400);
  assert.equal((await fetch(`${baseUrl}/demo/`)).status, 200);

  const editEntryResponse = await fetch(`${baseUrl}/demo/edit`, { redirect: "manual" });
  assert.equal(editEntryResponse.status, 307);
  assert.equal(editEntryResponse.headers.get("location"), "/demo/?edit=1");
  const editPageResponse = await fetch(`${baseUrl}/demo/edit`);
  assert.equal(editPageResponse.url, `${baseUrl}/demo/?edit=1`);
  assert.match(await editPageResponse.text(), /src="\.\.\/h5-editor\/bootstrap\.js"/);

  const revisionResponse = await fetch(`${baseUrl}/api/h5-editor/save/?path=%2Fdemo%2Findex.html`);
  assert.equal(revisionResponse.status, 200);
  const { revision } = await revisionResponse.json();
  assert.match(revision, /^[a-f0-9]{64}$/);

  const changedHtml = originalHtml.replace("Build web stories, visually.", "Edit real HTML, visually.");
  assert.notEqual(changedHtml, originalHtml);
  const textPlainResponse = await fetch(`${baseUrl}/api/h5-editor/save/`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ path: "/demo/index.html", html: changedHtml, revision }),
  });
  assert.equal(textPlainResponse.status, 415);

  const crossOriginResponse = await fetch(`${baseUrl}/api/h5-editor/save/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://example.invalid" },
    body: JSON.stringify({ path: "/demo/index.html", html: changedHtml, revision }),
  });
  assert.equal(crossOriginResponse.status, 403);

  const missingRevisionResponse = await fetch(`${baseUrl}/api/h5-editor/save/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/demo/index.html", html: changedHtml }),
  });
  assert.equal(missingRevisionResponse.status, 409);
  assert.equal((await missingRevisionResponse.json()).revision, revision);

  const saveResponse = await fetch(`${baseUrl}/api/h5-editor/save/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/demo/index.html", html: changedHtml, revision }),
  });
  assert.equal(saveResponse.status, 200);
  const saved = await saveResponse.json();
  assert.equal(saved.persisted, true);
  assert.equal(saved.storage, "memory");

  const refreshedHtml = await (await fetch(`${baseUrl}/demo/`)).text();
  assert.match(refreshedHtml, /Edit real HTML, visually\./);

  const conflictResponse = await fetch(`${baseUrl}/api/h5-editor/save/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/demo/index.html", html: originalHtml, revision }),
  });
  assert.equal(conflictResponse.status, 409);
  assert.equal((await conflictResponse.json()).revision, saved.revision);

  assert.equal((await fetch(`${baseUrl}/h5-editor/bootstrap.js`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/package.json`)).status, 404);
} finally {
  child.kill("SIGTERM");
  await once(child, "exit").catch(() => {});
}

console.log("Demo server save, conflict, and asset-boundary tests passed.");
