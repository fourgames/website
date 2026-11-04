<script setup>
import Button from "@/components/ui/Button.vue";
import CommunityCard from "@/components/shared/CommunityCard.vue";
import I18nT from "@/components/ui/I18nT.vue";
import Section from "@/components/ui/Section.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// "Getting a key" and the press contact, the last section of every press kit page. Laid out like
// the contact section on /jobs: the Discord card beside a plain card.
defineProps({ tone: { type: String, default: "bg" } });

const { t } = useI18n();
const email = SITE.press?.email ?? null;
</script>

<template>
	<Section id="key" :tone="tone" :title="t('press.key.title')" :description="t('press.key.description')">
		<div class="grid gap-5 lg:grid-cols-2">
			<CommunityCard :title="t('press.key.cardTitle')" :text="t('press.key.cardText')" />
			<article id="contact" class="card flex flex-col p-6 sm:p-8">
				<h3 class="text-xl">{{ t("press.contact.title") }}</h3>
				<p v-if="email" class="mt-5">
					<I18nT keypath="press.contact.email">
						<template #email>
							<a :href="`mailto:${email}`" class="link">{{ email }}</a>
						</template>
					</I18nT>
				</p>
				<p v-else class="mt-5">{{ t("press.contact.discord") }}</p>
				<div v-if="!email" class="mt-auto pt-6">
					<Button :href="SITE.links.discord" icon="discord">{{ t("discord.join") }}</Button>
				</div>
			</article>
		</div>
	</Section>
</template>
