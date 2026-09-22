<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import RepoCard from "@/components/code/RepoCard.vue";
import Roadmap from "@/components/code/Roadmap.vue";
import { SITE } from "@/data/site.js";
import { formatNumber } from "@/lib/format.js";
import github from "@/data/generated/github.json";

const repos = github.repos ?? [];
const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
</script>

<template>
	<PageHeader
		title="Open source"
		description="Project templates, curated game-dev resources and the code behind this site. Free to use, fork and learn from."
	>
		<div class="flex flex-wrap items-center gap-x-6 gap-y-4">
			<Button :href="SITE.links.github" variant="blue" icon="github">Follow on GitHub</Button>
			<p v-if="repos.length" class="flex items-center gap-4 text-sm text-date">
				<span class="inline-flex items-center gap-1.5">
					<Icon name="star" class="size-4 text-warning" />
					<span class="font-semibold text-fg tabular-nums">{{ formatNumber(totalStars) }}</span> stars
				</span>
				<span aria-hidden="true" class="h-4 w-px bg-line-strong"></span>
				<span><span class="font-semibold text-fg tabular-nums">{{ repos.length }}</span> public repositories</span>
			</p>
		</div>
	</PageHeader>

	<Section
		id="repositories"
		title="Repositories"
		description="Project templates, curated game-dev resources and the code behind this site. Free to use, fork and learn from."
	>
		<template #actions>
			<Button :href="SITE.links.github">All repositories</Button>
		</template>
		<ul v-if="repos.length" class="grid gap-4 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
			<li v-for="repo in repos" :key="repo.name">
				<RepoCard :repo="repo" />
			</li>
		</ul>
		<p v-else class="card p-8">
			Our repositories couldn't be loaded right now, so
			<a :href="SITE.links.github" class="link" target="_blank" rel="noopener noreferrer">browse them on GitHub<span class="sr-only"> (opens in new tab)</span></a>.
		</p>
	</Section>

	<Section
		id="roadmap"
		tone="surface"
		title="Our contributions to Godot"
		description="What we do for the engine that powers our games, and what's next."
	>
		<Roadmap />
	</Section>
</template>
