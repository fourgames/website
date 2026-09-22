// Footer columns, godotengine.org style. `to` = internal route, `href` = external link.
import { SITE } from "./site.js";

export const FOOTER_COLUMNS = [
	{
		heading: "Games",
		links: [
			{ label: "All games", to: "/games" },
			{ label: "Follow on Steam", href: SITE.links.steam },
			{ label: "Free for members", to: "/#membership" },
		],
	},
	{
		heading: "Studio",
		links: [
			{ label: "Home", to: "/" },
			{ label: "Open Source", to: "/code" },
			{ label: "Work with us", to: "/jobs" },
			{ label: "Contact", to: "/jobs#contact" },
		],
	},
	{
		heading: "Resources",
		links: [
			{ label: "Videos", to: "/videos" },
			{ label: "YouTube channel", href: SITE.links.youtube },
			{ label: "GitHub", href: SITE.links.github },
			{ label: "Report a website issue", href: SITE.links.issues },
		],
	},
	{
		heading: "Community",
		links: [
			{ label: "Discord", href: SITE.links.discord },
			{ label: "Membership", href: SITE.links.youtubeJoin },
			{ label: "Steam", href: SITE.links.steam },
		],
	},
];
