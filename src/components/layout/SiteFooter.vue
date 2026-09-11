<script setup>
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { NAV_LINKS } from "@/data/nav.js";
import { SITE, SOCIALS } from "@/data/site.js";

const year = __BUILD_YEAR__;
</script>

<template>
	<footer class="relative mt-8 overflow-hidden border-t border-line">
		<div class="container-page grid gap-12 py-14 sm:py-16 md:grid-cols-[1.5fr_1fr_1fr]">
			<div class="max-w-sm">
				<p class="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
					<Logo class="size-8" />
					Four Games
				</p>
				<p class="mt-4 text-sm text-muted">{{ SITE.tagline }}</p>
				<ul class="mt-6 -ml-2.5 flex items-center gap-1" aria-label="Social links">
					<li v-for="social in SOCIALS" :key="social.label">
						<a
							:href="social.href"
							target="_blank"
							rel="noopener noreferrer"
							class="grid size-11 place-items-center rounded-full text-muted transition-colors hover:bg-white/5 hover:text-fg"
						>
							<Icon :name="social.icon" class="size-5" />
							<span class="sr-only">{{ social.label }} (opens in new tab)</span>
						</a>
					</li>
				</ul>
			</div>

			<nav aria-labelledby="footer-studio">
				<h2 id="footer-studio" class="text-sm font-medium text-fg">Studio</h2>
				<ul class="mt-4 space-y-1">
					<li v-for="link in NAV_LINKS" :key="link.to">
						<NavLink :to="link.to" class="inline-block py-1.5 text-sm text-muted transition-colors hover:text-fg">
							{{ link.label }}
						</NavLink>
					</li>
				</ul>
			</nav>

			<nav aria-labelledby="footer-community">
				<h2 id="footer-community" class="text-sm font-medium text-fg">Community</h2>
				<ul class="mt-4 space-y-1">
					<li v-for="social in SOCIALS" :key="social.label">
						<a
							:href="social.href"
							target="_blank"
							rel="noopener noreferrer"
							class="group inline-flex items-center gap-1 py-1.5 text-sm text-muted transition-colors hover:text-fg"
						>
							{{ social.label }}
							<Icon name="arrow-up-right" class="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
							<span class="sr-only">(opens in new tab)</span>
						</a>
					</li>
				</ul>
			</nav>
		</div>

		<div class="border-t border-line">
			<div class="container-page flex flex-col gap-3 py-6 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
				<p>© {{ year }} Four Games. All rights reserved.</p>
				<p class="flex flex-wrap gap-x-4 gap-y-1">
					<a :href="SITE.links.issues" target="_blank" rel="noopener noreferrer" class="transition-colors hover:text-fg">
						Report a website issue<span class="sr-only"> (opens in new tab)</span>
					</a>
					<span>
						Clover icon by
						<a href="https://game-icons.net/" target="_blank" rel="noopener noreferrer" class="underline decoration-white/20 underline-offset-2 hover:text-fg">
							Lorc<span class="sr-only"> (opens in new tab)</span>
						</a>
						(CC BY 3.0)
					</span>
				</p>
			</div>
		</div>

		<p
			aria-hidden="true"
			class="pointer-events-none -mb-[0.22em] bg-linear-to-b from-white/[0.09] to-transparent to-80% bg-clip-text text-center text-[19vw] leading-none font-semibold tracking-[-0.06em] whitespace-nowrap text-transparent select-none md:text-[16vw]"
		>
			Four Games
		</p>
	</footer>
</template>
