<script setup>
import Button from "@/components/ui/Button.vue";
import Logo from "@/components/ui/Logo.vue";
import MembershipOffer from "./MembershipOffer.vue";
import { SITE } from "@/data/site.js";
</script>

<template>
	<section aria-labelledby="hero-title" class="relative isolate overflow-hidden pt-32 pb-4 sm:pt-40">
		<div aria-hidden="true" class="bg-dot-grid absolute inset-0 -z-10"></div>
		<div
			aria-hidden="true"
			class="pointer-events-none absolute top-[-18rem] left-1/2 -z-10 h-[44rem] w-[72rem] max-w-[220%] -translate-x-1/2 bg-[radial-gradient(closest-side,rgb(74_144_226/0.26),transparent)] motion-safe:animate-glow-drift"
		></div>

		<div class="container-page grid items-center gap-12 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-14">
			<div class="text-center lg:text-left">
				<p
					class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-3.5 pl-1.5 text-[0.8125rem] text-muted backdrop-blur-sm"
				>
					<span class="grid size-6 place-items-center rounded-full bg-white/[0.06]"><Logo class="size-3.5" /></span>
					Indie studio
					<span aria-hidden="true" class="text-subtle">·</span>
					Made with Godot
				</p>

				<h1
					id="hero-title"
					class="text-gradient mt-7 text-[clamp(2.5rem,1.6rem+3.2vw,3.75rem)] leading-[1.05] font-semibold tracking-[-0.035em]"
				>
					We make games in Godot —
					<span class="text-accent-gradient sm:block">and teach you how.</span>
				</h1>

				<p class="mx-auto mt-6 max-w-xl text-lg text-muted sm:text-xl lg:mx-0">
					Four Games builds indie games, shares free tutorials, and open-sources the tools we use.
				</p>

				<div class="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center lg:justify-start">
					<Button :href="SITE.links.youtubeJoin" size="lg" icon="youtube">Become a member</Button>
					<Button :href="SITE.links.discord" variant="secondary" size="lg" icon="discord">Join Discord</Button>
				</div>
			</div>

			<MembershipOffer class="mx-auto w-full max-w-md lg:max-w-none" />
		</div>
	</section>
</template>
