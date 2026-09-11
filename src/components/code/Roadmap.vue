<script setup>
import Icon from "@/components/ui/Icon.vue";
import { ROADMAP } from "@/data/roadmap.js";
</script>

<template>
	<ol class="relative mx-auto max-w-3xl">
		<li
			v-for="(item, i) in ROADMAP"
			:key="item.title"
			v-reveal="i * 60"
			class="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 pb-8 last:pb-0 sm:grid-cols-[7rem_2.25rem_minmax(0,1fr)] sm:gap-x-6"
		>
			<!-- Date column (desktop) -->
			<p class="hidden pt-2.5 text-right font-mono text-sm text-muted sm:block">
				{{ item.since ? `${item.since} →` : "Next" }}
			</p>

			<!-- Rail + node -->
			<div class="relative flex justify-center" aria-hidden="true">
				<span
					v-if="i < ROADMAP.length - 1"
					:class="[
						'absolute top-10 -bottom-8 w-px',
						ROADMAP[i + 1].status === 'planned'
							? 'bg-[repeating-linear-gradient(to_bottom,rgb(245_165_36/0.5)_0_4px,transparent_4px_9px)]'
							: 'bg-gradient-to-b from-accent-2/60 to-accent/30',
					]"
				></span>
				<span
					:class="[
						'relative mt-1 grid size-9 place-items-center rounded-full border',
						item.status === 'planned'
							? 'border-dashed border-warning/60 bg-warning/10 text-warning'
							: 'border-accent/40 bg-accent/15 text-accent-2 shadow-[0_0_24px_-4px_rgb(72_186_255/0.5)]',
					]"
				>
					<Icon :name="item.status === 'planned' ? 'clock' : 'check'" class="size-4" :stroke-width="2.25" />
				</span>
			</div>

			<!-- Content -->
			<div
				:class="[
					'surface-card p-5 sm:p-6',
					item.status === 'planned' && 'border-dashed border-warning/30 bg-warning/[0.03]',
				]"
			>
				<p :class="['text-xs font-medium', item.status === 'planned' ? 'text-warning' : 'text-accent-2']">
					{{ item.status === "planned" ? "Planned — next milestone" : `Ongoing since ${item.since}` }}
				</p>
				<h3 class="mt-2 text-lg font-semibold tracking-tight">{{ item.title }}</h3>
				<p class="mt-1.5 text-sm text-muted">{{ item.text }}</p>
			</div>
		</li>
	</ol>
</template>
