<script setup>
import Eyebrow from "@/components/ui/Eyebrow.vue";

defineProps({
	eyebrow: { type: String, default: undefined },
	title: { type: String, required: true },
	description: { type: String, default: undefined },
});
</script>

<template>
	<header class="relative isolate overflow-hidden pt-36 pb-6 sm:pt-44 sm:pb-10">
		<div aria-hidden="true" class="bg-dot-grid absolute inset-0 -z-10"></div>
		<div
			aria-hidden="true"
			class="pointer-events-none absolute top-0 left-1/2 -z-10 h-[28rem] w-[56rem] max-w-[200%] -translate-x-1/2 -translate-y-1/3 bg-[radial-gradient(closest-side,rgb(74_144_226/0.24),transparent)]"
		></div>
		<div class="container-page">
			<Eyebrow v-if="eyebrow">{{ eyebrow }}</Eyebrow>
			<h1 class="text-gradient mt-5 max-w-3xl text-4xl leading-[1.08] font-semibold tracking-[-0.03em] sm:text-6xl">
				{{ title }}
			</h1>
			<p v-if="description" class="mt-5 max-w-2xl text-lg text-muted">{{ description }}</p>
			<div v-if="$slots.default" class="mt-8">
				<slot />
			</div>
		</div>
	</header>
</template>
