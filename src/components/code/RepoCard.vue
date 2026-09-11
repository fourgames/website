<script setup>
import Icon from "@/components/ui/Icon.vue";
import RelativeTime from "@/components/ui/RelativeTime.vue";
import { LANGUAGE_COLORS } from "@/data/languageColors.js";
import { SITE } from "@/data/site.js";
import { formatNumber } from "@/lib/format.js";

defineProps({ repo: { type: Object, required: true } });
</script>

<template>
	<article v-spotlight class="surface-card spotlight group flex h-full flex-col p-6 transition-colors hover:border-white/15">
		<div class="flex items-start justify-between gap-4">
			<div class="flex min-w-0 items-center gap-3">
				<span class="grid size-10 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04] text-muted">
					<Icon name="book" class="size-[1.125rem]" />
				</span>
				<h3 class="min-w-0 truncate font-semibold">
					<!-- Stretched link: the whole card is clickable, but there's only one link in the tab order. -->
					<a
						:href="repo.url"
						target="_blank"
						rel="noopener noreferrer"
						class="after:absolute after:inset-0 after:rounded-card focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent-2"
					>
						<span class="font-normal text-subtle">{{ SITE.github.org }}/</span>{{ repo.name }}
						<span class="sr-only">(opens in new tab)</span>
					</a>
				</h3>
			</div>
			<Icon
				name="arrow-up-right"
				class="size-5 text-subtle transition-[color,translate] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg"
			/>
		</div>

		<p class="mt-4 line-clamp-3 text-sm text-muted">{{ repo.description || "No description yet." }}</p>

		<ul v-if="repo.topics.length" class="mt-4 flex flex-wrap gap-1.5" aria-label="Topics">
			<li
				v-for="topic in repo.topics.slice(0, 4)"
				:key="topic"
				class="rounded-full border border-accent/20 bg-accent/10 px-2.5 py-0.5 text-xs text-accent-2"
			>
				{{ topic }}
			</li>
		</ul>

		<div class="mt-auto flex flex-wrap items-center gap-x-5 gap-y-2 pt-6 text-sm text-muted">
			<span v-if="repo.language" class="inline-flex items-center gap-2">
				<span
					aria-hidden="true"
					class="size-2.5 rounded-full ring-1 ring-white/20"
					:style="{ backgroundColor: LANGUAGE_COLORS[repo.language] ?? '#8a8a8a' }"
				></span>
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
			<span class="text-subtle">Updated <RelativeTime :datetime="repo.pushedAt" /></span>
		</div>
	</article>
</template>
