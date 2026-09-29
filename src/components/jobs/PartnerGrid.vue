<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import PartnerColumnArt from "./PartnerColumnArt.vue";
import { PARTNERS } from "@/data/partners.js";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();

// Same three-column layout as "Get involved" on the home page: art, one paragraph, a raised CTA.
const types = PARTNERS.filter((p) => !p.principle);
const principle = PARTNERS.find((p) => p.principle);
</script>

<template>
	<div>
		<ul class="grid gap-12 text-center md:grid-cols-3 md:gap-8">
			<li v-for="partner in types" :key="partner.id" class="flex flex-col items-center">
				<PartnerColumnArt :kind="partner.id" />
				<p class="mt-6 text-sm font-semibold tracking-wide text-date uppercase">{{ t(`jobs.partners.${partner.id}.audience`) }}</p>
				<h3 class="mt-2 text-2xl">{{ t(`jobs.partners.${partner.id}.title`) }}</h3>
				<p class="mt-3 max-w-xs">{{ t(`jobs.partners.${partner.id}.text`) }}</p>
				<!-- flex-1 + items-end keeps the three CTAs on one baseline; mt-6 guarantees a gap
				     in the tallest column, where there's no slack left to distribute. -->
				<div class="mt-6 flex flex-1 items-end">
					<Button to="/jobs#contact" variant="ghost" class="bg-card shadow-card">{{ t(`jobs.partners.${partner.id}.cta`) }}</Button>
				</div>
			</li>
		</ul>

		<p v-if="principle" class="mt-12 flex items-center justify-center gap-2.5 text-center text-sm font-semibold text-success">
			<Icon :name="principle.icon" class="size-5 shrink-0" />
			{{ t("jobs.partners.principle.text") }}
		</p>
	</div>
</template>
