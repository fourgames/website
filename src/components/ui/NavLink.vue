<script setup>
import { computed } from "vue";
import { RouterLink, loadRouteLocation, useRouter } from "vue-router";
import { useI18n } from "@/i18n/index.js";

// RouterLink wrapper: keeps links in the page's language ("/games" → "/ja/games"), prefetches the
// page chunk on hover/focus, only marks real pages as aria-current (not "/#section" anchors), and
// re-scrolls when an anchor link is clicked twice.
defineOptions({ inheritAttrs: false });
const props = defineProps({ to: { type: String, required: true } });
const emit = defineEmits(["navigate"]);

const router = useRouter();
const { path } = useI18n();
const target = computed(() => path(props.to));
const isAnchor = computed(() => props.to.includes("#"));

function prefetch() {
	loadRouteLocation(router.resolve(target.value)).catch(() => {});
}

function onClick(event, navigate) {
	emit("navigate");
	const target = router.resolve(path(props.to));
	if (isAnchor.value && router.currentRoute.value.fullPath === target.fullPath) {
		event.preventDefault();
		const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		document.querySelector(target.hash)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
		return;
	}
	navigate(event);
}
</script>

<template>
	<RouterLink v-slot="{ href, navigate, isExactActive }" :to="target" custom>
		<a
			v-bind="$attrs"
			:href="href"
			:aria-current="isExactActive && !isAnchor ? 'page' : undefined"
			@click="onClick($event, navigate)"
			@pointerenter="prefetch"
			@focus="prefetch"
		>
			<slot />
		</a>
	</RouterLink>
</template>
