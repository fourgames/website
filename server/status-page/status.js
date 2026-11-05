// Checks each part of Four Games from the visitor's browser, every minute, and shows the server's
// 90-day history of each under it.
// Served as plain static files by Caddy at https://status.fourgames.se (see server/Caddyfile).
"use strict";

const API = "https://api.fourgames.se";
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 8_000;
// The feedback loop writes /status/<part>.json after each run (feedback/loop.sh, write_status).
// Running when the last good run is this recent, Delayed up to the second limit, Down after it.
// Research runs can take up to an hour (FEEDBACK_RUN_LIMIT), so it gets more room.
const LIMITS = { own: [15 * 60, 60 * 60], research: [75 * 60, 2 * 60 * 60] };

const LABELS = { running: "Running", delayed: "Delayed", down: "Down", unknown: "Unknown" };

// The 90-day history under each row: server/uptime/check.py checks every part from the server once a
// minute and writes this file. Read at load and every 5 minutes; without it the rows have no bars.
const HISTORY_URL = `${API}/status/history.json`;
const HISTORY_REFRESH_MS = 5 * 60_000;
// Phones get the last 30 days, so each bar stays wide enough to see.
const NARROW = window.matchMedia("(max-width: 559.98px)");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let lastChecked = 0;
let uptimeHistory = null;
let historyLoaded = 0;

function fetchWithTimeout(url, options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	return fetch(url, { cache: "no-store", ...options, signal: controller.signal }).finally(() =>
		clearTimeout(timer),
	);
}

function ago(seconds) {
	const s = Math.max(0, Math.round(seconds));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return m === 1 ? "1 min ago" : `${m} min ago`;
	const h = Math.round(s / 3600);
	if (h < 48) return h === 1 ? "1 hour ago" : `${h} hours ago`;
	const d = Math.round(s / 86400);
	return `${d} days ago`;
}

const now = () => Date.now() / 1000;

async function checkWebsite() {
	// GitHub Pages sends no CORS headers, so this can only tell whether the site answered at all.
	try {
		await fetchWithTimeout("https://fourgames.se/", { mode: "no-cors" });
		return { state: "running", detail: `Answered ${ago(0)}` };
	} catch {
		return { state: "unknown", detail: "Couldn't reach it from here. It may be your connection." };
	}
}

async function checkFeedback(part) {
	let data;
	try {
		const response = await fetchWithTimeout(`${API}/status/${part}.json`);
		if (!response.ok) {
			return { state: "unknown", detail: "No report from it yet." };
		}
		data = await response.json();
	} catch {
		return { state: "unknown", detail: "Couldn't read its report right now." };
	}
	const at = Number(data.lastRunAt);
	if (!Number.isFinite(at) || at <= 0) {
		return { state: "unknown", detail: "Its report has no time in it." };
	}
	const age = now() - at;
	const [FRESH_SECONDS, LATE_SECONDS] = LIMITS[part] ?? LIMITS.own;
	const ok = data.lastRunOk === true;
	const when = `Last run ${ago(age)}`;
	if (ok && age <= FRESH_SECONDS) return { state: "running", detail: when };
	if (age <= LATE_SECONDS) {
		return { state: "delayed", detail: ok ? `${when}, later than usual` : `${when}, which didn't finish; it tries again` };
	}
	return { state: "down", detail: `${when}, and none since` };
}

// A service's /health answer: Caddy answers 502 when the service itself isn't running.
async function checkHealth(path, judge = () => null) {
	try {
		const response = await fetchWithTimeout(`${API}${path}`);
		if (!response.ok) return { state: "down", detail: "It isn't answering right now." };
		const data = await response.json();
		if (!data || data.ok !== true) return { state: "down", detail: "It answered, but not as expected." };
		return judge(data) ?? { state: "running", detail: `Answered ${ago(0)}` };
	} catch {
		return { state: "unknown", detail: "Couldn't reach it right now." };
	}
}

