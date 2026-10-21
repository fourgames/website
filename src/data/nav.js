// Header navigation. Left links sit next to the logo; right links sit before the "Donate" pill
// (which is really our YouTube membership — the label mirrors godotengine.org, and it catches
// people who came to give without knowing there are perks). The footer has its own columns in
// footer.js. Two things deliberately aren't here: Discord, which is the hero's own button and
// only crowded "Work with us" when repeated up top, and Membership, which is the Donate pill's
// own destination — a text link to the same anchor just competes with the pill.
// Labels are message keys (src/i18n/messages); `to` is the English path, localised by NavLink.

export const NAV_LEFT = [
	{ label: "nav.games", to: "/games" },
	{ label: "nav.videos", to: "/videos" },
	{ label: "nav.code", to: "/code" },
];

export const NAV_RIGHT = [{ label: "nav.jobs", to: "/jobs" }];

export const DONATE = { label: "nav.donate", to: "/#membership", icon: "heart" };
