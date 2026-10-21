<script setup>
import Button from "@/components/ui/Button.vue";
import I18nT from "@/components/ui/I18nT.vue";
import Icon from "@/components/ui/Icon.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import RepoCard from "@/components/code/RepoCard.vue";
import Roadmap from "@/components/code/Roadmap.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import { formatNumber } from "@/lib/format.js";
import github from "@/data/generated/github.json";

const { t, locale } = useI18n();
const repos = github.repos ?? [];
const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
</script>

<template>
	<PageHeader :title="t('code.title')" :description="t('code.description')">
		<div class="flex flex-wrap items-center gap-x-6 gap-y-4">
			<Button :href="SITE.links.github" variant="blue" icon="github">{{ t("code.follow") }}</Button>
			<p v-if="repos.length" class="flex items-center gap-4 text-sm text-date">
				<span class="inline-flex items-center gap-1.5">
					<Icon name="star" class="size-4 text-warning" />
					<span>
						<I18nT keypath="code.stars">
							<template #count>
								<span class="font-semibold text-fg tabular-nums">{{ formatNumber(totalStars, locale.intl) }}</span>
							</template>
						</I18nT>
					</span>
				</span>
				<span aria-hidden="true" class="h-4 w-px bg-line-strong"></span>
				<span>
					<I18nT keypath="code.repoCount" :params="{ count: repos.length }">
						<template #count><span class="font-semibold text-fg tabular-nums">{{ repos.length }}</span></template>
					</I18nT>
				</span>
			</p>
		</div>
	</PageHeader>

	<Section
		id="repositories"
		:title="t('code.repositories')"
		:description="t('code.description')"
	>
		<template #actions>
			<Button :href="SITE.links.github">{{ t("code.allRepositories") }}</Button>
		</template>
		<ul v-if="repos.length" class="grid gap-4 sm:gap-6 md:grid-cols-2">
			<li v-for="repo in repos" :key="repo.name">
				<RepoCard :repo="repo" />
			</li>
		</ul>
		<p v-else class="card p-8">
			<I18nT keypath="code.unavailable">
				<template #link>
					<a :href="SITE.links.github" class="link" target="_blank" rel="noopener noreferrer"
						>{{ t("code.unavailableLink") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
					>
				</template>
			</I18nT>
		</p>
	</Section>

	<Section
		id="roadmap"
		:title="t('code.roadmap.title')"
		:description="t('code.roadmap.description')"
	>
		<Roadmap />
	</Section>
</template>
