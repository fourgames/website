<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
</script>

<template>
	<div class="surface-card gradient-border relative overflow-hidden p-6 text-left sm:p-8">
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -top-24 -right-16 -z-10 size-72 rounded-full bg-[radial-gradient(closest-side,rgb(74_144_226/0.28),transparent)]"
		></div>

		<div class="flex items-center gap-4">
			<span class="grid size-12 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/15 text-accent-2">
				<Icon name="heart" class="size-6" />
			</span>
			<div>
				<h2 id="offer-title" class="text-lg font-semibold tracking-tight">
					Four Games <span class="text-accent-gradient">{{ MEMBERSHIP.tier }}</span>
				</h2>
				<p class="text-sm text-subtle">YouTube channel membership</p>
			</div>
		</div>

		<p class="mt-6 flex items-baseline gap-1.5">
			<span class="text-4xl font-semibold tracking-tight tabular-nums">{{ MEMBERSHIP.price }}</span>
			<span class="text-muted">/ {{ MEMBERSHIP.period }}</span>
		</p>
		<p class="mt-2 text-sm text-muted">{{ MEMBERSHIP.pitch }}</p>

		<ul class="mt-6 space-y-3 border-t border-line pt-6">
			<li v-for="perk in MEMBERSHIP.perks.slice(0, 2)" :key="perk.id" class="flex items-start gap-3 text-sm">
				<span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-accent/15 text-accent-2">
					<Icon name="check" class="size-3.5" :stroke-width="2.5" />
				</span>
				<span class="font-medium text-fg">{{ perk.title }}</span>
			</li>
		</ul>

		<Button :href="SITE.links.youtubeJoin" size="lg" icon="youtube" class="mt-7 w-full">Become a member</Button>
		<div class="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-subtle">
			<span>Cancel anytime</span>
			<NavLink to="/#membership" class="inline-flex items-center gap-1 font-medium text-accent-2 transition-colors hover:text-fg">
				See all {{ MEMBERSHIP.perks.length }} perks
				<Icon name="arrow-right" class="size-3.5 rotate-90" />
			</NavLink>
		</div>
	</div>
</template>
