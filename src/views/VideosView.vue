<script setup>
import { onMounted, onUnmounted, ref } from "vue";
import Button from "@/components/ui/Button.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import VideoCard from "@/components/videos/VideoCard.vue";
import { SITE } from "@/data/site.js";
import { groupByYear, sortVideos } from "@/lib/videos.js";
// This view is the only importer of the catalogue, which keeps it out of every other page's bundle.
import catalogue from "@/data/generated/youtube-videos.json";
import youtube from "@/data/generated/youtube.json";

// The full long-form catalogue (no Shorts), newest first, split into years. `videos` is empty only
// when the build had no YOUTUBE_API_KEY and no cached data — then show the handful we always have.
const videos = sortVideos(catalogue.videos?.length ? catalogue.videos : [youtube.popular, ...(youtube.latest ?? [])]);
const years = groupByYear(videos);

// Every year is a <details>, so the markup is always in the prerendered HTML for search and Ctrl-F
// while the browser lays out and decodes only what's open — which is what keeps this page cheap as
// the channel grows. OPEN_YEARS only decides which years *start* expanded; all of them collapse.
const OPEN_YEARS = 2;
const open = ref(years.map((_, index) => index < OPEN_YEARS));

function openYear(year) {
	const index = years.findIndex((group) => group.year === year);
	if (index !== -1) open.value[index] = true;
}

// A shared deep link like /videos#y2023 — or a jump-nav click — should land on an open year. The
// browser's own anchor scroll stays correct: expanding a year never moves anything above it.
function openFromHash() {
	const match = /^#y(\d+)$/.exec(location.hash);
	if (match) openYear(Number(match[1]));
}

onMounted(() => {
	openFromHash();
	window.addEventListener("hashchange", openFromHash);
});
onUnmounted(() => window.removeEventListener("hashchange", openFromHash));
</script>

<template>
	<PageHeader title="Videos" description="Free Godot tutorials, from quick tips to full beginner courses. Members watch new videos early.">
		<div class="flex flex-wrap gap-3">
			<Button :href="SITE.links.youtubeSubscribe" variant="blue" icon="youtube">Follow on YouTube</Button>
			<Button :href="SITE.links.youtubeJoin" icon="youtube">Join on YouTube</Button>
		</div>
	</PageHeader>

	<div v-if="years.length" class="bg-bg">
		<div class="container-page padded">
			<nav v-if="years.length > 1" aria-label="Jump to year" class="mb-10 flex flex-wrap items-center gap-x-3 gap-y-2">
				<span class="text-subtitle">{{ videos.length }} videos</span>
				<a
					v-for="group in years"
					:key="group.year"
					:href="`#y${group.year}`"
					class="link tabular-nums"
					@click="openYear(group.year)"
					>{{ group.year }}</a
				>
			</nav>

			<section
				v-for="(group, index) in years"
				:key="group.year"
				:id="`y${group.year}`"
				:aria-label="`Videos from ${group.year}`"
				class="mb-12 scroll-mt-24 last:mb-0"
			>
				<details class="group" :open="open[index]" @toggle="open[index] = $event.target.open">
					<summary class="cursor-pointer list-none">
						<h2 class="flex items-baseline gap-3 tabular-nums">
							{{ group.year }}
							<span class="text-subtitle">{{ group.videos.length }} videos</span>
							<span aria-hidden="true" class="text-subtitle transition-transform group-open:rotate-90">›</span>
						</h2>
					</summary>
					<ul class="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
						<li v-for="video in group.videos" :key="video.id"><VideoCard :video="video" /></li>
					</ul>
				</details>
			</section>
		</div>
	</div>

	<div v-else class="bg-bg">
		<div class="container-page padded">
			<p class="card p-8">
				Our latest videos couldn't be loaded right now, so
				<a :href="SITE.links.youtube" class="link" target="_blank" rel="noopener noreferrer">watch them on YouTube<span class="sr-only"> (opens in new tab)</span></a>.
			</p>
		</div>
	</div>
</template>
