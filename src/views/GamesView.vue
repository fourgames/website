<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import GameCard from "@/components/games/GameCard.vue";
import { SITE } from "@/data/site.js";
import { byRecency, getGames } from "@/lib/games.js";

// Same timeline as the home page, split into the two sections below.
const ordered = getGames().sort(byRecency);
const released = ordered.filter((g) => g.status === "released");
const upcoming = ordered.filter((g) => g.status !== "released");
</script>

<template>
	<PageHeader title="Our games" description="Made with Godot, made with care. Every game we release is free for members.">
		<div class="flex flex-wrap gap-3">
			<Button :href="SITE.links.steam" variant="blue" icon="steam">Follow on Steam</Button>
			<Button :href="SITE.links.youtubeJoin" icon="youtube">Join on YouTube</Button>
		</div>
	</PageHeader>

	<Section id="games" title="Games">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
			<li v-for="game in released" :key="game.appId"><GameCard :game="game" /></li>
		</ul>
	</Section>

	<Section v-if="upcoming.length" id="coming-soon" title="Coming soon">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
			<li v-for="game in upcoming" :key="game.appId"><GameCard :game="game" /></li>
		</ul>
	</Section>
</template>
