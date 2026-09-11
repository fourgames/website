#!/usr/bin/env node
/**
 * Build-time data fetcher. Writes src/data/generated/{steam,youtube,github,discord}.json.
 *
 *   node scripts/fetch-data.mjs            fetch every source
 *   node scripts/fetch-data.mjs youtube    fetch only the named source(s)
 *   node scripts/fetch-data.mjs --ensure   no network: create empty defaults for missing/invalid files
 *   node scripts/fetch-data.mjs --strict   exit non-zero if any source fails (debugging)
 *
 * Each source falls back to: fresh data → the existing file (if valid and not too old) → empty
 * defaults. The script always exits 0 (unless --strict), so a third-party outage never blocks a deploy.
 *
 * Env: YOUTUBE_API_KEY (required for videos), GITHUB_TOKEN (optional, avoids rate limits).
 * For local runs you can put them in .env.local (gitignored). Keys are never logged or written out.
 */
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { SITE } from "../src/data/site.js";
import { GAMES } from "../src/data/games.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "src/data/generated");
const SCHEMA_VERSION = 1;
const DAY = 86_400_000;
const IN_ACTIONS = process.env.GITHUB_ACTIONS === "true";

try {
	process.loadEnvFile(path.join(ROOT, ".env.local"));
} catch {
	// No .env.local — fine.
}

const args = process.argv.slice(2);
const ENSURE = args.includes("--ensure");
const STRICT = args.includes("--strict");
const selected = args.filter((a) => !a.startsWith("--"));

class SkipError extends Error {}
class HttpError extends Error {
	constructor(status, url) {
		super(`HTTP ${status} from ${new URL(url).host}`);
		this.status = status;
	}
}

