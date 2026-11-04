<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import PolicyText from "@/components/privacy/PolicyText.vue";
import YourData from "@/components/privacy/YourData.vue";
import { useI18n } from "@/i18n/index.js";
import { formatDate } from "@/lib/format.js";

// The privacy policy in plain language, then "Your data": sign in with Steam to see, download, opt
// out of or anonymise what the games sent (server/gamedata/SPEC.md). The games' "Privacy" link
// opens this page. Change UPDATED whenever the policy text changes.
const UPDATED = "2026-11-04";

const { t, raw, locale } = useI18n();

// Each topic is privacy.policy.<id>: a title, paragraphs (body) and an optional list.
const TOPICS = ["control", "games", "website", "why", "storage", "sharing", "who"];
const topics = TOPICS.map((id) => {
	const topic = raw(`privacy.policy.${id}`) ?? {};
	return { id, body: topic.body?.length ?? 0, list: topic.list?.length ?? 0, after: topic.after?.length ?? 0 };
});
</script>

<template>
	<PageHeader :title="t('privacy.title')" :description="t('privacy.description')">
		<div class="flex flex-wrap gap-3">
			<Button to="/privacy#your-data" variant="blue" icon="shield">{{ t("privacy.seeData") }}</Button>
		</div>
	</PageHeader>

	<Section id="policy" :title="t('privacy.policy.title')" :description="t('privacy.updated', { date: formatDate(UPDATED, locale.intl) })">
		<div class="max-w-3xl space-y-10">
			<p>{{ t("privacy.policy.intro") }}</p>
			<section v-for="topic in topics" :id="`policy-${topic.id}`" :key="topic.id" :aria-labelledby="`policy-${topic.id}-title`">
				<h3 :id="`policy-${topic.id}-title`" class="text-xl">{{ t(`privacy.policy.${topic.id}.title`) }}</h3>
				<p v-for="i in topic.body" :key="`b${i}`" class="mt-3">
					<PolicyText :keypath="`privacy.policy.${topic.id}.body.${i - 1}`" />
				</p>
				<ul v-if="topic.list" class="mt-3 list-disc space-y-2 pl-6 marker:text-date">
					<li v-for="i in topic.list" :key="`l${i}`">
						<PolicyText :keypath="`privacy.policy.${topic.id}.list.${i - 1}`" />
					</li>
				</ul>
				<p v-for="i in topic.after" :key="`a${i}`" class="mt-3">
					<PolicyText :keypath="`privacy.policy.${topic.id}.after.${i - 1}`" />
				</p>
			</section>
		</div>
	</Section>

	<Section id="your-data" tone="surface" :title="t('privacy.data.title')" :description="t('privacy.data.description')">
		<YourData />
	</Section>
</template>
