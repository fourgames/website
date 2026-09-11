<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";
import { SITE } from "@/data/site.js";

defineProps({ game: { type: Object, required: true } });
</script>

<template>
	<article class="surface-card group flex w-full flex-col overflow-hidden">
		<div class="teaser-art relative aspect-[460/215] overflow-hidden border-b border-line" :style="{ '--hue': game.hue }">
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
				class="absolute top-1/2 left-1/2 size-20 -translate-x-1/2 -translate-y-1/2 opacity-20 grayscale transition-transform duration-700 ease-out group-hover:scale-110 group-hover:rotate-12"
			/>
			<span
				class="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-xs font-medium text-fg backdrop-blur-md"
			>
				<Icon name="clock" class="size-3.5" />
				{{ game.status === "upcoming" ? "Coming soon" : "In development" }}
			</span>
		</div>

		<div class="flex flex-1 flex-col p-5 sm:p-6">
			<h3 class="text-lg font-semibold tracking-tight">{{ game.name }}</h3>
			<p class="mt-2 text-sm text-muted">{{ game.description }}</p>
			<div class="mt-auto pt-5">
				<Button v-if="game.status === 'upcoming'" :href="game.storeUrl" variant="secondary" size="sm" icon="steam">
					Wishlist on Steam
				</Button>
				<a
					v-else
					:href="SITE.links.discord"
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1.5 text-sm font-medium text-accent-2 transition-colors hover:text-fg"
				>
					<Icon name="bell" class="size-4" />
					Get notified on Discord
					<span class="sr-only">(opens in new tab)</span>
				</a>
			</div>
		</div>
	</article>
</template>
