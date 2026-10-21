// "Get involved" columns on the home page. Text is under involve.<id> in src/i18n/messages.
import { SITE } from "./site.js";

export const INVOLVE = [
	{ id: "discord", icon: "discord", href: SITE.links.discord },
	{ id: "youtube", icon: "youtube", href: SITE.links.youtube },
	{ id: "jobs", icon: "users", to: "/jobs" },
];
