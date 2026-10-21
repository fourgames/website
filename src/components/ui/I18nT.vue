<script setup>
import { useSlots } from "vue";
import { useI18n } from "@/i18n/index.js";

// A translated sentence with markup inside it: "Looking for our {videos}, {code}, or {jobs}?".
// Each {name} renders the slot of that name, so links and bold numbers stay components while the
// word order around them belongs to the translation. Placeholders without a slot fall back to
// `params`, like t().
const props = defineProps({
	keypath: { type: String, required: true },
	params: { type: Object, default: () => ({}) },
});
const slots = useSlots();
const { t } = useI18n();

// Pass every slot name through as itself, so t() leaves {name} in place for the split below.
function parts() {
	const keep = Object.fromEntries(Object.keys(slots).map((name) => [name, `{${name}}`]));
	return t(props.keypath, { ...props.params, ...keep }).split(/(\{\w+\})/);
}
</script>

<template>
	<template v-for="(part, i) in parts()" :key="i">
		<slot v-if="/^\{\w+\}$/.test(part) && $slots[part.slice(1, -1)]" :name="part.slice(1, -1)" />
		<template v-else>{{ part }}</template>
	</template>
</template>
