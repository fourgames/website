<script setup>
import Icon from "@/components/ui/Icon.vue";
import RelativeTime from "@/components/ui/RelativeTime.vue";
import { LANGUAGE_COLORS } from "@/data/languageColors.js";
import { SITE } from "@/data/site.js";
import { formatNumber } from "@/lib/format.js";

defineProps({ repo: { type: Object, required: true } });
</script>

<template>
	<article class="card card-hover group flex h-full flex-col p-5">
		<div class="flex items-start justify-between gap-4">
			<div class="flex min-w-0 items-center gap-3">
				<span class="grid size-10 shrink-0 place-items-center rounded-lg bg-surface text-primary">
					<Icon name="book" class="size-[1.125rem]" />
				</span>
				<h3 class="min-w-0 truncate text-lg">
					<!-- Stretched link: the whole card is clickable, but there's only one link in the tab order. -->
					<a
						:href="repo.url"
						target="_blank"
						rel="noopener noreferrer"
						class="after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-primary"
					>
						<span class="font-semibold text-date">{{ SITE.github.org }}/</span>{{ repo.name }}
						<span class="sr-only">(opens in new tab)</span>
					</a>
				</h3>
			</div>
			<Icon name="arrow-up-right" class="size-5 text-date transition-colors group-hover:text-primary" />
		</div>

		<p class="mt-4 line-clamp-3 text-sm">{{ repo.description || "No description yet." }}</p>

		<ul v-if="repo.topics.length" class="mt-4 flex flex-wrap gap-1.5" aria-label="Topics">
			<li v-for="topic in repo.topics.slice(0, 4)" :key="topic" class="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-semibold text-primary">
				{{ topic }}
			</li>
		</ul>

		<div class="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-5 text-sm text-date">
			<span v-if="repo.language" class="inline-flex items-center gap-2">
				<span aria-hidden="true" class="size-2.5 rounded-full" :style="{ backgroundColor: LANGUAGE_COLORS[repo.language] ?? '#8a8a8a' }"></span>
				{{ repo.language }}
			</span>
			<span class="inline-flex items-center gap-1.5">
				<Icon name="star" class="size-4" />
				<span class="sr-only">Stars:</span>
				<span class="tabular-nums">{{ formatNumber(repo.stars) }}</span>
			</span>
			<span class="inline-flex items-center gap-1.5">
				<Icon name="fork" class="size-4" />
				<span class="sr-only">Forks:</span>
				<span class="tabular-nums">{{ formatNumber(repo.forks) }}</span>
			</span>
			<span>Updated <RelativeTime :datetime="repo.pushedAt" /></span>
		</div>
	</article>
</template>
