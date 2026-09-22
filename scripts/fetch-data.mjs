#!/usr/bin/env node
/**
 * Build-time data fetcher. Writes src/data/generated/{steam,youtube,github,discord}.json.
 *
 *   node scripts/fetch-data.mjs            fetch every source
 *   node scripts/fetch-data.mjs youtube    fetch only the named source(s)
 *   node scripts/fetch-data.mjs --ensure   no network: create empty defaults for missing/invalid files
 *
 * Steam's hero screenshots are also mirrored into public/images/hero as AVIF, so the home page's
 * LCP image comes off our own origin in a third of the bytes instead of Steam's CDN.
 *   node scripts/fetch-data.mjs --strict   exit non-zero if any source fails (debugging)
 *
 * Each source falls back to: fresh data → the existing file (if valid and not too old) → empty
 * defaults. The script always exits 0 (unless --strict), so a third-party outage never blocks a deploy.
 *
 * Env: YOUTUBE_API_KEY (required for videos), GITHUB_TOKEN (optional, avoids rate limits).
 * For local runs you can put them in .env.local (gitignored). Keys are never logged or written out.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { SITE } from "../src/data/site.js";
import { GAMES } from "../src/data/games.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "src/data/generated");
// Hero screenshots, re-encoded from Steam's JPEGs (see mirrorHeroShots). Generated, gitignored,
// and cached by the daily workflow alongside OUT_DIR.
const HERO_DIR = path.join(ROOT, "public/images/hero");
const HERO_URL = "/images/hero";
// What HeroBanner.vue asks for either side of HERO_MOBILE_QUERY. 960 covers a phone at 2x and is
// still smaller than the 600px JPEG Steam serves, because AVIF.
const HERO_SIZES = { thumb: 960, full: 1920 };
const SCHEMA_VERSION = 3;
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
	steam: { maxAge: 90 * DAY, empty: () => ({ appIds: [], apps: {} }), fetch: fetchSteam },
	youtube: {
		// YouTube API policy: don't keep API data longer than 30 days.
		maxAge: 30 * DAY,
		empty: () => ({ channel: null, popular: null, latest: [], videos: [] }),
		fetch: fetchYouTube,
		// The full catalogue is written to its own file. Only /videos imports it, so the home page's
		// bundle keeps carrying just `channel`/`popular`/`latest` however large the channel grows.
		split: { key: "videos", file: "youtube-videos" },
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
	await dropMissingHeroShots();
} else {
	const settled = await Promise.allSettled(names.map((name) => runSource(name)));
	settled.forEach((s, i) => results.push(s.status === "fulfilled" ? s.value : { name: names[i], outcome: "error", note: String(s.reason) }));
	printSummary(results);
	await writeStepSummary(results);
	if (STRICT && results.some((r) => r.outcome !== "live")) process.exit(1);
}

// The mirrored images live outside OUT_DIR, so they can go missing while steam.json still points at
// them (a cleared workflow cache, a cleaned checkout). Point those screenshots back at Steam rather
// than shipping a hero that 404s.
async function dropMissingHeroShots() {
	const steam = await readFileJson("steam");
	const shots = Object.values(steam?.apps ?? {}).flatMap((app) => app.screenshots ?? []);
	let dropped = 0;
	for (const shot of shots) {
		if (!shot.localFull) continue;
		const files = [shot.localFull, shot.localThumb].map((url) => path.join(ROOT, "public", url ?? ""));
		if ((await Promise.all(files.map(exists))).every(Boolean)) continue;
		delete shot.localFull;
		delete shot.localThumb;
		dropped++;
	}
	if (!dropped) return;
	await writeJson("steam", { appIds: steam.appIds, apps: steam.apps }, steam.fetchedAt);
	console.log(`fetch-data --ensure: ${dropped} hero image(s) missing — those slides fall back to Steam's CDN`);
}

// ---------------------------------------------------------------------------
// Source runner with fallback chain
// ---------------------------------------------------------------------------

async function runSource(name) {
	const source = SOURCES[name];
	const existing = await readExisting(name);
	try {
		const data = await source.fetch(existing?.data);
		const notes = [];
		if (data.source === "rss") notes.push("RSS fallback — add YOUTUBE_API_KEY for the full catalogue");
		if (data.videos) notes.push(`${data.videos.length} videos`);
		const bytes = await write(name, data, new Date().toISOString());
		notes.push(`${Math.round(bytes / 1024)} KB`);
		return { name, outcome: "live", note: notes.join(", ") };
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
	const { split } = SOURCES[name];
	// A half-written pair counts as absent, so the two files can never drift apart.
	if (split && !(await readFileJson(split.file))) return null;
	const json = await readFileJson(name);
	if (!json || json.schemaVersion !== SCHEMA_VERSION || !json.fetchedAt) return null;
	return { data: json, age: Date.now() - Date.parse(json.fetchedAt) };
}

async function readFileJson(file) {
	try {
		return JSON.parse(await readFile(path.join(OUT_DIR, `${file}.json`), "utf8"));
	} catch {
		return null;
	}
}

async function write(name, data, fetchedAt) {
	const { split } = SOURCES[name];
	let bytes = 0;
	if (split) {
		const { [split.key]: extracted, ...rest } = data;
		bytes += await writeJson(split.file, { [split.key]: extracted ?? [] }, fetchedAt);
		data = rest;
	}
	return bytes + (await writeJson(name, data, fetchedAt));
}

async function writeJson(file, data, fetchedAt) {
	const target = path.join(OUT_DIR, `${file}.json`);
	const tmp = `${target}.${process.pid}.tmp`;
	const json = JSON.stringify({ schemaVersion: SCHEMA_VERSION, fetchedAt, ...data }, null, 2) + "\n";
	await writeFile(tmp, json);
	await rename(tmp, target);
	return Buffer.byteLength(json);
}

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

// Our app IDs, straight from the public store search — no API key, no login. Only apps with a
// public store page show up here; unannounced ones stay hand-listed in src/data/games.js.
async function discoverAppIds() {
	const filters = [
		["publisher", SITE.steam?.publisher],
		["developer", SITE.steam?.developer],
	].filter(([, name]) => name);
	if (!filters.length) throw new SkipError("no SITE.steam publisher/developer configured");

	const ids = new Set();
	let requests = 0;
	for (const [filter, name] of filters) {
		for (let start = 0; start < 200; start += 50) {
			if (requests++ > 0) await sleep(300);
			const url =
				`https://store.steampowered.com/search/results/?term=&${filter}=${encodeURIComponent(name)}` +
				`&infinite=1&start=${start}&count=50&cc=us&l=english`;
			const page = await fetchJson(url);
			// Bundles and packages carry a comma-separated list of app IDs — skip those.
			for (const [, id] of String(page.results_html ?? "").matchAll(/data-ds-appid="(\d+)"/g)) ids.add(Number(id));
			if (start + 50 >= Number(page.total_count ?? 0)) break;
		}
	}
	return [...ids];
}

async function fetchSteam(previous) {
	const manual = GAMES.map((g) => g.appId);
	let discovered = [];
	try {
		discovered = await discoverAppIds();
	} catch (error) {
		// Discovery is a bonus: never let it shrink the games list.
		discovered = previous?.appIds ?? [];
		warn("steam", `app discovery failed (${error.message}) — falling back to ${discovered.length} known app IDs`);
	}

	// Hand-authored order first, then anything newly discovered, newest app ID first.
	const extra = discovered.filter((id) => !manual.includes(id)).sort((a, b) => b - a);
	const appIds = [...new Set([...manual, ...extra])];

	const apps = {};
	let failures = 0;
	for (const [index, appId] of appIds.entries()) {
		if (index > 0) await sleep(300);
		try {
			const json = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=english`);
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
				type: d.type ?? "game",
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
				// All of them: the hero shuffles across every screenshot of every game, and only two
				// are ever put in the DOM (see HeroBanner.vue), so a long list costs nothing.
				screenshots: (d.screenshots ?? []).map((s) => ({ thumb: s.path_thumbnail, full: s.path_full })),
			};
		} catch (error) {
			failures++;
			if (previous?.apps?.[appId]) apps[appId] = previous.apps[appId];
			warn("steam", `app ${appId}: ${error.message}`);
		}
	}
	if (failures === appIds.length) throw new Error("every Steam request failed");

	// A discovered DLC or demo has its own store page but isn't a game of ours — drop it.
	// Anything hand-listed in games.js is kept whatever Steam calls it.
	const kept = appIds.filter((id) => manual.includes(id) || !apps[id]?.type || apps[id].type === "game");
	for (const id of appIds) if (!kept.includes(id)) delete apps[id];

	await mirrorHeroShots(apps);
	return { appIds: kept, apps };
}

// Pull every hero screenshot down and re-encode it as AVIF at both the sizes the hero asks for.
// The home page's LCP is one of these, and serving it ourselves drops a cross-origin DNS + TLS
// handshake off the critical path on top of the bytes saved (206 KB JPEG → ~69 KB AVIF).
//
// Each file is named after the content hash already in Steam's URL, so the daily rebuild re-uses
// whatever the workflow cache restored and only pays for screenshots that are actually new. Any
// failure here is survivable: the Steam URLs stay in the data and the hero falls back to the CDN.
async function mirrorHeroShots(apps) {
	const shots = Object.values(apps).flatMap((app) => app.screenshots ?? []);
	if (!shots.length) return;

	let sharp;
	try {
		({ default: sharp } = await import("sharp"));
	} catch {
		warn("steam", "sharp is not installed — hero screenshots will load from Steam's CDN");
		return;
	}
	await mkdir(HERO_DIR, { recursive: true });

	const keep = new Set();
	let encoded = 0;
	let reused = 0;
	let failed = 0;
	for (const shot of shots) {
		if (!shot.full) continue;
		const id = shotId(shot.full);
		const files = Object.fromEntries(Object.entries(HERO_SIZES).map(([key, w]) => [key, `${id}-${w}.avif`]));
		Object.values(files).forEach((file) => keep.add(file));

		const present = await Promise.all(Object.values(files).map((file) => exists(path.join(HERO_DIR, file))));
		const missing = Object.entries(files).filter((_, i) => !present[i]);
		try {
			if (missing.length) {
				const source = Buffer.from(await (await request(shot.full)).arrayBuffer());
				for (const [key, file] of missing) {
					// Write via a temp name so an interrupted run can't leave a truncated image behind that
					// the next build would happily re-use.
					const target = path.join(HERO_DIR, file);
					const tmp = `${target}.${process.pid}.tmp`;
					await sharp(source)
						.resize({ width: HERO_SIZES[key], withoutEnlargement: true })
						.avif({ quality: 50, effort: 4 })
						.toFile(tmp);
					await rename(tmp, target);
					encoded++;
				}
			}
			reused += Object.keys(files).length - missing.length;
			shot.localThumb = `${HERO_URL}/${files.thumb}`;
			shot.localFull = `${HERO_URL}/${files.full}`;
		} catch (error) {
			failed++;
			warn("steam", `hero screenshot ${id}: ${error.message} — falling back to Steam's CDN for it`);
		}
	}

	// Screenshots come and go as store pages change; drop the images nothing points at any more.
	let pruned = 0;
	for (const file of await readdir(HERO_DIR).catch(() => [])) {
		if (!/^[0-9a-f]{16}-\d+\.avif$/.test(file) || keep.has(file)) continue;
		await rm(path.join(HERO_DIR, file), { force: true });
		pruned++;
	}
	console.log(
		`[steam] hero images: ${encoded} encoded, ${reused} cached, ${pruned} pruned` + (failed ? `, ${failed} failed` : ""),
	);
}

// Steam already puts a content hash in the path (…/<sha1>/ss_<sha1>.1920x1080.jpg?t=…); reuse it so
// the filename only changes when the screenshot itself does, not when the ?t= cache buster moves.
function shotId(url) {
	return createHash("sha1").update(new URL(url).pathname).digest("hex").slice(0, 16);
}

async function exists(file) {
	return (await stat(file).catch(() => null)) !== null;
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

	// The whole catalogue is kept, so the per-video shape stays small: no thumbnail URLs (src/lib/videos.js
	// derives them from the id) — just the largest size YouTube actually has for this upload.
	const videos = items
		.filter((v) => v.status?.privacyStatus === "public" && v.snippet?.liveBroadcastContent === "none")
		.map((v) => ({
			id: v.id,
			title: v.snippet.title,
			publishedAt: v.snippet.publishedAt,
			viewCount: Number(v.statistics?.viewCount ?? 0),
			durationSeconds: parseIsoDuration(v.contentDetails?.duration),
			thumbWidth: Math.max(320, ...Object.values(v.snippet.thumbnails ?? {}).map((t) => t.width ?? 0)),
		}))
		.filter((v) => longFormOnly || v.durationSeconds > 180)
		.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

	if (videos.length === 0 && Number(channel.statistics?.videoCount) > 0) throw new Error("0 usable videos returned");

	const popular = [...videos].sort((a, b) => b.viewCount - a.viewCount)[0] ?? null;
	const latest = videos.filter((v) => v.id !== popular?.id).slice(0, 6);

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
		videos,
	};
}

// Keyless fallback: the public feed has the 15 newest uploads (incl. view counts, no durations).
// "Popular" is the pinned SITE.youtube.popularFallbackId (title via oEmbed), else the most-viewed of those 15.
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
			thumbWidth: 320,
		}));
	if (videos.length === 0) throw new Error("RSS feed had no videos");

	let popular = null;
	const pinnedId = SITE.youtube.popularFallbackId;
	if (pinnedId) {
		popular = videos.find((v) => v.id === pinnedId) ?? null;
		if (!popular) {
			try {
				const watchUrl = `https://www.youtube.com/watch?v=${pinnedId}`;
				const embed = await fetchJson(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
				popular = { id: pinnedId, title: embed.title, publishedAt: null, viewCount: null, durationSeconds: 0, thumbWidth: 320 };
			} catch (error) {
				warn("youtube", `pinned video ${pinnedId}: ${error.message} — using the most viewed recent upload`);
			}
		}
	}
	popular ??= [...videos].sort((a, b) => b.viewCount - a.viewCount)[0];
	const latest = videos.filter((v) => v.id !== popular.id).slice(0, 6);

	// The feed doesn't say which thumbnail sizes exist (older uploads often lack sd/maxres, and
	// YouTube serves a grey placeholder for them) — so probe the larger ones. mqdefault/hqdefault
	// always exist, so 320 is a safe floor.
	const exists = async (url) => (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) }).catch(() => null))?.ok ?? false;
	await Promise.all(
		[popular, ...videos].map(async (video) => {
			const base = `https://i.ytimg.com/vi/${video.id}`;
			const [sd, maxres] = await Promise.all([exists(`${base}/sddefault.jpg`), exists(`${base}/maxresdefault.jpg`)]);
			video.thumbWidth = maxres ? 1280 : sd ? 640 : 480;
		}),
	);
	return {
		source: "rss",
		channel: { id: SITE.youtube.channelId, title: decodeEntities(pick(xml, /<title>([^<]*)<\/title>/)), subscriberCount: null, videoCount: null },
		popular,
		latest,
		videos,
	};
}

const PLAYLIST_PAGES = 20; // 50 items per page — 1000 videos before we start truncating.

async function listPlaylist(api, playlistId) {
	const ids = [];
	let pageToken;
	for (let page = 0; page < PLAYLIST_PAGES; page++) {
		const res = await api("playlistItems", {
			part: "contentDetails",
			playlistId,
			maxResults: "50",
			...(pageToken ? { pageToken } : {}),
		});
		ids.push(...(res.items ?? []).map((item) => item.contentDetails.videoId));
		pageToken = res.nextPageToken;
		if (!pageToken) return ids;
	}
	warn("youtube", `playlist ${playlistId} has more than ${ids.length} videos — raise PLAYLIST_PAGES`);
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
