<script setup>
import FanCards from "@/components/home/FanCards.vue";
import FranchiseArt from "./FranchiseArt.vue";
import { getGames } from "@/lib/games.js";
import { videoThumb } from "@/lib/videos.js";
import youtube from "@/data/generated/youtube.json";

// Art for the "Ways to work with us" columns, the jobs twin of InvolveColumnArt: the same fanned
// cards, so /jobs and the home page read as one design.
defineProps({
	kind: { type: String, required: true }, // series | codev | franchise
});

// mqdefault (320x180): the wider sizes are either 4:3 letterboxed or a 1280x720 file for a
// ~140px card. Same reasoning as InvolveColumnArt.vue.
const videoCards = [...(youtube.latest ?? [])].slice(0, 3).map((v) => ({
	image: videoThumb(v, 320),
	label: v.title,
	icon: "video",
	iconClass: "text-primary",
}));

const gameCards = getGames()
	.slice(0, 3)
	.map((game) => ({
		image: game.image,
		hue: game.hue,
		label: game.name,
		icon: "users",
		iconClass: "text-primary",
	}));
</script>

<template>
	<!-- 250px tall and its own @container, like InvolveColumnArt: FanCards sizes itself in cqw and
	     the three CTAs line up off this height. -->
	<span aria-hidden="true" class="@container relative block h-[250px] w-full">
		<FanCards v-if="kind === 'series' && videoCards.length" :cards="videoCards" ratio="16/9" />
		<FanCards v-else-if="kind === 'codev' && gameCards.length" :cards="gameCards" />
		<FranchiseArt v-else-if="kind === 'franchise'" />
	</span>
</template>
