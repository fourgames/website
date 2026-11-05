// Header navigation, laid out like godotengine.org's: left links next to the logo, right links
// before the "Donate" pill (which is really our YouTube membership — the label mirrors
// godotengine.org, and it catches people who came to give without knowing there are perks).
// Every public link has godotengine.org's hover dropdown, built by one rule: first the page's own
// sections (anchors on it), then the place to follow that side of us off-site. Games and Videos are
// a single list each, so theirs is just the off-site link. In the mobile menu the children sit
// indented under their link. The footer has its own columns in footer.js.
// Labels are message keys (src/i18n/messages); `to` is the English path, localised by NavLink,
// `href` is an external link (opens in a new tab).
import { SITE } from "./site.js";

export const NAV_LEFT = [
	{
		label: "nav.games",
		to: "/games",
		children: [{ label: "nav.steam", href: SITE.links.steam }],
	},
	{
		label: "nav.videos",
		to: "/videos",
		children: [{ label: "nav.youtube", href: SITE.links.youtubeSubscribe }],
	},
	{
		label: "nav.code",
		to: "/code",
		children: [
			{ label: "nav.repositories", to: "/code#repositories" },
			{ label: "nav.contributions", to: "/code#roadmap" },
			{ label: "nav.github", href: SITE.links.github },
			{ label: "nav.issue", href: SITE.links.issues },
		],
	},
	{
		label: "nav.press",
		to: "/press",
		children: [
			{ label: "nav.factsheet", to: "/press#factsheet" },
			{ label: "nav.logos", to: "/press#logos" },
			{ label: "nav.requestKey", to: "/press#key" },
			{ label: "nav.pressContact", to: "/press#contact" },
		],
	},
	{
		label: "nav.community",
		to: "/#community",
		children: [
			{ label: "nav.discord", href: SITE.links.discord },
			{ label: "nav.youtubeShort", href: SITE.links.youtube },
			{ label: "nav.steamShort", href: SITE.links.steam },
		],
	},
];

export const NAV_RIGHT = [
	{
		label: "nav.principles",
		to: "/principles",
		children: [
			{ label: "nav.fairPublishing", to: "/principles#publishing" },
			{ label: "nav.contact", to: "/jobs#contact" },
		],
	},
	{
		label: "nav.jobs",
		to: "/jobs",
		children: [
			{ label: "nav.collaborations", to: "/jobs#collaborations" },
			{ label: "nav.contact", to: "/jobs#contact" },
		],
	},
	{
		label: "nav.privacy",
		to: "/privacy",
		children: [
			{ label: "nav.policy", to: "/privacy#policy" },
			{ label: "nav.yourData", to: "/privacy#your-data" },
		],
	},
];

export const DONATE = { label: "nav.donate", to: "/#membership", icon: "heart" };
