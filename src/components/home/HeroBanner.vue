<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Button from "@/components/ui/Button.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { SITE } from "@/data/site.js";
import { byRecency, getGames, getHeroSlides } from "@/lib/games.js";
import { heroPick, heroReshuffles, heroSrc } from "@/lib/hero.js";

// Full-bleed screenshot hero, godotengine.org style. Like Godot, a random screenshot is shown on
// every page load — but the roll happens in an inline <head> script that `scripts/prerender.mjs`
// bakes into the home page, not here. That script picks the slide, preloads it, and (from the end
// of <body>, before this module runs) writes the screenshot and its credit into the markup, so the
// hero starts downloading while <body> is still being parsed instead of waiting on hydration.
//
// This component adopts that pick through `window.__HERO__` so its first render matches the markup
// exactly. Without it — in dev, where index.html is served untouched — it falls back to rolling in
// `onMounted`, the way it used to.
//
// The pick is remembered for the session (`heroPick`), so navigating away and back re-renders the
// same screenshot straight from cache instead of downloading another one behind a dark hero.
const slides = getHeroSlides();
// The newest game you can actually play. getGames() comes back in build order (the manual entries
// in games.js lead), so this has to sort, or a launch would never move the button off whatever
// happens to head that list.
const latest =
	getGames()
		.filter((g) => g.status === "released")
		.sort(byRecency)[0] ?? null;

// Adopt the <head> script's roll, unless this session already picked one (came back to the home
// page, or asked for a reshuffle) — that one wins, because its screenshot is the cached one.
const chosen = typeof window === "undefined" ? null : window.__HERO__;
if (chosen && !heroPick.value) heroPick.value = { i: chosen.i, src: chosen.src };

const index = ref(heroPick.value?.i ?? 0);
const current = computed(() => slides[index.value] ?? null);

// The screenshot on screen. Null on the server: the prerendered markup deliberately carries no
// `src`, so the browser never spends half a megabyte on a slide the visitor was not going to see.
// The file the picker chose (Steam's 600x338 cut on phones) is already on the element by the time
// we hydrate, so rendering the same string here is a no-op, not a second download.
const src = ref(heroPick.value?.src ?? null);

// Assigning a new src on the element we already have lets the browser drop the old fetch.
async function pick(exclude = -1) {
	let next = 0;
	if (slides.length > 1) {
		do {
			next = Math.floor(Math.random() * slides.length);
		} while (next === exclude);
	}
	const nextSrc = heroSrc(slides[next]);
	// If a screenshot is already up (the logo asking for another one), decode the next one off-screen
	// first so the hero cuts straight over, instead of blanking out or painting a half-loaded image.
	if (src.value && next !== index.value) {
		const pre = new Image();
		pre.src = nextSrc;
		await pre.decode().catch(() => {});
	}
	index.value = next;
	src.value = nextSrc;
	heroPick.value = { i: next, src: nextSrc };
}

// Clicking the navbar logo while already home asks for a fresh screenshot, excluding the current one
// so the click always visibly does something.
watch(heroReshuffles, () => pick(index.value));

// Parallax like godotengine.org: the image drifts down at 40% of the scroll distance on desktop,
// so the copy scrolls past it. Skipped for narrow screens and for people who prefer reduced motion.
const backdrop = ref(null);
let ticking = false;
function parallax() {
	ticking = false;
	if (!backdrop.value) return;
	backdrop.value.style.transform = window.innerWidth > 900 ? `translateY(${window.scrollY * 0.4}px)` : "none";
}
function onScroll() {
	if (ticking) return;
	ticking = true;
	requestAnimationFrame(parallax);
}

onMounted(async () => {
	// Nothing picked a screenshot before us (dev, or the inline script failed): roll now, after paint.
	if (!src.value) await pick();

	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	window.addEventListener("scroll", onScroll, { passive: true });
	window.addEventListener("resize", onScroll);
	parallax();
});
onBeforeUnmount(() => {
	window.removeEventListener("scroll", onScroll);
	window.removeEventListener("resize", onScroll);
});
</script>

<template>
	<section aria-labelledby="hero-title" class="relative isolate overflow-hidden bg-dark text-white">
		<!-- hero-backdrop / hero-shot / hero-credit are the hooks the inline hero scripts in
		     scripts/prerender.mjs write the picked screenshot into — rename them together. -->
		<div ref="backdrop" aria-hidden="true" class="hero-backdrop absolute inset-0 -z-20 opacity-60 will-change-transform">
			<img
				:src="src"
				alt=""
				aria-hidden="true"
				width="1920"
				height="1080"
				loading="eager"
				fetchpriority="high"
				decoding="async"
				class="hero-shot absolute inset-0 size-full object-cover"
			/>
			<span class="absolute inset-0 bg-[var(--hero-tint)] mix-blend-darken"></span>
		</div>

		<div
			class="relative mx-auto box-content max-w-[75rem] px-2.5 pt-[150px] pb-[120px] text-center min-[651px]:px-5 min-[651px]:pt-[180px] min-[651px]:pb-[100px] min-[901px]:text-left"
		>
			<h1
				id="hero-title"
				class="mb-5 text-hero-sm text-balance text-white [text-shadow:0_0_28px_rgb(0_0_0/0.5)] min-[901px]:text-hero"
			>
				{{ SITE.hero.title }}
			</h1>
			<p class="mb-5 text-[20px]/[1.5] [text-shadow:0_0_28px_rgb(0_0_0/0.5)]">{{ SITE.hero.subtitle }}</p>

			<div
				class="mt-12 flex flex-col items-center gap-3 min-[901px]:flex-row min-[901px]:flex-wrap min-[901px]:items-center min-[901px]:justify-start"
			>
				<a
					v-if="latest"
					:href="latest.storeUrl"
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex h-[54px] w-full overflow-hidden rounded-btn font-heading text-lg font-extrabold shadow-[0_0_4px_rgb(0_0_0/0.4)] transition-transform active:scale-[.98] min-[901px]:w-auto"
				>
					<span class="flex flex-1 items-center justify-center bg-white px-8 text-dark">Play latest</span>
					<span class="flex items-center bg-primary px-4 text-white">{{ latest.name }}</span>
					<span class="sr-only">(opens in new tab)</span>
				</a>
				<Button
					:href="SITE.links.youtubeJoin"
					variant="translucent"
					size="hero"
					icon="youtube"
					class="w-full min-[901px]:w-auto"
				>
					Join on YouTube
				</Button>
			</div>

			<p class="mt-6 text-[15px]/[1.2] font-light text-white/85 [text-shadow:0_0_10px_#000]">
				Looking for our
				<NavLink to="/videos" class="underline decoration-1 underline-offset-2 hover:text-white">videos</NavLink>,
				<NavLink to="/code" class="underline decoration-1 underline-offset-2 hover:text-white">open source</NavLink>, or
				<NavLink to="/jobs" class="underline decoration-1 underline-offset-2 hover:text-white">work with us</NavLink>?
			</p>
		</div>

		<a
			v-if="current"
			:href="current.href"
			target="_blank"
			rel="noopener noreferrer"
			class="hero-credit absolute right-4 bottom-3.5 rounded-lg bg-[rgb(26_26_26/0.48)] px-2.5 py-0.5 text-xs text-white opacity-60 transition-opacity hover:opacity-100 sm:right-[30px] sm:text-[15px]"
		>
			<span class="hero-credit-game">{{ current.game }}</span
			><span class="opacity-60"> - {{ current.author }}</span>
			<span class="sr-only"> (opens in new tab)</span>
		</a>
	</section>
</template>
