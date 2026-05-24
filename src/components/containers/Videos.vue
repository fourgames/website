<script setup>
import ContainerWrapper from "../common/ContainerWrapper.vue";
import LiteYouTubeEmbed from "vue-lite-youtube-embed";
import "vue-lite-youtube-embed/style.css";


const videoIds = [
  "hUCnsIy7W24", 
  "bR0v-yoZYZA"
];
</script>

<template>
	<ContainerWrapper title="Our Videos">
		<div class="grid grid-cols-1 md:grid-cols-2 gap-2">
			<div v-for="id in videoIds" :key="id" class="w-full p-2">
				<div class="aspect-video w-full overflow-hidden rounded-lg bg-base-100">
					<LiteYouTubeEmbed :id="id" title="Our Video" class="w-full h-full" />
				</div>
			</div>
		</div>
	</ContainerWrapper>
</template>
