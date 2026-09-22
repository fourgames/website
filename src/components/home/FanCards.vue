<script setup>
import { computed } from "vue";
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";

// Three fanned cards with an image and a small caption row; shared by the perk cards so they match.
// Cards without art fall back to the same tinted placeholder the game teasers use.
// `ratio` follows the source art — Steam capsules are 460x215, YouTube stills are 16/9 — so
// `object-cover` never has anything to crop.
// Sizes are container-relative (cqw) so the whole fan fits its column at every breakpoint —
// the art well around it is the @container.
const props = defineProps({
	cards: { type: Array, required: true }, // [{ image, hue, label, icon, iconClass }]
	ratio: { type: String, default: "460/215" },
});
const TILT = [
	"-rotate-6 -translate-x-[18cqw] translate-y-3 opacity-80",
	"z-10",
	"rotate-6 translate-x-[18cqw] translate-y-3 opacity-80",
];
// Only the card on top is labelled; at this size the side captions are all ellipsis.
const front = computed(() => Math.min(1, props.cards.length - 1));
</script>

<template>
	<div class="absolute inset-0 flex items-center justify-center">
		<div
			v-for="(card, i) in cards.slice(0, 3)"
			:key="i"
			:class="['absolute w-[50cqw] max-w-44 overflow-hidden rounded-lg bg-card shadow-lg shadow-black/50', TILT[i]]"
		>
			<img
				v-if="card.image"
				:src="card.image"
				alt=""
				loading="lazy"
				decoding="async"
				class="w-full object-cover"
				:style="{ aspectRatio: ratio }"
			/>
			<span v-else class="teaser-art grid w-full place-items-center text-white/40" :style="{ '--hue': card.hue, aspectRatio: ratio }">
				<Logo class="size-8" />
			</span>
			<div
				v-if="i === front"
				class="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[0.6875rem] font-semibold text-fg"
			>
				<span class="truncate">{{ card.label }}</span>
				<Icon :name="card.icon" :class="['size-3.5 shrink-0', card.iconClass]" :stroke-width="2.5" />
			</div>
		</div>
	</div>
</template>
