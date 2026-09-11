#!/usr/bin/env node
// Serves dist/ the way GitHub Pages does: /code → code.html, unknown paths → 404.html with status 404,
// gzip for text. (vite preview would fall back to index.html for everything, hiding routing bugs.)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const DIST = path.resolve(import.meta.dirname, "../dist");
const PORT = Number(process.env.PORT ?? 4173);
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".woff2": "font/woff2",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json",
};

const isFile = async (file) => (await stat(file).catch(() => null))?.isFile() ?? false;

async function send(req, res, status, file) {
	const type = TYPES[path.extname(file)] ?? "application/octet-stream";
	let body = await readFile(file);
	const headers = { "Content-Type": type, "Cache-Control": "max-age=600" };
	if (/text|javascript|json|xml|svg/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
		body = gzipSync(body);
		headers["Content-Encoding"] = "gzip";
	}
	res.writeHead(status, headers);
	res.end(body);
}

createServer(async (req, res) => {
	const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
	const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
	const candidates = [path.join(DIST, safe), path.join(DIST, `${safe}.html`), path.join(DIST, safe, "index.html")];
	for (const file of candidates) {
		if (file.startsWith(DIST) && (await isFile(file))) return send(req, res, 200, file);
	}
	return send(req, res, 404, path.join(DIST, "404.html"));
}).listen(PORT, () => console.log(`Preview (GitHub Pages-style) on http://localhost:${PORT}`));
