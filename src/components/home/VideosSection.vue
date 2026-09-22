<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import RelativeTime from "@/components/ui/RelativeTime.vue";
import Section from "@/components/ui/Section.vue";
import { SITE } from "@/data/site.js";
import { isRecent } from "@/lib/games.js";
import { videoThumb } from "@/lib/videos.js";
import youtube from "@/data/generated/youtube.json";

// "Latest releases" layout from godotengine.org: a stacked list of thumbnail + title + date rows.
const videos = [...(youtube.latest ?? [])]
	.sort((a, b) => new Date(b.publishedAt ?? 0) - new Date(a.publishedAt ?? 0))
	.slice(0, 6);
const thumb = (v) => videoThumb(v, 320);

// Godot marks recent posts with a coloured date and a "NEW" tag.
const isNew = (v) => isRecent(v.publishedAt, 14, youtube.fetchedAt);
</script>

<template>
	<Section id="videos" title="Latest videos">
		<ul v-if="videos.length" class="grid gap-[18px]">
			<li v-for="video in videos" :key="video.id">
				<a
					:href="`https://www.youtube.com/watch?v=${video.id}`"
					target="_blank"
					rel="noopener noreferrer"
					class="grid grid-cols-[80px_1fr] gap-5 md:grid-cols-[160px_1fr]"
				>
					<span class="block self-start overflow-hidden rounded-[7px] bg-card shadow-[0_5px_10px_-3px_rgb(0_0_0/0.47)]">
						<img
							:src="thumb(video)"
							width="320"
							height="180"
							alt=""
							loading="lazy"
							decoding="async"
							class="aspect-video w-full object-cover"
						/>
					</span>
					<span class="min-w-0">
						<h3 class="line-clamp-2 text-[19px] leading-snug md:text-[22px]">{{ video.title }}</h3>
						<span :class="['mt-2.5 block text-[15px]', isNew(video) ? 'is-new' : 'opacity-65']">
							<RelativeTime v-if="video.publishedAt" :datetime="video.publishedAt" />
						</span>
						<span class="sr-only">(opens in new tab)</span>
					</span>
				</a>
			</li>
		</ul>

		<div v-else class="card flex flex-col items-start gap-5 p-8 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex items-center gap-4">
				<span class="grid size-12 place-items-center rounded-full bg-surface text-primary">
					<Icon name="youtube" class="size-6" />
				</span>
				<p>New Godot tutorials land on our channel regularly.</p>
			</div>
			<Button :href="SITE.links.youtube" icon="youtube">Watch on YouTube</Button>
		</div>

		<div class="mt-2.5 flex justify-start md:justify-end">
			<Button to="/videos">More videos</Button>
		</div>
	</Section>
</template>
