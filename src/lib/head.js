// Tiny head manager. Every route is static, so head tags depend only on route.meta.head.
// Server: renderHeadTags() → HTML string for the prerendered page. Client: installHead() keeps tags in sync.
import { SITE, SOCIALS } from "@/data/site.js";

const OG_IMAGE = {
	url: `${SITE.url}/og/og-default.jpg`,
	width: 1200,
	height: 630,
	alt: "Four Games: indie games made in Godot",
};

export function getHead(route) {
	const head = route.meta?.head ?? {};
	const title = head.absoluteTitle ? head.title : `${head.title ?? SITE.name} · ${SITE.name}`;
	const robots = head.robots ?? "index, follow";
	const canonical = robots.includes("noindex") ? null : SITE.url + (route.path === "/" ? "/" : route.path);
	return { title, description: head.description ?? SITE.tagline, robots, canonical, isHome: route.name === "home" };
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
		["property", "og:image:alt", OG_IMAGE.alt],
		["property", "og:locale", "en_US"],
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

export function renderHeadTags(route) {
	const h = getHead(route);
	const tags = [`<title>${escapeHtml(h.title)}</title>`];
	for (const [attr, key, value] of metaTags(h)) {
		if (value) tags.push(`<meta ${attr}="${key}" content="${escapeHtml(value)}" />`);
	}
	if (h.canonical) tags.push(`<link rel="canonical" href="${escapeHtml(h.canonical)}" />`);
	if (h.isHome) tags.push(`<script type="application/ld+json">${jsonLd()}</script>`);
	return tags.join("\n\t\t");
}

function jsonLd() {
	const data = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "Organization",
				"@id": `${SITE.url}/#organization`,
				name: SITE.name,
				url: `${SITE.url}/`,
				logo: `${SITE.url}/logo-512.png`,
				description: SITE.tagline,
				sameAs: SOCIALS.map((s) => s.href),
			},
			{
				"@type": "WebSite",
				"@id": `${SITE.url}/#website`,
				name: SITE.name,
				url: `${SITE.url}/`,
				publisher: { "@id": `${SITE.url}/#organization` },
			},
		],
	};
	return JSON.stringify(data).replace(/</g, "\\u003c");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function applyHead(route) {
	const h = getHead(route);
	document.title = h.title;
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
}

export function installHead(router) {
	router.afterEach((to, from, failure) => {
		if (!failure) applyHead(to);
	});
}
