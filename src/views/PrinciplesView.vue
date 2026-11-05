<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import { useI18n } from "@/i18n/index.js";

// What Four Games believes in and how it's run. Each principle is principles.items.<id>: a title
// and one short text. The ids double as anchors (/principles#publishing).
const PRINCIPLES = ["catalog", "digital", "updates", "publishing", "languages", "tools", "profits", "next"];

const { t } = useI18n();
</script>

<template>
	<PageHeader :title="t('principles.title')" :description="t('principles.description')">
		<Button to="/jobs#contact" variant="blue" icon="mail">{{ t("principles.cta") }}</Button>
	</PageHeader>

	<Section id="list" :title="t('principles.listTitle')">
		<ol class="grid gap-5 md:grid-cols-2">
			<li v-for="(id, i) in PRINCIPLES" :id="id" :key="id" class="card flex gap-5 p-6 scroll-mt-28">
				<span class="text-3xl leading-none font-bold text-date tabular-nums" aria-hidden="true">{{ String(i + 1).padStart(2, "0") }}</span>
				<div>
					<h3 class="text-xl">{{ t(`principles.items.${id}.title`) }}</h3>
					<p class="mt-2">{{ t(`principles.items.${id}.text`) }}</p>
				</div>
			</li>
		</ol>
	</Section>
</template>
