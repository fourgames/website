// Site-wide constants. Plain ESM (no "@/" imports): scripts/fetch-data.mjs imports this too.

export const SITE = {
	name: "Four Games",
	url: "https://fourgames.se",
	tagline: "Indie games made in Godot, plus free tutorials and open-source tools.",
	hero: {
		title: "We make games in Godot and teach you how.",
		subtitle: "Indie games, free tutorials and open-source tools from Four Games.",
	},
	links: {
		// discord.fourgames.se currently has a broken HTTPS certificate, so link straight to the invite.
		discord: "https://discord.gg/bQTPTc5Qrt",
		youtube: "https://www.youtube.com/@FourGamesAB",
		youtubeJoin: "https://www.youtube.com/@FourGamesAB/join",
		github: "https://github.com/fourgames",
		steam: "https://store.steampowered.com/publisher/fourgamesab",
		x: "https://x.com/FourGamesAB",
		instagram: "https://www.instagram.com/fourgamesab/",
		tiktok: "https://www.tiktok.com/@fourgamesab",
		bluesky: "https://bsky.app/profile/fourgamesab.bsky.social",
		twitch: "https://www.twitch.tv/fourgamesab",
		itchio: "https://fourgamesab.itch.io",
		mastodon: "https://mastodon.gamedev.place/@fourgamesab",
		issues: "https://github.com/fourgames/website/issues/new",
	},
	youtube: {
		handle: "@FourGamesAB",
		channelId: "UCGf6yX8yYzo1FBzhmKhFduA",
		// Featured "Most popular" video when there's no YOUTUBE_API_KEY (the keyless feed only sees the
		// 15 newest uploads). With a key, the build finds the true most popular video by itself.
		popularFallbackId: "bR0v-yoZYZA",
	},
	steam: {
		// The build discovers our app IDs from the public store search, filtered by these names.
		// Both are queried and the results merged, so co-published titles are picked up too.
		publisher: "Four Games",
		developer: "Four Games",
	},
	discord: {
		guildId: "1084592623819444365",
	},
	github: {
		org: "fourgames",
		// Repos to hide from the Open Source page (dot-repos like .github are always hidden).
		exclude: [],
	},
	formspree: "https://formspree.io/f/mbdplgvl",
};

export const SOCIALS = [
	{ label: "YouTube", icon: "youtube", href: SITE.links.youtube },
	{ label: "Discord", icon: "discord", href: SITE.links.discord },
	{ label: "GitHub", icon: "github", href: SITE.links.github },
	{ label: "Steam", icon: "steam", href: SITE.links.steam },
	{ label: "itch.io", icon: "itchio", href: SITE.links.itchio },
	{ label: "X", icon: "x", href: SITE.links.x },
	{ label: "Bluesky", icon: "bluesky", href: SITE.links.bluesky },
	{ label: "Mastodon", icon: "mastodon", href: SITE.links.mastodon },
	{ label: "Instagram", icon: "instagram", href: SITE.links.instagram },
	{ label: "TikTok", icon: "tiktok", href: SITE.links.tiktok },
	{ label: "Twitch", icon: "twitch", href: SITE.links.twitch },
];
