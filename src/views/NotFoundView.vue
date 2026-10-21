<script setup>
import Button from "@/components/ui/Button.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import I18nT from "@/components/ui/I18nT.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();
</script>

<template>
	<PageHeader
		:title="t('notFound.title')"
		:description="t('notFound.description')"
	>
		<div class="flex flex-wrap gap-3">
			<Button to="/" variant="blue">{{ t("notFound.home") }}</Button>
			<Button to="/games">{{ t("nav.games") }}</Button>
			<Button to="/videos">{{ t("nav.videos") }}</Button>
		</div>
		<p class="mt-8 text-sm text-date">
			<I18nT keypath="notFound.bug">
				<template #link>
					<a :href="SITE.links.issues" target="_blank" rel="noopener noreferrer" class="link">
						{{ t("notFound.report") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span>
					</a>
				</template>
			</I18nT>
		</p>
	</PageHeader>
	<div class="h-24 sm:h-32"></div>
</template>
