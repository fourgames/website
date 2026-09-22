<script setup>
import { ROADMAP } from "@/data/roadmap.js";

const year = (item) => (item.status === "planned" ? "Next" : String(item.since));
</script>

<template>
	<!-- Ledger: big year on the left, title and text on the right. -->
	<ol class="mx-auto max-w-4xl divide-y divide-line border-y border-line">
		<li v-for="item in ROADMAP" :key="item.title" class="grid gap-2 py-6 sm:grid-cols-[8rem_1fr] sm:gap-8">
			<p :class="['font-heading text-4xl leading-none font-extrabold', item.status === 'planned' ? 'text-date' : 'text-primary']">
				{{ year(item) }}
			</p>
			<div>
				<h3 class="text-xl">{{ item.title }}</h3>
				<p class="mt-1.5">{{ item.text }}</p>
				<p v-if="item.status === 'planned'" class="mt-1.5 font-heading text-xs font-bold text-date uppercase">Planned</p>
			</div>
		</li>
	</ol>
</template>
