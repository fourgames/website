<script setup>
import { onBeforeUnmount, ref, useId, watch } from "vue";
import { useRoute } from "vue-router";
import Icon from "@/components/ui/Icon.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { useI18n } from "@/i18n/index.js";

// One navbar entry, with godotengine.org's dropdown when it has children: on desktop the menu opens
// on hover (closing 100ms after the pointer leaves, so the gap to the menu is forgiving) or on
// keyboard focus; on a touch screen the first tap opens it and the parent link sits first in the
// menu. Below the breakpoint the children are listed indented under the parent. Visibility is
// CSS-driven per breakpoint (.nav-dropdown in style.css); this only tracks the desktop open state.
const props = defineProps({ link: { type: Object, required: true } });
const emit = defineEmits(["navigate"]);
const { t } = useI18n();
const route = useRoute();
const id = useId();
const open = ref(false);
const root = ref(null);

const desktop = () => typeof window !== "undefined" && window.matchMedia("(width >= 75rem)").matches;

let closeTimer = 0;
function cancelClose() {
	clearTimeout(closeTimer);
}
function show() {
	if (!props.link.children || !desktop()) return;
	cancelClose();
	open.value = true;
}
function hide({ instant = false } = {}) {
	cancelClose();
	if (instant) open.value = false;
	else closeTimer = setTimeout(() => (open.value = false), 100);
}

// Touch on a desktop-width screen: the first tap on the parent opens the menu instead of navigating.
function onParentClick(event) {
	if (props.link.children && desktop() && lastPointer === "touch" && !openAtPointerDown) {
		event.preventDefault();
		event.stopImmediatePropagation();
		show();
	}
}
// Read at pointerdown, before the tap focuses the link (focus opens the menu too).
let lastPointer = "mouse";
let openAtPointerDown = false;
function onPointerDown(event) {
	lastPointer = event.pointerType;
	openAtPointerDown = open.value;
}

function onFocusOut(event) {
	if (!root.value?.contains(event.relatedTarget)) hide({ instant: true });
}
function onDocumentPointer(event) {
	if (!root.value?.contains(event.target)) hide({ instant: true });
}
watch(open, (isOpen) => {
	if (typeof document === "undefined") return;
	if (isOpen) document.addEventListener("pointerup", onDocumentPointer);
	else document.removeEventListener("pointerup", onDocumentPointer);
});
watch(
	() => route.fullPath,
	() => hide({ instant: true }),
);
onBeforeUnmount(() => {
	cancelClose();
	document.removeEventListener("pointerup", onDocumentPointer);
});

function navigated() {
	hide({ instant: true });
	emit("navigate");
}
</script>

<template>
	<li
		ref="root"
		:class="['nav-item', { 'is-open': open }]"
		@pointerenter="(e) => e.pointerType !== 'touch' && show()"
		@pointerleave="(e) => e.pointerType !== 'touch' && hide()"
		@focusin="show"
		@focusout="onFocusOut"
		@keydown.esc="hide({ instant: true })"
	>
		<!-- Capture phase, so a first touch tap can stop NavLink's navigation. -->
		<NavLink
			:to="link.to"
			class="nav-link aria-[current=page]:text-navbar-current"
			:aria-haspopup="link.children ? 'true' : undefined"
			:aria-expanded="link.children ? open : undefined"
			:aria-controls="link.children ? id : undefined"
			@pointerdown="onPointerDown"
			@click.capture="onParentClick"
			@navigate="navigated"
		>
			{{ t(link.label) }}
		</NavLink>
		<ul v-if="link.children" :id="id" class="nav-dropdown">
			<li class="nav-dropdown-touch">
				<NavLink :to="link.to" class="nav-sublink" @navigate="navigated">{{ t(link.label) }}</NavLink>
			</li>
			<li v-for="child in link.children" :key="child.label">
				<NavLink v-if="child.to" :to="child.to" class="nav-sublink" @navigate="navigated">
					{{ t(child.label) }}
				</NavLink>
				<a
					v-else
					:href="child.href"
					target="_blank"
					rel="noopener noreferrer"
					class="nav-sublink"
					@click="navigated"
				>
					{{ t(child.label) }}
					<Icon name="arrow-up-right" class="size-3.5 opacity-60" />
					<span class="sr-only">{{ t("a11y.newTab") }}</span>
				</a>
			</li>
		</ul>
	</li>
</template>
