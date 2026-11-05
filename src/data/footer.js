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
			{ label: "footer.studio.code", to: "/code" },
			{ label: "footer.studio.jobs", to: "/jobs" },
			{ label: "footer.studio.contact", to: "/jobs#contact" },
			{ label: "footer.studio.press", to: "/press" },
			{ label: "footer.studio.privacy", to: "/privacy" },
		],
	},
	{
		id: "resources",
		heading: "footer.resources.heading",
		links: [
			{ label: "footer.resources.videos", to: "/videos" },
			{ label: "footer.resources.github", href: SITE.links.github },
			{ label: "footer.resources.issue", href: SITE.links.issues },
			{ label: "footer.resources.status", href: SITE.status },
		],
	},
	{
		id: "community",
		heading: "footer.community.heading",
		links: [
			{ label: "footer.community.discord", href: SITE.links.discord },
			{ label: "footer.community.youtube", href: SITE.links.youtube },
		],
	},
];
