<script setup>
import Icon from "@/components/ui/Icon.vue";
import { PARTNERS } from "@/data/partners.js";
import youtube from "@/data/generated/youtube.json";

// Decorative stack of our latest thumbnails on the featured "Guest Series" tile.
const thumbs = [youtube.popular, ...(youtube.latest ?? [])]
	.filter(Boolean)
	.slice(0, 3)
	.map((v) => v.thumbs?.[0]?.url ?? `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);
const FAN = [
	"-rotate-8 -translate-x-16 translate-y-3 sm:-translate-x-28 opacity-80",
	"z-10 -translate-y-1",
	"rotate-8 translate-x-16 translate-y-3 sm:translate-x-28 opacity-80",
];
</script>

<template>
	<ul class="grid gap-4 sm:gap-6 md:auto-rows-[minmax(12rem,auto)] md:grid-cols-6">
		<li
			v-for="(partner, i) in PARTNERS"
			:key="partner.title"
			v-reveal="i * 80"
			:class="['flex', partner.span]"
		>
			<article
				v-spotlight
				:class="[
					'surface-card spotlight relative flex w-full overflow-hidden p-6 sm:p-8',
					partner.principle ? 'flex-col gap-5 sm:flex-row sm:items-center' : 'flex-col',
				]"
			>
				<span
					:class="[
						'grid size-12 shrink-0 place-items-center rounded-xl border',
						partner.principle
							? 'border-success/30 bg-success/10 text-success'
							: 'border-accent/30 bg-accent/10 text-accent-2',
					]"
				>
					<Icon :name="partner.icon" class="size-6" />
				</span>

				<div :class="partner.principle ? '' : 'mt-6'">
					<p :class="['text-sm font-medium', partner.principle ? 'text-success' : 'text-accent-2']">
						{{ partner.audience }}
					</p>
					<h3 :class="['mt-1 font-semibold tracking-tight', partner.featured ? 'text-2xl sm:text-3xl' : 'text-xl']">
						{{ partner.title }}
					</h3>
					<p :class="['mt-2 text-muted', partner.featured && 'max-w-md sm:text-lg']">{{ partner.text }}</p>
				</div>

				<div v-if="partner.featured && thumbs.length" aria-hidden="true" class="relative mt-10 flex h-40 items-end justify-center sm:mt-auto sm:h-48">
					<img
						v-for="(src, j) in thumbs"
						:key="src"
						:src="src"
						width="320"
						height="180"
						alt=""
						loading="lazy"
						decoding="async"
						:class="[
							'absolute bottom-0 aspect-video w-48 rounded-xl border border-white/10 object-cover shadow-2xl shadow-black/60 transition-transform duration-500 sm:w-60',
							FAN[j],
						]"
					/>
				</div>
			</article>
		</li>
	</ul>
</template>
