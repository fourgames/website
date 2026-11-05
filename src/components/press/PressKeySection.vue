<script setup>
import CommunityCard from "@/components/shared/CommunityCard.vue";
import Section from "@/components/ui/Section.vue";
import ContactForm from "@/components/jobs/ContactForm.vue";
import { useI18n } from "@/i18n/index.js";

// "Getting a key" and the press contact, the last section of every press kit page. Laid out like
// the contact section on /jobs: the Discord card (keys, and the quickest reply) beside the same
// message form, which says to use Discord for a quicker reply.
defineProps({ tone: { type: String, default: "bg" } });

const { t } = useI18n();
</script>

<template>
	<Section id="key" :tone="tone" :title="t('press.key.title')" :description="t('press.key.description')">
		<div class="grid gap-5 lg:grid-cols-2">
			<CommunityCard :title="t('press.key.cardTitle')" :text="t('press.key.cardText')" />
			<div id="contact" class="scroll-mt-24">
				<ContactForm :subtitle="t('press.contact.subtitle')" :placeholder="t('press.contact.placeholder')" topic="press" />
			</div>
		</div>
	</Section>
</template>