// The alerts service also says whether YouTube and Twitch are still sending to it.
function judgeAlerts(data) {
	const youtube = data.youtube?.subscribed === true;
	const twitch = data.twitch?.subscription === "enabled";
	if (youtube && twitch) return null;
	const missing = [!youtube && "YouTube", !twitch && "Twitch"].filter(Boolean).join(" and ");
	return { state: "delayed", detail: `${missing} not connected right now; posts still go out within 5 minutes` };
}

// The game-data service also reports when its disk is getting full.
function judgeGamedata(data) {
	if (data.disk?.low_space) return { state: "delayed", detail: "Running, but its disk is nearly full" };
	return null;
}

// Steam broadcasts (server/broadcast/status.sh writes this every minute). The row stays hidden
// until a stream is set up; HIDDEN tells refresh() to leave it out.
const HIDDEN = "hidden";
async function checkBroadcast() {
	let data;
	try {
		const response = await fetchWithTimeout(`${API}/status/broadcast.json`);
		if (!response.ok) return HIDDEN;
		data = await response.json();
	} catch {
		return { state: "unknown", detail: "Couldn't read its report right now." };
	}
	const streams = Array.isArray(data.streams) ? data.streams : [];
	if (streams.length === 0) return HIDDEN;
	if (now() - Number(data.checkedAt) > 10 * 60) {
		return { state: "unknown", detail: `Last checked ${ago(now() - Number(data.checkedAt))}` };
	}
	const down = streams.filter((s) => !s.sending).map((s) => s.name);
	const n = streams.length;
	if (down.length === 0) return { state: "running", detail: n === 1 ? "Sending to Steam" : `All ${n} sending to Steam` };
	if (down.length === n) return { state: "down", detail: "Not sending right now; it keeps trying" };
	return { state: "delayed", detail: `${down.join(", ")} not sending right now; it keeps trying` };
}

function checkLinks() {
	// The short links run on the same server and Caddy as this page, so this page loading means
	// that server is up. Each link isn't opened one by one.
	return { state: "running", detail: "Same server as this page, which loaded" };
}

const CHECKS = {
	website: checkWebsite,
	own: () => checkFeedback("own"),
	research: () => checkFeedback("research"),
	keybot: () => checkHealth("/keybot/health"),
	contact: () => checkHealth("/contact/health"),
	alerts: () => checkHealth("/alerts/health", judgeAlerts),
	gamedata: () => checkHealth("/gamedata/health", judgeGamedata),
	broadcast: checkBroadcast,
	links: checkLinks,
};

function show(row, result) {
	const pill = row.querySelector(".pill");
	pill.dataset.state = result.state;
	pill.textContent = LABELS[result.state];
	row.querySelector(".detail").textContent = result.detail;
}

function showSummary(results) {
	const summary = document.getElementById("summary");
	const states = results.map((r) => r.state);
	const text = states.every((s) => s === "running") ? "All systems running" : "Some systems have problems";
	if (summary.textContent !== text) summary.textContent = text; // aria-live: only speak changes
}

function showUpdated() {
	const updated = document.getElementById("updated");
	updated.textContent = lastChecked ? `Updated ${ago(now() - lastChecked)}` : "Checking…";
}

// --- The history bars ---

// Minutes not down out of minutes checked (degraded counts as up), rounded down like check.py does,
// so any time down never shows as 100%. Null without any checks.
function uptimeOf(daily) {
	let checked = 0;
	let down = 0;
	for (const day of daily) {
		if (!day) continue;
		checked += day[0] + day[1] + day[2];
		down += day[2];
	}
	return checked ? Math.floor(((checked - down) * 10_000) / checked) / 100 : null;
}

function formatUptime(percent) {
	if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
	return percent >= 100 ? "100%" : `${percent.toFixed(2)}%`;
}

function duration(minutes) {
	if (minutes < 60) return `${minutes} min`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return m ? `${h} h ${m} min` : `${h} h`;
}

const total = (counts) => (counts ? counts[0] + counts[1] + counts[2] : 0);

