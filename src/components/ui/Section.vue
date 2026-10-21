<script setup>
import { useId } from "vue";

defineProps({
	id: { type: String, default: undefined },
	title: { type: String, required: true },
	description: { type: String, default: undefined },
	tone: { type: String, default: "bg" }, // bg | surface — alternate bands like godotengine.org
});

const TONES = { bg: "bg-bg", surface: "bg-surface" };
const headingId = useId();
</script>

<template>
	<section :id="id" :aria-labelledby="headingId" :class="TONES[tone]">
		<div class="container-page padded">
			<div class="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
				<div class="max-w-3xl">
					<h2 :id="headingId">{{ title }}</h2>
					<p v-if="description" class="mt-3 text-subtitle">{{ description }}</p>
				</div>
				<div v-if="$slots.actions" class="shrink-0">
					<slot name="actions" />
				</div>
			</div>
			<slot />
		</div>
	</section>
</template>
