import { nextTick } from "vue";
import { START_LOCATION } from "vue-router";

// After client-side navigation, move focus to the new page's <h1> (or the #hash section's heading) so
// keyboard and screen-reader users land on the new content. The heading is read out, so no extra
// live region is needed.
export function installRouteFocus(router) {
	router.afterEach((to, from, failure) => {
		if (failure || from === START_LOCATION) return;
		if (to.path === from.path && to.hash === from.hash) return;

		// nextTick: the new page is rendered. The timeout lets other close/focus handlers (e.g. the
		// mobile menu dialog restoring focus to its button) finish first, so this always wins.
		nextTick(() =>
			setTimeout(() => {
				let target = null;
				if (to.hash) {
					const section = document.querySelector(to.hash);
					target = section?.querySelector("h2, h1") ?? section;
				}
				target ??= document.querySelector("#main h1") ?? document.getElementById("main");
				if (!target) return;
				if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
				target.focus({ preventScroll: true });
			}, 0),
		);
	});
}
