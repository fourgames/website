<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import GameCard from "@/components/games/GameCard.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import { byRecency, getGames } from "@/lib/games.js";

// Same timeline as the home page, split into the two sections below.
const i18n = useI18n();
const { t } = i18n;
const ordered = getGames(i18n).sort(byRecency);
const released = ordered.filter((g) => g.status === "released");
const upcoming = ordered.filter((g) => g.status !== "released");
</script>

<template>
	<PageHeader :title="t('games.title')" :description="t('games.description')">
		<div class="flex flex-wrap gap-3">
			<Button :href="SITE.links.steam" variant="blue" icon="steam">{{ t("games.followSteam") }}</Button>
			<Button :href="SITE.links.youtubeJoin" icon="youtube">{{ t("membership.join") }}</Button>
		</div>
	</PageHeader>

	<Section id="games" :title="t('games.released')">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
			<li v-for="game in released" :key="game.appId"><GameCard :game="game" /></li>
		</ul>
	</Section>

	<Section v-if="upcoming.length" id="coming-soon" :title="t('games.upcoming')">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
			<li v-for="game in upcoming" :key="game.appId"><GameCard :game="game" /></li>
		</ul>
	</Section>
</template>
