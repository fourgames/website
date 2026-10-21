import { reveal } from "./directives/reveal.js";
import { installI18n } from "./i18n/index.js";

// Shared setup for the server (prerender) and client apps.
export function setupApp(app, router, i18n) {
	app.use(router);
	installI18n(app, i18n);
	app.directive("reveal", reveal);
}