const SOURCES = {
	steam: { maxAge: 90 * DAY, empty: () => ({ apps: {} }), fetch: fetchSteam },
	youtube: {
		// YouTube API policy: don't keep API data longer than 30 days.
		maxAge: 30 * DAY,
		empty: () => ({ channel: null, popular: null, latest: [] }),
		fetch: fetchYouTube,
	},
	github: { maxAge: 90 * DAY, empty: () => ({ repos: [] }), fetch: fetchGitHub },
	discord: {
		maxAge: 7 * DAY,
		empty: () => ({ name: null, presenceCount: null, members: [] }),
		fetch: fetchDiscord,
	},
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await mkdir(OUT_DIR, { recursive: true });

const names = selected.length ? selected : Object.keys(SOURCES);
for (const name of names) {
	if (!SOURCES[name]) {
		console.error(`Unknown source "${name}". Known: ${Object.keys(SOURCES).join(", ")}`);
		process.exit(1);
	}
}

const results = [];
if (ENSURE) {
	for (const name of Object.keys(SOURCES)) {
		const existing = await readExisting(name);
		if (!existing || existing.age > SOURCES[name].maxAge) {
			await write(name, SOURCES[name].empty(), null);
			results.push({ name, outcome: existing ? "expired → default" : "default" });
		}
	}
	if (results.length) console.log(`fetch-data --ensure: wrote defaults for ${results.map((r) => r.name).join(", ")}`);
} else {
	const settled = await Promise.allSettled(names.map((name) => runSource(name)));
	settled.forEach((s, i) => results.push(s.status === "fulfilled" ? s.value : { name: names[i], outcome: "error", note: String(s.reason) }));
	printSummary(results);
	await writeStepSummary(results);
	if (STRICT && results.some((r) => r.outcome !== "live")) process.exit(1);
}

// ---------------------------------------------------------------------------
// Source runner with fallback chain
// ---------------------------------------------------------------------------

async function runSource(name) {
	const source = SOURCES[name];
	const existing = await readExisting(name);
	try {
		const data = await source.fetch(existing?.data);
		await write(name, data, new Date().toISOString());
		return { name, outcome: "live", note: data.source === "rss" ? "RSS fallback — add YOUTUBE_API_KEY for all-time most popular" : undefined };
	} catch (error) {
		const reason = error instanceof SkipError ? `skipped: ${error.message}` : error.message;
		if (existing && existing.age <= source.maxAge) {
			warn(name, `${reason} — keeping previous data (${formatAge(existing.age)} old)`);
			return { name, outcome: "kept", note: `${reason}; ${formatAge(existing.age)} old` };
		}
		if (!(error instanceof SkipError)) warn(name, `${reason} — using empty defaults`);
		else console.log(`[${name}] ${reason} — using empty defaults`);
		await write(name, source.empty(), null);
		return { name, outcome: "default", note: reason };
	}
}

async function readExisting(name) {
	try {
		const json = JSON.parse(await readFile(path.join(OUT_DIR, `${name}.json`), "utf8"));
		if (json.schemaVersion !== SCHEMA_VERSION || !json.fetchedAt) return null;
		return { data: json, age: Date.now() - Date.parse(json.fetchedAt) };
	} catch {
		return null;
	}
}

async function write(name, data, fetchedAt) {
	const file = path.join(OUT_DIR, `${name}.json`);
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, JSON.stringify({ schemaVersion: SCHEMA_VERSION, fetchedAt, ...data }, null, 2) + "\n");
	await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

async function fetchSteam(previous) {
	const apps = {};
	let failures = 0;
	for (const [index, { appId }] of GAMES.entries()) {
		if (index > 0) await sleep(300);
		try {
			const json = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=se&l=english`);
			const entry = json?.[appId];
			if (!entry) throw new Error("empty response");
			if (!entry.success) {
				if (previous?.apps?.[appId]?.status === "released") warn("steam", `app ${appId} was released but is now unlisted`);
				apps[appId] = { status: "unlisted" };
				continue;
			}
			const d = entry.data;
			apps[appId] = {
				status: d.release_date?.coming_soon ? "upcoming" : "released",
				name: d.name,
				shortDescription: decodeEntities(d.short_description ?? ""),
				headerImage: d.header_image ?? null,
				storeUrl: `https://store.steampowered.com/app/${appId}/`,
				isFree: Boolean(d.is_free),
				price: d.price_overview
					? {
							final: d.price_overview.final_formatted,
							initial: d.price_overview.initial_formatted,
							discountPercent: d.price_overview.discount_percent ?? 0,
						}
					: null,
				releaseDate: d.release_date?.date || null,
				platforms: Object.entries(d.platforms ?? {})
					.filter(([, supported]) => supported)
					.map(([platform]) => platform),
				genres: (d.genres ?? []).map((g) => g.description).slice(0, 3),
				screenshots: (d.screenshots ?? []).slice(0, 3).map((s) => ({ thumb: s.path_thumbnail, full: s.path_full })),
			};
		} catch (error) {
			failures++;
			if (previous?.apps?.[appId]) apps[appId] = previous.apps[appId];
			warn("steam", `app ${appId}: ${error.message}`);
		}
	}
	if (failures === GAMES.length) throw new Error("every Steam request failed");
	return { apps };
}

// ---------------------------------------------------------------------------
// YouTube Data API v3 — ~1 + 2·⌈videos/50⌉ quota units per run
// ---------------------------------------------------------------------------

async function fetchYouTube() {
	const key = process.env.YOUTUBE_API_KEY;
	if (!key) {
		console.log("[youtube] YOUTUBE_API_KEY is not set — using the public RSS feed (latest 15 uploads only)");
		return fetchYouTubeRss();
	}
	try {
		return await fetchYouTubeApi(key);
	} catch (error) {
		warn("youtube", `Data API failed (${error.message}) — falling back to the RSS feed`);
		return fetchYouTubeRss();
	}
}

