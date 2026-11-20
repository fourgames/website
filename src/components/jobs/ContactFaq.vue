<script setup>
import I18nT from "@/components/ui/I18nT.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// Quick answers above the contact form, so the common questions get answered without a message.
// Each answer is <prefix>.<id>.a; {discord}, {press} and {steamHelp} render as
// links wherever a translation puts them. The support page passes its own prefix and items.
const props = defineProps({
	prefix: { type: String, default: "jobs.faq" },
	items: { type: Array, default: () => ["key", "bug", "coverage"] },
	heading: { type: Boolean, default: true },
});

const STEAM_HELP = "https://help.steampowered.com/";
const { t, path } = useI18n();
</script>

<template>
	<div class="mb-10 max-w-3xl">
		<h3 v-if="props.heading" class="mb-4 text-xl">{{ t(`${props.prefix}.title`) }}</h3>
		<div class="divide-y divide-line border-y border-line">
			<details v-for="id in props.items" :id="`faq-${id}`" :key="id" class="group">
				<summary class="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold">
					{{ t(`${props.prefix}.${id}.q`) }}
					<span aria-hidden="true" class="text-date transition-transform group-open:rotate-90">›</span>
				</summary>
				<p class="pb-4 text-date">
					<I18nT :keypath="`${props.prefix}.${id}.a`">
						<template #discord>
							<a :href="SITE.links.discord" target="_blank" rel="noopener noreferrer" class="link"
								>Discord<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
						</template>
						<template #press>
							<a :href="path('/press')" class="link">{{ t("press.title") }}</a>
						</template>
						<template #steamHelp>
							<a :href="STEAM_HELP" target="_blank" rel="noopener noreferrer" class="link"
								>Steam Support<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
						</template>
					</I18nT>
				</p>
			</details>
		</div>
	</div>
</template>
