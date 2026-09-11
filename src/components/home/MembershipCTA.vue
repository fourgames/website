<script setup>
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
</script>

<template>
	<article class="surface-card gradient-border relative flex h-full flex-col overflow-hidden p-6 sm:p-8">
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -bottom-32 -left-20 size-80 rounded-full bg-[radial-gradient(closest-side,rgb(74_144_226/0.3),transparent)]"
		></div>

		<div class="flex items-center gap-4">
			<span class="grid size-12 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/15 text-accent-2">
				<Icon name="heart" class="size-6" />
			</span>
			<div>
				<h3 class="text-xl font-semibold tracking-tight">{{ MEMBERSHIP.title }}</h3>
				<p class="text-sm text-subtle">YouTube channel membership</p>
			</div>
		</div>

		<p class="mt-5 text-muted">{{ MEMBERSHIP.text }}</p>

		<ul v-if="MEMBERSHIP.perks.length" class="mt-6 space-y-2.5">
			<li v-for="perk in MEMBERSHIP.perks" :key="perk" class="flex items-start gap-2.5 text-sm text-fg">
				<Icon name="check" class="mt-0.5 size-4 text-accent-2" />
				{{ perk }}
			</li>
		</ul>

		<div class="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-8">
			<Button :href="SITE.links.youtubeJoin" icon="youtube">Become a member</Button>
			<p class="text-xs text-subtle">Billed and managed by YouTube.</p>
		</div>
	</article>
</template>
