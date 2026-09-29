// Formatting helpers. Fixed per-language locale + UTC so the prerendered HTML and the hydrated
// client always agree. `locale` is an Intl locale (see `intl` in src/i18n/locales.js).

const cache = new Map();
function formatter(Type, locale, options) {
	const key = `${Type.name}|${locale}|${JSON.stringify(options)}`;
	if (!cache.has(key)) cache.set(key, new Type(locale, options));
	return cache.get(key);
}

export const formatCompact = (n, locale = "en") =>
	formatter(Intl.NumberFormat, locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
export const formatNumber = (n, locale = "en") => formatter(Intl.NumberFormat, locale, {}).format(n);
export const formatMonthYear = (iso, locale = "en") =>
	formatter(Intl.DateTimeFormat, locale, { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
export const formatDate = (iso, locale = "en") =>
	formatter(Intl.DateTimeFormat, locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
		new Date(iso),
	);

export function formatDuration(seconds) {
	if (!seconds) return "";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatRelative(iso, locale = "en", now = Date.now()) {
	const relative = formatter(Intl.RelativeTimeFormat, locale, { numeric: "auto" });
	const seconds = (new Date(iso).getTime() - now) / 1000;
	const units = [
		["year", 31_536_000],
		["month", 2_592_000],
		["week", 604_800],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	for (const [unit, size] of units) {
		if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
	}
	return relative.format(0, "second"); // "now", "今", "지금", "现在"
}
