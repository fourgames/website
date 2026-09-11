// Our Steam games. Plain ESM: scripts/fetch-data.mjs imports this to know which app IDs to fetch.
//
// Live Steam data (name, art, description, price…) is fetched at build time and always wins.
// `fallback` is used while a game has no public store page yet ("Coming soon" card):
//   name     – shown instead of the Steam name (e.g. a codename)
//   tagline  – one-liner under the name
//   image    – optional path in /public, 460×215 or larger (e.g. "/images/games/project-x.webp")
//   hue      – colour of the placeholder art when there's no image (0–360)
//   status   – only used if Steam can't be reached at build time ("released" | "unlisted")

export const GAMES = [
	{
		appId: 2807130,
		fallback: {
			status: "released",
			name: "Reforge Front",
			image: "/images/hero/hero-m-640.avif",
			tagline: "Defend the furnace from waves of goblins by building and upgrading in an FPS tower defense.",
		},
	},
	{
		appId: 3958210,
		fallback: {
			name: "Unannounced project",
			tagline: "Something new is in the forge. Join the Discord to be first to see it.",
			hue: 212,
		},
	},
	{
		appId: 5253650,
		fallback: {
			name: "Unannounced project",
			tagline: "In development. Follow along for the reveal.",
			hue: 150,
		},
	},
	{
		appId: 5207970,
		fallback: {
			name: "Unannounced project",
			tagline: "Early days — more to share soon.",
			hue: 265,
		},
	},
];
