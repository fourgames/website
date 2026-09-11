#!/usr/bin/env node
/**
 * Prerenders every route to static HTML (runs after the client + SSR builds, see package.json).
 *  - Flat files (code.html, not code/index.html) so GitHub Pages serves /code with a 200, no redirect.
 *  - Inlines the single CSS file, fills per-route <head> tags and modulepreloads.
 *  - Writes 404.html and sitemap.xml, and fails the build on obviously broken output.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const DIST_SSR = path.join(ROOT, "dist-ssr");

const template = await readFile(path.join(DIST, "index.html"), "utf8");
const manifest = JSON.parse(await readFile(path.join(DIST, ".vite/ssr-manifest.json"), "utf8"));
const { render, prerenderTargets, SITE } = await import(pathToFileURL(path.join(DIST_SSR, "entry-server.js")).href);

// Inline the stylesheet: one fewer render-blocking request on every page.
const cssLink = /<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/.exec(template);
let base = template;
if (cssLink) {
	const css = await readFile(path.join(DIST, cssLink[1]), "utf8");
	base = base.replace(cssLink[0], () => `<style>${css}</style>`);
}

const errors = [];
for (const target of prerenderTargets) {
	const { appHtml, routeName, headTags, preloadLinks } = await render(target.url, manifest);
	const html = base
		.replace(/<!--head:start-->[\s\S]*?<!--head:end-->/, () => headTags)
		.replace("<!--preload-links-->", () => preloadLinks)
		.replace('<div id="app"><!--app-html--></div>', () => `<div id="app" data-ssr-route="${routeName}">${appHtml}</div>`);

	const h1Count = (appHtml.match(/<h1[\s>]/g) ?? []).length;
	if (h1Count !== 1) errors.push(`${target.file}: expected exactly one <h1>, found ${h1Count}`);
	if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${target.file}: missing <title>`);
	if (/<!--(app-html|preload-links|head:start)-->/.test(html)) errors.push(`${target.file}: unreplaced placeholder`);

	await writeFile(path.join(DIST, target.file), html);
	console.log(`prerender: ${target.url.padEnd(6)} → dist/${target.file} (${(html.length / 1024).toFixed(1)} KB)`);
}

const today = new Date().toISOString().slice(0, 10);
const urls = prerenderTargets
	.filter((t) => t.sitemap)
	.map((t) => `  <url><loc>${SITE.url}${t.url === "/" ? "/" : t.url}</loc><lastmod>${today}</lastmod></url>`);
await writeFile(
	path.join(DIST, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`,
);

await rm(path.join(DIST, ".vite"), { recursive: true, force: true });
if (cssLink) await rm(path.join(DIST, cssLink[1]), { force: true });
await rm(DIST_SSR, { recursive: true, force: true });

if (errors.length) {
	console.error(`prerender failed:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}
