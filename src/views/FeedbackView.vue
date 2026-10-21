<script setup>
import { onMounted, ref } from "vue";
import PageHeader from "@/components/layout/PageHeader.vue";

// Private player-feedback dashboard: not linked anywhere (the header shows a link only in browsers
// that have opened it) and noindex. The dashboard itself is plain DOM code in src/lib/feedback,
// loaded only here and only in the browser, so the rest of the site never ships it.
const root = ref(null);
onMounted(async () => {
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
		dashboard = await import("@/lib/feedback/dashboard.js");
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
		<!-- Filled by the dashboard: how often it collects and whether each service works. -->
		<div class="fb"><div id="fb-status"></div></div>
	</PageHeader>
	<section class="bg-bg">
		<div class="container-page padded">
			<div ref="root" class="fb">
				<p class="text-date">Loading…</p>
			</div>
		</div>
	</section>
</template>
