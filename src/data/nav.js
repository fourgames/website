// Header and footer navigation. Left links sit next to the logo; right links sit before the
// "Donate" pill (which is really our YouTube membership — the label mirrors godotengine.org).
import { SITE } from "./site.js";

export const NAV_LEFT = [
	{ label: "Games", to: "/games" },
	{ label: "Videos", to: "/videos" },
	{ label: "Membership", to: "/#membership" },
	{ label: "Open Source", to: "/code" },
];

export const NAV_RIGHT = [
	{ label: "Work with us", to: "/jobs" },
	{ label: "Discord", href: SITE.links.discord, icon: "discord" },
];

export const DONATE = { label: "Donate", to: "/#membership", icon: "heart" };
