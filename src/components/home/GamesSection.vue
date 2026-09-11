<script setup>
import Section from "@/components/ui/Section.vue";
import GameFeature from "./GameFeature.vue";
import GameTeaser from "./GameTeaser.vue";
import { GAMES } from "@/data/games.js";
import steam from "@/data/generated/steam.json";

// Live Steam data (fetched at build time) wins; games.js fallbacks cover unannounced games.
const games = GAMES.map(({ appId, fallback = {} }) => {
	const live = steam.apps?.[appId];
	return {
		appId,
		status: live?.status ?? fallback.status ?? "unlisted",
		name: live?.name ?? fallback.name ?? "Unannounced project",
		description: live?.shortDescription || fallback.tagline || "",
		image: live?.headerImage ?? fallback.image ?? null,
		storeUrl: live?.storeUrl ?? `https://store.steampowered.com/app/${appId}/`,
		price: live?.price ?? null,
		isFree: live?.isFree ?? false,
		releaseDate: live?.releaseDate ?? null,
		platforms: live?.platforms ?? [],
		genres: live?.genres ?? [],
		screenshots: live?.screenshots ?? [],
		hue: fallback.hue ?? 212,
	};
});

const released = games.filter((g) => g.status === "released");
const upcoming = games.filter((g) => g.status !== "released");
</script>

<template>
	<Section
		id="games"
		eyebrow="Our games"
		title="Made with Godot, made with care"
		description="What's out now — and what's still heating up in the forge."
	>
		<div class="space-y-4 sm:space-y-6">
			<GameFeature v-for="game in released" :key="game.appId" v-reveal :game="game" />
			<ul v-if="upcoming.length" class="grid gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
				<li v-for="(game, i) in upcoming" :key="game.appId" v-reveal="i * 90" class="flex">
					<GameTeaser :game="game" />
				</li>
			</ul>
		</div>
	</Section>
</template>
