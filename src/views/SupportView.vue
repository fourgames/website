<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import CommunityCard from "@/components/shared/CommunityCard.vue";
import ContactFaq from "@/components/jobs/ContactFaq.vue";
import ContactForm from "@/components/jobs/ContactForm.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import { byRecency, getGames } from "@/lib/games.js";

// Player support, the page Steamworks lists as our support website. Built to answer things before
// they become an email: Discord first (fastest), then each game's Steam discussions and reviews for
// bugs and feedback, then quick answers (refunds and payments are Steam's), and the form last.
const i18n = useI18n();
const { t } = i18n;
const released = getGames(i18n)
	.sort(byRecency)
	.filter((g) => g.status === "released");
const gameNames = getGames(i18n)
	.sort(byRecency)
	.filter((g) => g.status !== "unlisted")
	.map((g) => g.name);

const discussions = (appId) => `https://steamcommunity.com/app/${appId}/discussions/`;
const review = (appId) => `https://store.steampowered.com/recommended/recommendgame/${appId}`;

const FAQ = ["refund", "purchase", "crash", "save", "bug", "idea", "key", "data", "down"];
</script>

<template>
	<PageHeader :title="t('support.title')" :description="t('support.description')">
		<div class="flex flex-wrap gap-3">
			<Button :href="SITE.links.discord" variant="blue" icon="discord">{{ t("support.askDiscord") }}</Button>
			<Button to="/support#contact" variant="ghost" class="bg-card shadow-card" icon="mail">{{ t("support.writeUs") }}</Button>
		</div>
	</PageHeader>

	<Section id="steam" :title="t('support.steam.title')" :description="t('support.steam.description')">
		<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
			<li v-for="game in released" :key="game.appId" class="flex flex-col gap-3 rounded-lg bg-card p-2.5 pb-4 shadow-card">
				<div class="aspect-capsule overflow-hidden rounded border border-black/60 bg-surface">
					<img
						v-if="game.image"
						:src="game.image"
						width="460"
						height="215"
						:alt="t('a11y.keyArt', { name: game.name })"
						loading="lazy"
						decoding="async"
						class="size-full object-cover"
					/>
				</div>
				<h3 class="px-1.5 text-lg">{{ game.name }}</h3>
				<div class="mt-auto flex flex-wrap gap-2 px-1.5">
					<Button :href="discussions(game.appId)" size="sm" variant="blue" icon="steam">{{ t("support.steam.discussions") }}</Button>
					<Button :href="review(game.appId)" size="sm" variant="ghost" icon="star">{{ t("support.steam.review") }}</Button>
				</div>
			</li>
		</ul>
	</Section>

	<Section id="faq" tone="surface" :title="t('support.faq.title')">
		<ContactFaq prefix="support.faq" :items="FAQ" :heading="false" />
	</Section>

	<Section id="contact" :title="t('support.contact.title')" :description="t('support.contact.description')">
		<div class="grid gap-5 lg:grid-cols-2">
			<CommunityCard :title="t('support.contact.discordTitle')" :text="t('support.contact.discordText')" />
			<ContactForm
				topic="support"
				:title="t('support.form.title')"
				:subtitle="t('support.form.subtitle')"
				:placeholder="t('support.form.placeholder')"
				:email-placeholder="t('footer.news.placeholder')"
				:games="gameNames"
				:attachments="false"
			/>
		</div>
	</Section>
</template>
