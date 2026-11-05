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

// The server's own load (server/uptime/server_stats.py, every minute), with a meter per resource.
const BUSY_PCT = 90;
const fmtPct = (n) => (n == null ? "–" : `${Math.round(n)}%`);
const fmtMbit = (n) => (n == null ? "–" : `${n < 10 ? n.toFixed(1) : Math.round(n)} Mbit/s`);
const fmtGB = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} TB` : `${n} GB`);
const fmtInt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en") : "–");
const fmtPerMin = (n) => (Number.isFinite(n) ? `${fmtInt(n)}/min` : "–");

function meter(label, value, pct, note = null) {
	const item = document.createElement("div");
	item.className = "meter";
	const head = document.createElement("div");
	head.className = "meter-head";
	const name = document.createElement("span");
	name.textContent = label;
	const val = document.createElement("span");
	val.className = "meter-value";
	val.textContent = value;
	head.append(name, val);
	item.append(head);
	if (note) {
		const sub = document.createElement("div");
		sub.className = "meter-sub";
		sub.textContent = note;
		item.append(sub);
	}
	if (pct != null) {
		const track = document.createElement("div");
		track.className = "meter-track";
		const fill = document.createElement("div");
		fill.className = "meter-fill";
		fill.dataset.level = pct >= BUSY_PCT ? "down" : pct >= 70 ? "warn" : "ok";
		fill.style.width = `${Math.max(2, Math.min(100, pct))}%`;
		track.append(fill);
		track.setAttribute("role", "img");
		track.setAttribute("aria-label", `${label}: ${value}`);
		item.append(track);
	}
	return item;
}

function showMeters(data) {
	const row = document.querySelector('[data-check="server"]');
	row.querySelector(".server-stats")?.remove();
	if (!data) return;
	const box = document.createElement("div");
	box.className = "server-stats";
	const load = document.createElement("div");
	load.className = "meters";
	load.append(
		meter(`CPU used${data.cores ? ` · ${data.cores} ${data.cores === 1 ? "core" : "cores"}` : ""}`, fmtPct(data.cpuPct), data.cpuPct),
		meter(`Memory used${data.memoryTotalGB ? ` · of ${data.memoryTotalGB} GB` : ""}`, fmtPct(data.memoryPct), data.memoryPct),
		meter(`Disk used${data.diskTotalGB ? ` · of ${data.diskTotalGB} GB` : ""}`, `${fmtPct(data.diskPct)} · ${data.diskFreeGB} GB free`, data.diskPct),
	);
	const traffic = document.createElement("div");
	traffic.className = "traffic";
	const heading = document.createElement("h3");
	heading.className = "meters-heading";
	heading.textContent = "Traffic";
	const meters = document.createElement("div");
	meters.className = "meters";
	const normal = data.recent?.normal?.req;
	const synRecv = Number(data.synRecv);
	meters.append(
		meter("Uploading now", fmtMbit(data.outMbit), null),
		meter("Downloading now", fmtMbit(data.inMbit), null),
		meter("Requests now", fmtPerMin(data.requestsPerMin), null, Number.isFinite(normal) ? `normally ${fmtInt(normal)}` : null),
		meter("Connections", fmtInt(data.established), null, synRecv > 0 ? `${fmtInt(synRecv)} half-open` : null),
		meter(`Sent in ${monthName(data.month)}`, fmtGB(data.monthOutGB), null),
		meter(`Received in ${monthName(data.month)}`, fmtGB(data.monthInGB), null),
	);
	traffic.append(heading, meters);
	const spark = sparkline(data.recent);
	if (spark) traffic.append(spark);
	box.append(load, traffic);
	row.append(box);
}

// The last hour's requests a minute (server.json `recent`, oldest first), a bar a minute, with the
// normal level (the median of the last day) as a dashed line.
const SPARK_MINUTES = 60;
const SPARK_HEIGHT = 24;
const SVG_NS = "http://www.w3.org/2000/svg";

function sparkline(recent) {
	const values = Array.isArray(recent?.req) ? recent.req.slice(-SPARK_MINUTES) : [];
	const known = values.filter(Number.isFinite);
	if (!known.length) return null;
	const normal = Number.isFinite(recent.normal?.req) ? recent.normal.req : null;
	const max = Math.max(1, ...known, normal != null ? normal * 1.25 : 0);
	const offset = SPARK_MINUTES - values.length; // fewer minutes known: they end at the right, now
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "spark");
	svg.setAttribute("viewBox", `0 0 ${SPARK_MINUTES} ${SPARK_HEIGHT}`);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.setAttribute("role", "img");
	const now = values[values.length - 1];
	svg.setAttribute(
		"aria-label",
		`Requests a minute over the last hour: now ${Number.isFinite(now) ? fmtInt(now) : "unknown"}, at most ${fmtInt(Math.max(...known))}` +
			(normal != null ? `, normally ${fmtInt(normal)}` : ""),
	);
	values.forEach((v, i) => {
		if (!Number.isFinite(v)) return;
		const h = Math.max(0.6, (v / max) * SPARK_HEIGHT);
		const rect = document.createElementNS(SVG_NS, "rect");
		rect.setAttribute("class", "spark-bar");
		rect.setAttribute("x", String(offset + i + 0.15));
		rect.setAttribute("width", "0.7");
		rect.setAttribute("y", String(SPARK_HEIGHT - h));
		rect.setAttribute("height", String(h));
		svg.append(rect);
	});
	if (normal != null) {
		const y = SPARK_HEIGHT - (normal / max) * SPARK_HEIGHT;
		const line = document.createElementNS(SVG_NS, "line");
		line.setAttribute("class", "spark-normal");
		line.setAttribute("x1", "0");
		line.setAttribute("x2", String(SPARK_MINUTES));
		line.setAttribute("y1", String(y));
		line.setAttribute("y2", String(y));
		line.setAttribute("vector-effect", "non-scaling-stroke");
		svg.append(line);
	}
	const wrap = document.createElement("div");
	wrap.className = "spark-wrap";
	const legend = document.createElement("p");
	legend.className = "history-legend";
	for (const text of ["1 hour ago", normal != null ? "Requests a minute (dashed: normal)" : "Requests a minute", "Now"]) {
		const item = document.createElement("span");
		item.textContent = text;
		legend.append(item);
	}
	wrap.append(svg, legend);
	return wrap;
}

function monthName(month) {
	const [y, m] = String(month).split("-").map(Number);
	if (!y || !m) return "this month";
	return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en", { month: "long", timeZone: "UTC" });
}

async function checkServer() {
	let data;
	try {
		const response = await fetchWithTimeout(`${API}/status/server.json`);
		if (!response.ok) {
			showMeters(null);
			return { state: "unknown", detail: "No report from it yet." };
		}
		data = await response.json();
	} catch {
		showMeters(null);
		return { state: "unknown", detail: "Couldn't read its report right now." };
	}
	showMeters(data);
	const age = now() - Number(data.checkedAt);
	if (!(age <= 5 * 60)) return { state: "unknown", detail: `Last report ${ago(age)}` };
	// The traffic watch (server_stats.py, judge): an attack is Down; busy is Delayed only when the CPU is the reason.
	// Busy is most likely real visitors (a game going viral), so its reasons say it themselves.
	const watch = data.watch;
	const reasons = Array.isArray(watch?.reasons) ? watch.reasons.filter((r) => typeof r === "string").join("; ") : "";
	if (watch?.state === "attack") return { state: "down", detail: `Unusual traffic${reasons ? `: ${reasons}` : ""}` };
	// Lots of traffic that's all being answered is good news (a game doing well): green. Only a server
	// working flat out is worth the orange pill.
	if (watch?.state === "busy") {
		const strained = (watch.reasons || []).some((r) => typeof r === "string" && r.startsWith("Working hard"));
		return { state: strained ? "delayed" : "running", detail: reasons || "Busier than usual" };
	}
	const busy = [["CPU", data.cpuPct], ["Memory", data.memoryPct], ["Disk", data.diskPct]].filter(([, v]) => v >= BUSY_PCT);
	if (busy.length) return { state: "delayed", detail: `${busy.map(([n]) => n).join(" and ")} nearly full` };
	return { state: "running", detail: `Plenty of room · checked ${ago(age)}` };
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
	server: checkServer,
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

// --- One day's facts, for the bar's aria-label and its popover ---

const LEVEL_TEXT = { ok: "No problems", warn: "Some problems", down: "Down for a while", none: "No data" };
const DEFAULT_TIMEZONE = "Europe/Stockholm";

// "2026-11-05" → "Wed 5 Nov 2026" (a calendar date, so read as UTC to keep the day as it is).
function longDate(day) {
	const [y, m, d] = day.split("-").map(Number);
	const weekday = new Date(Date.UTC(y, m - 1, d)).toLocaleString("en", { weekday: "short", timeZone: "UTC" });
	return `${weekday} ${d} ${MONTHS[m - 1]} ${y}`;
}

function shortDate(day) {
	const [, m, d] = day.split("-").map(Number);
	return `${d} ${MONTHS[m - 1]}`;
}

// Minutes not down out of minutes checked, rounded down to two decimals: "99.30% up".
function dayFacts(day, counts) {
	const minutes = total(counts);
	const facts = { date: longDate(day), level: level(counts), up: null, minutes: null };
	if (!minutes) return facts;
	const [, degraded, down] = counts;
	const up = Math.floor(((minutes - down) * 10_000) / minutes) / 100;
	facts.up = `${up >= 100 ? "100" : up.toFixed(2)}% up`;
	const parts = [];
	if (down) parts.push(`${duration(down)} down`);
	if (degraded) parts.push(`${duration(degraded)} with problems`);
	facts.minutes = parts.join(" · ") || null;
	return facts;
}

// "Wed 5 Nov 2026: Some problems · 99.30% up · 10 min down · 4 min with problems"
function dayLabel(day, counts) {
	const f = dayFacts(day, counts);
	return [`${f.date}: ${LEVEL_TEXT[f.level]}`, f.up, f.minutes].filter(Boolean).join(" · ");
}

// An epoch time's local date ("2026-11-05") and time ("14:02") in the history's time zone.
const zoneFormats = new Map();
const zoneFormat = (timeZone) =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
	});
function inZone(epoch, timeZone) {
	let format = zoneFormats.get(timeZone);
	if (!format) {
		try {
			format = zoneFormat(timeZone);
		} catch {
			format = zoneFormat(DEFAULT_TIMEZONE); // an unknown zone name
		}
		zoneFormats.set(timeZone, format);
	}
	const p = Object.fromEntries(format.formatToParts(new Date(epoch * 1000)).map((x) => [x.type, x.value]));
	return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// The outages that touch this local day, newest first (as history.json has them, so one still going
// on today comes first). `end` is the first minute up again.
function outagesOn(day, outages, timeZone) {
	const list = [];
	for (const o of Array.isArray(outages) ? outages : []) {
		if (!o || !Number.isFinite(o.start)) continue;
		const first = inZone(o.start, timeZone).date;
		const last = Number.isFinite(o.end) ? inZone(Math.max(o.start, o.end - 1), timeZone).date : "9999-12-31";
		if (first <= day && day <= last) list.push(o);
	}
	return list.sort((a, b) => b.start - a.start);
}

// "Down 14:02–14:15", "Problems since 14:02"; a time on another day gets its date: "4 Nov 23:50".
function outageText(o, day, timeZone) {
	const when = (epoch) => {
		const z = inZone(epoch, timeZone);
		return z.date === day ? z.time : `${shortDate(z.date)} ${z.time}`;
	};
	const name = o.state === "down" ? "Down" : "Problems";
	return Number.isFinite(o.end) ? `${name} ${when(o.start)}–${when(o.end)}` : `${name} since ${when(o.start)}`;
}

const MAX_OUTAGES_SHOWN = 3;

function historyStrip(allDays, part, span) {
	const days = allDays.slice(-span);
	const daily = part.daily.slice(-span);
	const uptime = formatUptime(span >= allDays.length ? part.uptime : uptimeOf(daily));

	const strip = document.createElement("div");
	strip.className = "history";
	const bars = document.createElement("div");
	bars.className = "bars";
	bars.tabIndex = 0;
	bars.setAttribute("role", "group");
	bars.setAttribute("aria-label", `Uptime for the last ${span} days: ${uptime ?? "No data yet"}. Left and right arrows go through the days.`);
	days.forEach((day, i) => {
		const bar = document.createElement("span");
		bar.className = "bar";
		bar.dataset.level = level(daily[i]);
		bar.setAttribute("role", "img");
		bar.setAttribute("aria-label", dayLabel(day, daily[i]));
		bars.append(bar);
	});
	STRIPS.set(bars, { days, daily, outages: part.outages });
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
	// A popover open from the keyboard comes back on the same day once the strips are rebuilt.
	const keep = active && document.activeElement === active.bars
		? { part: active.bars.closest("[data-check]")?.dataset.check, index: active.index }
		: null;
	closePopover();
	const span = Math.min(NARROW.matches ? 30 : 90, uptimeHistory.days.length);
	for (const row of document.querySelectorAll("[data-check]")) {
		row.querySelector(".history")?.remove();
		const part = uptimeHistory.parts[row.dataset.check];
		if (!part || !Array.isArray(part.daily) || part.daily.length !== uptimeHistory.days.length) continue;
		row.append(historyStrip(uptimeHistory.days, part, span));
	}
	const bars = keep && document.querySelector(`[data-check="${keep.part}"] .bars`);
	if (bars) {
		bars.focus();
		openPopover(bars, Math.min(keep.index, bars.children.length - 1), "key");
	}
}

// --- The popover over a day's bar: on hover, on tap (tap again or elsewhere to close), and from the
// keyboard (the strip takes focus; left and right go through the days, Esc closes). One element,
// placed over the bar, kept inside the window, under the bar when there's no room above.

const STRIPS = new WeakMap(); // .bars → { days, daily, outages }
let popover = null;
let active = null; // { bars, bar, index, via: "hover" | "tap" | "key" }
let lastPointer = "mouse";

function fillPopover(data, index) {
	const day = data.days[index];
	const counts = data.daily[index];
	const facts = dayFacts(day, counts);
	const timeZone = uptimeHistory?.timezone || DEFAULT_TIMEZONE;
	const line = (className, text) => {
		const el = document.createElement("p");
		el.className = className;
		el.textContent = text;
		return el;
	};
	const items = [line("pop-date", facts.date)];
	const status = line("pop-status", LEVEL_TEXT[facts.level]);
	status.dataset.level = facts.level;
	items.push(status);
	if (facts.up) items.push(line("pop-line", facts.up));
	if (facts.minutes) items.push(line("pop-line", facts.minutes));
	const outages = total(counts) ? outagesOn(day, data.outages, timeZone) : [];
	if (outages.length) {
		const list = document.createElement("ul");
		list.className = "pop-outages";
		for (const o of outages.slice(0, MAX_OUTAGES_SHOWN)) {
			const li = document.createElement("li");
			li.textContent = outageText(o, day, timeZone);
			li.dataset.state = o.state === "down" ? "down" : "warn";
			list.append(li);
		}
		if (outages.length > MAX_OUTAGES_SHOWN) {
			const more = document.createElement("li");
			more.className = "pop-more";
			more.textContent = `+${outages.length - MAX_OUTAGES_SHOWN} more`;
			list.append(more);
		}
		items.push(list);
	}
	popover.replaceChildren(...items);
}

const POP_GAP = 8; // between the bar and the popover's arrow tip
const POP_EDGE = 8; // kept at least this far from the window's edges

function placePopover(bar) {
	popover.hidden = false;
	popover.classList.remove("below");
	popover.style.left = "0px";
	popover.style.top = "0px";
	const r = bar.getBoundingClientRect();
	const width = popover.offsetWidth;
	const height = popover.offsetHeight;
	const viewport = document.documentElement.clientWidth;
	const centre = r.left + r.width / 2;
	const left = Math.round(Math.max(POP_EDGE, Math.min(centre - width / 2, viewport - POP_EDGE - width)));
	let top = r.top - POP_GAP - height;
	if (top < POP_EDGE) {
		top = r.bottom + POP_GAP;
		popover.classList.add("below");
	}
	popover.style.left = `${left + window.scrollX}px`;
	popover.style.top = `${Math.round(top + window.scrollY)}px`;
	popover.style.setProperty("--arrow-x", `${Math.round(Math.max(12, Math.min(centre - left, width - 12)))}px`);
}

function openPopover(bars, index, via) {
	const data = STRIPS.get(bars);
	const bar = bars.children[index];
	if (!data || !bar) return;
	active?.bar.classList.remove("is-active");
	bar.classList.add("is-active");
	active = { bars, bar, index, via };
	bars.dataset.index = String(index);
	// Read out as it changes when it follows the keyboard; on hover the bar's own label is enough.
	popover.setAttribute("aria-live", via === "key" ? "polite" : "off");
	fillPopover(data, index);
	placePopover(bar);
}

function closePopover() {
	if (!active) return;
	active.bar.classList.remove("is-active");
	active = null;
	popover.hidden = true;
}

function barIndex(bar) {
	return Array.prototype.indexOf.call(bar.parentElement.children, bar);
}

function setupPopover() {
	popover = document.createElement("div");
	popover.className = "popover";
	popover.id = "day-popover";
	popover.setAttribute("role", "tooltip");
	popover.hidden = true;
	document.body.append(popover);

	document.addEventListener("pointerdown", (e) => { lastPointer = e.pointerType || "mouse"; }, true);
	document.addEventListener("pointerover", (e) => {
		if (e.pointerType !== "mouse") return;
		const bar = e.target.closest?.(".bar");
		if (bar && STRIPS.has(bar.parentElement)) openPopover(bar.parentElement, barIndex(bar), "hover");
	});
	document.addEventListener("pointerout", (e) => {
		if (e.pointerType !== "mouse" || active?.via !== "hover") return;
		if (e.relatedTarget?.closest?.(".bars") === active.bars) return; // still over the strip (the gaps)
		closePopover();
	});
	document.addEventListener("click", (e) => {
		const bar = e.target.closest?.(".bar");
		if (bar && lastPointer !== "mouse" && STRIPS.has(bar.parentElement)) {
			const bars = bar.parentElement;
			const index = barIndex(bar);
			if (active?.bars === bars && active.index === index && active.via === "tap") closePopover();
			else openPopover(bars, index, "tap");
			return;
		}
		if (!bar && active?.via === "tap") closePopover();
	});
	document.addEventListener("focusin", (e) => {
		const bars = e.target;
		if (!STRIPS.has(bars) || !bars.matches(":focus-visible")) return; // a click's focus opens nothing
		const index = Number(bars.dataset.index);
		openPopover(bars, Number.isInteger(index) ? index : bars.children.length - 1, "key");
	});
	document.addEventListener("focusout", (e) => {
		if (active?.via === "key" && e.target === active.bars) closePopover();
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			if (active) {
				closePopover();
				e.preventDefault();
			}
			return;
		}
		const bars = e.target;
		if (!STRIPS.has(bars)) return;
		const n = bars.children.length;
		const stored = Number(bars.dataset.index);
		let index = active?.bars === bars ? active.index : Number.isInteger(stored) ? stored : n - 1;
		if (e.key === "ArrowLeft") index = Math.max(0, index - 1);
		else if (e.key === "ArrowRight") index = Math.min(n - 1, index + 1);
		else if (e.key === "Home") index = 0;
		else if (e.key === "End") index = n - 1;
		else return;
		e.preventDefault();
		openPopover(bars, index, "key");
	});
	window.addEventListener("resize", () => {
		if (active) placePopover(active.bar);
	});
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

setupPopover();
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
