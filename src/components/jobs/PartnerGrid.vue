<script setup>
import Icon from "@/components/ui/Icon.vue";
import { PARTNERS } from "@/data/partners.js";

const types = PARTNERS.filter((p) => !p.principle);
const principle = PARTNERS.find((p) => p.principle);
</script>

<template>
	<div>
		<!-- Feature cards: gradient icon header, navy body -->
		<ul class="grid gap-5 sm:grid-cols-3">
			<li v-for="partner in types" :key="partner.title" class="flex flex-col overflow-hidden rounded-lg bg-dark text-white shadow-card">
				<div aria-hidden="true" class="grid h-40 place-items-center bg-[linear-gradient(135deg,var(--color-primary),var(--color-dark))] text-white">
					<Icon :name="partner.icon" class="size-16" :stroke-width="1.25" />
				</div>
				<div class="p-6">
					<p class="text-sm font-semibold text-white/70">{{ partner.audience }}</p>
					<h3 class="mt-1 text-xl text-white">{{ partner.title }}</h3>
					<p class="mt-2 text-white/85">{{ partner.text }}</p>
				</div>
			</li>
		</ul>

		<!-- The principle as a green pill -->
		<p v-if="principle" class="mx-auto mt-10 flex max-w-2xl items-center justify-center gap-3 rounded-full bg-success/15 px-5 py-3 text-center text-sm font-semibold text-success">
			<Icon :name="principle.icon" class="size-5 shrink-0" />
			{{ principle.text }}
		</p>
	</div>
</template>
