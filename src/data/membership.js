// YouTube channel membership — keep in sync with the tier on youtube.com/@FourGamesAB/join.

export const MEMBERSHIP = {
	tier: "Supporter",
	price: "$4.99",
	period: "month",
	pitch: "Support Four Games on YouTube and get every game we make — free.",
	perks: [
		{
			id: "games",
			icon: "gamepad",
			title: "Keys to all our games",
			text: "Reforge Front and every game we release after it.",
		},
		{
			id: "early",
			icon: "clock",
			title: "Early access to new videos",
			text: "Watch new Godot tutorials before everyone else.",
		},
		{
			id: "discord",
			icon: "discord",
			title: "Discord role",
			text: "A members role in our Discord server.",
		},
		{
			id: "badges",
			icon: "sparkles",
			title: "Member badges",
			text: "Loyalty badges next to your name in comments and live chat.",
		},
	],
	fineprint: "Recurring payment · cancel anytime · price varies by region · handled by YouTube",
};
