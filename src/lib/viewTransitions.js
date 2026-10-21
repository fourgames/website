import { nextTick } from "vue";
import { START_LOCATION } from "vue-router";

// Cross-fade between pages with the View Transitions API. Progressive: skipped where unsupported,
// on the initial load, for same-page (hash) navigation and when the user prefers reduced motion.
export function installViewTransitions(router) {
	if (typeof document === "undefined" || !document.startViewTransition) return;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

	let finish = null;

	router.beforeResolve((to, from) => {
		if (from === START_LOCATION || reducedMotion.matches || to.path === from.path) return;
		return new Promise((resolve) => {
			const transition = document.startViewTransition(
				() =>
					new Promise((done) => {
						finish = done;
						resolve(); // let the navigation continue; the new DOM is captured once `done` runs
					}),
			);
			// A skipped transition (hidden tab, rapid clicks) rejects `ready` — that's fine, not an error.
			transition.ready.catch(() => {});
		});
	});

	const settle = () => {
		const done = finish;
		finish = null;
		if (done) nextTick(done);
	};

	router.afterEach(settle);
	router.onError(settle);
}
