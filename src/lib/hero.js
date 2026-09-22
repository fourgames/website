import { ref } from "vue";

// Bumped whenever something wants the home hero to swap to another screenshot without the page
// being remounted — clicking the navbar logo while you are already on the home page.
export const heroReshuffles = ref(0);

export function reshuffleHero() {
	heroReshuffles.value++;
}

// The screenshot this visit landed on — `{ i, src }`, the slide and the exact file that was loaded
// for it — kept outside the component so coming back to the home page reuses it instead of rolling
// again. Re-rolling on every visit meant a fresh ~0.5 MB download each time (a cache hit was
// 1-in-11), which is what made returning home sit on a dark hero. Null until something picks.
export const heroPick = ref(null);

// Below this the hero takes Steam's 600x338 cut instead of the 1920x1080 one. It is a dark-tinted
// backdrop at 60% opacity, so the difference doesn't show, and it is ~450 KB less on a phone.
// The same breakpoint the parallax uses.
export const HERO_MOBILE_QUERY = "(max-width: 900px)";

// Which file of a slide this screen should load. `prerender.mjs` bakes the same rule into the
// inline <head> script that preloads the hero, so the preload and the <img> never disagree and
// download the screenshot twice — keep the two in step.
export function heroSrc(slide) {
	if (!slide) return null;
	return window.matchMedia(HERO_MOBILE_QUERY).matches ? slide.thumb : slide.full;
}
