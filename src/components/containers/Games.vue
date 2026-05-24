<script setup>
import ContainerWrapper from "../common/ContainerWrapper.vue";
</script>

<template>
	<ContainerWrapper title="Our Games">
		<div class="grid grid-cols-1 md:grid-cols-2 gap-0">
			<div v-for="n in 2" :key="n" class="w-full p-2">
				<div class="overflow-hidden rounded-lg shadow-none">
					<iframe
						src="https://store.steampowered.com/widget/2807130/"
						frameborder="0"
						class="w-full h-[190px]"
						style="color-scheme: light"
					></iframe>
				</div>
			</div>
		</div>
	</ContainerWrapper>
</template>
