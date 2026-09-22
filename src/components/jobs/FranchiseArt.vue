<script setup>
import Icon from "@/components/ui/Icon.vue";
import LogoMark from "@/components/ui/LogoMark.vue";

// Art for the "Franchise Collaborations" column. There's no licensed art to show, so this stands
// in with the same parts as the fans beside it: three tiles on the FanCards tilt, our clover on
// the one in front, and the pill BadgesArt ends on.
</script>

<template>
	<div class="absolute inset-0 flex flex-col items-center justify-center gap-5">
		<div class="relative flex h-32 w-full items-center justify-center">
			<span class="absolute grid size-24 -translate-x-[22cqw] -rotate-6 translate-y-2 place-items-center rounded-lg bg-card text-fg/30 opacity-80 shadow-lg shadow-black/40">
				<Icon name="sparkles" class="size-8" :stroke-width="1.5" />
			</span>
			<span class="absolute grid size-24 translate-x-[22cqw] translate-y-2 rotate-6 place-items-center rounded-lg bg-card text-fg/30 opacity-80 shadow-lg shadow-black/40">
				<Icon name="star" class="size-8" :stroke-width="1.5" />
			</span>
			<span class="relative z-10 grid size-28 place-items-center rounded-lg bg-card shadow-lg shadow-black/50">
				<LogoMark class="size-14" />
			</span>
		</div>
		<span class="rounded-full bg-primary/15 px-3 py-1 text-xs font-semibold text-primary">Licensed IP</span>
	</div>
</template>
