import { LOCALE_PATTERN, localeFromPath, localizePath } from "@/i18n/locales.js";

// Every page exists once per language: /games, /ja/games, /ko/games… (see src/i18n/locales.js).
// One route per page with an optional language prefix, so route names stay "games", "videos"….
const L = `/:locale(${LOCALE_PATTERN})?`;

// A redirect that keeps the language: /ja/games.html → /ja/games.
const keepLocale = (path) => (to) => localizePath(path, localeFromPath(to.path));

// Game press kits read the build-time Steam data, which only the press pages should carry, so
// src/lib/press.js loads with the page instead of with every route. The guard below waits for it,
// and by the time the page's <head> is written it's here for the title too.
let press = null;
async function loadPressGame(to) {
	press ??= await import("@/lib/press.js");
	if (press.hasPressKit(to.params.game)) return true;
	// Unknown game: the 404 page, at the same URL.
	return { name: "not-found", params: { pathMatch: to.path.split("/").slice(1) }, query: to.query, hash: to.hash };
}

// Every view is lazy; the prerender step adds <link rel="modulepreload"> for each page's own chunk.
// meta.head.key picks the page's title and description from head.<key> in src/i18n/messages.
export const routes = [
	{
		path: L,
		name: "home",
		component: () => import("@/views/HomeView.vue"),
		meta: { head: { key: "home", absoluteTitle: true } },
	},
	{
		path: `${L}/games`,
		name: "games",
		component: () => import("@/views/GamesView.vue"),
		meta: { head: { key: "games" } },
	},
	{
		path: `${L}/videos`,
		name: "videos",
		component: () => import("@/views/VideosView.vue"),
		meta: { head: { key: "videos" } },
	},
	{
		path: `${L}/code`,
		name: "code",
		component: () => import("@/views/OpenSourceView.vue"),
		meta: { head: { key: "code" } },
	},
	{
		path: `${L}/jobs`,
		name: "jobs",
		component: () => import("@/views/WorkWithUsView.vue"),
		meta: { head: { key: "jobs" } },
	},
	{
		path: `${L}/press`,
		name: "press",
		component: () => import("@/views/PressView.vue"),
		meta: { head: { key: "press" } },
	},
	// One page per game with a public store page: /press/reforge-front (slugs in src/lib/press.js).
	{
		path: `${L}/press/:game`,
		name: "press-game",
		component: () => import("@/views/PressGameView.vue"),
		beforeEnter: loadPressGame,
		meta: {
			head: {
				key: "pressGame",
				params: (i18n, route) => ({ name: press?.getPressGame(route.params.game, i18n)?.name ?? "" }),
			},
		},
	},
	// Private player-feedback dashboard: English only, never indexed, not in the sitemap.
	{
		path: "/fb-dash",
		name: "feedback",
		component: () => import("@/views/FeedbackView.vue"),
		meta: {
			head: {
				title: "Player feedback",
				description: "Private player feedback dashboard.",
				robots: "noindex, nofollow",
			},
		},
	},
	// GitHub Pages also serves the physical files — keep one canonical URL per page.
	{ path: `${L}/index.html`, redirect: keepLocale("/") },
	{ path: `${L}/games.html`, redirect: keepLocale("/games") },
	{ path: `${L}/videos.html`, redirect: keepLocale("/videos") },
	{ path: `${L}/code.html`, redirect: keepLocale("/code") },
	{ path: `${L}/jobs.html`, redirect: keepLocale("/jobs") },
	{ path: `${L}/press.html`, redirect: keepLocale("/press") },
	{ path: `${L}/press/:game([^/]+)\\.html`, redirect: (to) => localizePath(`/press/${to.params.game}`, localeFromPath(to.path)) },
	{ path: "/fb-dash.html", redirect: "/fb-dash" },
	{
		path: "/:pathMatch(.*)*",
		name: "not-found",
		component: () => import("@/views/NotFoundView.vue"),
		meta: { head: { key: "notFound", robots: "noindex" } },
	},
];

// Pages written by scripts/prerender.mjs, once per language (English at the root, the rest under
// their prefix: ja/games.html…). Flat files so GitHub Pages serves /code without a redirect.
// 404.html is English-only: GitHub Pages serves the root one for every missing path, and the client
// re-renders it in the language of the URL.
export const prerenderTargets = [
	{ url: "/", file: "index.html", sitemap: true },
	{ url: "/games", file: "games.html", sitemap: true },
	{ url: "/videos", file: "videos.html", sitemap: true },
	{ url: "/code", file: "code.html", sitemap: true },
	{ url: "/jobs", file: "jobs.html", sitemap: true },
	{ url: "/press", file: "press.html", sitemap: true },
	// The game press kits (press/<slug>.html) are added by src/entry-server.js, from the Steam data.
	{ url: "/fb-dash", file: "fb-dash.html", sitemap: false, localized: false },
	{ url: "/404", file: "404.html", sitemap: false, localized: false },
];
