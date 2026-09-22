import { createApp, createSSRApp } from "vue";
import { loadRouteLocation } from "vue-router";
import App from "./App.vue";
import { setupApp } from "./app.js";
import { createAppRouter } from "./router/index.js";
import { applyHead, installHead } from "./lib/head.js";
import { installRouteFocus } from "./lib/routeFocus.js";
import { installViewTransitions } from "./lib/viewTransitions.js";
import "./style.css";

const el = document.getElementById("app");
const router = createAppRouter();

// Resolve the route before creating the app, so we know whether the markup on the page belongs to it.
router.push(router.options.history.location).catch(() => {});

router.isReady().then(() => {
	const route = router.currentRoute.value;
	// GitHub Pages serves 404.html for unknown paths (e.g. /code/), and `vite dev` has no prerendered
	// markup — in those cases render fresh instead of hydrating mismatched HTML.
	const hydrate = el.dataset.ssrRoute === String(route.name);
	const app = hydrate ? createSSRApp(App) : createApp(App);

	setupApp(app, router);
	installHead(router);
	installRouteFocus(router);
	installViewTransitions(router);
	if (!hydrate) applyHead(route);

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
