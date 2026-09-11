<script setup>
import { useId } from "vue";
import Eyebrow from "./Eyebrow.vue";

defineProps({
	id: { type: String, default: undefined },
	eyebrow: { type: String, default: undefined },
	title: { type: String, required: true },
	description: { type: String, default: undefined },
});

const headingId = useId();
</script>

<template>
	<section :id="id" :aria-labelledby="headingId" class="py-16 sm:py-24">
		<div class="container-page">
			<div v-reveal class="mb-10 flex flex-col gap-6 sm:mb-12 md:flex-row md:items-end md:justify-between">
				<div class="max-w-2xl">
					<Eyebrow v-if="eyebrow">{{ eyebrow }}</Eyebrow>
					<h2 :id="headingId" class="mt-4 text-3xl font-semibold tracking-[-0.025em] text-fg sm:text-[2.5rem] sm:leading-[1.1]">
						{{ title }}
					</h2>
					<p v-if="description" class="mt-4 text-base text-muted sm:text-lg">{{ description }}</p>
				</div>
				<div v-if="$slots.actions" class="shrink-0">
					<slot name="actions" />
				</div>
			</div>
			<slot />
		</div>
	</section>
</template>
