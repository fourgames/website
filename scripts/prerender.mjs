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
const { render, prerenderTargets, SITE, getHeroSlides, HERO_MOBILE_QUERY } = await import(
	pathToFileURL(path.join(DIST_SSR, "entry-server.js")).href,
);

// Inline the stylesheet: one fewer render-blocking request on every page.
const cssLink = /<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/.exec(template);
let base = template;
if (cssLink) {
	const css = await readFile(path.join(DIST, cssLink[1]), "utf8");
	base = base.replace(cssLink[0], () => `<style>${css}</style>`);
}

// The home hero, picked in the page instead of after hydration. The <head> half rolls a slide and
// preloads it, so the ~0.5 MB screenshot starts downloading while <body> is still being parsed; the
// <body> half writes it into the markup that HeroBanner.vue is about to hydrate, so the two agree
// and the browser never fetches a second one. Keep the mobile rule in step with heroSrc().
const heroSlides = getHeroSlides();
const heroHead = heroSlides.length
	? `<script>${inline(`
			var S = ${json(heroSlides.map((s) => [s.full, s.thumb, s.game, s.href]))},
				i = Math.floor(Math.random() * S.length),
				s = S[i];
			window.__HERO__ = { i: i, src: matchMedia(${json(HERO_MOBILE_QUERY)}).matches ? s[1] : s[0], game: s[2], href: s[3] };
			var l = document.createElement("link");
			l.rel = "preload"; l.as = "image"; l.fetchPriority = "high"; l.href = window.__HERO__.src;
			document.head.appendChild(l);
		`)}</script><noscript><style>.hero-backdrop{background:url(${json(heroSlides[0].full)}) center/cover no-repeat}</style></noscript>`
	: "";
const heroBody = heroSlides.length
	? `<script>${inline(`
			var h = window.__HERO__, img = document.querySelector(".hero-shot"), a = document.querySelector(".hero-credit"),
				g = document.querySelector(".hero-credit-game");
			if (h) { if (img) img.src = h.src; if (a) a.href = h.href; if (g) g.textContent = h.game; }
		`)}</script>`
	: "";

// Squeeze the snippets above onto one line, inside a function so their temporaries stay off window,
// and keep "<" out of the JSON, so nothing in the data can close the <script> tag early.
function inline(code) {
	return `!function(){${code.replace(/\s+/g, " ").trim()}}()`;
}
function json(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

const errors = [];
for (const target of prerenderTargets) {
	const { appHtml, routeName, headTags, preloadLinks } = await render(target.url, manifest);
	const html = base
		.replace(/<!--head:start-->[\s\S]*?<!--head:end-->/, () => headTags)
		.replace("<!--preload-links-->", () => preloadLinks)
		.replace('<div id="app"><!--app-html--></div>', () => `<div id="app" data-ssr-route="${routeName}">${appHtml}</div>`)
		.replace("<!--hero-head-->", () => (target.url === "/" ? heroHead : ""))
		.replace("<!--hero-body-->", () => (target.url === "/" ? heroBody : ""));

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
