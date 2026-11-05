<script setup>
import { computed, ref, useId, watch } from "vue";
import { useRoute } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import PressFacts from "@/components/press/PressFacts.vue";
import PressKeySection from "@/components/press/PressKeySection.vue";
import { useI18n } from "@/i18n/index.js";
import { getPressGame } from "@/lib/press.js";

// One game's press kit, laid out like its Steam store page: the media viewer with its screenshot
// strip beside the details box up top, then presskit()'s sections. Every section only shows when
// the Steam data has something for it. (No "download everything" zip: the build doesn't download
// these files, it only links to Steam's.) The route guard only lets known slugs through.
const route = useRoute();
const i18n = useI18n();
const { t } = i18n;

// Computed from the route: going from one game's kit straight to another's reuses this component.
const kit = computed(() => {
	const game = getPressGame(route.params.game, i18n);
	if (!game) return null;

	const facts = [
		{ label: t("press.facts.developer"), value: game.developers.join(", ") },
		{ label: t("press.facts.publisher"), value: game.publishers.join(", ") },
		{ label: t("press.facts.releaseDate"), value: game.releaseText },
		{ label: t("press.facts.platforms"), value: game.platformNames.join(", ") },
		{ label: t("press.facts.price"), value: game.priceText },
		{ label: t("press.facts.languages"), value: game.languages.join(", ") },
		{ label: t("press.facts.steam"), links: [{ label: t("press.game.steamPage"), href: game.storeUrl }] },
		game.website && {
			label: t("press.facts.website"),
			links: [{ label: game.website.replace(/^https?:\/\/|\/$/g, ""), href: game.website }],
		},
	].filter(Boolean);

	// The viewer: trailers first (their poster links to the store page, which plays them), then the
	// screenshots at full size. The strip below it picks which one is shown, like on Steam.
	const media = [
		...game.movies.map((m) => ({ kind: "movie", thumb: m.thumbnail, big: m.thumbnail, href: game.storeUrl, label: m.name })),
		...game.screenshots.map((s, i) => ({ kind: "shot", thumb: s.thumb || s.full, big: s.full, href: s.full, label: i + 1 })),
	].filter((m) => m.thumb);


	// Alternate the bands below the viewer, whichever sections have something to show.
	const sections = [
		game.about.length && "description",
		game.features.length && "features",
		game.movies.length && "trailers",
		game.screenshots.length && "screenshots",
		game.artLanguages.length && "art",
		"monetization",
		"key",
	].filter(Boolean);

	return { game, facts, media, sections };
});

// Steam opens on the trailer, but its poster is only 600px wide, so the viewer opens on the first
// screenshot instead; the trailer stays first in the strip.
const firstShot = () => Math.max(0, kit.value?.media.findIndex((m) => m.kind === "shot") ?? 0);
const active = ref(firstShot());
watch(() => route.params.game, () => (active.value = firstShot()));
const shown = computed(() => kit.value?.media[active.value]);
// The art section's language: the page's own when Steam has art in it, English otherwise.
const artLanguage = ref(kit.value?.game.artDefault ?? "english");
watch(() => route.params.game, () => (artLanguage.value = kit.value?.game.artDefault ?? "english"));
const art = computed(() =>
	(kit.value?.game.artByLanguage[artLanguage.value] ?? kit.value?.game.artByLanguage.english ?? []).map((a) => ({
		...a,
		label: t(`press.game.art.${a.key}`),
	})),
);
const artSelectId = useId();
const tone = (id) => (kit.value.sections.indexOf(id) % 2 ? "surface" : "bg");
</script>

