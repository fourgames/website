<script setup>
import { computed } from "vue";
import Badge from "@/components/ui/Badge.vue";
import Button from "@/components/ui/Button.vue";

const props = defineProps({ game: { type: Object, required: true } });

const PLATFORM_NAMES = { windows: "Windows", mac: "macOS", linux: "Linux" };
const platforms = computed(() => props.game.platforms.map((p) => PLATFORM_NAMES[p] ?? p).join(" · "));
const price = computed(() => (props.game.isFree ? "Free to play" : props.game.price?.final));
</script>

<template>
	<article
		v-spotlight
		class="surface-card spotlight group overflow-hidden lg:grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]"
	>
		<div class="relative border-b border-line bg-black/20 lg:border-r lg:border-b-0">
			<div class="overflow-hidden">
				<img
					v-if="game.image"
					:src="game.image"
					width="460"
					height="215"
					:alt="`${game.name} key art`"
					loading="lazy"
					decoding="async"
					class="aspect-[460/215] w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.02]"
				/>
			</div>
			<ul v-if="game.screenshots.length" class="grid grid-cols-3 gap-2 p-2">
				<li v-for="(shot, i) in game.screenshots" :key="shot.thumb">
					<img
						:src="shot.thumb"
						width="600"
						height="338"
						:alt="`${game.name} screenshot ${i + 1}`"
						loading="lazy"
						decoding="async"
						class="aspect-video w-full rounded-lg object-cover"
					/>
				</li>
			</ul>
		</div>

		<div class="flex flex-col p-6 sm:p-8 lg:p-10">
			<div class="flex flex-wrap items-center gap-2">
				<Badge tone="success" dot>Out now</Badge>
				<Badge v-for="genre in game.genres" :key="genre">{{ genre }}</Badge>
			</div>
			<h3 class="mt-5 text-2xl font-semibold tracking-tight sm:text-3xl">{{ game.name }}</h3>
			<p class="mt-3 text-muted sm:text-lg">{{ game.description }}</p>

			<dl class="mt-7 grid grid-cols-2 gap-4 border-t border-line pt-6 text-sm">
				<div v-if="game.releaseDate">
					<dt class="text-subtle">Released</dt>
					<dd class="mt-1 text-fg">{{ game.releaseDate }}</dd>
				</div>
				<div v-if="platforms">
					<dt class="text-subtle">Platforms</dt>
					<dd class="mt-1 text-fg">{{ platforms }}</dd>
				</div>
			</dl>

			<div class="mt-auto flex flex-wrap items-center gap-x-5 gap-y-3 pt-8">
				<Button :href="game.storeUrl" icon="steam">Buy on Steam</Button>
				<p v-if="price" class="text-sm text-muted">
					<span class="sr-only">Price: </span>
					<span class="font-medium text-fg">{{ price }}</span>
					<span v-if="game.price?.discountPercent" class="ml-2 text-success">−{{ game.price.discountPercent }}%</span>
				</p>
			</div>
		</div>
	</article>
</template>
