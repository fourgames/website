<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { useRoute } from "vue-router";
import Icon from "@/components/ui/Icon.vue";
import { useI18n } from "@/i18n/index.js";
import { LOCALES, localizePath, stripLocale } from "@/i18n/locales.js";
import { PREFERENCE_KEY } from "@/i18n/detect.js";

// godotengine.org's language selector: on desktop, their translate glyph in the navbar opening a
// small frosted dropdown; in the mobile menu, a "Language:" row with the languages indented under
// it. Each entry is a plain link to this same page in that language — a full page load, so every
// language is its own prerendered file — and picking one remembers it, which is what stops the
// auto-detect script (src/i18n/detect.js) from overriding the choice on the next visit.
const route = useRoute();
const { t, code } = useI18n();
const id = useId();
const open = ref(false);
const root = ref(null);

// The not-found page has no counterpart to switch to, so its entries go to each language's home.
const englishPath = computed(() => (route.name === "not-found" ? "/" : stripLocale(route.path)));
const options = computed(() =>
	LOCALES.map((l) => ({ ...l, href: localizePath(englishPath.value, l.code), current: l.code === code })),
);

function remember(choice) {
	try {
		localStorage.setItem(PREFERENCE_KEY, choice);
	} catch {
		// Storage blocked (private mode, cookies off): the link still works, it just won't stick.
	}
}

function onDocumentClick(event) {
	if (!root.value?.contains(event.target)) open.value = false;
}
watch(open, (isOpen) => {
	if (typeof document === "undefined") return;
	if (isOpen) document.addEventListener("click", onDocumentClick);
	else document.removeEventListener("click", onDocumentClick);
});
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));

function onFocusOut(event) {
	if (!root.value?.contains(event.relatedTarget)) open.value = false;
}
</script>

<template>
	<li ref="root" :class="['lang-menu', { 'is-open': open }]" @keydown.esc="open = false" @focusout="onFocusOut">
		<button type="button" class="lang-toggle" :aria-expanded="open" :aria-controls="id" @click="open = !open">
			<Icon name="language" class="h-[26px] w-[33px]" />
			<span class="sr-only">{{ t("language.button") }}</span>
		</button>
		<span class="lang-label" aria-hidden="true">{{ t("language.label") }}</span>
		<ul :id="id" class="lang-list" :aria-label="t('language.button')">
			<li v-for="option in options" :key="option.code">
				<a
					:href="option.href"
					:hreflang="option.htmlLang"
					:lang="option.htmlLang"
					:aria-current="option.current ? 'true' : undefined"
					class="lang-option"
					@click="remember(option.code)"
				>
					{{ option.label }}
				</a>
			</li>
		</ul>
	</li>
</template>
