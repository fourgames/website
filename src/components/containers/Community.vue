<script setup>
import { ref } from "vue";
import ContainerWrapper from "../common/ContainerWrapper.vue";

const isLoaded = ref(false);

const handleLoad = () => {
  isLoaded.value = true;
};
</script>

<template>
  <ContainerWrapper title="Our Community">
    <div class="w-full p-2">
      <div v-if="!isLoaded" class="w-full h-[450px] skeleton rounded-lg"></div>

      <div 
        class="overflow-hidden rounded-lg bg-[#2f3136] w-full h-[450px]"
        :class="{ 'hidden': !isLoaded }"
      >
        <iframe
          src="https://discord.com/widget?id=1084592623819444365&theme=dark"
          allowtransparency="true"
          frameborder="0"
          sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
          class="w-full h-full"
          @load="handleLoad"
        ></iframe>
      </div>
    </div>
  </ContainerWrapper>
</template>