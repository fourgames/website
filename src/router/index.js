import { createMemoryHistory, createRouter, createWebHistory } from "vue-router";
import { routes } from "./routes.js";

export function createAppRouter() {
	const router = createRouter({
		history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
		routes,
		scrollBehavior(to, from, savedPosition) {
			if (savedPosition) return savedPosition;
			if (to.hash) {
				const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
				// scroll-padding-top in CSS keeps the target clear of the floating header.
				return { el: to.hash, behavior: smooth && to.path === from.path ? "smooth" : "auto" };
			}
			if (to.path !== from.path) return { top: 0 };
		},
	});

	// One URL per page: /code/ → /code (GitHub Pages serves 404.html for the slash version). Language
	// homes are the exception, the other way round: they're ja/index.html, so /ja/ is the real URL.
	router.beforeEach((to) => {
		const isLanguageHome = to.name === "home" && to.path.length > 1;
		const path = isLanguageHome ? `${to.path.replace(/\/+$/, "")}/` : to.path.replace(/(.)\/+$/, "$1");
		if (path !== to.path) return { path, query: to.query, hash: to.hash, replace: true };
	});

	return router;
}
