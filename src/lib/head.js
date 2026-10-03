// Tiny head manager. Every route is static, so head tags depend only on route.meta.head and the
// page's language. Server: renderHeadTags() → HTML string for the prerendered page. Client:
// installHead() keeps tags in sync.
import { SITE, SOCIALS } from "@/data/site.js";
import { LOCALES, localizePath, stripLocale } from "@/i18n/locales.js";

const OG_IMAGE = {
	url: `${SITE.url}/og/og-default.jpg?v=${__BUILD_DATE__}`,
	width: 1200,
	height: 630,
};

export function getHead(route, i18n) {
	const { t, locale } = i18n;
	const head = route.meta?.head ?? {};
	// A page without translations (the private dashboard) gives its title and description as text.
	const pageTitle = head.title ?? (head.key ? t(`head.${head.key}.title`) : SITE.name);
	const title = head.absoluteTitle ? pageTitle : `${pageTitle} · ${SITE.name}`;
	const robots = head.robots ?? "index, follow";
	const indexable = !robots.includes("noindex");
	// Every language version of this page, for hreflang — Google uses them to send each searcher
	// to their own language, and x-default (English) to everyone else.
	const englishPath = stripLocale(route.path);
	const alternates = indexable
		? [
				...LOCALES.map((l) => ({ hreflang: l.htmlLang, href: SITE.url + localizePath(englishPath, l.code) })),
				{ hreflang: "x-default", href: SITE.url + englishPath },
			]
		: [];
	return {
		title,
		description: head.description ?? (head.key ? t(`head.${head.key}.description`) : t("site.tagline")),
		robots,
		canonical: indexable ? SITE.url + localizePath(englishPath, locale.code) : null,
		alternates,
		lang: locale.htmlLang,
		ogLocale: locale.og,
		ogImageAlt: t("site.ogImageAlt"),
		tagline: t("site.tagline"),
		isHome: route.name === "home",
	};
}

function metaTags(h) {
	return [
		["name", "description", h.description],
		["name", "robots", h.robots],
		["property", "og:type", "website"],
		["property", "og:site_name", SITE.name],
		["property", "og:title", h.title],
		["property", "og:description", h.description],
		["property", "og:url", h.canonical],
		["property", "og:image", OG_IMAGE.url],
		["property", "og:image:width", String(OG_IMAGE.width)],
		["property", "og:image:height", String(OG_IMAGE.height)],
		["property", "og:image:alt", h.ogImageAlt],
		["property", "og:locale", h.ogLocale],
		["name", "twitter:card", "summary_large_image"],
		["name", "twitter:title", h.title],
		["name", "twitter:description", h.description],
		["name", "twitter:image", OG_IMAGE.url],
	];
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function renderHeadTags(route, i18n) {
	const h = getHead(route, i18n);
	const tags = [`<title>${escapeHtml(h.title)}</title>`];
	for (const [attr, key, value] of metaTags(h)) {
		if (value) tags.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
	}
	if (h.canonical) tags.push(`<link rel="canonical" href="${escapeHtml(h.canonical)}" />`);
	for (const alt of h.alternates) {
		tags.push(`<link rel="alternate" hreflang="${alt.hreflang}" href="${escapeHtml(alt.href)}" />`);
	}
	if (h.isHome) tags.push(`<script type="application/ld+json">${jsonLd(h)}</script>`);
	return tags.join("\n\t\t");
}

function jsonLd(h) {
	const data = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Organization",
				"@id": `${SITE.url}/#organization`,
				name: SITE.name,
				url: `${SITE.url}/`,
				logo: `${SITE.url}/logo-512.png`,
				description: h.tagline,
				sameAs: SOCIALS.map((s) => s.href),
			},
			{
				"@type": "WebSite",
				"@id": `${SITE.url}/#website`,
				name: SITE.name,
				url: `${SITE.url}/`,
				inLanguage: LOCALES.map((l) => l.htmlLang),
				publisher: { "@id": `${SITE.url}/#organization` },
			},
		],
	};
	return JSON.stringify(data).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function applyHead(route, i18n) {
	const h = getHead(route, i18n);
	document.title = h.title;
	document.documentElement.lang = h.lang;
	for (const [attr, key, value] of metaTags(h)) {
		let el = document.head.querySelector(`meta[${attr}="${key}"]`);
		if (!value) {
			el?.remove();
			continue;
		}
		if (!el) {
			el = document.createElement("meta");
			el.setAttribute(attr, key);
			document.head.append(el);
		}
		el.setAttribute("content", value);
	}
	let canonical = document.head.querySelector('link[rel="canonical"]');
	if (!h.canonical) canonical?.remove();
	else {
		if (!canonical) {
			canonical = document.createElement("link");
			canonical.rel = "canonical";
			document.head.append(canonical);
		}
		canonical.href = h.canonical;
	}
	for (const el of document.head.querySelectorAll('link[rel="alternate"][hreflang]')) el.remove();
	for (const alt of h.alternates) {
		const el = document.createElement("link");
		el.rel = "alternate";
		el.hreflang = alt.hreflang;
		el.href = alt.href;
		document.head.append(el);
	}
}

export function installHead(router, i18n) {
	router.afterEach((to, from, failure) => {
		if (!failure) applyHead(to, i18n);
	});
}
