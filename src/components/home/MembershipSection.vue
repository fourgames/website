<script setup>
import { ref } from "vue";
import { RouterLink } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import BadgesArt from "./BadgesArt.vue";
import DiscordArt from "./DiscordArt.vue";
import FanCards from "./FanCards.vue";
import { useDiscordPresence } from "@/composables/useDiscordPresence.js";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
import { getGames } from "@/lib/games.js";
import { videoThumb } from "@/lib/videos.js";
import discord from "@/data/generated/discord.json";
import youtube from "@/data/generated/youtube.json";

// Feature cards like "A different way to make games" on godotengine.org: 250px art, navy body,
// and the whole card is a link.
const games = getGames();

// Live Discord members for the role card (fetched once the cards scroll into view).
const cards = ref(null);
const presence = useDiscordPresence(discord, cards);

// Card fans for the "keys" and "early access" perks (same component, so they match).
// One card per game we actually have — the perk is "all our games", so showing the same one
// three times undersells it.
const keyCards = games.slice(0, 3).map((game) => ({
	image: game.image,
	hue: game.hue,
	label: game.name,
	icon: "check-circle",
	iconClass: "text-success",
}));
// mqdefault (320x180): the wider ones are either 4:3 letterboxed (hq/sd) or a 1280x720 file
// for a ~140px card.
const videoCards = [...(youtube.latest ?? [])].slice(0, 3).map((v) => ({
	image: videoThumb(v, 320),
	label: v.title,
	icon: "clock",
	iconClass: "text-primary",
}));

// Internal perks route, external ones open in a new tab.
const linkFor = (perk) =>
	perk.to ? { is: RouterLink, to: perk.to } : { is: "a", href: perk.href, target: "_blank", rel: "noopener noreferrer" };
</script>

<template>
	<Section id="membership" :title="`${SITE.name} ${MEMBERSHIP.tier}`" :description="MEMBERSHIP.pitch">
		<ul ref="cards" class="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
			<li v-for="perk in MEMBERSHIP.perks" :key="perk.id" class="flex">
				<component
					:is="linkFor(perk).is"
					v-bind="linkFor(perk)"
					class="flex flex-1 flex-col overflow-hidden rounded-lg bg-dark text-white shadow-card transition-transform duration-200 ease-in-out hover:-translate-y-0.5"
				>
					<span aria-hidden="true" class="@container relative block h-[250px] shrink-0 overflow-hidden bg-surface">
						<FanCards v-if="perk.id === 'games' && keyCards.length" :cards="keyCards" />
						<FanCards v-else-if="perk.id === 'early' && videoCards.length" :cards="videoCards" ratio="16/9" />
						<DiscordArt v-else-if="perk.id === 'discord'" :tier="MEMBERSHIP.tier" :members="presence.members" :count="presence.count" :live="presence.live" />
						<BadgesArt v-else-if="perk.id === 'badges'" />
					</span>

					<span class="block flex-1 p-6">
						<h3 class="text-xl text-white">{{ perk.title }}</h3>
						<span class="mt-3 block text-white/85">{{ perk.text }}</span>
						<span v-if="perk.href" class="sr-only"> (opens in new tab)</span>
					</span>
				</component>
			</li>
		</ul>

		<div class="mt-10 flex flex-col items-center gap-4 text-center">
			<Button :href="SITE.links.youtubeJoin" variant="blue" size="lg" icon="youtube">Join on YouTube</Button>
		</div>
	</Section>
</template>
