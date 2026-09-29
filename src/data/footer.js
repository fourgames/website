// Footer columns, godotengine.org style. `to` = internal route, `href` = external link.
// Headings and labels are message keys (src/i18n/messages).
import { SITE } from "./site.js";

export const FOOTER_COLUMNS = [
	{
		id: "games",
		heading: "footer.games.heading",
		links: [
			{ label: "footer.games.all", to: "/games" },
			{ label: "footer.games.steam", href: SITE.links.steam },
			{ label: "footer.games.members", to: "/#membership" },
		],
	},
	{
		id: "studio",
		heading: "footer.studio.heading",
		links: [
			{ label: "footer.studio.home", to: "/" },
			{ label: "footer.studio.code", to: "/code" },
			{ label: "footer.studio.jobs", to: "/jobs" },
			{ label: "footer.studio.contact", to: "/jobs#contact" },
		],
	},
	{
		id: "resources",
		heading: "footer.resources.heading",
		links: [
			{ label: "footer.resources.videos", to: "/videos" },
			{ label: "footer.resources.youtube", href: SITE.links.youtube },
			{ label: "footer.resources.github", href: SITE.links.github },
			{ label: "footer.resources.issue", href: SITE.links.issues },
		],
	},
	{
		id: "community",
		heading: "footer.community.heading",
		links: [
			{ label: "footer.community.discord", href: SITE.links.discord },
			{ label: "footer.community.membership", href: SITE.links.youtubeJoin },
			{ label: "footer.community.steam", href: SITE.links.steam },
		],
	},
];
