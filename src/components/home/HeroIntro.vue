<script setup>
import Button from "@/components/ui/Button.vue";
import Logo from "@/components/ui/Logo.vue";
import { SITE } from "@/data/site.js";
</script>

<template>
	<section aria-labelledby="hero-title" class="relative isolate overflow-hidden pt-32 sm:pt-44">
		<div aria-hidden="true" class="bg-dot-grid absolute inset-0 -z-10"></div>
		<div
			aria-hidden="true"
			class="pointer-events-none absolute top-[-18rem] left-1/2 -z-10 h-[44rem] w-[72rem] max-w-[220%] -translate-x-1/2 bg-[radial-gradient(closest-side,rgb(74_144_226/0.3),transparent)] motion-safe:animate-glow-drift"
		></div>

		<div class="container-page">
			<div class="mx-auto max-w-5xl text-center">
				<p
					class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-3.5 pl-1.5 text-[0.8125rem] text-muted backdrop-blur-sm"
				>
					<span class="grid size-6 place-items-center rounded-full bg-white/[0.06]"><Logo class="size-3.5" /></span>
					Indie studio
					<span aria-hidden="true" class="text-subtle">·</span>
					Sweden
					<span aria-hidden="true" class="text-subtle">·</span>
					Made with Godot
				</p>

				<h1 id="hero-title" class="text-gradient mt-7 text-display font-semibold">
					We make games in Godot —
					<span class="text-accent-gradient sm:block">and teach you how.</span>
				</h1>

				<p class="mx-auto mt-6 max-w-xl text-lg text-muted sm:text-xl">
					Four Games builds indie games, shares free tutorials, and open-sources the tools we use.
				</p>

				<div class="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
					<Button :href="SITE.links.steam" size="lg" icon="steam">Play Reforge Front</Button>
					<Button :href="SITE.links.discord" variant="secondary" size="lg" icon="discord">Join Discord</Button>
				</div>
			</div>

			<figure class="relative mx-auto mt-16 max-w-5xl sm:mt-20">
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-x-[5%] -top-12 bottom-8 -z-10 bg-[radial-gradient(closest-side,rgb(72_186_255/0.22),transparent)]"
				></div>
				<div class="gradient-border rounded-[1.4rem] bg-white/[0.03] p-1.5 shadow-glow sm:p-2">
					<picture>
						<source
							media="(max-width: 47.99rem)"
							type="image/avif"
							srcset="/images/hero/hero-m-640.avif 640w, /images/hero/hero-m-1102.avif 1102w"
							sizes="calc(100vw - 3rem)"
						/>
						<source
							type="image/avif"
							srcset="/images/hero/hero-960.avif 960w, /images/hero/hero-1536.avif 1536w, /images/hero/hero-1920.avif 1920w"
							sizes="(min-width: 68rem) 64rem, calc(100vw - 4.5rem)"
						/>
						<img
							src="/images/hero/hero-1920.webp"
							width="1920"
							height="620"
							alt="Reforge Front: a stylised forest clearing with a glowing furnace at its centre"
							fetchpriority="high"
							class="block aspect-video w-full rounded-[1rem] bg-card object-cover md:aspect-[1920/620]"
						/>
					</picture>
				</div>
				<figcaption class="mt-5 flex items-center justify-center gap-2 text-sm text-subtle">
					<span class="relative flex size-2">
						<span class="absolute inset-0 rounded-full bg-success motion-safe:animate-pulse-dot"></span>
						<span class="relative size-2 rounded-full bg-success"></span>
					</span>
					Reforge Front — out now on Steam
				</figcaption>
			</figure>
		</div>
	</section>
</template>