async function fetchYouTubeApi(key) {
	const api = (endpoint, params) =>
		fetchJson(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ ...params, key })}`);

	const channelQuery = SITE.youtube.channelId ? { id: SITE.youtube.channelId } : { forHandle: SITE.youtube.handle };
	const channels = await api("channels", { part: "snippet,contentDetails,statistics", ...channelQuery });
	const channel = channels.items?.[0];
	if (!channel) throw new Error("channel not found");

	// "UULF…" is the long-form-only uploads playlist (no Shorts). Undocumented, so fall back to "UU…".
	let longFormOnly = true;
	let ids = [];
	try {
		ids = await listPlaylist(api, `UULF${channel.id.slice(2)}`);
	} catch (error) {
		if (error.status !== 404) throw error;
	}
	if (ids.length === 0) {
		longFormOnly = false;
		ids = await listPlaylist(api, channel.contentDetails.relatedPlaylists.uploads);
	}

	const items = [];
	for (let i = 0; i < ids.length; i += 50) {
		const res = await api("videos", {
			part: "snippet,contentDetails,statistics,status",
			id: ids.slice(i, i + 50).join(","),
		});
		items.push(...(res.items ?? []));
	}

	const videos = items
		.filter((v) => v.status?.privacyStatus === "public" && v.snippet?.liveBroadcastContent === "none")
		.map((v) => ({
			id: v.id,
			title: v.snippet.title,
			publishedAt: v.snippet.publishedAt,
			viewCount: Number(v.statistics?.viewCount ?? 0),
			durationSeconds: parseIsoDuration(v.contentDetails?.duration),
			embeddable: v.status?.embeddable !== false,
			thumbs: Object.values(v.snippet.thumbnails ?? {})
				.filter((t) => t.width >= 320)
				.map((t) => ({ url: t.url, width: t.width, height: t.height }))
				.sort((a, b) => a.width - b.width),
		}))
		.filter((v) => longFormOnly || v.durationSeconds > 180);

	if (videos.length === 0 && Number(channel.statistics?.videoCount) > 0) throw new Error("0 usable videos returned");

	const popular = [...videos].sort((a, b) => b.viewCount - a.viewCount)[0] ?? null;
	const latest = videos
		.filter((v) => v.id !== popular?.id)
		.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
		.slice(0, 6);

	return {
		source: "api",
		channel: {
			id: channel.id,
			title: channel.snippet.title,
			subscriberCount: channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount ?? 0),
			videoCount: Number(channel.statistics?.videoCount ?? 0),
		},
		popular,
		latest,
	};
}

// Keyless fallback: the public feed has the 15 newest uploads (incl. view counts, no durations).
// "Popular" is then the most-viewed of those 15.
async function fetchYouTubeRss() {
	if (!SITE.youtube.channelId) throw new SkipError("no YOUTUBE_API_KEY and no SITE.youtube.channelId");
	const res = await request(`https://www.youtube.com/feeds/videos.xml?channel_id=${SITE.youtube.channelId}`);
	const xml = await res.text();
	const pick = (block, pattern) => pattern.exec(block)?.[1] ?? "";

	const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
		.map(([, entry]) => ({ entry, id: pick(entry, /<yt:videoId>([^<]+)<\/yt:videoId>/) }))
		// Shorts link to /shorts/ in the feed.
		.filter(({ entry, id }) => id && !/href="[^"]*\/shorts\//.test(entry))
		.map(({ entry, id }) => ({
			id,
			title: decodeEntities(pick(entry, /<title>([^<]*)<\/title>/)),
			publishedAt: new Date(pick(entry, /<published>([^<]+)<\/published>/)).toISOString(),
			viewCount: Number(pick(entry, /<media:statistics views="(\d+)"/) || 0),
			durationSeconds: 0,
			embeddable: true,
			thumbs: [],
		}));
	if (videos.length === 0) throw new Error("RSS feed had no videos");

	const popular = [...videos].sort((a, b) => b.viewCount - a.viewCount)[0];
	const latest = videos.filter((v) => v.id !== popular.id).slice(0, 6);

	// The feed doesn't say which thumbnail sizes exist (older uploads often lack sd/maxres, and
	// YouTube serves a grey placeholder for them) — so probe the larger ones.
	const exists = async (url) => (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).catch(() => null))?.ok ?? false;
	await Promise.all(
		[popular, ...latest].map(async (video) => {
			const base = `https://i.ytimg.com/vi/${video.id}`;
			const [sd, maxres] = await Promise.all([exists(`${base}/sddefault.jpg`), exists(`${base}/maxresdefault.jpg`)]);
			video.thumbs = [
				{ url: `${base}/mqdefault.jpg`, width: 320, height: 180 },
				{ url: `${base}/hqdefault.jpg`, width: 480, height: 360 },
				...(sd ? [{ url: `${base}/sddefault.jpg`, width: 640, height: 480 }] : []),
				...(maxres ? [{ url: `${base}/maxresdefault.jpg`, width: 1280, height: 720 }] : []),
			];
		}),
	);
	return {
		source: "rss",
		channel: { id: SITE.youtube.channelId, title: decodeEntities(pick(xml, /<title>([^<]*)<\/title>/)), subscriberCount: null, videoCount: null },
		popular,
		latest,
	};
}