// Green: no time down and under 15 minutes degraded. Orange: under an hour down, or 15 minutes or
// more degraded. Red: an hour or more down. Grey: no data.
function level(counts) {
	if (!total(counts)) return "none";
	const [, degraded, down] = counts;
	if (down >= 60) return "down";
	if (down > 0 || degraded >= 15) return "warn";
	return "ok";
}

// "5 Nov 2026: 99.3% up · 10 min down · 4 min degraded"
function dayTitle(day, counts) {
	const [y, m, d] = day.split("-").map(Number);
	const date = `${d} ${MONTHS[m - 1]} ${y}`;
	const minutes = total(counts);
	if (!minutes) return `${date}: No data`;
	const [, degraded, down] = counts;
	const up = Math.floor(((minutes - down) * 1000) / minutes) / 10;
	const parts = [`${up >= 100 ? "100" : up.toFixed(1)}% up`];
	if (down) parts.push(`${duration(down)} down`);
	if (degraded) parts.push(`${duration(degraded)} degraded`);
	return `${date}: ${parts.join(" · ")}`;
}

function historyStrip(allDays, part, span) {
	const days = allDays.slice(-span);
	const daily = part.daily.slice(-span);
	const uptime = formatUptime(span >= allDays.length ? part.uptime : uptimeOf(daily));

	const strip = document.createElement("div");
	strip.className = "history";
	const bars = document.createElement("div");
	bars.className = "bars";
	bars.setAttribute("role", "img");
	bars.setAttribute("aria-label", `Uptime for the last ${span} days: ${uptime ?? "No data yet"}`);
	days.forEach((day, i) => {
		const bar = document.createElement("span");
		bar.className = "bar";
		bar.dataset.level = level(daily[i]);
		bar.title = dayTitle(day, daily[i]);
		bars.append(bar);
	});
	const legend = document.createElement("p");
	legend.className = "history-legend";
	for (const text of [`${span} days ago`, uptime ? `${uptime} uptime` : "No data yet", "Today"]) {
		const item = document.createElement("span");
		item.textContent = text;
		legend.append(item);
	}
	strip.append(bars, legend);
	return strip;
}

function showHistory() {
	if (!uptimeHistory) return;
	const span = Math.min(NARROW.matches ? 30 : 90, uptimeHistory.days.length);
	for (const row of document.querySelectorAll("[data-check]")) {
		row.querySelector(".history")?.remove();
		const part = uptimeHistory.parts[row.dataset.check];
		if (!part || !Array.isArray(part.daily) || part.daily.length !== uptimeHistory.days.length) continue;
		row.append(historyStrip(uptimeHistory.days, part, span));
	}
}

async function loadHistory() {
	historyLoaded = Date.now();
	try {
		const response = await fetchWithTimeout(HISTORY_URL);
		if (!response.ok) return;
		const data = await response.json();
		if (!data || !Array.isArray(data.days) || !data.days.length || typeof data.parts !== "object" || !data.parts) return;
		uptimeHistory = data;
		showHistory();
	} catch {
		// Left out quietly (or kept as last read); the live checks don't need it.
	}
}

async function refresh() {
	const rows = [...document.querySelectorAll("[data-check]")];
	const results = await Promise.all(
		rows.map(async (row) => {
			let result;
			try {
				result = await CHECKS[row.dataset.check]();
			} catch {
				result = { state: "unknown", detail: "Couldn't check it right now." };
			}
			row.hidden = result === HIDDEN;
			if (row.hidden) return null;
			show(row, result);
			return result;
		}),
	);
	showSummary(results.filter(Boolean));
	lastChecked = now();
	showUpdated();
}

refresh();
loadHistory();
setInterval(refresh, REFRESH_MS);
setInterval(loadHistory, HISTORY_REFRESH_MS);
setInterval(showUpdated, 15_000);
NARROW.addEventListener("change", showHistory);
document.addEventListener("visibilitychange", () => {
	if (document.hidden) return;
	if (now() - lastChecked > REFRESH_MS / 1000) refresh();
	if (Date.now() - historyLoaded > HISTORY_REFRESH_MS) loadHistory();
});
