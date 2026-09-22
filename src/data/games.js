// Games that Steam can't tell us about. Plain ESM: scripts/fetch-data.mjs imports this too.
//
// Published games are discovered automatically at build time from the public store search
// (SITE.steam.publisher / .developer), so a new store page needs NO entry here — it appears on the
// site by itself within a day, "Coming soon" pages included. Add an entry only for:
//   • an unannounced game, which has no public store page for the search to find; or
//   • an offline fallback, so the site still renders before the first fetch succeeds.
//
// Every `fallback` field is used only where live Steam data is missing — Steam always wins.
//   name     – shown instead of the Steam name (e.g. a codename)
//   tagline  – one-liner under the name (unannounced games share a generic one if left out)
//   image    – optional path in /public, Steam capsule art at 460×215 (cards use that ratio)
//   hue      – colour of the placeholder art when there's no image (0–360)
//   status   – only used if Steam can't be reached at build time ("released" | "unlisted")

export const GAMES = [
	{
		appId: 2807130,
		fallback: {
			status: "released",
			name: "Reforge Front",
			image: "/images/games/reforge-front.avif",
			tagline: "Defend the furnace from waves of goblins by building and upgrading in an FPS tower defense.",
		},
	},
];
