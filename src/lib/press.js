import { defaultI18n } from "@/i18n/index.js";
import steam from "@/data/generated/steam.json";
import { PLATFORM_NAMES, byRecency, getGames, upcomingDate } from "@/lib/games.js";

// Press kits (/press and /press/<slug>), modelled on presskit()'s section order. Everything comes
// from the build-time Steam data (scripts/fetch-data.mjs): a game gets a press kit once it has a
// public store page, "Coming soon" included. Unannounced and unlisted games are skipped.

// "Reforge Front" → "reforge-front". From the English Steam name, so the URL is the same in every
// language and only changes if the game is renamed.
function slugify(name) {
	return String(name)
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

const SLUGS = new Map();
for (const appId of steam.appIds ?? []) {
	const app = steam.apps?.[appId];
	if (!app?.name || (app.status !== "released" && app.status !== "upcoming")) continue;
	let slug = slugify(app.name) || String(appId);
	if ([...SLUGS.values()].includes(slug)) slug = `${slug}-${appId}`;
	SLUGS.set(appId, slug);
}

const BY_SLUG = new Map([...SLUGS].map(([appId, slug]) => [slug, appId]));

// Prerendered once per language by scripts/prerender.mjs (see src/entry-server.js).
export function pressTargets() {
	return [...SLUGS.values()].map((slug) => ({ url: `/press/${slug}`, file: `press/${slug}.html`, sitemap: true }));
}

export function hasPressKit(slug) {
	return BY_SLUG.has(slug);
}

// The games the studio press kit lists, newest first: the /games list minus unannounced ones.
export function getPressGames(i18n = defaultI18n) {
	return getGames(i18n)
		.filter((g) => SLUGS.has(g.appId))
		.sort(byRecency)
		.map((g) => ({ ...g, slug: SLUGS.get(g.appId) }));
}

// Steam's "About this game", split for the press kit: list items become Features (a heading over a
// single item is that feature's title, as store pages often lay them out), the paragraphs stay in
// the Description. See steamAbout() in scripts/fetch-data.mjs for the shape.
function splitAbout(sections = []) {
	const features = [];
	const description = [];
	for (const section of sections) {
		if (section.items.length === 1 && section.heading) features.push({ title: section.heading, text: section.items[0] });
		else features.push(...section.items.map((text) => ({ title: null, text })));
		if (section.paragraphs.length) {
			description.push({ heading: section.items.length ? null : section.heading, paragraphs: section.paragraphs });
		}
	}
	return { features, description };
}

// One game's press kit, in the page's language. null for a slug without one.
export function getPressGame(slug, i18n = defaultI18n) {
	const appId = BY_SLUG.get(slug);
	if (!appId) return null;
	const { t, code } = i18n;
	const game = getGames(i18n).find((g) => g.appId === appId);
	const live = steam.apps[appId];
	const local = live.i18n?.[code] ?? {};
	const { features, description: about } = splitAbout(local.about ?? live.about ?? []);

	// A specific day (or quarter) when Steam has one, "Coming soon" otherwise.
	const releaseText =
		game.status === "released"
			? game.releaseDateLabel
			: upcomingDate(game.releaseDate)
				? game.releaseDateLabel
				: t("games.status.comingSoon");

	// The regular price, not a sale one: coverage outlives a discount.
	const price = game.isFree
		? t("games.free")
		: game.price?.final
			? game.price.discountPercent > 0 && game.price.initial
				? game.price.initial
				: game.price.final
			: null;

	const { artLanguages, artByLanguage } = pressArt(live, game);

	return {
		...game,
		slug,
		developers: live.developers ?? [],
		publishers: live.publishers ?? [],
		website: live.website ?? null,
		languages: local.languages ?? live.languages ?? [],
		platformNames: game.platforms.map((p) => PLATFORM_NAMES[p] ?? p),
		releaseText,
		priceText: price,
		features,
		// The rest of "About this game", after the short description (game.description).
		about,
		movies: (live.movies ?? []).filter((m) => m.thumbnail || m.mp4 || m.webm || m.hls),
		artLanguages,
		artByLanguage,
		artDefault: artLanguages.find((l) => l.steam === STEAM_LANGUAGE[code])?.steam ?? "english",
	};
}

// Steam's language names → BCP 47, for each language's own name in the art picker.
const STEAM_TAGS = {
	english: "en", schinese: "zh-Hans", tchinese: "zh-Hant", japanese: "ja", koreana: "ko", thai: "th",
	bulgarian: "bg", czech: "cs", danish: "da", german: "de", spanish: "es-ES", latam: "es-419", greek: "el",
	french: "fr", italian: "it", indonesian: "id", hungarian: "hu", dutch: "nl", norwegian: "nb", polish: "pl",
	portuguese: "pt-PT", brazilian: "pt-BR", romanian: "ro", russian: "ru", finnish: "fi", swedish: "sv",
	turkish: "tr", vietnamese: "vi", ukrainian: "uk", arabic: "ar",
};
// The site's languages → Steam's, so a page opens the art picker on its own language.
const STEAM_LANGUAGE = { en: "english", ja: "japanese", ko: "koreana", "zh-cn": "schinese", "zh-tw": "tchinese" };

// The order and size (of the 2x file we link) of each piece of store art. Sizes are Steam's spec;
// the logo and background vary per game, so they have none.
const ART = [
	["logo", null],
	["header", "920×430"],
	["capsule", "1232×706"],
	["smallCapsule", "462×174"],
	["heroCapsule", "748×896"],
	["libraryCapsule", "600×900"],
	["libraryHero", "3840×1240"],
	["background", null],
];

function nativeName(steam) {
	const tag = STEAM_TAGS[steam] ?? "en";
	try {
		const name = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
		return name.charAt(0).toLocaleUpperCase(tag) + name.slice(1);
	} catch {
		return steam;
	}
}

// Logos and key art per language, like SteamDB's assets tab. scripts/fetch-data.mjs stores English
// whole and only each language's own files, so a language here is English with its own files on
// top, and an item marks whether it is that language's own (`own`). Older data without `art` falls
// back to what appdetails had: the header and small capsule.
function pressArt(live, game) {
	const english = live.art?.english ?? {
		header: game.image,
		smallCapsule: live.capsuleImage,
		background: live.backgroundImage,
	};
	const languages = ["english", ...Object.keys(live.art ?? {}).filter((l) => l !== "english")];
	const artByLanguage = {};
	for (const language of languages) {
		const own = language === "english" ? {} : live.art[language];
		artByLanguage[language] = ART.map(([key, size]) => {
			const url = own[key] ?? english[key];
			return url && { key, url, size, own: Boolean(own[key]) };
		}).filter(Boolean);
	}
	// English first, then the rest in Steam's order.
	const artLanguages = languages.map((steam) => ({ steam, label: nativeName(steam) }));
	return { artLanguages, artByLanguage };
}
