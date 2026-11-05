<script setup>
import I18nT from "@/components/ui/I18nT.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// Quick answers above the contact form, so the common questions (keys, bugs, data, outages,
// coverage) get answered without a message. Each answer is jobs.faq.<id>.a; {discord}, {press},
// {privacy} and {status} render as links wherever a translation puts them.
const ITEMS = ["key", "bug", "data", "down", "coverage"];

const { t, path } = useI18n();
</script>

<template>
	<div class="mb-10 max-w-3xl">
		<h3 class="text-xl">{{ t("jobs.faq.title") }}</h3>
		<div class="mt-4 divide-y divide-line border-y border-line">
			<details v-for="id in ITEMS" :id="`faq-${id}`" :key="id" class="group">
				<summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold">
					{{ t(`jobs.faq.${id}.q`) }}
					<span aria-hidden="true" class="text-date transition-transform group-open:rotate-90">›</span>
				</summary>
				<p class="pb-4 text-date">
					<I18nT :keypath="`jobs.faq.${id}.a`">
						<template #discord>
							<a :href="SITE.links.discord" target="_blank" rel="noopener noreferrer" class="link"
								>Discord<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
						</template>
						<template #press>
							<a :href="path('/press')" class="link">{{ t("press.title") }}</a>
						</template>
						<template #privacy>
							<a :href="path('/privacy')" class="link">{{ t("privacy.title") }}</a>
						</template>
						<template #status>
							<a :href="SITE.status" target="_blank" rel="noopener noreferrer" class="link"
								>{{ t("footer.resources.status") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
						</template>
					</I18nT>
				</p>
			</details>
		</div>
	</div>
</template>
