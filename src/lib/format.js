// Formatting helpers. Fixed locale + UTC so the prerendered HTML and the hydrated client always agree.

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");
const monthYear = new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" });
const fullDate = new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export const formatCompact = (n) => compact.format(n);
export const formatNumber = (n) => whole.format(n);
export const formatMonthYear = (iso) => monthYear.format(new Date(iso));
export const formatDate = (iso) => fullDate.format(new Date(iso));

export function formatDuration(seconds) {
	if (!seconds) return "";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function formatRelative(iso, now = Date.now()) {
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
	return "just now";
}
