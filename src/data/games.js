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
//   tagline  – one-liner under the name (unannounced games share a generic one if left out). A string
//              (English), or one per language { en, ja, ko, "zh-cn", "zh-tw" } — the translations are
//              used where the Steam page itself has no translated blurb for that language.
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
			tagline: {
				en: "Defend the furnace from waves of goblins by building and upgrading in an FPS tower defense.",
				ja: "FPSタワーディフェンスで建築とアップグレードを重ね、押し寄せるゴブリンの群れから炉を守り抜け。",
				ko: "FPS 타워 디펜스에서 건설하고 업그레이드하며 몰려오는 고블린 무리로부터 용광로를 지켜 내세요.",
				"zh-cn": "在这款 FPS 塔防游戏中建造和升级，抵御一波又一波的哥布林，守护熔炉。",
				"zh-tw": "在這款 FPS 塔防遊戲中建造和升級，抵禦一波又一波的哥布林，守護熔爐。",
			},
		},
	},
];
