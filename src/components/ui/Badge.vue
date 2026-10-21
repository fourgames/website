<script setup>
defineProps({
	tone: { type: String, default: "neutral" }, // neutral | accent | success | warning
	dot: { type: Boolean, default: false },
});

const TONES = {
	neutral: "bg-surface text-fg",
	accent: "bg-primary/15 text-primary",
	success: "bg-success/15 text-success",
	warning: "bg-warning/15 text-warning",
};
const DOTS = { neutral: "bg-fg", accent: "bg-primary", success: "bg-success", warning: "bg-warning" };
</script>

<template>
	<span :class="['inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold', TONES[tone]]">
		<span v-if="dot" aria-hidden="true" :class="['size-1.5 rounded-full', DOTS[tone]]"></span>
		<slot />
	</span>
</template>
