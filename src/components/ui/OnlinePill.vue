<script setup>
// The Discord live-presence row: a green dot that pulses once the public widget has answered, and
// the number of people online right now. Shared so the hero CTA and the art wells (DiscordArt)
// can't drift apart — they are the same pulse, on different backgrounds.
defineProps({
	count: { type: Number, default: null },
	live: { type: Boolean, default: false },
	// "button" rides inside a CTA, where the button's own colour already carries it: it only has to
	// step back from the label so the two don't compete.
	tone: { type: String, default: "default" }, // default | button
});

const TONES = {
	default: "text-sm",
	button: "text-sm font-normal text-white/85",
};
</script>

<template>
	<span :class="['inline-flex items-center gap-2', TONES[tone]]">
		<span class="relative flex size-2.5" aria-hidden="true">
			<span v-if="live" class="absolute inset-0 rounded-full bg-[#23a559] motion-safe:animate-pulse-dot"></span>
			<span class="relative size-2.5 rounded-full bg-[#23a559]"></span>
		</span>
		<span class="font-semibold tabular-nums">{{ count }}</span> online now
	</span>
</template>
