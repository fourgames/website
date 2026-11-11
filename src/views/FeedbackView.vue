<script setup>
import { onMounted, ref } from "vue";
import PageHeader from "@/components/layout/PageHeader.vue";

// Private player-feedback dashboard: not linked anywhere (the header shows a link only in browsers
// that have opened it) and noindex. The dashboard itself is plain DOM code in src/lib/feedback,
// loaded only here and only in the browser, so the rest of the site never ships it.
const root = ref(null);
// Design variants being compared: full copies of the dashboard in src/lib/feedback-variants/v1…v5,
// each changed in its own way. ?v=1…5 picks one and is remembered in this browser (Steam's sign-in
// comes back without it); ?v=0, or the links above the dashboard, go back to the current one.
// Delete this, the links and the folder once a direction is chosen.
const variants = import.meta.glob("@/lib/feedback-variants/*/dashboard.js");
const variantIds = Object.keys(variants).map((path) => path.split("/").at(-2)).sort();
const variant = ref("");
function pickVariant() {
	try {
		const asked = new URLSearchParams(location.search).get("v");
		if (asked !== null) localStorage.setItem("fb-variant", asked === "0" ? "" : `v${asked.replace(/^v/, "")}`);
		const id = localStorage.getItem("fb-variant") || "";
		return variantIds.includes(id) ? id : "";
	} catch {
		return "";
	}
}
onMounted(async () => {
	variant.value = pickVariant();
	const load = variant.value
		? Object.entries(variants).find(([path]) => path.includes(`/${variant.value}/`))[1]
		: () => import("@/lib/feedback/dashboard.js");
	// Each deploy renames the dashboard's file, so a page from before the latest deploy (or a cached
	// one) asks for a file that's gone: load the current page instead, once, rather than staying on
	// "Loading…".
	const tried = () => {
		try {
			return sessionStorage.getItem("fb-reloaded") === "1";
		} catch {
			return true;
		}
	};
	let dashboard;
	try {
		dashboard = await load();
	} catch {
		if (!tried()) {
			try {
				sessionStorage.setItem("fb-reloaded", "1");
			} catch {}
			location.reload();
			return;
		}
		root.value.textContent = "Couldn't load the dashboard. Reload the page to try again.";
		return;
	}
	try {
		sessionStorage.removeItem("fb-reloaded");
	} catch {}
	dashboard.mount(root.value);
});
</script>

<template>
	<PageHeader
		title="Player feedback"
		description="Reviews, discussions, bugs and ideas for every game, sorted by Claude."
	>
		<!-- Filled by the dashboard: how often it collects and whether each service works, and who's
		signed in (with Steam, the owner's account only). -->
		<div class="fb"><div id="fb-status"></div><div id="fb-account"></div></div>
	</PageHeader>
	<section class="bg-bg">
		<div class="container-page padded">
			<p v-if="variantIds.length" class="text-date" style="margin-bottom: 0.75rem">
				Design:
				<a href="?v=0" :style="{ fontWeight: variant ? 400 : 700, marginRight: '0.75rem' }">Current</a>
				<a
					v-for="id in variantIds"
					:key="id"
					:href="`?v=${id.slice(1)}`"
					:style="{ fontWeight: variant === id ? 700 : 400, marginRight: '0.75rem' }"
					>Variant {{ id.slice(1) }}</a
				>
			</p>
			<div ref="root" class="fb">
				<p class="text-date">Loading…</p>
			</div>
		</div>
	</section>
</template>