async function listPlaylist(api, playlistId) {
	const ids = [];
	let pageToken;
	for (let page = 0; page < 20; page++) {
		const res = await api("playlistItems", {
			part: "contentDetails",
			playlistId,
			maxResults: "50",
			...(pageToken ? { pageToken } : {}),
		});
		ids.push(...(res.items ?? []).map((item) => item.contentDetails.videoId));
		pageToken = res.nextPageToken;
		if (!pageToken) break;
	}
	return ids;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

async function fetchGitHub() {
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "fourgames-website",
	};
	if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

	const all = [];
	let url = `https://api.github.com/orgs/${SITE.github.org}/repos?type=public&per_page=100`;
	for (let page = 0; url && page < 10; page++) {
		const res = await request(url, { headers });
		all.push(...(await res.json()));
		url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
	}

	const repos = all
		.filter((r) => !r.fork && !r.archived && !r.private && !r.name.startsWith(".") && !SITE.github.exclude.includes(r.name))
		.sort((a, b) => b.stargazers_count - a.stargazers_count || b.pushed_at.localeCompare(a.pushed_at))
		.map((r) => ({
			name: r.name,
			description: r.description,
			url: r.html_url,
			homepage: r.homepage || null,
			topics: r.topics ?? [],
			language: r.language,
			stars: r.stargazers_count,
			forks: r.forks_count,
			pushedAt: r.pushed_at,
		}));
	if (repos.length === 0) throw new Error("0 repos returned");
	return { repos };
}

// ---------------------------------------------------------------------------
// Discord widget (public)
// ---------------------------------------------------------------------------

async function fetchDiscord() {
	const widget = await fetchJson(`https://discord.com/api/guilds/${SITE.discord.guildId}/widget.json`);
	return {
		name: widget.name,
		presenceCount: widget.presence_count ?? 0,
		// Usernames/activities are intentionally dropped.
		members: (widget.members ?? [])
			.filter((m) => m.avatar_url)
			.slice(0, 12)
			.map((m) => ({ avatarUrl: m.avatar_url })),
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(url, { headers = {}, retries = 2, timeout = 10_000 } = {}) {
	for (let attempt = 0; ; attempt++) {
		let res;
		try {
			res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
		} catch (error) {
			if (attempt >= retries) throw new Error(`network error (${new URL(url).host}): ${error.cause?.code ?? error.name}`);
			await sleep(1000 * 3 ** attempt);
			continue;
		}
		if (res.ok) return res;
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt >= retries) throw new HttpError(res.status, url);
		const retryAfter = Number(res.headers.get("retry-after"));
		await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 3 ** attempt);
	}
}

async function fetchJson(url, options) {
	return (await request(url, options)).json();
}

function parseIsoDuration(value = "") {
	const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(value);
	if (!m) return 0;
	const [, d = 0, h = 0, min = 0, s = 0] = m.map((n) => Number(n ?? 0));
	return d * 86400 + h * 3600 + min * 60 + s;
}

function decodeEntities(text) {
	const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
	return text
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match)
		.trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAge(ms) {
	const hours = Math.round(ms / 3_600_000);
	return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function warn(name, message) {
	if (IN_ACTIONS) console.log(`::warning title=fetch-data (${name})::${message}`);
	else console.warn(`[${name}] ${message}`);
}

function printSummary(rows) {
	for (const row of rows) console.log(`fetch-data: ${row.name.padEnd(8)} ${row.outcome}${row.note ? ` (${row.note})` : ""}`);
}

async function writeStepSummary(rows) {
	if (!process.env.GITHUB_STEP_SUMMARY) return;
	const icon = { live: "🟢 live", kept: "🟡 kept previous", default: "⚪ default", error: "🔴 error" };
	const lines = ["### Build-time data", "", "| Source | Result | Note |", "|---|---|---|"];
	for (const row of rows) lines.push(`| ${row.name} | ${icon[row.outcome] ?? row.outcome} | ${row.note ?? ""} |`);
	await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}
