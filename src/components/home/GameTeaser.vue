<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";
import { SITE } from "@/data/site.js";

const props = defineProps({ game: { type: Object, required: true } });
const statusLabel = props.game.status === "upcoming" ? "Coming soon" : "In development";
</script>

<template>
	<!-- Compact row on phones, card from sm up. -->
	<article class="surface-card group flex w-full overflow-hidden sm:flex-col">
		<div
			class="teaser-art relative w-28 shrink-0 overflow-hidden border-r border-line sm:aspect-[460/215] sm:w-full sm:border-r-0 sm:border-b"
			:style="{ '--hue': game.hue }"
		>
			<img
				v-if="game.image"
				:src="game.image"
				width="460"
				height="215"
				alt=""
				loading="lazy"
				decoding="async"
				class="size-full object-cover"
			/>
			<Logo
				v-else
				class="absolute top-1/2 left-1/2 size-12 -translate-x-1/2 -translate-y-1/2 opacity-20 grayscale transition-transform duration-700 ease-out group-hover:scale-110 group-hover:rotate-12 sm:size-20"
			/>
			<span
				class="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-xs font-medium text-fg backdrop-blur-md max-sm:hidden"
			>
				<Icon name="clock" class="size-3.5" />
				{{ statusLabel }}
			</span>
		</div>

		<div class="flex flex-1 flex-col p-4 sm:p-6">
			<p class="mb-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-muted sm:hidden">
				<Icon name="clock" class="size-3.5" />
				{{ statusLabel }}
			</p>
			<h3 class="text-base font-semibold tracking-tight sm:text-lg">{{ game.name }}</h3>
			<p class="mt-1.5 text-sm text-muted sm:mt-2">{{ game.description }}</p>
			<p class="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-accent-2">
				<Icon name="heart" class="size-3.5" />
				Free for members at launch
			</p>
			<div class="mt-auto pt-3 sm:pt-5">
				<Button v-if="game.status === 'upcoming'" :href="game.storeUrl" variant="secondary" size="sm" icon="steam">
					Wishlist on Steam
				</Button>
				<a
					v-else
					:href="SITE.links.discord"
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex min-h-6 items-center gap-1.5 text-sm font-medium text-accent-2 transition-colors hover:text-fg"
				>
					<Icon name="bell" class="size-4" />
					Get notified on Discord
					<span class="sr-only">(opens in new tab)</span>
				</a>
			</div>
		</div>
	</article>
</template>
