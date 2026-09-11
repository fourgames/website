import { GAMES } from "@/data/games.js";
import steam from "@/data/generated/steam.json";

// Our games, merged from src/data/games.js and the build-time Steam data.
// Live Steam data wins; games.js fallbacks cover games without a public store page.
export function getGames() {
	return GAMES.map(({ appId, fallback = {} }) => {
		const live = steam.apps?.[appId];
		return {
			appId,
			status: live?.status ?? fallback.status ?? "unlisted",
			name: live?.name ?? fallback.name ?? "Unannounced project",
			description: live?.shortDescription || fallback.tagline || "",
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
