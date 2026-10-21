// Pure helpers only — no JSON imports. The home page pulls `videoThumb` in from here, so anything
// this module loads ends up in the home bundle too; the catalogue is imported by VideosView alone.

// The thumbnail sizes YouTube serves, smallest first. mq/hq always exist; sd and maxres don't for
// older uploads (YouTube answers with a grey placeholder instead), which is why fetch-data.mjs
// records the largest real width per video rather than us guessing here.
// hq/sd are 4:3 letterboxed — the cards are `aspect-video object-cover`, which crops the bars off.
const SIZES = [
	{ name: "mqdefault", width: 320 },
	{ name: "hqdefault", width: 480 },
	{ name: "sddefault", width: 640 },
	{ name: "maxresdefault", width: 1280 },
];

// Smallest size that's at least `minWidth` wide and that this video actually has.
export function videoThumb(video, minWidth = 320) {
	const available = SIZES.filter((s) => s.width <= (video.thumbWidth || 320));
	const size = available.find((s) => s.width >= minWidth) ?? available.at(-1) ?? SIZES[0];
	return `https://i.ytimg.com/vi/${video.id}/${size.name}.jpg`;
}

// Newest first, deduped, undated entries dropped (the keyless pinned "popular" has no date).
export function sortVideos(videos) {
	const byId = new Map(videos.filter((v) => v?.id && v.publishedAt).map((v) => [v.id, v]));
	return [...byId.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// UTC, like src/lib/format.js: these pages are prerendered, so the static HTML and the hydrated
// client have to agree on which year a video belongs to regardless of the visitor's timezone.
export function groupByYear(videos) {
	const years = new Map();
	for (const video of videos) {
		const year = new Date(video.publishedAt).getUTCFullYear();
		if (!years.has(year)) years.set(year, []);
		years.get(year).push(video);
	}
	return [...years.entries()].sort((a, b) => b[0] - a[0]).map(([year, items]) => ({ year, videos: items }));
}
