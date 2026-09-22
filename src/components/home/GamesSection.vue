<script setup>
import Badge from "@/components/ui/Badge.vue";
import Button from "@/components/ui/Button.vue";
import Logo from "@/components/ui/Logo.vue";
import PlatformIcons from "@/components/games/PlatformIcons.vue";
import Section from "@/components/ui/Section.vue";
import { byRecency, gameStatusLabel, getGames, isRecent, priceLabel } from "@/lib/games.js";
import steam from "@/data/generated/steam.json";

// "Latest news" layout from godotengine.org: one big featured card, compact rows beside it.
// One timeline (byRecency) fills both: the newest game takes the big card, the next three drop
// into the rows beside it, and anything older is left to the "View all" page.
const ordered = getGames().sort(byRecency);
const featured = ordered[0];
const rows = ordered.slice(1, 4);

// Godot flags recent posts with a coloured date and a "NEW" tag; do the same for a fresh release.
const isNew = (game) => game.status === "released" && isRecent(game.releaseDate, 30, steam.fetchedAt);

// Live Steam price, shown on the featured card only — the compact rows are too tight for it.
const featuredPrice = featured ? priceLabel(featured) : null;

// Every card shows the Steam capsule in its native 460x215 box, so nothing is cropped and the
// featured card matches the rows. Screenshots stay with the hero (getHeroSlides).
</script>

<template>
	<Section id="games" title="Our games">
		<div class="grid gap-[30px] min-[900px]:grid-cols-2">
			<a
				v-if="featured"
				:href="featured.storeUrl"
				target="_blank"
				rel="noopener noreferrer"
				class="block"
			>
				<article class="flex flex-col gap-5">
					<span class="block overflow-hidden rounded-[7px] bg-card shadow-[0_5px_10px_-3px_rgb(0_0_0/0.47)]">
						<img
							v-if="featured.image"
							:src="featured.image"
							width="460"
							height="215"
							:alt="`${featured.name} key art`"
							loading="lazy"
							decoding="async"
							class="aspect-capsule w-full object-cover"
						/>
						<span v-else class="teaser-art grid aspect-capsule w-full place-items-center text-white/40" :style="{ '--hue': featured.hue }">
							<Logo class="size-20" />
						</span>
					</span>
					<div>
						<h3 class="text-[22px] leading-snug">{{ featured.name }}</h3>
						<p class="mt-2 text-base opacity-80">{{ featured.description }}</p>
						<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[15px]">
							<p :class="isNew(featured) ? 'is-new' : 'opacity-65'">{{ gameStatusLabel(featured) }}</p>
							<p v-if="featured.genres.length" class="opacity-65">{{ featured.genres.join(" · ") }}</p>
							<PlatformIcons :platforms="featured.platforms" />
							<p v-if="featuredPrice" class="flex items-center gap-1.5">
								<template v-if="typeof featuredPrice === 'string'">
									<span class="font-semibold">{{ featuredPrice }}</span>
								</template>
								<template v-else>
									<Badge v-if="featuredPrice.discountPercent" tone="accent">-{{ featuredPrice.discountPercent }}%</Badge>
									<span v-if="featuredPrice.discountPercent" class="line-through opacity-60">{{ featuredPrice.initial }}</span>
									<span class="font-semibold">{{ featuredPrice.final }}</span>
								</template>
							</p>
						</div>
					</div>
					<span class="sr-only">(opens in new tab)</span>
				</article>
			</a>

			<div class="flex flex-col gap-[18px]">
				<ul v-if="rows.length" class="flex flex-col gap-[18px]">
					<li v-for="game in rows" :key="game.appId">
						<a :href="game.storeUrl" target="_blank" rel="noopener noreferrer" class="grid grid-cols-[80px_1fr] gap-5 md:grid-cols-[160px_1fr]">
							<span class="relative block self-start overflow-hidden rounded-[7px] bg-card shadow-[0_5px_10px_-3px_rgb(0_0_0/0.47)]">
								<img
									v-if="game.image"
									:src="game.image"
									width="460"
									height="215"
									alt=""
									loading="lazy"
									decoding="async"
									class="aspect-capsule w-full object-cover"
								/>
								<span v-else class="teaser-art grid aspect-capsule w-full place-items-center text-white/40" :style="{ '--hue': game.hue }">
									<Logo class="size-8" />
								</span>
							</span>
							<span class="min-w-0">
								<h3 class="text-[19px] leading-snug md:text-[22px]">{{ game.name }}</h3>
								<span class="mt-1.5 hidden text-base opacity-80 md:line-clamp-2">{{ game.description }}</span>
								<span class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[15px]">
									<span :class="isNew(game) ? 'is-new' : 'opacity-65'">{{ gameStatusLabel(game) }}</span>
									<span v-if="game.genres.length" class="opacity-65">{{ game.genres.join(" · ") }}</span>
								</span>
								<span class="sr-only">(opens in new tab)</span>
							</span>
						</a>
					</li>
				</ul>

				<div class="mt-auto flex justify-start md:justify-end">
					<Button to="/games">View all</Button>
				</div>
			</div>
		</div>
	</Section>
</template>
