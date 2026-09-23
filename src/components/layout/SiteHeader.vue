<script setup>
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import Icon from "@/components/ui/Icon.vue";
import LogoMark from "@/components/ui/LogoMark.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { DONATE, NAV_LEFT, NAV_RIGHT } from "@/data/nav.js";
import { reshuffleHero } from "@/lib/hero.js";

// A literal port of godotengine.org's navbar: one absolute, frosted bar on every page, one <nav>
// that the breakpoint restyles from a row into the mobile panel. Only the text colour adapts —
// white over the hero image, navbar colour elsewhere. Geometry lives in style.css (.site-bar etc).
const route = useRoute();
const isHome = computed(() => route.name === "home");

// Their menu is a CSS checkbox, so every tap reloads the page and resets it. We're an SPA, so close
// it by hand — on the link click, and again on the route change for anything that redirects.
// Visibility itself stays CSS-driven, which is what makes the desktop nav reappear cleanly when you
// widen the window while it's open.
const open = ref(false);
watch(
	() => route.fullPath,
	() => (open.value = false),
);

// The hero keeps one screenshot for the whole session, so clicking the logo is the way to ask for
// another — whether that is a real navigation home or a no-op click while already there.
function onLogoClick() {
	if (isHome.value) reshuffleHero();
}
</script>

<template>
	<header
		:class="[
			'site-header absolute inset-x-0 top-0 z-40 nav:top-2 [view-transition-name:site-header]',
			isHome ? 'text-white' : 'text-navbar-link',
			{ 'is-open': open },
		]"
		@keydown.esc="open = false"
	>
		<div class="site-bar">
			<!-- #nav_head: the logo row. Below the breakpoint it also carries the donate pill and
			     the menu toggle, and the nav unrolls underneath it. -->
			<div class="flex h-[51.5px] w-full items-center justify-between nav:w-auto">
				<NavLink to="/" class="site-logo text-lg sm:text-xl" aria-label="Four Games, home" @navigate="onLogoClick">
					<LogoMark class="size-12" />
					<span>Four Games</span>
				</NavLink>

				<div class="flex items-center gap-1 nav:hidden">
					<!-- .fund.mobile: the span keeps the link inline, so the pill hugs the glyphs (45px)
					     instead of the full 24px line box a flex item would get. -->
					<span class="relative">
						<NavLink :to="DONATE.to" class="nav-donate" @navigate="open = false">
							<Icon :name="DONATE.icon" class="mr-1 inline w-[13px] align-baseline" />
							{{ DONATE.label }}
						</NavLink>
					</span>
					<button
						type="button"
						class="nav-toggle"
						aria-controls="site-nav"
						:aria-expanded="open"
						@click="open = !open"
					>
						<Icon name="menu" class="size-6" :stroke-width="2.25" />
						<span class="sr-only">{{ open ? "Close menu" : "Open menu" }}</span>
					</button>
				</div>
			</div>

			<nav id="site-nav" aria-label="Main" :class="['site-nav', { 'is-open': open }]">
				<ul>
					<li v-for="link in NAV_LEFT" :key="link.to">
						<NavLink
							:to="link.to"
							class="nav-link aria-[current=page]:text-navbar-current"
							@navigate="open = false"
						>
							{{ link.label }}
						</NavLink>
					</li>
				</ul>
				<ul>
					<li v-for="link in NAV_RIGHT" :key="link.label">
						<NavLink
							v-if="link.to"
							:to="link.to"
							class="nav-link aria-[current=page]:text-navbar-current"
							@navigate="open = false"
						>
							{{ link.label }}
						</NavLink>
						<a
							v-else
							:href="link.href"
							target="_blank"
							rel="noopener noreferrer"
							class="nav-link"
							@click="open = false"
						>
							<Icon v-if="link.icon" :name="link.icon" class="size-4" />
							{{ link.label }}
							<span class="sr-only">(opens in new tab)</span>
						</a>
					</li>
					<li class="fund hidden nav:block">
						<NavLink :to="DONATE.to" class="nav-donate">
							<Icon :name="DONATE.icon" class="relative top-px mr-1 inline w-[13px] align-baseline" />
							{{ DONATE.label }}
						</NavLink>
					</li>
				</ul>
			</nav>
		</div>
	</header>
</template>
