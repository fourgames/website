<script setup>
import { PLATFORM_NAMES } from "@/lib/games.js";

// Windows / macOS / Linux marks, as on godotengine.org/showcase (icons from that site).
defineProps({ platforms: { type: Array, required: true } });
const ICONS = { windows: "/images/platforms/windows.svg", mac: "/images/platforms/macos.svg", linux: "/images/platforms/linux.svg" };
</script>

<template>
	<ul v-if="platforms.length" class="flex items-center gap-2" aria-label="Platforms">
		<li v-for="platform in platforms" :key="platform">
			<img
				v-if="ICONS[platform]"
				:src="ICONS[platform]"
				width="20"
				height="20"
				:alt="PLATFORM_NAMES[platform] ?? platform"
				:title="PLATFORM_NAMES[platform] ?? platform"
				class="size-5 opacity-80 dark:invert"
			/>
		</li>
	</ul>
</template>
