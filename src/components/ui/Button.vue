<script setup>
import { computed } from "vue";
import { RouterLink } from "vue-router";
import Icon from "./Icon.vue";

const props = defineProps({
	to: { type: [String, Object], default: undefined },
	href: { type: String, default: undefined },
	type: { type: String, default: "button" },
	variant: { type: String, default: "primary" }, // primary | blue | donate | translucent | ghost
	size: { type: String, default: "md" }, // sm | md | lg
	icon: { type: String, default: undefined },
	external: { type: Boolean, default: undefined },
});

const isExternal = computed(() => props.external ?? (Boolean(props.href) && /^https?:\/\//.test(props.href)));

const SIZES = {
	sm: "h-9 px-3.5 text-sm",
	md: "h-11 px-5 text-base",
	lg: "h-13 px-7 text-base",
	hero: "h-[54px] px-8 text-lg",
};
// Complete literal strings so Tailwind picks them up.
const VARIANTS = {
	primary: "bg-btn text-dark shadow-card hover:bg-btn-hover dark:text-fg",
	blue: "bg-primary text-white shadow-card hover:bg-primary-hover",
	donate: "bg-donate text-white shadow-card hover:bg-donate-hover",
	white: "bg-white text-dark shadow-card hover:bg-[#f3f5f9]",
	translucent: "bg-[rgb(129_129_129/0.66)] text-white shadow-card hover:bg-[rgb(129_129_129/0.8)]",
	ghost: "text-link hover:bg-black/5 dark:hover:bg-white/10",
};

const classes = computed(() => [
	"group/btn inline-flex items-center justify-center gap-2 rounded-btn font-heading font-extrabold whitespace-nowrap",
	"transition-[background-color,color,transform] duration-150 active:scale-[.98]",
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
		<span v-if="isExternal" class="sr-only">(opens in new tab)</span>
	</component>
</template>
