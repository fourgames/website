// Every view is lazy; the prerender step adds <link rel="modulepreload"> for each page's own chunk.
export const routes = [
	{
		path: "/",
		name: "home",
		component: () => import("@/views/HomeView.vue"),
		meta: {
			head: {
				title: "Four Games — Indie games made in Godot",
				absoluteTitle: true,
				description:
					"Four Games makes indie games in Godot, shares free tutorials on YouTube, and open-sources the tools we use.",
			},
		},
	},
	{
		path: "/code",
		name: "code",
		component: () => import("@/views/OpenSourceView.vue"),
		meta: {
			head: {
				title: "Open Source",
				description:
					"Godot templates, curated game-dev resources and our contributions to the Godot engine and foundation.",
			},
		},
	},
	{
		path: "/jobs",
		name: "jobs",
		component: () => import("@/views/WorkWithUsView.vue"),
		meta: {
			head: {
				title: "Work with us",
				description:
					"Guest series for YouTube creators, co-development and publishing with indie studios, and franchise collaborations. Get in touch with Four Games.",
			},
		},
	},
	// GitHub Pages also serves the physical files — keep one canonical URL per page.
	{ path: "/index.html", redirect: "/" },
	{ path: "/code.html", redirect: "/code" },
	{ path: "/jobs.html", redirect: "/jobs" },
	{
		path: "/:pathMatch(.*)*",
		name: "not-found",
		component: () => import("@/views/NotFoundView.vue"),
		meta: {
			head: {
				title: "Page not found",
				description: "This page doesn't exist.",
				robots: "noindex",
			},
		},
	},
];

// Pages written by scripts/prerender.mjs. Flat files so GitHub Pages serves /code without a redirect.
export const prerenderTargets = [
	{ url: "/", file: "index.html", sitemap: true },
	{ url: "/code", file: "code.html", sitemap: true },
	{ url: "/jobs", file: "jobs.html", sitemap: true },
	{ url: "/404", file: "404.html", sitemap: false },
];
