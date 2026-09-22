<script setup>
import DiscordArt from "./DiscordArt.vue";
import FanCards from "./FanCards.vue";
import { getGames } from "@/lib/games.js";
import { videoThumb } from "@/lib/videos.js";
import youtube from "@/data/generated/youtube.json";

// Art for the "Get involved" columns, reusing the membership perk-card art so the two sections
// read as one design: the fanned cards for videos and games, the avatar stack for Discord.
defineProps({
	kind: { type: String, required: true }, // chat | learn | collaborate
	members: { type: Array, default: () => [] },
	count: { type: Number, default: null },
	live: { type: Boolean, default: false },
});

// mqdefault (320x180): the wider sizes are either 4:3 letterboxed or a 1280x720 file for a
// ~140px card. Same reasoning as MembershipSection.vue.
const videoCards = [...(youtube.latest ?? [])].slice(0, 3).map((v) => ({
	image: videoThumb(v, 320),
	label: v.title,
	icon: "play",
	iconClass: "text-primary",
}));

const gameCards = getGames()
	.slice(0, 3)
	.map((game) => ({
		image: game.image,
		hue: game.hue,
		label: game.name,
		icon: "gamepad",
		iconClass: "text-primary",
	}));
</script>

<template>
	<!-- No well here: unlike the perk cards, this art floats straight on the section band. Still
	     250px tall (the three CTAs line up off that) and its own @container so FanCards' cqw sizing
	     works; without overflow-hidden the fan can lean past the old box edge. -->
	<span aria-hidden="true" class="@container relative block h-[250px] w-full">
		<DiscordArt v-if="kind === 'chat'" :tier="null" :members="members" :count="count" :live="live" frame-class="border-bg" />
		<FanCards v-else-if="kind === 'learn' && videoCards.length" :cards="videoCards" ratio="16/9" />
		<FanCards v-else-if="kind === 'collaborate' && gameCards.length" :cards="gameCards" />
	</span>
</template>
