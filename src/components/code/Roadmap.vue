<script setup>
import I18nT from "@/components/ui/I18nT.vue";
import { ROADMAP } from "@/data/roadmap.js";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();
const planned = (item) => item.status === "planned";
const underway = ROADMAP.filter((item) => !planned(item)).length;
</script>

<template>
	<!-- Progress journey: segmented bar, then a list with big faded years behind. -->
	<div class="mx-auto max-w-5xl">
		<div class="flex flex-wrap items-baseline justify-between gap-2">
			<p class="font-heading text-2xl font-extrabold text-title">
				<I18nT keypath="roadmap.underway" :params="{ total: ROADMAP.length }">
					<template #done><span class="text-primary">{{ underway }}</span></template>
				</I18nT>
			</p>
			<p class="text-sm text-date">{{ t("roadmap.since", { year: ROADMAP[0].since }) }}</p>
		</div>
		<div class="mt-4 flex gap-1.5" role="img" :aria-label="t('roadmap.underway', { done: underway, total: ROADMAP.length })">
			<span
				v-for="item in ROADMAP"
				:key="item.id"
				:class="[
					'h-3 flex-1 rounded-full first:rounded-l-full',
					planned(item) ? 'bg-[repeating-linear-gradient(45deg,var(--line-strong)_0_4px,transparent_4px_8px)] opacity-60' : 'bg-primary',
				]"
			></span>
		</div>

		<ol class="mt-10 grid gap-x-10 gap-y-8 md:grid-cols-2">
			<li v-for="item in ROADMAP" :key="item.id" class="relative isolate overflow-hidden py-2 pl-2">
				<span
					aria-hidden="true"
					class="absolute -top-3 right-0 -z-10 font-heading text-7xl leading-none font-extrabold text-primary/10 select-none sm:text-8xl"
				>
					{{ planned(item) ? t("roadmap.next") : item.since }}
				</span>
				<p :class="['font-heading text-sm font-bold uppercase', planned(item) ? 'text-warning' : 'text-primary']">
					{{ planned(item) ? t("roadmap.planned") : item.since }}
				</p>
				<h3 class="mt-1 text-xl">{{ t(`roadmap.items.${item.id}.title`) }}</h3>
				<p class="mt-1.5 max-w-md">{{ t(`roadmap.items.${item.id}.text`) }}</p>
			</li>
		</ol>
	</div>
</template>
