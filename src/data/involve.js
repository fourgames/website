// "Get involved" columns on the home page.
import { SITE } from "./site.js";

export const INVOLVE = [
	{
		id: "discord",
		icon: "discord",
		title: "Chat",
		text: "Ask questions, share what you're building and help shape our games on Discord.",
		cta: "Join Discord",
		href: SITE.links.discord,
	},
	{
		id: "youtube",
		icon: "youtube",
		title: "Learn",
		text: "Free Godot tutorials on our YouTube channel, from quick tips to full beginner courses.",
		cta: "Watch on YouTube",
		href: SITE.links.youtube,
	},
	{
		id: "jobs",
		icon: "users",
		title: "Collaborate",
		text: "Creators, studios and brands: let's build something together.",
		cta: "Work with us",
		to: "/jobs",
	},
];
