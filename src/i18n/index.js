// A tiny i18n layer, in the spirit of lib/head.js: every page is prerendered once per language, and
// the language never changes inside a page load (the picker is a real link to the other URL), so a
// plain object is enough — no reactivity, no plugin.
//
// Messages live in ./messages/<code>.js. English is bundled everywhere as the fallback; every other
// language is its own chunk, loaded before the app mounts (prerender modulepreloads it).
// A message is a string with {placeholders}, or a function of the params for anything that needs
// grammar (English plurals). <I18nT> renders placeholders as slots, for links inside sentences.
import { inject } from "vue";
import en from "./messages/en.js";
import { DEFAULT_LOCALE, getLocale, localizePath } from "./locales.js";

const loaders = import.meta.glob(["./messages/*.js", "!./messages/en.js"], { import: "default" });

export async function loadMessages(code) {
	if (code === DEFAULT_LOCALE) return en;
	const load = loaders[`./messages/${code}.js`];
	return load ? load() : en;
}

function lookup(messages, key) {
	let node = messages;
	for (const part of key.split(".")) {
		if (node == null) return undefined;
		node = node[part];
	}
	return node;
}

export function createI18n(code, messages = en) {
	const locale = getLocale(code);
	function raw(key) {
		return lookup(messages, key) ?? lookup(en, key);
	}
	function t(key, params = {}) {
		let message = raw(key);
		if (typeof message === "function") message = message(params);
		if (typeof message !== "string") return key;
		return message.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
	}
	return {
		locale,
		code: locale.code,
		t,
		raw,
		// Internal link in this language: path("/games") → "/ja/games".
		path: (to) => localizePath(to, locale.code),
	};
}

export const I18N_KEY = Symbol("i18n");

// English, for code that runs outside a page render (the prerender script's hero slides).
export const defaultI18n = createI18n(DEFAULT_LOCALE, en);

export function installI18n(app, i18n) {
	app.provide(I18N_KEY, i18n);
	app.config.globalProperties.$t = i18n.t;
}

export function useI18n() {
	return inject(I18N_KEY, defaultI18n);
}
