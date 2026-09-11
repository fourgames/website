<script setup>
defineProps({
	tone: { type: String, default: "neutral" }, // neutral | accent | success | warning
	dot: { type: Boolean, default: false },
});

const TONES = {
	neutral: "border-white/10 bg-white/[0.04] text-muted",
	accent: "border-accent/30 bg-accent/10 text-accent-2",
	success: "border-success/25 bg-success/10 text-success",
	warning: "border-warning/25 bg-warning/10 text-warning",
};
const DOTS = { neutral: "bg-muted", accent: "bg-accent-2", success: "bg-success", warning: "bg-warning" };
</script>

<template>
	<span :class="['inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium', TONES[tone]]">
		<span v-if="dot" aria-hidden="true" :class="['size-1.5 rounded-full', DOTS[tone]]"></span>
		<slot />
	</span>
</template>
