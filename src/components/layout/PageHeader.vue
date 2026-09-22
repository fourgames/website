<script setup>
defineProps({
	title: { type: String, required: true },
	description: { type: String, default: undefined },
});
</script>

<template>
	<!-- The site header floats over the page, so leave room for it at the top. -->
	<header class="bg-surface">
		<!-- Fixed minimum height so every inner page starts its content at the same place. -->
		<div class="container-page min-h-[22rem] pt-24 pb-10 nav:pt-28">
			<h1 class="max-w-3xl">{{ title }}</h1>
			<p v-if="description" class="mt-4 max-w-2xl text-subtitle">{{ description }}</p>
			<div v-if="$slots.default" class="mt-7">
				<slot />
			</div>
		</div>
	</header>
</template>
