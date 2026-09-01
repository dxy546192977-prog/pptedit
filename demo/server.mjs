#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoDir, "..");
const demoHtmlPath = path.join(demoDir, "index.html");
const port = Number(process.env.PORT || 4173);
let currentHtml = await readFile(demoHtmlPath, "utf8");
let revision = createHash("sha256").update(currentHtml).digest("hex");

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"],
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveFile(response, filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) throw new Error("Not a file");
  response.writeHead(200, {
    "Content-Type": contentTypes.get(path.extname(filePath).toLowerCase()) || "application/octet-stream",
    "Content-Length": fileStat.size,
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

function serveHtml(response) {
  const body = Buffer.from(currentHtml, "utf8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  } catch {
    return sendJson(response, 400, { error: "Invalid request URL" });
  }

  try {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      return sendJson(response, 403, { error: "Localhost requests only" });
    }

    if (url.pathname === "/api/h5-editor/save/" && request.method === "GET") {
      if (url.searchParams.get("path") !== "/demo/index.html") return sendJson(response, 403, { error: "Demo path only" });
      return sendJson(response, 200, { revision });
    }

    if (url.pathname === "/api/h5-editor/save/" && request.method === "POST") {
      const requestOrigin = request.headers.origin;
      if (requestOrigin && requestOrigin !== url.origin) {
        return sendJson(response, 403, { error: "Same-origin requests only" });
      }
      const contentType = String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        return sendJson(response, 415, { error: "application/json required" });
      }
      const body = await readJson(request);
      if (body.path !== "/demo/index.html" || typeof body.html !== "string") {
        return sendJson(response, 403, { error: "Demo path only" });
      }
      if (typeof body.revision !== "string" || body.revision !== revision) {
        return sendJson(response, 409, { error: "Revision conflict", revision });
      }
      currentHtml = body.html;
      revision = createHash("sha256").update(currentHtml).digest("hex");
      return sendJson(response, 200, { revision, persisted: true, storage: "memory" });
    }

    if (["/demo/edit", "/demo/edit/"].includes(url.pathname)) {
      response.writeHead(307, { Location: "/demo/?edit=1", "Cache-Control": "no-store" });
      response.end();
      return;
    }

    if (["/demo", "/demo/", "/demo/index.html"].includes(url.pathname)) {
      return serveHtml(response);
    }

    const decodedPath = decodeURIComponent(url.pathname);
    const assetPath = decodedPath.startsWith("/h5-editor/")
      ? path.join("assets", decodedPath.slice(1))
      : decodedPath.startsWith("/demo/media/")
        ? decodedPath.slice(1)
        : null;
    if (!assetPath) return sendJson(response, 404, { error: "Not found" });
    const absolutePath = path.resolve(repoRoot, assetPath);
    const allowedRoots = [path.join(repoRoot, "assets", "h5-editor"), path.join(demoDir, "media")];
    if (!allowedRoots.some((root) => absolutePath.startsWith(`${root}${path.sep}`))) {
      return sendJson(response, 403, { error: "Forbidden" });
    }
    await serveFile(response, absolutePath);
  } catch (error) {
    if (!response.headersSent) sendJson(response, 404, { error: "Not found" });
    else response.destroy(error);
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  console.log(`PPTedit demo: http://127.0.0.1:${activePort}/demo/`);
  console.log(`Editor:       http://127.0.0.1:${activePort}/demo/edit`);
});
