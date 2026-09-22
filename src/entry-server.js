import { basename } from "node:path";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import App from "./App.vue";
import { setupApp } from "./app.js";
import { createAppRouter } from "./router/index.js";
import { renderHeadTags } from "./lib/head.js";

export { prerenderTargets } from "./router/routes.js";
export { SITE } from "./data/site.js";
// Read by scripts/prerender.mjs to build the home page's inline hero script.
export { getHeroSlides } from "./lib/games.js";
export { HERO_MOBILE_QUERY } from "./lib/hero.js";

export async function render(url, manifest) {
	const router = createAppRouter();
	const app = createSSRApp(App);
	setupApp(app, router);

	await router.push(url);
	await router.isReady();

	const ctx = {};
	const appHtml = await renderToString(app, ctx);
	const route = router.currentRoute.value;

	return {
		appHtml,
		routeName: String(route.name),
		headTags: renderHeadTags(route),
		preloadLinks: renderPreloadLinks(ctx.modules, manifest),
	};
}

// Adapted from @vitejs/plugin-vue's ssr-vue playground: modulepreload the JS chunks this page rendered.
// CSS is a single file inlined by prerender.mjs, so only JS is preloaded here.
function renderPreloadLinks(modules, manifest) {
	const seen = new Set();
	let links = "";
	for (const id of modules ?? []) {
		for (const file of manifest[id] ?? []) {
			if (seen.has(file)) continue;
			seen.add(file);
			for (const dep of manifest[basename(file)] ?? []) {
				if (!seen.has(dep) && dep.endsWith(".js")) links += `<link rel="modulepreload" crossorigin href="${dep}">`;
				seen.add(dep);
			}
			if (file.endsWith(".js")) links += `<link rel="modulepreload" crossorigin href="${file}">`;
		}
	}
	return links;
}
