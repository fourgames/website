// Picks a language for first-time visitors, like godotengine.org does: someone whose browser asks
// for Japanese and lands on an English page is sent to the Japanese one. Plain ESM, no Vue:
// scripts/prerender.mjs bakes redirectScript() into the <head> of every English page, so the switch
// happens before anything paints instead of after the app boots.
//
// The rules, kinder than a plain Accept-Language redirect:
//  • Only English (unprefixed) pages redirect. Opening /ja/… is a choice and is always honoured,
//    which also keeps shared links and search results in the language they were shared in.
//  • A language picked in the menu (LanguageMenu.vue) is remembered and beats the browser's.
//    Picking English is remembered too, so a Japanese browser can stay on the English site.
//  • Otherwise the first of navigator.languages we support wins; English, or nothing we have, stays.
//  • location.replace, so Back doesn't bounce off the English page into the redirect again.
import { DEFAULT_LOCALE, LOCALES } from "./locales.js";

// Same key godotengine.org uses.
export const PREFERENCE_KEY = "preferred_language";

// A BCP 47 tag from the browser → one of our codes, or null. Chinese goes by script, then region:
// Traditional for zh-Hant and for Taiwan, Hong Kong and Macau; Simplified for everything else.
// Must stay self-contained: its source is inlined into the page by redirectScript().
export function matchLanguage(tag, codes) {
	const t = String(tag).toLowerCase();
	let code = t.split("-")[0];
	if (code === "zh") code = /-hant|-tw|-hk|-mo/.test(t) ? "zh-tw" : "zh-cn";
	return codes.indexOf(code) === -1 ? null : code;
}

export function redirectScript() {
	const codes = LOCALES.map((l) => l.code);
	return `!function(){try{
		var codes=${JSON.stringify(codes)},match=${matchLanguage.toString()},pref=null;
		try{pref=localStorage.getItem(${JSON.stringify(PREFERENCE_KEY)})}catch(e){}
		if(codes.indexOf(pref)===-1){pref=null;var langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language];
			for(var i=0;i<langs.length&&!pref;i++)pref=match(langs[i]||"",codes)}
		if(!pref||pref===${JSON.stringify(DEFAULT_LOCALE)})return;
		document.documentElement.style.visibility="hidden";
		location.replace("/"+pref+location.pathname+location.search+location.hash)
	}catch(e){}}()`.replace(/\n\s*/g, "");
}
