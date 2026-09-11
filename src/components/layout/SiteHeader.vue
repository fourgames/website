<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Logo from "@/components/ui/Logo.vue";
import NavLink from "@/components/ui/NavLink.vue";
import MobileMenu from "./MobileMenu.vue";
import { NAV_LINKS } from "@/data/nav.js";
import { SITE } from "@/data/site.js";

// A 1px sentinel at the top of the page: once it scrolls out of view, the pill gets more opaque.
const sentinel = ref(null);
const scrolled = ref(false);
let observer;

onMounted(() => {
	observer = new IntersectionObserver(([entry]) => {
		scrolled.value = !entry.isIntersecting;
	});
	observer.observe(sentinel.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<div ref="sentinel" aria-hidden="true" class="pointer-events-none absolute top-0 left-0 h-4 w-px"></div>
	<header class="fixed inset-x-0 top-3 z-40 px-3 [view-transition-name:site-header]" :data-scrolled="scrolled">
		<div
			class="header-pill mx-auto flex h-14 max-w-pill items-center justify-between gap-3 rounded-full border border-white/[0.08] pr-2 pl-2 backdrop-blur-xl backdrop-saturate-150"
		>
			<RouterLink
				to="/"
				class="flex items-center gap-2.5 rounded-full py-1.5 pr-3 pl-2 font-semibold tracking-tight whitespace-nowrap text-fg"
				aria-label="Four Games — home"
			>
				<Logo class="size-7" />
				<span>Four Games</span>
			</RouterLink>

			<nav aria-label="Main" class="hidden md:block">
				<ul class="flex items-center gap-0.5">
					<li v-for="link in NAV_LINKS" :key="link.to">
						<NavLink
							:to="link.to"
							class="block rounded-full px-3.5 py-2 text-sm text-muted transition-colors hover:bg-white/5 hover:text-fg aria-[current=page]:bg-white/[0.08] aria-[current=page]:text-fg"
						>
							{{ link.label }}
						</NavLink>
					</li>
				</ul>
			</nav>

			<div class="flex items-center">
				<Button :href="SITE.links.discord" size="sm" icon="discord" class="max-md:hidden">Join Discord</Button>
				<MobileMenu />
			</div>
		</div>
	</header>
</template>
