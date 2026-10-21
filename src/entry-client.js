import { createApp, createSSRApp } from "vue";
import { loadRouteLocation } from "vue-router";
import App from "./App.vue";
import { setupApp } from "./app.js";
import { createAppRouter } from "./router/index.js";
import { applyHead, installHead } from "./lib/head.js";
import { createI18n, loadMessages } from "./i18n/index.js";
import { localeFromPath } from "./i18n/locales.js";
import { installRouteFocus } from "./lib/routeFocus.js";
import { installViewTransitions } from "./lib/viewTransitions.js";
import "./style.css";

const el = document.getElementById("app");
const router = createAppRouter();

// The language is the URL's, fixed for the life of the page: the language picker is a real link to
// the other URL, never a client-side switch. Its messages load alongside the route (prerender
// modulepreloads the chunk, so this is normally already in cache).
const code = localeFromPath(location.pathname);

// Resolve the route before creating the app, so we know whether the markup on the page belongs to it.
router.push(router.options.history.location).catch(() => {});

Promise.all([router.isReady(), loadMessages(code)]).then(([, messages]) => {
	const i18n = createI18n(code, messages);
	const route = router.currentRoute.value;
	// GitHub Pages serves 404.html for unknown paths (e.g. /code/ or /ja/nope, which gets the English
	// one), and `vite dev` has no prerendered markup — in those cases render fresh instead of
	// hydrating mismatched HTML.
	const hydrate = el.dataset.ssrRoute === String(route.name) && el.dataset.ssrLocale === code;
	const app = hydrate ? createSSRApp(App) : createApp(App);

	setupApp(app, router, i18n);
	installHead(router, i18n);
	installRouteFocus(router);
	installViewTransitions(router);
	if (!hydrate) applyHead(route, i18n);

	app.mount(el);

	// Home is by far the largest route chunk, and it is the one place people go back to. Hovering a
	// link prefetches it (NavLink), but the browser's Back button cannot be hovered — so when we land
	// anywhere else, pull the home chunk in once the page is idle and Back is instant.
	if (route.name !== "home") {
		const warm = () => loadRouteLocation(router.resolve("/")).catch(() => {});
		if (window.requestIdleCallback) window.requestIdleCallback(warm, { timeout: 3000 });
		else setTimeout(warm, 1500);
	}
});
