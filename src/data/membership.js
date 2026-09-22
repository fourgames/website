// YouTube channel membership — keep the tier name in sync with youtube.com/@FourGamesAB/join.
// No price here on purpose: YouTube prices memberships per region and shows the real cost on the join page.
// Each perk links somewhere that shows it off (godotengine.org wraps its feature cards in a link):
// `to` for an internal route, `href` for an external one.
import { SITE } from "./site.js";

export const MEMBERSHIP = {
	tier: "Supporter",
	pitch: "Support Four Games on YouTube and get every game we make for free.",
	perks: [
		{
			id: "games",
			icon: "gamepad",
			to: "/games",
			title: "Keys to all our games",
			text: "Reforge Front and every game we release after it.",
		},
		{
			id: "early",
			icon: "clock",
			to: "/videos",
			title: "Early access to new videos",
			text: "Watch new Godot tutorials before everyone else.",
		},
		{
			id: "discord",
			icon: "discord",
			href: SITE.links.discord,
			title: "Discord role",
			text: "A members role in our Discord server.",
		},
		{
			id: "badges",
			icon: "sparkles",
			href: SITE.links.youtubeJoin,
			title: "Member badges",
			text: "Loyalty badges next to your name in comments and live chat.",
		},
	],
};
