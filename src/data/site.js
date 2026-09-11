// Site-wide constants. Plain ESM (no "@/" imports): scripts/fetch-data.mjs imports this too.

export const SITE = {
	name: "Four Games",
	url: "https://fourgames.se",
	tagline: "Indie games made in Godot — plus free tutorials and open-source tools.",
	links: {
		// discord.fourgames.se currently has a broken HTTPS certificate, so link straight to the invite.
		discord: "https://discord.gg/bQTPTc5Qrt",
		youtube: "https://www.youtube.com/@FourGamesAB",
		youtubeJoin: "https://www.youtube.com/@FourGamesAB/join",
		github: "https://github.com/fourgames",
		steam: "https://store.steampowered.com/app/2807130/Reforge_Front/",
		issues: "https://github.com/fourgames/website/issues/new",
	},
	youtube: {
		handle: "@FourGamesAB",
		channelId: "UCGf6yX8yYzo1FBzhmKhFduA",
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
];
