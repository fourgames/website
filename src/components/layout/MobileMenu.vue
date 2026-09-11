<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import Logo from "@/components/ui/Logo.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { NAV_LINKS } from "@/data/nav.js";
import { SITE, SOCIALS } from "@/data/site.js";

// Native modal <dialog>: the browser handles the top layer, inert background, focus containment,
// Esc to close and returning focus to the trigger.
const dialog = ref(null);
const open = ref(false);
const route = useRoute();

function show() {
	dialog.value.showModal();
	open.value = true;
}
function close() {
	if (dialog.value?.open) dialog.value.close();
}
function onBackdropClick(event) {
	if (event.target === dialog.value) close();
}

watch(() => route.fullPath, close);

let desktop;
onMounted(() => {
	desktop = window.matchMedia("(min-width: 48rem)");
	desktop.addEventListener("change", close);
});
onBeforeUnmount(() => desktop?.removeEventListener("change", close));
</script>

<template>
	<button
		type="button"
		class="grid size-11 place-items-center rounded-full text-fg transition-colors hover:bg-white/5 md:hidden"
		aria-haspopup="dialog"
		aria-controls="mobile-menu"
		:aria-expanded="open"
		@click="show"
	>
		<Icon name="menu" class="size-5" />
		<span class="sr-only">Open menu</span>
	</button>

	<dialog
		id="mobile-menu"
		ref="dialog"
		aria-label="Menu"
		class="m-0 h-auto max-h-dvh w-full max-w-none bg-transparent p-3 text-fg opacity-0 transition-[opacity,translate,display,overlay] transition-discrete duration-200 ease-out backdrop:bg-black/60 open:translate-y-0 open:opacity-100 starting:open:-translate-y-3 starting:open:opacity-0 -translate-y-3"
		@close="open = false"
		@click="onBackdropClick"
		@keydown.esc.prevent="close"
	>
		<div class="rounded-[1.75rem] border border-white/10 bg-surface p-2 shadow-2xl shadow-black/60">
			<div class="flex h-12 items-center justify-between pr-0 pl-2">
				<span class="flex items-center gap-2.5 font-semibold tracking-tight">
					<Logo class="size-7" />
					Four Games
				</span>
				<button
					type="button"
					class="grid size-11 place-items-center rounded-full text-fg transition-colors hover:bg-white/5"
					autofocus
					@click="close"
				>
					<Icon name="close" class="size-5" />
					<span class="sr-only">Close menu</span>
				</button>
			</div>

			<nav aria-label="Mobile" class="px-2 pt-4 pb-2">
				<ul class="divide-y divide-white/[0.06]">
					<li v-for="link in NAV_LINKS" :key="link.to">
						<NavLink
							:to="link.to"
							class="flex min-h-14 items-center justify-between py-3 text-2xl font-medium tracking-tight text-fg aria-[current=page]:text-accent-2"
							@navigate="close"
						>
							{{ link.label }}
							<Icon name="arrow-right" class="size-5 text-subtle" />
						</NavLink>
					</li>
				</ul>
			</nav>

			<div class="mt-2 flex flex-col gap-3 p-2">
				<Button :href="SITE.links.discord" size="lg" icon="discord">Join Discord</Button>
				<ul class="flex items-center justify-center gap-1 pt-1" aria-label="Social links">
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
		</div>
	</dialog>
</template>
