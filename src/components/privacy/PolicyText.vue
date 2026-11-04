<script setup>
import I18nT from "@/components/ui/I18nT.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// One sentence of the privacy policy, with its links: {email}, {imy}, {dbip} and {yourData}
// render as links wherever a translation puts them.
defineProps({ keypath: { type: String, required: true } });

const { t, path } = useI18n();
const email = SITE.privacy.email;
</script>

<template>
	<I18nT :keypath="keypath">
		<template #email>
			<a :href="`mailto:${email}`" class="link">{{ email }}</a>
		</template>
		<template #imy>
			<a href="https://www.imy.se/en/" target="_blank" rel="noopener noreferrer" class="link"
				>{{ t("privacy.imy") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
			>
		</template>
		<template #dbip>
			<a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" class="link"
				>db-ip.com<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
			>
		</template>
		<template #yourData>
			<a :href="path('/privacy#your-data')" class="link">{{ t("privacy.data.title") }}</a>
		</template>
	</I18nT>
</template>
