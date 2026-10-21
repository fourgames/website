// v-reveal — fade/rise elements in as they scroll into view.
// Only elements that start *below the fold* are hidden (so no LCP cost and nothing visible ever blinks),
// nothing is hidden without JS, and reduced-motion users get static content.
// Optional value: stagger delay in ms, e.g. v-reveal="120".

let observer;

function getObserver() {
	observer ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.dataset.reveal = "shown";
				observer.unobserve(entry.target);
			}
		},
		{ rootMargin: "0px 0px -6% 0px", threshold: 0.06 },
	);
	return observer;
}

export const reveal = {
	mounted(el, binding) {
		if (typeof IntersectionObserver === "undefined") return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		if (el.getBoundingClientRect().top < window.innerHeight) return;
		if (binding.value) el.style.setProperty("--reveal-delay", `${binding.value}ms`);
		el.dataset.reveal = "armed";
		getObserver().observe(el);
	},
	unmounted(el) {
		observer?.unobserve(el);
	},
	getSSRProps: () => ({}),
};
