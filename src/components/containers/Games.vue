<script setup>
import ContainerWrapper from "../common/ContainerWrapper.vue";

const steamAppIds = [2807130, 3958210, 5207970];
</script>

<template>
	<ContainerWrapper title="Our Games">
		<div class="grid grid-cols-1 md:grid-cols-2 gap-0">
			<div v-for="appId in steamAppIds" :key="appId" class="w-full p-2">
				<div class="overflow-hidden rounded-lg shadow-none">
					<iframe
						:src="`https://store.steampowered.com/widget/${appId}/`"
						frameborder="0"
						class="w-full h-[190px]"
						style="color-scheme: light"
					></iframe>
				</div>
			</div>
		</div>
	</ContainerWrapper>
</template>
