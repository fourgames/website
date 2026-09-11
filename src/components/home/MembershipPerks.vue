<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";
import Section from "@/components/ui/Section.vue";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
import { getGames } from "@/lib/games.js";
import youtube from "@/data/generated/youtube.json";

const games = getGames();
const featuredGame = games.find((g) => g.status === "released" && g.image) ?? null;
const upcoming = games.filter((g) => g.status !== "released");

const thumbs = (youtube.latest ?? [])
	.slice(0, 3)
	.map((v) => v.thumbs?.[0]?.url ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);

// Complete class strings so Tailwind picks them up.
const SPANS = {
	games: "md:col-span-4",
	early: "md:col-span-2",
	discord: "md:col-span-2",
	badges: "md:col-span-4",
};
const FAN = [
	"-rotate-6 -translate-x-8 translate-y-2 opacity-70",
	"z-10",
	"rotate-6 translate-x-8 translate-y-2 opacity-70",
];
</script>

<template>
	<Section
		id="membership"
		eyebrow="Membership"
		title="Get every game we make — and more"
		description="One YouTube membership supports everything we do: the games, the free tutorials and the open-source tools."
	>
		<ul class="grid gap-4 sm:gap-6 md:grid-cols-6">
			<li v-for="(perk, i) in MEMBERSHIP.perks" :key="perk.id" v-reveal="i * 80" :class="['flex', SPANS[perk.id]]">
				<article v-spotlight class="surface-card spotlight relative flex w-full flex-col overflow-hidden p-6 sm:p-8">
					<span class="grid size-11 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent-2">
						<Icon :name="perk.icon" class="size-5" />
					</span>
					<h3 class="mt-5 text-xl font-semibold tracking-tight">{{ perk.title }}</h3>
					<p class="mt-2 text-muted">{{ perk.text }}</p>

					<!-- Keys to all our games: current game + what's in development -->
					<div v-if="perk.id === 'games'" aria-hidden="true" class="mt-8 grid grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)] gap-2">
						<div class="relative overflow-hidden rounded-xl border border-white/10 bg-black/30">
							<img
								v-if="featuredGame"
								:src="featuredGame.image"
								width="460"
								height="215"
								alt=""
								loading="lazy"
								decoding="async"
								class="aspect-[460/215] w-full object-cover"
							/>
							<span
								class="absolute bottom-2 left-2 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/60 px-2.5 py-1 text-xs font-medium text-fg backdrop-blur-md"
							>
								<Icon name="check" class="size-3.5 text-success" :stroke-width="2.5" />
								Key included
							</span>
						</div>
						<div class="grid gap-2" :style="{ gridTemplateRows: `repeat(${Math.max(upcoming.length, 1)}, minmax(0, 1fr))` }">
							<span
								v-for="game in upcoming"
								:key="game.appId"
								class="teaser-art relative min-h-8 overflow-hidden rounded-lg border border-white/10"
								:style="{ '--hue': game.hue }"
							>
								<Logo class="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 opacity-30 grayscale" />
							</span>
						</div>
						<p class="col-span-2 mt-1 text-xs text-subtle">
							{{ featuredGame ? featuredGame.name : "Our games" }} + {{ upcoming.length }} more in development
						</p>
					</div>

					<!-- Early access: a stack of the newest videos -->
					<div v-else-if="perk.id === 'early' && thumbs.length" aria-hidden="true" class="relative mt-8 flex h-32 items-end justify-center">
						<img
							v-for="(src, j) in thumbs"
							:key="src"
							:src="src"
							width="320"
							height="180"
							alt=""
							loading="lazy"
							decoding="async"
							:class="['absolute bottom-0 aspect-video w-40 rounded-lg border border-white/10 object-cover shadow-xl shadow-black/60', FAN[j]]"
						/>
						<span
							class="absolute -top-1 right-0 z-20 inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-bg/80 px-2.5 py-1 text-xs font-medium text-accent-2 backdrop-blur-md"
						>
							<Icon name="clock" class="size-3.5" />
							Members first
						</span>
					</div>

					<!-- Discord role: a mock member row -->
					<div v-else-if="perk.id === 'discord'" aria-hidden="true" class="mt-8 rounded-xl border border-white/10 bg-[#1e1f22] p-3 text-sm">
						<p class="px-1 pb-2 text-[0.6875rem] font-semibold tracking-wide text-[#949ba4] uppercase">Supporter — online</p>
						<div class="flex items-center gap-3 rounded-lg bg-white/[0.04] px-2 py-2">
							<span class="grid size-8 place-items-center rounded-full bg-[#2b2d31]"><Logo class="size-4" /></span>
							<span class="font-medium text-accent-2">You</span>
							<span class="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[#2b2d31] px-2 py-0.5 text-xs text-[#dbdee1]">
								<span class="size-2.5 rounded-full bg-accent-2"></span>
								{{ MEMBERSHIP.tier }}
							</span>
						</div>
					</div>

					<!-- Member badges: a mock YouTube comment -->
					<div v-else-if="perk.id === 'badges'" aria-hidden="true" class="mt-8 flex gap-3 rounded-xl border border-white/10 bg-black/25 p-4">
						<span class="grid size-9 shrink-0 place-items-center rounded-full bg-elevated text-sm font-semibold text-muted">Y</span>
						<div class="min-w-0 text-sm">
							<p class="flex flex-wrap items-center gap-2">
								<span class="font-medium text-fg">@you</span>
								<span class="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[0.6875rem] font-medium text-accent-2">
									<Logo class="size-3" />
									Member
								</span>
								<span class="text-xs text-subtle">just now</span>
							</p>
							<p class="mt-1.5 text-muted">Thanks for the tutorial — this fixed my project!</p>
						</div>
					</div>
				</article>
			</li>
		</ul>

		<div
			v-reveal
			class="mt-8 flex flex-col items-start gap-4 rounded-card border border-white/[0.08] bg-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6"
		>
			<p class="text-muted">
				<span class="font-semibold text-fg">{{ MEMBERSHIP.price }} / {{ MEMBERSHIP.period }}</span>
				<span class="mx-2 text-subtle" aria-hidden="true">·</span>
				<span class="text-sm">{{ MEMBERSHIP.fineprint }}</span>
			</p>
			<Button :href="SITE.links.youtubeJoin" icon="youtube">Become a member</Button>
		</div>
	</Section>
</template>
