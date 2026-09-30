import { GAMES } from "@/data/games.js";
import { SITE } from "@/data/site.js";
import { defaultI18n } from "@/i18n/index.js";
import steam from "@/data/generated/steam.json";
import { byRecency, heroGame, latestReleased } from "@/lib/recency.js";

export { byRecency, latestReleased };

// Our games, merged from src/data/games.js and the build-time Steam data, in the page's language.
// The order comes from the build (published games are discovered from Steam, so they aren't all in
// games.js); GAMES is the offline fallback. Live Steam data wins; games.js covers the rest.
// Steam's own translation of the store blurb, genres and release date is used where the build
// fetched one (`live.i18n[code]`): name, capsule art, screenshots, blurb, genres and release date.
export function getGames(i18n = defaultI18n) {
	const { t, code } = i18n;
	const ids = steam.appIds?.length ? steam.appIds : GAMES.map((g) => g.appId);
	const overrides = new Map(GAMES.map((g) => [g.appId, g.fallback ?? {}]));
	return ids.map((appId) => {
		const fallback = overrides.get(appId) ?? {};
		const live = steam.apps?.[appId];
		const local = live?.i18n?.[code] ?? {};
		// Our own tagline in this language (games.js), for when Steam has no translated blurb.
		const tagline = typeof fallback.tagline === "object" ? fallback.tagline : { en: fallback.tagline };
		const translated = code === "en" ? null : local.shortDescription || tagline[code];
		return {
			appId,
			status: live?.status ?? fallback.status ?? "unlisted",
			name: local.name || (live?.name ?? fallback.name ?? t("games.unannounced.name")),
			description:
				translated || live?.shortDescription || (code === "en" && tagline.en) || t("games.unannounced.tagline"),
			image: local.headerImage || (live?.headerImage ?? fallback.image ?? null),
			storeUrl: live?.storeUrl ?? `https://store.steampowered.com/app/${appId}/`,
			price: live?.price ?? null,
			isFree: live?.isFree ?? false,
			// English, for sorting (byRecency parses it); releaseDateLabel is what the page shows.
			releaseDate: live?.releaseDate ?? null,
			releaseDateLabel: local.releaseDate || live?.releaseDate || null,
			platforms: live?.platforms ?? [],
			genres: local.genres?.length ? local.genres : (live?.genres ?? []),
			screenshots: local.screenshots?.length ? local.screenshots : (live?.screenshots ?? []),
			hue: fallback.hue ?? 212,
		};
	});
}

// Full-width hero slides: every screenshot of the "Play latest" game (see heroGame), key art as a
// fallback. Only that game's screenshots are mirrored as AVIF (scripts/fetch-data.mjs), so the
// hero never picks a picture from another game.
// In the page's language: the game's localized screenshots when Steam has them, and its translated name.
export function getHeroSlides(i18n = defaultI18n) {
	const g = heroGame(getGames(i18n));
	if (!g) return [];
	// Prefer our own AVIF copies (scripts/fetch-data.mjs mirrors them): same picture, a third of
	// the bytes, and no second origin to connect to before the LCP image can start. `thumb` is
	// the narrow cut phones get — the hero is a dark-tinted backdrop, so it reads the same there.
	const sources = g.screenshots.length
		? g.screenshots.map((s) => ({ full: s.localFull || s.full, thumb: s.localThumb || s.thumb || s.full }))
		: [g.image].filter(Boolean).map((src) => ({ full: src, thumb: src }));
	return sources.map((s) => ({ ...s, game: g.name, author: SITE.name, href: g.storeUrl }));
}

export const PLATFORM_NAMES = { windows: "Windows", mac: "macOS", linux: "Linux" };

// Fresh enough to flag with a "NEW" marker, like godotengine.org does on recent posts.
// `since` is the build's own fetch timestamp, not Date.now(): these pages are prerendered, so a
// clock-based answer would differ between the static HTML and hydration.
export function isRecent(date, days, since) {
	if (!date || !since) return false;
	const then = new Date(date).getTime();
	const now = new Date(since).getTime();
	if (Number.isNaN(then) || Number.isNaN(now)) return false;
	return now - then < days * 24 * 60 * 60 * 1000;
}

// Price for a card: a "Free" string, a { final, initial, discountPercent } object, or null when
// there's nothing to show (upcoming and unannounced games have no price yet).
// Steam's *_formatted values already carry the currency symbol — the fetch pins cc=us.
export function priceLabel(game, t = defaultI18n.t) {
	if (game.isFree) return t("games.free");
	if (!game.price?.final) return null;
	const { final, initial, discountPercent } = game.price;
	return { final, initial, discountPercent: discountPercent > 0 && initial ? discountPercent : 0 };
}

// Phrases Steam puts in release_date.date that already mean "coming soon" — printing
// "Coming To be announced" would be worse than saying nothing.
const VAGUE_RELEASE_DATES = new Set(["coming soon", "to be announced", "tba", "tbd", "when it's ready", "when its ready", "soon"]);

// release_date.date is a display string, not a date: a real day ("Sep 29, 2026"), a quarter
// ("Q1 2026"), a bare year, or one of the phrases above. Anything specific is worth showing.
function upcomingDate(date) {
	const normalised = date?.trim().replace(/[.!]$/, "").toLowerCase();
	return normalised && !VAGUE_RELEASE_DATES.has(normalised) ? date.trim() : null;
}

// The vague-phrase check reads the English date; the label shows Steam's translation of it.
export function gameStatusLabel(game, t = defaultI18n.t) {
	const date = game.releaseDateLabel ?? game.releaseDate;
	if (game.status === "released") {
		return game.releaseDate ? t("games.status.releasedOn", { date }) : t("games.status.outNow");
	}
	if (game.status === "upcoming") {
		return upcomingDate(game.releaseDate) ? t("games.status.comingOn", { date }) : t("games.status.comingSoon");
	}
	return t("games.status.inDevelopment");
}
