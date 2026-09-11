<script setup>
import { computed, nextTick, onMounted, ref } from "vue";
import Icon from "@/components/ui/Icon.vue";
import { formatDuration } from "@/lib/format.js";

// Click-to-play YouTube: a real link to youtube.com (works without JS, Cmd/Ctrl-click opens a tab)
// that swaps in a privacy-enhanced iframe on a plain click. Nothing from YouTube loads until then.
const props = defineProps({
	video: { type: Object, required: true },
	autoplay: { type: Boolean, default: false },
	sizes: { type: String, default: "100vw" },
});

const playing = ref(props.autoplay && props.video.embeddable);
const frame = ref(null);

const watchUrl = computed(() => `https://www.youtube.com/watch?v=${props.video.id}`);
const embedUrl = computed(
	() => `https://www.youtube-nocookie.com/embed/${props.video.id}?autoplay=1&rel=0&playsinline=1`,
);
const thumbs = computed(() => props.video.thumbs ?? []);
const fallbackThumb = computed(
	() => thumbs.value.at(-1)?.url ?? `https://i.ytimg.com/vi/${props.video.id}/hqdefault.jpg`,
);
const srcset = computed(() => thumbs.value.map((t) => `${t.url} ${t.width}w`).join(", "));
const duration = computed(() => formatDuration(props.video.durationSeconds));

function play(event) {
	if (!props.video.embeddable || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
	event.preventDefault();
	playing.value = true;
	nextTick(() => frame.value?.focus());
}

let warmed = false;
function warm() {
	if (warmed) return;
	warmed = true;
	const link = document.createElement("link");
	link.rel = "preconnect";
	link.href = "https://www.youtube-nocookie.com";
	document.head.append(link);
}

onMounted(() => {
	if (playing.value) frame.value?.focus();
});
</script>

<template>
	<div class="relative aspect-video overflow-hidden rounded-xl bg-black">
		<iframe
			v-if="playing"
			ref="frame"
			:src="embedUrl"
			:title="`YouTube video: ${video.title}`"
			class="absolute inset-0 size-full"
			allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
			allowfullscreen
			referrerpolicy="strict-origin-when-cross-origin"
		></iframe>
		<a
			v-else
			:href="watchUrl"
			class="group/play absolute inset-0 block"
			:aria-label="`Play video: ${video.title}`"
			@click="play"
			@pointerenter="warm"
			@focus="warm"
		>
			<img
				:src="fallbackThumb"
				:srcset="srcset || undefined"
				:sizes="srcset ? sizes : undefined"
				width="640"
				height="360"
				alt=""
				loading="lazy"
				decoding="async"
				class="size-full object-cover transition-transform duration-700 ease-out group-hover/play:scale-[1.03]"
			/>
			<span aria-hidden="true" class="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent"></span>
			<span
				aria-hidden="true"
				class="absolute top-1/2 left-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/95 text-bg shadow-[0_10px_40px_-5px_rgb(0_0_0/0.6)] transition-transform duration-300 group-hover/play:scale-110"
			>
				<Icon name="play" class="size-6 translate-x-0.5" />
			</span>
			<span
				v-if="duration"
				aria-hidden="true"
				class="absolute right-3 bottom-3 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white tabular-nums"
			>
				{{ duration }}
			</span>
		</a>
	</div>
</template>
