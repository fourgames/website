<script setup>
defineProps({
	title: {
		type: String,
		required: true,
	},
});
</script>

<template>
	<div class="py-8 max-w-[1200px] mx-auto px-4 w-full">
		<div class="bg-base-200 p-6 md:p-8 shadow-none rounded-lg">
			<h2 class="text-center mb-6 text-2xl font-bold tracking-tight text-base-content">
				{{ title }}
			</h2>

			<slot />
		</div>
	</div>
</template>