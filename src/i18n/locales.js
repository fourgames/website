// The languages the site ships in. Plain ESM (no "@/" imports, no Vue): scripts/prerender.mjs reads
// this too, for the page files, <html lang>, hreflang and the auto-detect script it bakes into <head>.
//
// URLs follow godotengine.org: English at the root, every other language under its own prefix
// (/ja/, /ko/, /zh-cn/, /zh-tw/), so each page is a real, crawlable, shareable file per language.
//   code     – the URL prefix and the key used everywhere else (messages/<code>.js)
//   htmlLang – <html lang> and hreflang. Script subtags for Chinese, so the browser picks Simplified
//              or Traditional glyphs and the CSS :lang() font stacks match.
//   intl     – locale for Intl number/date formatting
//   og       – og:locale
//   label    – the language's own name, as the picker shows it (godotengine.org order and spelling)
export const LOCALES = [
	{ code: "en", htmlLang: "en", intl: "en", og: "en_US", label: "English" },
	{ code: "ja", htmlLang: "ja", intl: "ja", og: "ja_JP", label: "日本語" },
	{ code: "ko", htmlLang: "ko", intl: "ko", og: "ko_KR", label: "한국어" },
	{ code: "zh-cn", htmlLang: "zh-Hans", intl: "zh-CN", og: "zh_CN", label: "中文（简体）" },
	{ code: "zh-tw", htmlLang: "zh-Hant", intl: "zh-TW", og: "zh_TW", label: "中文（繁體）" },
];

export const DEFAULT_LOCALE = "en";

const BY_CODE = new Map(LOCALES.map((l) => [l.code, l]));
const PREFIXED = LOCALES.filter((l) => l.code !== DEFAULT_LOCALE).map((l) => l.code);

// For route paths: "ja|ko|zh-cn|zh-tw".
export const LOCALE_PATTERN = PREFIXED.join("|");

export function getLocale(code) {
	return BY_CODE.get(code) ?? BY_CODE.get(DEFAULT_LOCALE);
}

// "/ja/games" → "ja", "/games" → "en".
export function localeFromPath(path) {
	const first = String(path).split(/[/?#]/)[1];
	return PREFIXED.includes(first) ? first : DEFAULT_LOCALE;
}

// "/ja/games#x" → "/games#x", "/ja/" → "/".
export function stripLocale(path) {
	const code = localeFromPath(path);
	if (code === DEFAULT_LOCALE) return path;
	const rest = path.slice(code.length + 1);
	return rest.startsWith("/") ? rest : `/${rest}`;
}

// An English site path in another language: ("/games", "ja") → "/ja/games", ("/", "ja") → "/ja/",
// ("/#membership", "ja") → "/ja/#membership". Language homes keep their slash, like GitHub Pages
// serves them (ja/index.html). External URLs and already-prefixed paths pass through.
export function localizePath(path, code) {
	if (typeof path !== "string" || !path.startsWith("/") || code === DEFAULT_LOCALE) return path;
	if (localeFromPath(path) !== DEFAULT_LOCALE) return path;
	return `/${code}${path}`;
}
