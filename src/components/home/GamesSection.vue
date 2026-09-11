<script setup>
import Section from "@/components/ui/Section.vue";
import GameFeature from "./GameFeature.vue";
import GameTeaser from "./GameTeaser.vue";
import { getGames } from "@/lib/games.js";

const games = getGames();
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
