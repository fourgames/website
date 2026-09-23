<script setup>
import { computed } from "vue";
import Badge from "@/components/ui/Badge.vue";
import Logo from "@/components/ui/Logo.vue";
import PlatformIcons from "./PlatformIcons.vue";
import { SITE } from "@/data/site.js";
import { gameStatusLabel, priceLabel } from "@/lib/games.js";

// Showcase card, godotengine.org/showcase style: capsule art, title + studio, platform icons,
// then the live Steam genres and price.
const props = defineProps({ game: { type: Object, required: true } });

const price = computed(() => priceLabel(props.game));

// Upcoming games have no price yet, so the slot that holds it is free for the release date.
const status = computed(() => (price.value ? null : gameStatusLabel(props.game)));
</script>

<template>
	<a
		:href="game.storeUrl"
		target="_blank"
		rel="noopener noreferrer"
		class="group block h-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
	>
		<article
			class="flex h-full flex-col gap-2.5 rounded-lg bg-card p-2.5 shadow-[0_5px_10px_-3px_rgb(0_0_0/0.47)] transition-[box-shadow,transform] duration-100 ease-in-out group-hover:-translate-y-1 group-hover:shadow-[0_10px_18px_-3px_rgb(0_0_0/0.47)] group-focus-visible:-translate-y-1"
		>
			<div class="relative aspect-capsule overflow-hidden rounded border border-black/60 bg-surface">
				<img
					v-if="game.image"
					:src="game.image"
					width="460"
					height="215"
					:alt="`${game.name} key art`"
					loading="lazy"
					decoding="async"
					class="size-full object-cover"
				/>
				<span v-else class="teaser-art absolute inset-0 grid place-items-center text-white/40" :style="{ '--hue': game.hue }">
					<Logo class="size-14" />
				</span>
			</div>
			<div class="flex items-start justify-between gap-3">
				<div class="flex min-w-0 flex-col gap-0.5 text-sm">
					<span class="font-bold hyphens-auto">{{ game.name }}</span>
					<span>{{ SITE.name }}</span>
				</div>
				<PlatformIcons :platforms="game.platforms" class="shrink-0 justify-end" />
			</div>
			<div v-if="game.genres.length || price || status" class="mt-auto flex items-center justify-between gap-3 pt-0.5 text-xs">
				<span class="min-w-0 truncate opacity-65">{{ game.genres.join(" · ") }}</span>
				<span v-if="price" class="flex shrink-0 items-center gap-1.5">
					<template v-if="typeof price === 'string'">
						<span class="font-semibold">{{ price }}</span>
					</template>
					<template v-else>
						<Badge v-if="price.discountPercent" tone="accent">-{{ price.discountPercent }}%</Badge>
						<span v-if="price.discountPercent" class="line-through opacity-60">{{ price.initial }}</span>
						<span class="font-semibold">{{ price.final }}</span>
					</template>
				</span>
				<span v-else-if="status" class="shrink-0 opacity-65">{{ status }}</span>
			</div>
			<span class="sr-only">(opens in new tab)</span>
		</article>
	</a>
</template>
