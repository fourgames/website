<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import CommunityCard from "@/components/shared/CommunityCard.vue";
import ContactForm from "@/components/jobs/ContactForm.vue";
import PartnerGrid from "@/components/jobs/PartnerGrid.vue";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();
</script>

<template>
	<PageHeader
		:title="t('jobs.title')"
		:description="t('jobs.description')"
	>
		<Button to="/jobs#contact" variant="blue" icon="mail">{{ t("jobs.getInTouch") }}</Button>
	</PageHeader>

	<Section id="collaborations" :title="t('jobs.ways')">
		<PartnerGrid />
	</Section>

	<Section
		id="contact"
		tone="surface"
		:title="t('jobs.contact.title')"
		:description="t('jobs.contact.description')"
	>
		<div class="grid gap-5 lg:grid-cols-2">
			<CommunityCard
				:title="t('jobs.contact.discordTitle')"
				:text="t('jobs.contact.discordText')"
			/>
			<ContactForm />
		</div>
	</Section>
</template>