<template>
	<template v-if="kit">
		<PageHeader :title="kit.game.name" :description="t('press.game.description', { name: kit.game.name })">
			<div class="flex flex-wrap gap-3">
				<Button :href="kit.game.storeUrl" variant="blue" icon="steam">{{ t("press.game.steamPage") }}</Button>
				<Button to="/press">{{ t("press.game.allKits") }}</Button>
			</div>
		</PageHeader>

		<div class="bg-bg">
			<div class="container-page padded grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_324px]">
				<div v-if="kit.media.length" class="min-w-0">
					<a :href="shown.href" target="_blank" rel="noopener noreferrer" class="relative block overflow-hidden rounded-lg bg-card shadow-card">
						<img
							:src="shown.big"
							width="1920"
							height="1080"
							:alt="shown.kind === 'movie' ? shown.label : t('press.game.screenshotAlt', { n: shown.label, name: kit.game.name })"
							decoding="async"
							class="aspect-video w-full object-cover"
						/>
						<span v-if="shown.kind === 'movie'" class="no-filter absolute inset-0 grid place-items-center">
							<span class="grid size-16 place-items-center rounded-full bg-black/60 text-white">
								<Icon name="play" class="size-7" />
							</span>
						</span>
						<span class="sr-only">{{ shown.kind === "movie" ? t("press.game.watchOnSteam") : t("press.game.fullSize") }} {{ t("a11y.newTab") }}</span>
					</a>
					<ul v-if="kit.media.length > 1" class="mt-2 flex gap-2 overflow-x-auto pb-1">
						<li v-for="(item, i) in kit.media" :key="item.thumb" class="shrink-0">
							<button
								type="button"
								:aria-pressed="i === active"
								:aria-label="item.kind === 'movie' ? t('press.game.showTrailer', { name: item.label }) : t('press.game.showScreenshot', { n: item.label })"
								class="relative block w-[116px] overflow-hidden rounded border-2 transition-[border-color,opacity]"
								:class="i === active ? 'border-primary' : 'border-transparent opacity-70 hover:opacity-100'"
								@click="active = i"
							>
								<img :src="item.thumb" width="116" height="65" alt="" loading="lazy" decoding="async" class="aspect-video w-full object-cover" />
								<span v-if="item.kind === 'movie'" class="absolute inset-0 grid place-items-center text-white">
									<Icon name="play" class="size-5 drop-shadow" />
								</span>
							</button>
						</li>
					</ul>
				</div>

				<PressFacts :title="t('press.factsheet')" :rows="kit.facts" :class="kit.media.length ? '' : 'lg:col-start-2'">
					<template #media>
						<img
							v-if="kit.game.image"
							:src="kit.game.image"
							width="460"
							height="215"
							:alt="t('a11y.keyArt', { name: kit.game.name })"
							decoding="async"
							class="aspect-capsule w-full object-cover"
						/>
						<p class="px-5 pt-5 text-sm">{{ kit.game.description }}</p>
					</template>
				</PressFacts>
			</div>
		</div>

		<Section v-if="kit.game.about.length" id="description" :tone="tone('description')" :title="t('press.game.descriptionTitle')">
			<div class="max-w-3xl">
				<p>{{ kit.game.description }}</p>
				<template v-for="(block, i) in kit.game.about" :key="i">
					<h3 v-if="block.heading" class="mt-8 text-xl">{{ block.heading }}</h3>
					<p v-for="(paragraph, j) in block.paragraphs" :key="j" class="mt-4">{{ paragraph }}</p>
				</template>
			</div>
		</Section>

		<Section v-if="kit.game.features.length" id="features" :tone="tone('features')" :title="t('press.game.features')">
			<ul class="grid gap-4 md:grid-cols-2">
				<li v-for="(feature, i) in kit.game.features" :key="i" class="card p-5">
					<h3 v-if="feature.title" class="text-lg">{{ feature.title }}</h3>
					<p :class="feature.title ? 'mt-2 text-base' : 'text-base'">{{ feature.text }}</p>
				</li>
			</ul>
		</Section>

		<Section v-if="kit.game.movies.length" id="trailers" :tone="tone('trailers')" :title="t('press.game.trailers')">
			<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<li v-for="movie in kit.game.movies" :key="movie.thumbnail ?? movie.hls" class="card flex flex-col overflow-hidden">
					<a :href="kit.game.storeUrl" target="_blank" rel="noopener noreferrer" class="relative block">
						<img
							v-if="movie.thumbnail"
							:src="movie.thumbnail"
							width="600"
							height="337"
							:alt="movie.name ?? ''"
							loading="lazy"
							decoding="async"
							class="aspect-video w-full object-cover"
						/>
						<span class="no-filter absolute inset-0 grid place-items-center">
							<span class="grid size-12 place-items-center rounded-full bg-black/60 text-white">
								<Icon name="play" class="size-6" />
							</span>
						</span>
						<span class="sr-only">{{ t("press.game.watchOnSteam") }} {{ t("a11y.newTab") }}</span>
					</a>
					<div class="flex flex-1 flex-col gap-2 p-4">
						<h3 v-if="movie.name" class="text-lg">{{ movie.name }}</h3>
						<p class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
							<a :href="kit.game.storeUrl" target="_blank" rel="noopener noreferrer" class="link"
								>{{ t("press.game.watchOnSteam") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
							<a v-if="movie.mp4" :href="movie.mp4" class="link">{{ t("press.game.mp4") }}</a>
							<a v-if="movie.webm" :href="movie.webm" class="link">{{ t("press.game.webm") }}</a>
							<a v-if="movie.hls" :href="movie.hls" class="link">{{ t("press.game.hls") }}</a>
						</p>
					</div>
				</li>
			</ul>
		</Section>

		<Section
			v-if="kit.game.screenshots.length"
			id="screenshots"
			:tone="tone('screenshots')"
			:title="t('press.game.screenshots')"
			:description="t('press.game.freeToUse')"
		>
			<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				<li v-for="(shot, i) in kit.game.screenshots" :key="shot.full">
					<a :href="shot.full" target="_blank" rel="noopener noreferrer" class="block overflow-hidden rounded-lg bg-card shadow-card">
						<img
							:src="shot.thumb || shot.full"
							width="600"
							height="338"
							:alt="t('press.game.screenshotAlt', { n: i + 1, name: kit.game.name })"
							loading="lazy"
							decoding="async"
							class="aspect-video w-full object-cover"
						/>
						<span class="sr-only">{{ t("press.game.fullSize") }} {{ t("a11y.newTab") }}</span>
					</a>
				</li>
			</ul>
		</Section>

		<Section
			v-if="art.length"
			id="art"
			:tone="tone('art')"
			:title="t('press.game.art.title')"
			:description="t('press.game.art.description', { name: kit.game.name })"
		>
			<div v-if="kit.game.artLanguages.length > 1" class="mb-6 flex flex-wrap items-center gap-3">
				<label :for="artSelectId" class="text-sm font-semibold">{{ t("press.game.art.language") }}</label>
				<select
					:id="artSelectId"
					v-model="artLanguage"
					class="h-10 rounded-btn border border-line bg-bg px-3 text-base text-fg focus:border-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-primary/40"
				>
					<option v-for="language in kit.game.artLanguages" :key="language.steam" :value="language.steam">{{ language.label }}</option>
				</select>
				<span class="text-sm text-date">{{ t("press.game.art.languageCount", { n: kit.game.artLanguages.length }) }}</span>
			</div>
			<ul class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
				<li v-for="item in art" :key="item.key">
					<a :href="item.url" target="_blank" rel="noopener noreferrer" class="group block h-full">
						<article class="card card-hover flex h-full flex-col overflow-hidden">
							<span class="block aspect-capsule overflow-hidden bg-dark p-2">
								<img :src="item.url" alt="" loading="lazy" decoding="async" class="size-full object-contain" />
							</span>
							<span class="flex flex-col gap-0.5 p-4 text-sm">
								<span class="font-semibold">{{ item.label }}</span>
								<span class="text-date">
									{{ [item.size, item.own && artLanguage !== "english" ? t("press.game.art.localized") : null].filter(Boolean).join(" · ") || t("press.game.fullSize") }}
								</span>
							</span>
						</article>
						<span class="sr-only">{{ t("a11y.newTab") }}</span>
					</a>
				</li>
			</ul>
		</Section>

		<Section id="monetization" :tone="tone('monetization')" :title="t('press.game.monetization.title')">
			<p class="max-w-3xl">{{ t("press.game.monetization.text") }}</p>
		</Section>

		<PressKeySection :tone="tone('key')" />
	</template>
</template>
