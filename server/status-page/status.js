// Checks each part of Four Games from the visitor's browser, every minute.
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

let lastChecked = 0;

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
			show(row, result);
			return result;
		}),
	);
	showSummary(results);
	lastChecked = now();
	showUpdated();
}

refresh();
setInterval(refresh, REFRESH_MS);
setInterval(showUpdated, 15_000);
document.addEventListener("visibilitychange", () => {
	if (!document.hidden && now() - lastChecked > REFRESH_MS / 1000) refresh();
});
