// YouTube channel membership — keep the tier name in sync with youtube.com/@FourGamesAB/join.
// It stays in English in every language, because that's what YouTube shows on the join page.
// No price here on purpose: YouTube prices memberships per region and shows the real cost on the join page.
// Each perk links somewhere that shows it off (godotengine.org wraps its feature cards in a link):
// `to` for an internal route, `href` for an external one. Text is under membership.perks.<id> in
// src/i18n/messages.
import { SITE } from "./site.js";

export const MEMBERSHIP = {
	tier: "Supporter",
	perks: [
		{ id: "games", icon: "gamepad", to: "/games" },
		{ id: "early", icon: "clock", to: "/videos" },
		{ id: "discord", icon: "discord", href: SITE.links.discord },
		{ id: "badges", icon: "sparkles", href: SITE.links.youtubeJoin },
	],
};
