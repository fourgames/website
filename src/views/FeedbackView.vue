<script setup>
import { onMounted, ref } from "vue";
import PageHeader from "@/components/layout/PageHeader.vue";

// Private player-feedback dashboard: not linked anywhere (the header shows a link only in browsers
// that have opened it) and noindex. The dashboard itself is plain DOM code in src/lib/feedback,
// loaded only here and only in the browser, so the rest of the site never ships it.
const root = ref(null);
onMounted(async () => {
	const { mount } = await import("@/lib/feedback/dashboard.js");
	mount(root.value);
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
