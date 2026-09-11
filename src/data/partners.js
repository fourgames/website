// Partnership types on /jobs. `span` classes must be complete literal strings (Tailwind scans them).

export const PARTNERS = [
	{
		audience: "YouTube Creators",
		title: "Guest Series",
		text: "Featuring educational series on our channel to provide exposure to your work.",
		icon: "video",
		span: "md:col-span-4 md:row-span-2",
		featured: true,
	},
	{
		audience: "Indie Studios",
		title: "Co-Development & Publishing",
		text: "We partner with experienced developers to co-develop or publish new titles.",
		icon: "users",
		span: "md:col-span-2",
	},
	{
		audience: "Brands & IPs",
		title: "Franchise Collaborations",
		text: "We aim to develop licensed games for Nintendo, LEGO, and anime properties.",
		icon: "sparkles",
		span: "md:col-span-2",
	},
	{
		audience: "Community Trust",
		title: "Zero Sponsorships",
		text: "We have never and will never accept sponsorships or paid brand deals.",
		icon: "shield",
		span: "md:col-span-6",
		principle: true,
	},
];
