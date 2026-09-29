#!/usr/bin/env node
/**
 * Prerenders every route to static HTML (runs after the client + SSR builds, see package.json).
 *  - Every page once per language: English at the root, the rest under their prefix (ja/games.html…).
 *  - Flat files (code.html, not code/index.html) so GitHub Pages serves /code with a 200, no redirect.
 *  - Inlines the single CSS file, fills per-route <head> tags and modulepreloads.
 *  - Writes 404.html and sitemap.xml (with hreflang alternates), and fails the build on obviously broken
 *    output. Warns about message keys a language is missing (they fall back to English).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const DIST_SSR = path.join(ROOT, "dist-ssr");

const template = await readFile(path.join(DIST, "index.html"), "utf8");
const manifest = JSON.parse(await readFile(path.join(DIST, ".vite/ssr-manifest.json"), "utf8"));
const {
	render,
	prerenderTargets,
	SITE,
	getHeroSlides,
	HERO_MOBILE_QUERY,
	LOCALES,
	localizePath,
	enMessages,
	loadMessages,
	redirectScript,
	createI18n,
} = await import(pathToFileURL(path.join(DIST_SSR, "entry-server.js")).href);

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
// Per language, because the credit carries the game's (possibly translated) name.
function heroScripts(heroSlides) {
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
	return { heroHead, heroBody };
}

// Squeeze the snippets above onto one line, inside a function so their temporaries stay off window,
// and keep "<" out of the JSON, so nothing in the data can close the <script> tag early.
function inline(code) {
	return `!function(){${code.replace(/\s+/g, " ").trim()}}()`;
}
function json(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

// English pages send first-time visitors whose browser prefers one of our other languages there,
// before anything paints (see src/i18n/detect.js). Never on 404.html: GitHub Pages serves it for
// /ja/… paths too, which would be sent on to /ja/ja/….
const languageRedirect = `<script>${redirectScript()}</script>`;

// Each language's messages are their own chunk, which the client loads before it hydrates;
// modulepreload it so that's a cache hit rather than a request after the entry script.
function messagesPreload(code) {
	const files = manifest[`src/i18n/messages/${code}.js`] ?? [];
	return files
		.filter((file) => file.endsWith(".js"))
		.map((file) => `<link rel="modulepreload" crossorigin href="${file}">`)
		.join("");
}

const errors = [];
const pages = prerenderTargets.flatMap((target) =>
	(target.localized === false ? LOCALES.slice(0, 1) : LOCALES).map((locale) => ({ target, locale })),
);
for (const { target, locale } of pages) {
	const isDefault = locale.code === LOCALES[0].code;
	const url = localizePath(target.url, locale.code);
	const file = isDefault ? target.file : `${locale.code}/${target.file}`;
	const isHome = target.url === "/";

	const { appHtml, routeName, headTags, preloadLinks } = await render(url, manifest);
	const { heroHead, heroBody } = heroScripts(getHeroSlides(createI18n(locale.code, await loadMessages(locale.code))));
	const html = base
		.replace('<html lang="en">', () => `<html lang="${locale.htmlLang}">`)
		.replace(/<!--head:start-->[\s\S]*?<!--head:end-->/, () => headTags)
		.replace("<!--lang-redirect-->", () => (isDefault && target.localized !== false ? languageRedirect : ""))
		.replace("<!--preload-links-->", () => preloadLinks + messagesPreload(locale.code))
		.replace(
			'<div id="app"><!--app-html--></div>',
			() => `<div id="app" data-ssr-route="${routeName}" data-ssr-locale="${locale.code}">${appHtml}</div>`,
		)
		.replace("<!--hero-head-->", () => (isHome ? heroHead : ""))
		.replace("<!--hero-body-->", () => (isHome ? heroBody : ""));

	const h1Count = (appHtml.match(/<h1[\s>]/g) ?? []).length;
	if (h1Count !== 1) errors.push(`${file}: expected exactly one <h1>, found ${h1Count}`);
	if (!/<title>[^<]+<\/title>/.test(html)) errors.push(`${file}: missing <title>`);
	if (/<!--(app-html|preload-links|head:start|lang-redirect)-->/.test(html)) errors.push(`${file}: unreplaced placeholder`);
	if (!html.includes(`<html lang="${locale.htmlLang}">`)) errors.push(`${file}: <html lang> not set`);

	await mkdir(path.dirname(path.join(DIST, file)), { recursive: true });
	await writeFile(path.join(DIST, file), html);
	console.log(`prerender: ${url.padEnd(12)} → dist/${file} (${(html.length / 1024).toFixed(1)} KB)`);
}

// Missing translations fall back to English at runtime; say which, so they get filled in.
function keys(node, prefix = "") {
	return Object.entries(node).flatMap(([key, value]) =>
		value && typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
	);
}
const englishKeys = keys(enMessages);
for (const locale of LOCALES.slice(1)) {
	const own = new Set(keys(await loadMessages(locale.code)));
	const missing = englishKeys.filter((key) => !own.has(key));
	if (missing.length) console.warn(`prerender: ${locale.code} is missing ${missing.length} message(s): ${missing.join(", ")}`);
}

// Every language version of every page, each listing all of its alternates (Google's sitemap
// hreflang format), so search engines serve the right language without crawling the picker.
const today = new Date().toISOString().slice(0, 10);
const urls = prerenderTargets
	.filter((t) => t.sitemap)
	.flatMap((t) => {
		const links = LOCALES.map((l) => ({ hreflang: l.htmlLang, href: SITE.url + localizePath(t.url, l.code) }));
		const alternates = [...links, { hreflang: "x-default", href: SITE.url + t.url }]
			.map((l) => `\n    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${l.href}"/>`)
			.join("");
		return links.map((l) => `  <url>\n    <loc>${l.href}</loc>\n    <lastmod>${today}</lastmod>${alternates}\n  </url>`);
	});
await writeFile(
	path.join(DIST, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`,
);

await rm(path.join(DIST, ".vite"), { recursive: true, force: true });
if (cssLink) await rm(path.join(DIST, cssLink[1]), { force: true });
await rm(DIST_SSR, { recursive: true, force: true });

if (errors.length) {
	console.error(`prerender failed:\n  ${errors.join("\n  ")}`);
	process.exit(1);
}
