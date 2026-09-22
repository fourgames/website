import { GAMES } from "@/data/games.js";
import { SITE } from "@/data/site.js";
import steam from "@/data/generated/steam.json";

const UNANNOUNCED_TAGLINE = "Something new is in the forge. Join the Discord to be first to see it.";

// Our games, merged from src/data/games.js and the build-time Steam data.
// The order comes from the build (published games are discovered from Steam, so they aren't all in
// games.js); GAMES is the offline fallback. Live Steam data wins; games.js covers the rest.
export function getGames() {
	const ids = steam.appIds?.length ? steam.appIds : GAMES.map((g) => g.appId);
	const overrides = new Map(GAMES.map((g) => [g.appId, g.fallback ?? {}]));
	return ids.map((appId) => {
		const fallback = overrides.get(appId) ?? {};
		const live = steam.apps?.[appId];
		return {
			appId,
			status: live?.status ?? fallback.status ?? "unlisted",
			name: live?.name ?? fallback.name ?? "Unannounced project",
			description: live?.shortDescription || fallback.tagline || UNANNOUNCED_TAGLINE,
			image: live?.headerImage ?? fallback.image ?? null,
			storeUrl: live?.storeUrl ?? `https://store.steampowered.com/app/${appId}/`,
			price: live?.price ?? null,
			isFree: live?.isFree ?? false,
			releaseDate: live?.releaseDate ?? null,
			platforms: live?.platforms ?? [],
			genres: live?.genres ?? [],
			screenshots: live?.screenshots ?? [],
			hue: fallback.hue ?? 212,
		};
	});
}

// Full-width hero slides: every screenshot of every announced game (key art as a fallback).
// Upcoming games are included, so a new store page joins the shuffle the day it's discovered;
// unlisted ones are skipped because their only art is a local placeholder, not a 1920px shot.
export function getHeroSlides() {
	return getGames()
		.filter((g) => g.status !== "unlisted")
		.flatMap((g) => {
			// Prefer our own AVIF copies (scripts/fetch-data.mjs mirrors them): same picture, a third of
			// the bytes, and no second origin to connect to before the LCP image can start. `thumb` is
			// the narrow cut phones get — the hero is a dark-tinted backdrop, so it reads the same there.
			const sources = g.screenshots.length
				? g.screenshots.map((s) => ({ full: s.localFull || s.full, thumb: s.localThumb || s.thumb || s.full }))
				: [g.image].filter(Boolean).map((src) => ({ full: src, thumb: src }));
			return sources.map((s) => ({ ...s, game: g.name, author: SITE.name, href: g.storeUrl }));
		});
}

// Our games as one timeline, newest first: the furthest-out thing leads (the home page gives it the
// big card), and each game slides down the list as it announces, launches and ages out.
// Steam's releaseDate is a display string, not a date ("Nov 20, 2024", "Q1 2026", "Coming soon"),
// so Date.parse is expected to fail here: an undated announcement ranks above a dated one, and an
// unparseable release date sinks to the bottom. Sort is stable, so ties keep the build's order.
const STATUS_RANK = { unlisted: 0, upcoming: 1, released: 2 };
const releaseKey = (game) => Date.parse(game.releaseDate) || (game.status === "upcoming" ? Infinity : 0);

export function byRecency(a, b) {
	const rank = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
	if (rank !== 0) return rank;
	const [keyA, keyB] = [releaseKey(a), releaseKey(b)];
	return keyA === keyB ? 0 : keyB - keyA;
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
export function priceLabel(game) {
	if (game.isFree) return "Free";
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

export function gameStatusLabel(game) {
	if (game.status === "released") return game.releaseDate ? `Released ${game.releaseDate}` : "Out now";
	if (game.status === "upcoming") {
		const date = upcomingDate(game.releaseDate);
		return date ? `Coming ${date}` : "Coming soon";
	}
	return "In development";
}
