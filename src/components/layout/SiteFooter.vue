<script setup>
import Icon from "@/components/ui/Icon.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { FOOTER_COLUMNS } from "@/data/footer.js";
import { SITE, SOCIALS } from "@/data/site.js";

const year = __BUILD_YEAR__;
</script>

<template>
	<footer class="bg-footer text-footer-fg">
		<div class="container-page grid gap-10 pt-14 pb-12 sm:grid-cols-2 lg:grid-cols-4">
			<nav v-for="column in FOOTER_COLUMNS" :key="column.heading" :aria-labelledby="`footer-${column.heading}`">
				<h2 :id="`footer-${column.heading}`" class="text-lg text-white">{{ column.heading }}</h2>
				<ul class="mt-4 space-y-2 text-sm">
					<li v-for="link in column.links" :key="link.label">
						<NavLink v-if="link.to" :to="link.to" class="inline-block py-0.5 transition-colors hover:text-white">
							{{ link.label }}
						</NavLink>
						<a
							v-else
							:href="link.href"
							target="_blank"
							rel="noopener noreferrer"
							class="inline-block py-0.5 transition-colors hover:text-white"
						>
							{{ link.label }}<span class="sr-only"> (opens in new tab)</span>
						</a>
					</li>
				</ul>
			</nav>
		</div>

		<div class="border-t border-white/10">
			<div class="container-page flex flex-col gap-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
				<p>
					© {{ year }} {{ SITE.name }}. All rights reserved. Clover icon by
					<a href="https://game-icons.net/" target="_blank" rel="noopener noreferrer" class="underline hover:text-white">
						Lorc<span class="sr-only"> (opens in new tab)</span>
					</a>
					(CC BY 3.0).
				</p>
				<ul class="flex flex-wrap items-center gap-1" aria-label="Social links">
					<li v-for="social in SOCIALS" :key="social.label">
						<a
							:href="social.href"
							target="_blank"
							rel="noopener noreferrer"
							class="grid size-10 place-items-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
						>
							<Icon :name="social.icon" class="size-5" />
							<span class="sr-only">{{ social.label }} (opens in new tab)</span>
						</a>
					</li>
				</ul>
			</div>
		</div>
	</footer>
</template>
