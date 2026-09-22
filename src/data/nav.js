// Header navigation. Left links sit next to the logo; right links sit before the "Donate" pill
// (which is really our YouTube membership — the label mirrors godotengine.org, and it catches
// people who came to give without knowing there are perks). The footer has its own columns in
// footer.js. Two things deliberately aren't here: Discord, which is the hero's own button and
// only crowded "Work with us" when repeated up top, and Membership, which is the Donate pill's
// own destination — a text link to the same anchor just competes with the pill.

export const NAV_LEFT = [
	{ label: "Games", to: "/games" },
	{ label: "Videos", to: "/videos" },
	{ label: "Open Source", to: "/code" },
];

export const NAV_RIGHT = [{ label: "Work with us", to: "/jobs" }];

export const DONATE = { label: "Donate", to: "/#membership", icon: "heart" };
