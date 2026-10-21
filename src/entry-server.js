import { basename } from "node:path";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import App from "./App.vue";
import { setupApp } from "./app.js";
import { createAppRouter } from "./router/index.js";
import { renderHeadTags } from "./lib/head.js";
import { createI18n, loadMessages } from "./i18n/index.js";
import { localeFromPath } from "./i18n/locales.js";

export { prerenderTargets } from "./router/routes.js";
export { SITE } from "./data/site.js";
export { LOCALES, localizePath } from "./i18n/locales.js";
export { default as enMessages } from "./i18n/messages/en.js";
export { loadMessages };
export { redirectScript } from "./i18n/detect.js";
// Read by scripts/prerender.mjs to build the home page's inline hero script.
export { getHeroSlides } from "./lib/games.js";
export { createI18n } from "./i18n/index.js";
export { HERO_MOBILE_QUERY } from "./lib/hero.js";

export async function render(url, manifest) {
	const i18n = createI18n(localeFromPath(url), await loadMessages(localeFromPath(url)));
	const router = createAppRouter();
	const app = createSSRApp(App);
	setupApp(app, router, i18n);

	await router.push(url);
	await router.isReady();

	const ctx = {};
	const appHtml = await renderToString(app, ctx);
	const route = router.currentRoute.value;

	return {
		appHtml,
		routeName: String(route.name),
		locale: i18n.locale,
		headTags: renderHeadTags(route, i18n),
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
