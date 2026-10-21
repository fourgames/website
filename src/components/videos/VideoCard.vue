<script setup>
import RelativeTime from "@/components/ui/RelativeTime.vue";
import { useI18n } from "@/i18n/index.js";
import { formatCompact, formatDuration } from "@/lib/format.js";
import { videoThumb } from "@/lib/videos.js";

const props = defineProps({ video: { type: Object, required: true } });
const thumb = videoThumb(props.video, 640);
const { t, locale } = useI18n();
</script>

<template>
	<a
		:href="`https://www.youtube.com/watch?v=${video.id}`"
		target="_blank"
		rel="noopener noreferrer"
		class="card card-hover flex h-full flex-col overflow-hidden"
	>
		<span class="relative block aspect-video overflow-hidden bg-black">
			<img :src="thumb" width="640" height="360" alt="" loading="lazy" decoding="async" class="size-full object-cover" />
			<span
				v-if="video.durationSeconds"
				aria-hidden="true"
				class="absolute right-2 bottom-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums"
			>
				{{ formatDuration(video.durationSeconds) }}
			</span>
		</span>
		<span class="flex flex-1 flex-col p-4">
			<span class="text-sm text-date">
				<template v-if="video.viewCount !== null && video.viewCount !== undefined">{{ t("videos.views", { count: formatCompact(video.viewCount, locale.intl) }) }} · </template>
				<RelativeTime v-if="video.publishedAt" :datetime="video.publishedAt" />
			</span>
			<h3 class="mt-1.5 line-clamp-3 text-lg">{{ video.title }}</h3>
			<span class="sr-only">{{ $t("a11y.newTab") }}</span>
		</span>
	</a>
</template>
