<script setup>
import Button from "@/components/ui/Button.vue";
import LogoMark from "@/components/ui/LogoMark.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import GameCard from "@/components/games/GameCard.vue";
import PressFacts from "@/components/press/PressFacts.vue";
import PressKeySection from "@/components/press/PressKeySection.vue";
import { SITE, SOCIALS } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import { getPressGames } from "@/lib/press.js";

// The studio press kit, in presskit()'s order: about and games beside the factsheet, logos, keys and contact.
const i18n = useI18n();
const { t } = i18n;
const games = getPressGames(i18n);

// Discord first: it's where we answer fastest. The form below (#contact) is for everything else.
const contact = [
	{ label: "Discord", href: SITE.links.discord },
	{ label: t("press.facts.contactForm"), href: "#contact" },
];

const facts = [
	{ label: t("press.facts.studio"), value: SITE.name },
	{ label: t("press.facts.basedIn"), value: t("press.sweden") },
	{ label: t("press.facts.founded"), value: "2023" },
	{ label: t("press.facts.website"), links: [{ label: SITE.url.replace(/^https:\/\//, ""), href: SITE.url }] },
	{ label: t("press.facts.contact"), links: contact },
	{ label: t("press.facts.social"), links: SOCIALS.map((s) => ({ label: s.label, href: s.href })) },
];

// Files that already ship in /public: the clover as a vector and as a PNG.
const logos = [
	{ href: "/favicon.svg", file: "fourgames-logo.svg", label: t("press.logos.svg") },
	{ href: "/logo-512.png", file: "fourgames-logo-512.png", label: t("press.logos.png") },
];

// Alternate the bands.
const sections = ["factsheet", "logos", "key"];
const tone = (id) => (sections.indexOf(id) % 2 ? "surface" : "bg");
</script>

<template>
	<PageHeader :title="t('press.title')" :description="t('press.description')">
		<div class="flex flex-wrap gap-3">
			<Button to="/press#key" variant="blue" icon="steam">{{ t("press.getKey") }}</Button>
			<Button :href="SITE.links.discord" icon="discord">{{ t("discord.join") }}</Button>
		</div>
	</PageHeader>

	<Section id="factsheet" :tone="tone('factsheet')" :title="t('press.about')">
		<div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_324px]">
			<!-- The games sit beside the factsheet, the way a Steam page fills the space next to its
			     details box, instead of leaving the factsheet beside a single paragraph. -->
			<div class="min-w-0">
				<p class="max-w-3xl">{{ t("head.home.description") }}</p>
				<template v-if="games.length">
					<h3 id="games" class="mt-10 text-xl">{{ t("press.games.title") }}</h3>
					<p class="mt-2 max-w-3xl text-base text-date">{{ t("press.games.description") }}</p>
					<ul class="mt-5 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
						<li v-for="game in games" :key="game.appId"><GameCard :game="game" :to="`/press/${game.slug}`" /></li>
					</ul>
				</template>
			</div>
			<PressFacts :title="t('press.factsheet')" :rows="facts">
				<template #media>
					<span class="grid aspect-capsule place-items-center bg-dark">
						<LogoMark class="size-20" />
					</span>
				</template>
			</PressFacts>
		</div>
	</Section>

	<Section id="logos" :tone="tone('logos')" :title="t('press.logos.title')" :description="t('press.logos.description')">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
			<li v-for="logo in logos" :key="logo.href">
				<a :href="logo.href" :download="logo.file" class="group block h-full">
					<article class="card card-hover flex h-full flex-col overflow-hidden">
						<span class="grid aspect-capsule place-items-center bg-dark">
							<img :src="logo.href" width="80" height="80" alt="" loading="lazy" decoding="async" class="size-20" />
						</span>
						<span class="p-4 text-sm font-semibold">{{ logo.label }}</span>
					</article>
				</a>
			</li>
		</ul>
	</Section>

	<PressKeySection :tone="tone('key')" />
</template>
