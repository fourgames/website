<script setup>
import { ref, shallowRef } from "vue";
import Badge from "@/components/ui/Badge.vue";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import RelativeTime from "@/components/ui/RelativeTime.vue";
import Section from "@/components/ui/Section.vue";
import VideoFacade from "./VideoFacade.vue";
import { formatCompact, formatDuration } from "@/lib/format.js";
import { SITE } from "@/data/site.js";
import youtube from "@/data/generated/youtube.json";

const latest = (youtube.latest ?? []).slice(0, 4);
const featured = youtube.popular ?? latest[0] ?? null;

const current = shallowRef(featured);
const label = ref(youtube.popular ? "Most popular" : "Latest upload");
const autoplay = ref(false);

// Clicking a video in the list plays it in the main player (a normal link to YouTube without JS).
function select(video, event) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
	event.preventDefault();
	current.value = video;
	label.value = video === youtube.popular ? "Most popular" : "Latest upload";
	autoplay.value = true;
}

const views = (n) => `${formatCompact(n)} views`;
</script>

<template>
	<Section
		id="videos"
		eyebrow="YouTube"
		title="Learn Godot with us"
		description="Free Godot tutorials — from quick tips to full beginner courses."
	>
		<template #actions>
			<Button :href="SITE.links.youtube" variant="secondary" icon="youtube">Visit channel</Button>
		</template>

		<div v-if="current" class="grid gap-8 lg:grid-cols-12 lg:gap-10">
			<article v-reveal class="lg:col-span-7">
				<div class="surface-card p-1.5 sm:p-2">
					<VideoFacade
						:key="current.id"
						:video="current"
						:autoplay="autoplay"
						sizes="(min-width: 72rem) 40rem, (min-width: 64rem) 55vw, calc(100vw - 3rem)"
					/>
				</div>
				<div class="mt-5 px-1">
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-subtle">
						<Badge tone="accent">{{ label }}</Badge>
						<span v-if="current.viewCount" class="inline-flex items-center gap-1.5">
							<Icon name="eye" class="size-4" />
							{{ views(current.viewCount) }}
						</span>
						<RelativeTime v-if="current.publishedAt" :datetime="current.publishedAt" />
					</div>
					<h3 class="mt-3 text-xl font-semibold tracking-tight sm:text-2xl">{{ current.title }}</h3>
				</div>
			</article>

			<div v-if="latest.length" v-reveal="120" class="lg:col-span-5">
				<h3 class="mb-3 px-2 text-sm font-medium text-muted">Latest uploads</h3>
				<ul class="space-y-1">
					<li v-for="video in latest" :key="video.id">
						<a
							:href="`https://www.youtube.com/watch?v=${video.id}`"
							:aria-current="current.id === video.id ? 'true' : undefined"
							class="group flex items-center gap-4 rounded-xl p-2 transition-colors hover:bg-white/[0.04] aria-[current=true]:bg-white/[0.06]"
							@click="select(video, $event)"
						>
							<span class="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-card sm:w-36">
								<img
									:src="video.thumbs?.[0]?.url ?? `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`"
									width="320"
									height="180"
									alt=""
									loading="lazy"
									decoding="async"
									class="size-full object-cover transition-transform duration-500 group-hover:scale-105"
								/>
								<span
									v-if="video.durationSeconds"
									class="absolute right-1 bottom-1 rounded bg-black/80 px-1 text-[0.6875rem] font-medium text-white tabular-nums"
								>
									{{ formatDuration(video.durationSeconds) }}
								</span>
							</span>
							<span class="min-w-0">
								<span class="line-clamp-2 text-sm font-medium text-fg">{{ video.title }}</span>
								<span class="mt-1 block text-xs text-subtle">
									<template v-if="video.viewCount !== null">{{ views(video.viewCount) }} · </template>
									<RelativeTime v-if="video.publishedAt" :datetime="video.publishedAt" />
								</span>
							</span>
						</a>
					</li>
				</ul>
				<p class="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-accent/20 bg-accent/[0.06] px-4 py-3 text-sm text-muted">
					<Icon name="clock" class="size-4 text-accent-2" />
					Members watch new tutorials early.
					<a
						:href="SITE.links.youtubeJoin"
						target="_blank"
						rel="noopener noreferrer"
						class="font-medium text-accent-2 transition-colors hover:text-fg"
					>
						Become a member<span class="sr-only"> (opens in new tab)</span> →
					</a>
				</p>
			</div>
		</div>

		<div v-else class="surface-card flex flex-col items-start gap-5 p-8 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex items-center gap-4">
				<span class="grid size-12 place-items-center rounded-xl bg-[#ff0033]/10 text-[#ff4d6a]">
					<Icon name="youtube" class="size-6" />
				</span>
				<p class="text-muted">New Godot tutorials land on our channel regularly.</p>
			</div>
			<Button :href="SITE.links.youtube" icon="youtube">Watch on YouTube</Button>
		</div>
	</Section>
</template>
