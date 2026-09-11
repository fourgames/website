<script setup>
import { computed } from "vue";
import { RouterLink } from "vue-router";
import Icon from "./Icon.vue";

const props = defineProps({
	to: { type: [String, Object], default: undefined },
	href: { type: String, default: undefined },
	type: { type: String, default: "button" },
	variant: { type: String, default: "primary" }, // primary | secondary | ghost
	size: { type: String, default: "md" }, // sm | md | lg
	icon: { type: String, default: undefined },
	external: { type: Boolean, default: undefined },
});

const isExternal = computed(() => props.external ?? (Boolean(props.href) && /^https?:\/\//.test(props.href)));

const SIZES = {
	sm: "h-10 px-4 text-sm",
	md: "h-11 px-5 text-[0.9375rem]",
	lg: "h-12 px-6 text-base",
};
const VARIANTS = {
	primary:
		"border-transparent bg-white text-bg shadow-[0_0_0_1px_rgb(255_255_255/0.08),0_8px_30px_-10px_rgb(255_255_255/0.45)] hover:bg-white/90",
	secondary: "border-white/10 bg-white/[0.04] text-fg hover:border-white/20 hover:bg-white/[0.08]",
	ghost: "border-transparent text-muted hover:bg-white/5 hover:text-fg",
};

const classes = computed(() => [
	"group/btn inline-flex items-center justify-center gap-2 rounded-full border font-medium whitespace-nowrap",
	"transition-[background-color,border-color,color,box-shadow,scale] duration-200 active:scale-[.98]",
	"disabled:pointer-events-none disabled:opacity-60",
	SIZES[props.size],
	VARIANTS[props.variant],
]);
</script>

<template>
	<!-- Internal link: a real <a href> (crawlable, middle-clickable) with client-side navigation. -->
	<RouterLink v-if="to" v-slot="{ href: linkHref, navigate }" :to="to" custom>
		<a :href="linkHref" :class="classes" @click="navigate">
			<Icon v-if="icon" :name="icon" class="size-[1.15em]" />
			<slot />
		</a>
	</RouterLink>

	<component
		:is="href ? 'a' : 'button'"
		v-else
		:href="href"
		:type="href ? undefined : type"
		:target="isExternal ? '_blank' : undefined"
		:rel="isExternal ? 'noopener noreferrer' : undefined"
		:class="classes"
	>
		<Icon v-if="icon" :name="icon" class="size-[1.15em]" />
		<slot />
		<template v-if="isExternal">
			<Icon
				name="arrow-up-right"
				class="size-[1em] opacity-60 transition-transform duration-200 group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5"
			/>
			<span class="sr-only">(opens in new tab)</span>
		</template>
	</component>
</template>
