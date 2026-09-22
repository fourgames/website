import { reveal } from "./directives/reveal.js";

// Shared setup for the server (prerender) and client apps.
export function setupApp(app, router) {
	app.use(router);
	app.directive("reveal", reveal);
}
