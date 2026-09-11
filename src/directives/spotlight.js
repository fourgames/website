// v-spotlight — feeds the pointer position into --mx/--my for the .spotlight glow (see style.css).
// Mouse/trackpad only; touch devices and reduced-motion users never get the listener.

export const spotlight = {
	mounted(el) {
		if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let frame = 0;
		const onMove = (event) => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				const rect = el.getBoundingClientRect();
				el.style.setProperty("--mx", `${event.clientX - rect.left}px`);
				el.style.setProperty("--my", `${event.clientY - rect.top}px`);
			});
		};
		el.addEventListener("pointermove", onMove, { passive: true });
		el._spotlightMove = onMove;
	},
	unmounted(el) {
		if (el._spotlightMove) el.removeEventListener("pointermove", el._spotlightMove);
	},
	getSSRProps: () => ({}),
};
