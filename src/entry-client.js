import { createApp, createSSRApp } from "vue";
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
});
