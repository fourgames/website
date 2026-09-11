<script setup>
import { computed } from "vue";
import { RouterLink, loadRouteLocation, useRouter } from "vue-router";

// RouterLink wrapper: prefetches the page chunk on hover/focus, only marks real pages as
// aria-current (not "/#section" anchors), and re-scrolls when an anchor link is clicked twice.
defineOptions({ inheritAttrs: false });
const props = defineProps({ to: { type: String, required: true } });
const emit = defineEmits(["navigate"]);

const router = useRouter();
const isAnchor = computed(() => props.to.includes("#"));

function prefetch() {
	loadRouteLocation(router.resolve(props.to)).catch(() => {});
}

function onClick(event, navigate) {
	emit("navigate");
	const target = router.resolve(props.to);
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
	<RouterLink v-slot="{ href, navigate, isExactActive }" :to="to" custom>
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
