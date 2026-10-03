// The player feedback dashboard behind /fb-dash (src/views/FeedbackView.vue). Plain DOM code, loaded
// only when that page opens, so the rest of the site never ships it. It reads feedback/data straight
// from the repo (written by .github/workflows/feedback.yml), so new data shows up without a deploy.
// Add ?data=<base url> to read another copy of the data, e.g. a local test run.
import CSS from "./dashboard.css?inline";

// The data is read from the newest commit that touched it (see dataBase), never from "main": raw
// GitHub caches a branch's files for minutes, so "main" can serve a stale copy.
const DATA_OVERRIDE = new URLSearchParams(location.search).get("data")?.replace(/\/$/, "");
const RAW = "https://raw.githubusercontent.com/fourgames/website";
let DATA = DATA_OVERRIDE || `${RAW}/main/feedback/data`;
const DAY = 86400;
const URGENCY = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const KIND = { review: "Review", topic: "Thread", reply: "Reply" };
const state = { index: null, games: {}, game: null, tab: "overview", filters: { issues: { status: "active", q: "" }, suggestions: { status: "active", q: "" }, feed: { kind: "all", category: "all", q: "", shown: 50 }, stats: { range: 0 }, replies: { show: "open" } } };

const store = {
  get(k) { try { return localStorage.getItem("fb-dash:" + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("fb-dash:" + k, v); } catch {} },
};

// DOM helper: h("div.card", {onclick}, child, "text"…). Text always goes in as text nodes.
function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name);
  if (classes.length) el.className = classes.join(" ");
  // A first argument that isn't a props object (text, a number like 0, a node, a list) is a child.
  if (props != null && (typeof props !== "object" || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className += " " + v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const svgEl = (tag, attrs = {}) => { const el = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const now = () => Math.floor(Date.now() / 1000);
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const fmtShort = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function ago(t) {
  const s = now() - t;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + " min ago";
  if (s < DAY) return Math.round(s / 3600) + " h ago";
  if (s < 30 * DAY) return Math.round(s / DAY) + " d ago";
  return fmtDate(t);
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function toast(msg) {
  const el = document.getElementById("fb-toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1600);
}
async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { style: "position:fixed;opacity:0" }, text);
    document.body.append(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  toast("Copied");
  if (button) { const old = button.textContent; button.textContent = "Copied ✓"; button.classList.add("done"); setTimeout(() => { button.textContent = old; button.classList.remove("done"); }, 1500); }
}

async function getJson(path) {
  const res = await fetch(`${DATA}/${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}


// A flag for a language: the country it's most associated with (a language isn't a country, but
// it reads at a glance). Reviews carry Steam's own language code; forum posts the name Claude gave.
const STEAM_LANG = {
  english: "gb", koreana: "kr", japanese: "jp", schinese: "cn", tchinese: "tw", german: "de", french: "fr",
  spanish: "es", latam: "mx", portuguese: "pt", brazilian: "br", russian: "ru", polish: "pl", italian: "it",
  turkish: "tr", ukrainian: "ua", dutch: "nl", swedish: "se", danish: "dk", norwegian: "no", finnish: "fi",
  czech: "cz", hungarian: "hu", romanian: "ro", thai: "th", vietnamese: "vn", indonesian: "id", greek: "gr",
  bulgarian: "bg", arabic: "sa",
};
const LANG_NAME = {
  english: "gb", korean: "kr", japanese: "jp", chinese: "cn", "simplified chinese": "cn", "chinese (simplified)": "cn",
  "traditional chinese": "tw", "chinese (traditional)": "tw", german: "de", french: "fr", spanish: "es",
  "latin american spanish": "mx", "spanish (latin america)": "mx", portuguese: "pt", "brazilian portuguese": "br",
  "portuguese (brazil)": "br", russian: "ru", polish: "pl", italian: "it", turkish: "tr", ukrainian: "ua", dutch: "nl",
  swedish: "se", danish: "dk", norwegian: "no", finnish: "fi", czech: "cz", hungarian: "hu", romanian: "ro", thai: "th",
  vietnamese: "vn", indonesian: "id", greek: "gr", bulgarian: "bg", arabic: "sa",
};
function flag(code) {
  return code ? [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0))).join("") : "";
}
function langFlag(name, steamCode) {
  return flag(STEAM_LANG[steamCode] || LANG_NAME[(name || "").toLowerCase()]);
}
const withFlag = (name, steamCode) => [langFlag(name, steamCode), name].filter(Boolean).join(" ");

const ICONS = {
  issues: "M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  suggestions: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  feed: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  overview: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  replies: "M9 17H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M14 19l2 2 5-5",
};
function icon(name) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", class: "icon", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: ICONS[name] }));
  return svg;
}

// One-click filter buttons (replaces every dropdown).
function chips(options, value, onChange, label) {
  const group = h("div.chips", { role: "group", "aria-label": label });
  for (const [v, text] of options) {
    group.append(h("button", { type: "button", "aria-pressed": String(v === value), onclick: (e) => {
      group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", "false"));
      e.currentTarget.setAttribute("aria-pressed", "true");
      onChange(v);
    } }, text));
  }
  return group;
}

// A small single-series trend line for the KPI cards.
function spark(values, color = "var(--fb-accent)") {
  const svg = svgEl("svg", { viewBox: "0 0 100 30", preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
  if (values.length < 2 || !values.some((v) => v)) return svg;
  const max = Math.max(...values), min = Math.min(0, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - ((v - min) / (max - min || 1)) * 26]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  svg.append(svgEl("path", { d: `${line}L100,30L0,30Z`, fill: color, opacity: 0.14 }));
  svg.append(svgEl("path", { d: line, fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }));
  return svg;
}
// Per-day values for the last `n` days.
function daily(n, valueOf) {
  const today = Math.floor(now() / DAY);
  return Array.from({ length: n }, (_, i) => valueOf((today - n + 1 + i) * DAY));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

// Points DATA at the newest data commit and shows when it was made. Falls back to "main" if the
// GitHub API is unreachable or rate-limited (60 requests an hour per IP).
async function dataBase() {
  if (DATA_OVERRIDE) return;
  try {
    const res = await fetch("https://api.github.com/repos/fourgames/website/commits?path=feedback/data&per_page=1", { cache: "no-store" });
    const [c] = await res.json();
    if (!c?.sha) return;
    DATA = `${RAW}/${c.sha}/feedback/data`;
    state.dataChanged = Date.parse(c.commit.committer.date) / 1000;
  } catch {}
}

async function init() {
  await dataBase();
  try {
    state.index = await getJson("index.json");
  } catch (e) {
    document.getElementById("fb-updated").textContent = "No data yet: the feedback workflow hasn't committed anything. (" + e.message + ")";
    return;
  }
  renderStatus();
  const games = state.index.games || [];
  const hash = new URLSearchParams(location.hash.slice(1));
  const wanted = Number(hash.get("app") || store.get("app"));
  state.tab = ["overview", "issues", "suggestions", "replies", "feed"].includes(hash.get("tab")) ? hash.get("tab") : state.tab;
  if (games.length) pickGame(games.some((g) => g.appId === wanted) ? wanted : orderedGames()[0].appId);
}

// What the last runs could and couldn't reach (feedback/status.py), with the fix for each problem.
const SERVICES = {
  claude: ["Claude (translation and triage)", "https://platform.claude.com/settings/billing", "Add credit"],
  steam: ["Steam reviews, players and updates", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"],
  forums: ["Steam discussions", "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"],
  discord: ["Discord alerts", "https://github.com/fourgames/website/settings/secrets/actions", "GitHub secrets"],
};
function renderStatus() {
  const all = Object.entries(state.index.status || {}).filter(([key]) => SERVICES[key]);
  const problems = all.filter(([, s]) => !s.ok);
  const el = document.getElementById("fb-status");
  if (!all.length) return el.replaceChildren();
  if (!problems.length) {
    return el.replaceChildren(h("div.status-ok", h("span.dot"), `All ${all.length} services worked on the last run.`));
  }
  el.replaceChildren(h("div.status-bad",
    h("div.status-head", "⚠ ", problems.length === 1 ? "1 service needs attention" : `${problems.length} services need attention`,
      h("span.status-fine", `${all.length - problems.length} of ${all.length} working`)),
    ...problems.map(([key, s]) => {
      const [label, href, action] = SERVICES[key] || [key, "https://github.com/fourgames/website/actions/workflows/feedback.yml", "See the runs"];
      // Out of credit is the one with a fix behind a button; other services link to where they're fixed.
      const fix = key === "claude" && !/credit/i.test(s.message || "") ? ["https://platform.claude.com/settings/keys", "API keys"] : [href, action];
      return h("div.status-row",
        h("div", h("b", label), h("div.status-msg", s.message || "Failed."), h("div.status-since", `since ${ago(s.since)}`)),
        h("a.btn.primary", { href: fix[0], target: "_blank", rel: "noopener" }, fix[1], " ↗"));
    })));
}

// Released games first, newest release on top; then coming-soon games, soonest first.
// One list: the game with the newest player post on top (newest release breaks ties).
function orderedGames() {
  return [...(state.index.games || [])].sort((a, b) => (b.lastPost || 0) - (a.lastPost || 0) || (b.released || 0) - (a.released || 0));
}

function renderGames() {
  const games = orderedGames();
  const sub = (g) => g.lastPost ? `last post ${ago(g.lastPost)}` : g.status === "upcoming" ? "coming soon, no posts yet" : "no posts yet";
  const item = (g) => h("button.g-item", { type: "button", title: g.name, "aria-current": String(state.game?.appId === g.appId), onclick: () => pickGame(g.appId) },
    g.capsule ? h("img.g-thumb", { src: g.capsule, alt: "", loading: "lazy" }) : h("span.g-thumb"),
    h("span.g-name", g.name, h("span.g-sub", sub(g))));
  document.getElementById("fb-games-side").replaceChildren(h("div.side-label", "Games"), ...games.map(item));
  document.getElementById("fb-games-strip").replaceChildren(...games.map(item));
}

async function pickGame(appId) {
  store.set("app", appId);
  const meta = state.index.games.find((g) => g.appId === appId);
  if (!state.games[appId]) {
    document.getElementById("fb-view").replaceChildren(h("p.empty", "Loading…"));
    try {
      state.games[appId] = await getJson(`games/${appId}.json`);
    } catch (e) {
      state.game = { appId, meta, items: {}, issues: {}, players: [], releases: [], reviewTotals: {} };
      render();
      document.getElementById("fb-view").replaceChildren(h("p.empty", "No data for this game yet."));
      return;
    }
  }
  state.game = { ...state.games[appId], meta };
  render();
}

function setHash() {
  // Keep vue-router's history state; only the hash changes.
  history.replaceState(history.state, "", `${location.pathname}${location.search}#app=${state.game.appId}&tab=${state.tab}`);
}

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------

const items = () => Object.values(state.game.items || {});
const issues = (kind) => Object.values(state.game.issues || {}).filter((i) => i.kind === kind);
const english = (item) => (item.triage && item.triage.english) || item.text || "";
const isActive = (i) => i.status !== "likely_fixed";

function playersAt(series, t) {
  let v = null;
  for (const [ts, n] of series) { if (ts > t) break; v = n; }
  return v;
}

function renderHeader() {
  const meta = state.game.meta || {};
  const img = document.getElementById("fb-capsule");
  img.hidden = !meta.capsule;
  if (meta.capsule) img.src = meta.capsule;
  document.getElementById("fb-title").replaceChildren(...[meta.name || "", meta.status === "upcoming" ? h("span.pill", "Coming soon") : null].filter(Boolean));
  const g = state.game;
  // The newest numbered update; a launch post or an unnumbered one only when there's nothing else.
  const release = (g.releases || []).filter((r) => r.version).at(-1) || (g.releases || []).at(-1);
  document.getElementById("fb-updated").replaceChildren([
    release ? `Latest update ${release.version ? "v" + release.version : release.name}, ${ago(release.time)}` : null,
    state.dataChanged ? `data updated ${ago(state.dataChanged)}` : null,
  ].filter(Boolean).join(" · "));
  const id = state.game.appId;
  const links = [
    ["Store page", `https://store.steampowered.com/app/${id}/`],
    ["Reviews", `https://steamcommunity.com/app/${id}/reviews/?browsefilter=mostrecent`],
    ["Discussions", `https://steamcommunity.com/app/${id}/discussions/`],
    ["News", `https://store.steampowered.com/news/app/${id}`],
    ["Steamworks", `https://partner.steamgames.com/apps/landing/${id}`],
    // Sales stay in Steamworks (not mirrored here): its per-game sales and activations report.
    ["Sales", `https://partner.steampowered.com/app/details/${id}/`],
  ];
  document.getElementById("fb-links").replaceChildren(
    h("details.steam-menu",
      h("summary.btn", "Steam ▾"),
      h("div.menu", ...links.map(([label, href]) => h("a", { href, target: "_blank", rel: "noopener" }, label, " ↗")))));
}

function renderStats() {
  const g = state.game;
  const series = g.players || [];
  const t = now();
  const current = series.length ? series[series.length - 1][1] : null;
  const inDay = series.filter(([ts]) => ts >= t - DAY).map(([, n]) => n);
  const peak = Math.max(...inDay, playersAt(series, t - DAY) ?? 0, current ?? 0);
  const peaks = daily(14, (d) => Math.max(playersAt(series, d) ?? 0, ...series.filter(([ts]) => ts >= d && ts < d + DAY).map(([, n]) => n)));
  const totalsKey = Object.keys(g.reviewTotals || {}).sort().pop();
  const totals = totalsKey ? g.reviewTotals[totalsKey] : null;
  const reviewsPerDay = daily(14, (d) => items().filter((i) => i.kind === "review" && i.created >= d && i.created < d + DAY).length);
  const postsPerDay = daily(14, (d) => items().filter((i) => !i.dev && i.created >= d && i.created < d + DAY).length);
  const bugs = issues("bug").filter(isActive);
  const urgent = bugs.filter((i) => i.urgency === "urgent" || i.urgency === "high");
  const still = bugs.filter((i) => i.status === "still_happening");
  const fresh = items().filter((i) => !i.dev && i.created >= t - DAY);
  const tile = (label, value, sub, trend, color, chart) => {
    const body = [h("div.label", label, chart ? h("span.kpi-more", state.expanded === chart ? "Hide chart ▴" : "Chart ▾") : null), h("div.value", value), sub ? h("div.sub", sub) : null, trend ? spark(trend, color) : null];
    if (!chart) return h("div.kpi", ...body);
    return h("button.kpi.kpi-open", { type: "button", "aria-expanded": String(state.expanded === chart), onclick: () => {
      state.expanded = state.expanded === chart ? null : chart;
      renderStats();
    } }, ...body);
  };
  const pct = totals && totals.positive + totals.negative ? Math.round((100 * totals.positive) / (totals.positive + totals.negative)) + "%" : "–";
  document.getElementById("fb-stats").replaceChildren(...[
    tile("Players now", current ?? "–", current != null ? `${peak} peak today` : "not released", peaks, undefined, "players"),
    tile("Positive reviews", pct, totals ? `${totals.positive} 👍 · ${totals.negative} 👎` : "no reviews yet", reviewsPerDay, "var(--fb-positive)", "reviews"),
    tile("Open bugs", bugs.length, still.length ? `${still.length} still happening` : urgent.length ? `${urgent.length} high or urgent` : "none high or urgent"),
    tile("New posts", fresh.length, "last 24 h", postsPerDay),
  ].filter(Boolean));
  document.getElementById("fb-expand").replaceChildren(...(state.expanded ? [chartPanel(state.expanded)] : []));
}

// The chart behind an opened stat card, with its own time range.
function chartPanel(which) {
  const f = state.filters.stats;
  const wrap = h("div.expand");
  const body = h("div");
  const draw = () => {
    const end = now();
    const start = f.range ? end - f.range * DAY : Math.min(end - 7 * DAY, ...[...(state.game.players || []).map((p) => p[0]), ...items().map((i) => i.created)]);
    const releases = markers(start, end);
    body.replaceChildren(which === "players" ? playersChart(start, end, releases) : reviewsChart(start, end, releases));
  };
  const range = chips([[7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"], [0, "All"]], f.range, (v) => { f.range = v; draw(); }, "Time range");
  wrap.append(h("div.filters", range), body);
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function render() {
  renderGames();
  renderHeader();
  renderStats();
  const counts = {
    issues: issues("bug").filter(isActive).length,
    suggestions: issues("suggestion").filter(isActive).length,
    feed: items().filter((i) => !i.dev).length,
    replies: toReply().length,
    overview: attention().length || null,
  };
  const tabs = [["overview", "Overview"], ["issues", "Bugs"], ["suggestions", "Ideas"], ["replies", "Replies"], ["feed", "All posts"]];
  const buttons = () => tabs.map(([id, label]) =>
    h("button.nav-btn", { type: "button", "aria-current": String(state.tab === id), onclick: () => { state.tab = id; render(); } },
      icon(id), h("span", label), counts[id] != null ? h("span.count", counts[id]) : null));
  document.getElementById("fb-nav-side").replaceChildren(...buttons());
  document.getElementById("fb-nav-top").replaceChildren(...buttons());
  setHash();
  const view = { overview: overviewView, issues: () => issueView("bug"), suggestions: () => issueView("suggestion"), replies: repliesView, feed: feedView }[state.tab]();
  document.getElementById("fb-view").replaceChildren(view);
}

function issueView(kind) {
  const f = state.filters[kind === "bug" ? "issues" : "suggestions"];
  const wrap = h("div");
  const list = h("div");
  const draw = () => {
    const q = f.q.toLowerCase();
    const shown = issues(kind)
      .filter((i) => f.status === "all" || (f.status === "active" ? isActive(i) : f.status === "still" ? i.status === "still_happening" : i.status === "likely_fixed"))
      .filter((i) => !q || (i.title + " " + i.area + " " + (i.summary || "")).toLowerCase().includes(q))
      .sort((a, b) => b.priority - a.priority);
    list.replaceChildren(...(shown.length ? shown.map((i) => issueCard(i)) : [h("p.empty", kind === "bug" ? "No issues here." : "No suggestions here.")]));
  };
  const status = chips([["active", "Open"], ["still", "Still happening"], ["fixed", "Likely fixed"], ["all", "All"]], f.status, (v) => { f.status = v; draw(); }, "Status");
  const search = h("input", { type: "search", placeholder: "Search issues", value: f.q, oninput: (e) => { f.q = e.target.value; draw(); } });
  wrap.append(h("div.filters", status, search), list);
  draw();
  return wrap;
}

function urgencyBadge(u) {
  return h(`span.badge.u-${u}`, h("span.dot", { "aria-hidden": "true" }), URGENCY[u] || u);
}

function statusBadge(issue) {
  if (issue.status === "likely_fixed")
    return h("a.badge.s-fixed", { href: issue.fixedUrl, target: "_blank", rel: "noopener", title: issue.fixReason || "" }, "✓ Likely fixed in " + issue.fixedIn);
  if (issue.status === "still_happening")
    return h("span.badge.s-still", { title: issue.fixReason || "" }, `↻ Still happening after ${issue.fixedIn}`);
  return null;
}

function issueCard(issue) {
  const posts = issue.items.map((id) => state.game.items[id]).filter(Boolean).sort((a, b) => b.created - a.created);
  const postList = h("div", { hidden: true });
  let filled = false;
  const toggle = h("button.btn", { onclick: () => {
    if (!filled) { postList.append(...posts.map(postView)); filled = true; }
    postList.hidden = !postList.hidden;
    toggle.textContent = postList.hidden ? `Show ${plural(posts.length, "post")}` : "Hide posts";
  } }, `Show ${plural(posts.length, "post")}`);
  const copyText = issue.kind === "bug" ? issue.fixPrompt : suggestionText(issue, posts);
  const copyBtn = h("button.btn.primary", { onclick: (e) => copy(copyText, e.currentTarget) }, issue.kind === "bug" ? "Copy fix prompt" : "Copy summary");
  const linkBtn = h("button.btn", { onclick: (e) => copy(posts.map((p) => p.url).join("\n"), e.currentTarget) }, "Copy links");
  return h("article.card",
    h("div.card-head",
      h("div.main-col",
        h("h3", issue.title),
        h("div.meta", urgencyBadge(issue.urgency), statusBadge(issue), h("span", issue.area), h("span", (issue.languages || []).map((l) => withFlag(l)).join(", ")),
          h("span", `last ${ago(issue.lastSeen)}`), issue.negativeReviews ? h("span.vote-down", `${issue.negativeReviews} 👎 review${issue.negativeReviews === 1 ? "" : "s"}`) : null)),
      h("div.mentions", h("b", issue.mentions), h("span", issue.mentions === 1 ? "player" : "players"))),
    issue.summary ? h("p", { style: "margin:6px 0 0;color:var(--fb-ink-2)" }, issue.summary) : null,
    h("div.actions", copyBtn, toggle, linkBtn),
    postList);
}

function suggestionText(issue, posts) {
  return [
    `${state.game.meta.name} suggestion: ${issue.title}`,
    `${plural(issue.mentions, "player")} (${(issue.languages || []).join(", ")}), area: ${issue.area}`,
    "",
    ...posts.slice(0, 10).map((p) => `- "${english(p).replace(/\s+/g, " ").slice(0, 300)}" ${p.url}`),
  ].join("\n");
}

// "Select" highlights a text, so you can have macOS read it with your own voice (Siri included,
// which web pages can't use themselves) by pressing your Speak Selection key. A page can't start
// macOS speech itself, and running a Shortcut from a link always brings the Shortcuts app forward.
function speakButton(target) {
  const button = h("button.speak", { type: "button", title: "Select the text, then press your Speak Selection key to listen" }, "Select");
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.addRange(range);
  });
  return button;
}

// A text with its Select button beside it.
function textRow(text) {
  const el = h("div.text", text);
  return h("div.text-row", el, speakButton(el));
}
function withSpeak(text) {
  const el = h("span", text);
  return [el, " ", speakButton(el)];
}

// Steam's "0.4 hrs on record (0.2 hrs at review time)": total hours now, and the hours when the
// review was written if they've played more since.
function playtime(item) {
  if (item.kind !== "review" || item.playtime == null) return null;
  const now = Math.max(item.playtimeForever || 0, item.playtime);
  return { total: `${now} h`, atReview: now > item.playtime ? `${item.playtime} h at review` : null };
}

// ---------------------------------------------------------------------------
// Post card: laid out like Steam's own review box. The header carries the verdict, hours and date
// on the left and the player's language with what triage made of it on the right.
// ---------------------------------------------------------------------------

const CATEGORY = { bug: ["🐞", "Bug"], suggestion: ["💡", "Suggestion"], question: ["❓", "Question"], praise: ["💬", "Praise"] };

// The parts of a post the card shows.
function postParts(item) {
  const t = item.triage || {};
  const translated = t.english && t.english.trim() !== (item.text || "").trim();
  const flipped = (item.flips || []).at(-1);
  const parent = item.topic ? state.game.items[item.topic] : null;
  const review = item.kind === "review";
  return {
    t, review,
    flag: t.language ? langFlag(t.language, item.lang) || "🌐" : item.dev ? "🛠️" : "🌐",
    language: t.language || (item.dev ? "Your post" : "Not triaged yet"),
    hours: playtime(item)?.total || null,
    atReview: playtime(item)?.atReview || null,
    verdict: review ? (item.votedUp ? ["vote-up", "👍", "Recommended"] : ["vote-down", "👎", "Not recommended"]) : null,
    who: item.author?.name || null,
    when: fmtDate(item.created),
    kind: KIND[item.kind] + (item.forum ? ` · ${item.forum}` : ""),
    link: h("a", { href: item.url, target: "_blank", rel: "noopener" }, "Open on Steam ↗"),
    // What happened to the post, and what triage made of it.
    flags: [
      item.edited ? h("span.badge", { title: `Edited · ${(item.versions || []).length} earlier version(s) kept` }, "edited") : null,
      flipped ? h("span.badge", { class: flipped.to === "negative" ? "s-still" : "s-fixed" }, `flipped ${flipped.to} ${fmtShort(flipped.at)}`) : null,
      item.deleted ? h("span.badge.s-still", "deleted on Steam") : null,
      item.dev ? h("span.badge", "Your post") : null,
    ].filter(Boolean),
    tags: [t.category ? h("span.badge", t.category) : null, t.urgency ? urgencyBadge(t.urgency) : null].filter(Boolean),
    body: [
      parent ? h("div.meta", "in “", parent.title || "thread", "”") : null,
      item.title ? h("div", h("b", item.title)) : null,
      textRow(english(item)),
      translated ? h("details", h("summary", `Original (${t.language})`), textRow(item.text)) : null,
      (item.versions || []).length ? h("details", h("summary", `Earlier versions (${item.versions.length})`),
        ...item.versions.slice().reverse().map((v) => h("div.text", `${fmtDate(v.at)}${v.votedUp == null ? "" : v.votedUp ? " · 👍" : " · 👎"}\n${v.title ? v.title + "\n" : ""}${v.text}`))) : null,
      item.devResponse ? h("details", h("summary", "Your reply on Steam"), h("div.text", item.devResponse)) : null,
    ].filter(Boolean),
  };
}

// Priority as signal bars, one to four.
const PRIORITY_BARS = { low: 1, medium: 2, high: 3, urgent: 4 };

// The card's left edge says how the player feels: blue for a recommending review, red for a
// negative one, grey for everything else (threads, replies, your own posts). The header keeps
// Steam's order: verdict, hours and date on the left; language, type (in its colour) and priority
// (as signal bars) on the right.
function postView(item) {
  const p = postParts(item);
  const cat = p.t.category;
  const [icon, kind] = CATEGORY[cat] || [];
  const u = p.t.urgency;
  const edge = p.verdict ? p.verdict[0].replace("vote-", "is-") : "neutral";
  const bars = u ? h(`span.bars4.pt-${u}`, ...[1, 2, 3, 4].map((n) => h(n <= PRIORITY_BARS[u] ? "i.on" : "i"))) : null;
  return h(`div.post.pc.${edge}`,
    h("div.pc-head",
      h("div.pv3-icon", p.verdict ? p.verdict[1] : "💬"),
      h("div.pv3-title",
        h("b", p.verdict ? p.verdict[2] : p.kind),
        p.hours ? h("span", `${p.hours} on record`, p.atReview ? ` (${p.atReview})` : "") : p.who ? h("span", p.who) : null,
        h("span", `Posted ${p.when}`)),
      h("div.pv3-right",
        h("div.pv3-lang", h("span.pv3-flag", p.flag), p.language),
        kind ? h(`div.pc-type.tt-text-${cat}`, icon, " ", kind) : null,
        u ? h("div.pc-prio", bars, `${URGENCY[u]} priority`) : null)),
    ...p.body,
    h("div.meta", ...p.flags, item.forum && item.kind !== "review" ? h("span", item.forum) : null, p.link));
}

// Posts worth a reply: a negative review or a thread about something a later update fixed (Steam's
// guidance: reply to "a bug that has since been resolved"). Drafted by feedback/run.py when a patch
// is matched; gone once you've replied on Steam, the issue turns out to be still happening, or you
// press Done (remembered in this browser).
function replied(item) {
  if (item.devResponse) return true;
  const thread = item.topic || item.id;
  // Any post of yours in the thread after the player's counts, even one from before the fix.
  return items().some((i) => i.dev && (i.id === thread || i.topic === thread) && i.created > item.created);
}
function toReply() {
  const done = new Set((store.get("replied") || "").split(",").filter(Boolean));
  return items()
    .filter((i) => i.fixReply && !done.has(i.id) && !replied(i))
    .filter((i) => state.game.issues?.[i.fixReply.issue]?.status === "likely_fixed")
    .sort((a, b) => b.created - a.created);
}

function replyCard(item) {
  const r = item.fixReply;
  const issue = state.game.issues[r.issue];
  const done = h("button.btn", { onclick: () => {
    store.set("replied", [...(store.get("replied") || "").split(",").filter(Boolean), item.id].join(","));
    render();
  } }, "Done");
  return h("div.card",
    h("div.meta", h("span.badge.s-fixed", `✓ Fixed in ${r.version}`), h("b", issue?.title || "")),
    h("div.reply",
      h("div.reply-row",
        h("div", h("div", "💬 ", ...withSpeak(r.text)), r.text !== r.english ? h("div.en", r.english) : null),
        h("div.actions", { style: "margin:0;flex:none" },
          h("button.btn.primary", { onclick: (e) => copy(r.text, e.currentTarget) }, "Copy reply"),
          h("a.btn.link-btn", { href: item.url, target: "_blank", rel: "noopener" }, item.kind === "review" ? "Reply on Steam ↗" : "Open thread ↗"),
          done))),
    postView(item));
}

// Your answer to a player's post: the developer response on a review, or your first post in the
// thread after theirs.
function yourReply(item) {
  if (item.devResponse) return { text: item.devResponse, at: null };
  const thread = item.topic || item.id;
  const mine = items().filter((i) => i.dev && (i.id === thread || i.topic === thread) && i.created > item.created)
    .sort((a, b) => a.created - b.created)[0];
  return mine ? { text: mine.text, at: mine.created } : null;
}

function repliedCard(item) {
  const mine = yourReply(item);
  return h("div.card",
    h("div.meta", h("span.badge.s-fixed", "✓ Replied"), mine?.at ? h("span", fmtDate(mine.at)) : null,
      !mine ? h("span", "marked done here") : null),
    mine ? h("div.reply", h("div.reply-row", h("div", h("div.en", "Your reply"), h("div", ...withSpeak(mine.text))))) : null,
    postView(item));
}

function repliesView() {
  const f = state.filters.replies;
  const done = new Set((store.get("replied") || "").split(",").filter(Boolean));
  const open = toReply();
  // Every player post you've answered, plus drafts you marked done here.
  const answered = items()
    .filter((i) => !i.dev && (replied(i) || (i.fixReply && done.has(i.id))))
    .sort((a, b) => b.created - a.created);
  const list = h("div");
  const draw = () => {
    const cards = f.show === "open" ? open.map(replyCard)
      : f.show === "replied" ? answered.map(repliedCard)
      : [...open.map(replyCard), ...answered.map(repliedCard)];
    const empty = { open: "Nothing to reply to right now.", replied: "You haven't replied to any posts yet.", all: "Nothing here yet." }[f.show];
    list.replaceChildren(...(cards.length ? cards : [h("p.empty", empty)]));
  };
  const intro = h("p.updated", { style: "margin:0 0 12px" },
    "To reply: negative reviews and threads about something an update has since fixed. Steam suggests replying in cases like these, briefly: say what was fixed. Replied: posts you've already answered on Steam.");
  const filter = chips([["open", `To reply (${open.length})`], ["replied", `Replied (${answered.length})`], ["all", "All"]], f.show, (v) => { f.show = v; draw(); }, "Show");
  draw();
  return h("div", intro, h("div.filters", filter), list);
}

// Bugs that need you now: reported again after a fix, or high/urgent and still open.
function attention() {
  return Object.values(state.game.issues || {})
    .filter((i) => i.status === "still_happening" || (i.kind === "bug" && isActive(i) && (i.urgency === "urgent" || i.urgency === "high")))
    .sort((a, b) => b.priority - a.priority);
}

function overviewView() {
  const go = (tab, label) => h("button.btn", { onclick: () => { state.tab = tab; render(); window.scrollTo({ top: 0 }); } }, label, " →");
  const section = (title, count, ...body) => h("section.ov-section", h("h3", title, count != null ? h("span.ov-count", count) : null), ...body);
  const urgent = attention();
  const replies = toReply();
  const latest = items().filter((i) => !i.dev).sort((a, b) => b.created - a.created).slice(0, 5);
  // The week in one sentence.
  const week = items().filter((i) => !i.dev && i.created >= now() - 7 * DAY);
  const reviews = week.filter((i) => i.kind === "review");
  const up = reviews.filter((i) => i.votedUp).length;
  const summary = [
    week.length ? `${plural(week.length, "new post")} this week` : "No new posts this week",
    reviews.length ? `${plural(reviews.length, "review")} (${up} 👍, ${reviews.length - up} 👎)` : null,
    urgent.length ? `${urgent.length} need${urgent.length === 1 ? "s" : ""} attention` : "nothing urgent",
    replies.length ? `${plural(replies.length, "post")} worth a reply` : null,
  ].filter(Boolean).join(" · ") + ".";
  return h("div",
    h("p.ov-summary", summary),
    urgent.length
      ? section("Needs attention", urgent.length, ...urgent.slice(0, 5).map((i) => issueCard(i)), urgent.length > 5 || issues("bug").filter(isActive).length > urgent.length ? go("issues", "All bugs") : null)
      : section("Needs attention", null, h("p.ov-calm", "Nothing urgent: no high-priority bugs, and nothing came back after a fix.")),
    replies.length
      ? section("Worth a reply", replies.length, h("p.ov-calm", `${plural(replies.length, "post")} about something an update has since fixed. `, go("replies", "Replies")))
      : null,
    section("Latest posts", null,
      // Long reviews are cut to a few lines here; a click shows the whole post.
      ...(latest.length ? latest.map((i) => h("div.card.clamp", { onclick: (e) => e.currentTarget.classList.remove("clamp") }, postView(i))) : [h("p.ov-calm", "No posts yet.")]),
      latest.length ? go("feed", "All posts") : null),
  );
}

function feedView() {
  const f = state.filters.feed;
  const wrap = h("div");
  const list = h("div");
  const draw = () => {
    const q = f.q.toLowerCase();
    const all = items()
      .filter((i) => !i.dev || !(i.kind === "topic" && i.forum === "Events & Announcements"))
      .filter((i) => f.kind === "all" || i.kind === f.kind)
      .filter((i) => f.category === "all" || (f.category === "pending" ? !i.triage && !i.dev : i.triage?.category === f.category))
      .filter((i) => !q || (english(i) + " " + (i.text || "") + " " + (i.title || "")).toLowerCase().includes(q))
      .sort((a, b) => Math.max(b.created, b.updated || 0) - Math.max(a.created, a.updated || 0));
    const shown = all.slice(0, f.shown);
    list.replaceChildren(...(shown.length ? shown.map((i) => h("div.card", postView(i))) : [h("p.empty", "Nothing here yet.")]));
    if (all.length > shown.length) list.append(h("button.btn.more", { onclick: () => { f.shown += 50; draw(); } }, `Show more (${all.length - shown.length} left)`));
  };
  const sel = (label, key, options) => chips(options, f[key], (v) => { f[key] = v; f.shown = 50; draw(); }, label);
  wrap.append(
    h("div.filters",
      sel("Type", "kind", [["all", "All posts"], ["review", "Reviews"], ["topic", "Threads"], ["reply", "Replies"]]),
      sel("Category", "category", [["all", "Any category"], ["bug", "Bugs"], ["suggestion", "Suggestions"], ["question", "Questions"], ["praise", "Praise"], ["pending", "Not triaged yet"]]),
      h("input", { type: "search", placeholder: "Search posts", value: f.q, oninput: (e) => { f.q = e.target.value; f.shown = 50; draw(); } })),
    list);
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const W = 760, H = 240, M = { top: 44, right: 12, bottom: 24, left: 40 };

function niceMax(v) {
  if (v <= 4) return Math.max(4, Math.ceil(v));
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function timeAxis(svg, x, start, end) {
  const span = end - start;
  const step = span <= 10 * DAY ? DAY : span <= 60 * DAY ? 7 * DAY : span <= 400 * DAY ? 30 * DAY : 90 * DAY;
  const first = Math.ceil(start / DAY) * DAY;
  let last = -1e9;
  for (let t = first; t <= end; t += step) {
    const px = x(t);
    if (px - last < 60) continue;
    last = px;
    const label = svgEl("text", { x: px, y: H - 6, "text-anchor": "middle" });
    label.textContent = fmtShort(t);
    svg.append(label);
  }
}

function yAxis(svg, y, max, fmt = (v) => v) {
  for (const v of [0, max / 2, max]) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: v === 0 ? "base" : "grid" }));
    const t = svgEl("text", { x: M.left - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = fmt(Math.round(v * 10) / 10);
    svg.append(t);
  }
}

// Updates and the launch as dashed lines, every one labelled: labels that would overlap move to
// the next of three rows above the plot.
const isLaunch = (r) => r.launch || /\b(out now|available now|launch(ed)?|released?)\b/i.test(r.name || "");
function markers(start, end) {
  const list = (state.game.releases || []).filter((r) => r.time >= start && r.time <= end);
  // No launch post: mark the store's release date instead.
  const released = state.game.meta?.released;
  if (!list.some(isLaunch) && released && released >= start && released <= end) list.push({ time: released, launch: true, name: "Release" });
  return list.sort((a, b) => a.time - b.time);
}
function releaseMarkers(svg, x, releases) {
  const rowEnd = [-1e9, -1e9, -1e9];
  for (const r of releases) {
    const px = x(r.time);
    const label = isLaunch(r) ? "🚀 Launch" : r.version ? "v" + r.version : r.name.slice(0, 14);
    const width = label.length * 6 + 8;
    let row = rowEnd.findIndex((e) => px - e > 4);
    if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
    rowEnd[row] = px + width;
    const y = M.top - 6 - row * 12;
    svg.append(svgEl("line", { x1: px, x2: px, y1: y + 2, y2: H - M.bottom, class: isLaunch(r) ? "release launch" : "release" }));
    const t = svgEl("text", { x: px + 3, y, class: "release-label" });
    t.textContent = label;
    svg.append(t);
  }
}

// Sale periods (recorded from the store's discount, see feedback/run.py record_discount) as shaded bands.
function saleBands(svg, x, start, end) {
  const series = state.game.discounts || [];
  const bands = [];
  series.forEach(([t, pct], i) => {
    if (!pct) return;
    const from = Math.max(t, start), to = Math.min(series[i + 1]?.[0] ?? end, end);
    if (to > from) bands.push([from, to, pct]);
  });
  for (const [from, to, pct] of bands) {
    svg.append(svgEl("rect", { x: x(from), y: M.top, width: Math.max(2, x(to) - x(from)), height: H - M.top - M.bottom, class: "band" }));
    const t = svgEl("text", { x: x(from) + 4, y: H - M.bottom - 6, class: "band-label" });
    t.textContent = `−${pct}%`;
    svg.append(t);
  }
  return bands.length > 0;
}
const saleLegend = () => h("span", h("i", { style: "background:var(--fb-warning);opacity:.45" }), "On sale");

function chartCard(title, sub, legend, svg, table) {
  const card = h("div.chart-card", h("h3", title), h("div.sub", sub), legend, svg, table);
  const tip = h("div.tip");
  card.append(tip);
  return { card, tip };
}

function showTip(card, tip, svg, px, py, lines) {
  tip.replaceChildren(...lines);
  tip.style.display = "block";
  const box = svg.getBoundingClientRect(), cbox = card.getBoundingClientRect();
  const sx = box.width / W, sy = box.height / H;
  let left = box.left - cbox.left + px * sx + 12;
  if (left + tip.offsetWidth > cbox.width - 8) left = box.left - cbox.left + px * sx - tip.offsetWidth - 12;
  tip.style.left = Math.max(4, left) + "px";
  tip.style.top = box.top - cbox.top + Math.max(0, py * sy - 20) + "px";
}

function playersChart(start, end, releases) {
  const series = state.game.players || [];
  // A step line: each stored sample holds until the next one (samples are stored only on change).
  const pts = [];
  const first = playersAt(series, start);
  if (first != null) pts.push([start, first]);
  for (const [t, n] of series) if (t >= start && t <= end) pts.push([t, n]);
  if (pts.length) pts.push([end, pts[pts.length - 1][1]]);
  const max = niceMax(Math.max(1, ...pts.map((p) => p[1])));
  const x = (t) => M.left + ((t - start) / (end - start)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Concurrent players over time" });
  const onSale = saleBands(svg, x, start, end);
  yAxis(svg, y, max);
  timeAxis(svg, x, start, end);
  releaseMarkers(svg, x, releases);
  if (pts.length) {
    let d = `M${x(pts[0][0])},${y(pts[0][1])}`;
    for (let i = 1; i < pts.length; i++) d += `H${x(pts[i][0])}V${y(pts[i][1])}`;
    svg.append(svgEl("path", { d, fill: "none", stroke: "var(--fb-accent)", "stroke-width": 2, "stroke-linejoin": "round" }));
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "cross", visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: "var(--fb-accent)", stroke: "var(--fb-card)", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  const table = h("details", h("summary", "Data table"),
    h("table.data", h("tr", h("th", "Time"), h("th", "Players")), ...series.filter(([t]) => t >= start).slice(-200).reverse().map(([t, n]) => h("tr", h("td", new Date(t * 1000).toLocaleString()), h("td", n)))));
  const { card, tip } = chartCard("Concurrent players", pts.length ? "Steam's current player count, sampled every run. Dashed lines are updates." : "No player data in this range.",
    onSale ? h("div.legend", saleLegend()) : null, svg, table);
  svg.addEventListener("pointermove", (e) => {
    if (!pts.length) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = Math.min(end, Math.max(start, start + ((px - M.left) / (W - M.left - M.right)) * (end - start)));
    const v = playersAt(pts, t);
    if (v == null) return;
    cross.setAttribute("x1", x(t)); cross.setAttribute("x2", x(t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(t)); dot.setAttribute("cy", y(v)); dot.setAttribute("visibility", "visible");
    const near = releases.find((r) => Math.abs(x(r.time) - x(t)) < 6);
    showTip(card, tip, svg, x(t), y(v), [h("div", h("b", v), " players"), h("div.t", new Date(t * 1000).toLocaleString()), near ? h("div.t", "Update: " + (near.version ? "v" + near.version : near.name)) : null].filter(Boolean));
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
  return card;
}

function reviewsChart(start, end, releases) {
  // New reviews per day (or week, for long ranges): recommended up, not recommended down.
  const bucket = end - start > 120 * DAY ? 7 * DAY : DAY;
  const b0 = Math.floor(start / bucket) * bucket;
  const n = Math.ceil((end - b0) / bucket);
  const up = new Array(n).fill(0), down = new Array(n).fill(0);
  for (const i of items()) {
    if (i.kind !== "review" || i.created < start) continue;
    const k = Math.floor((i.created - b0) / bucket);
    if (k >= 0 && k < n) (i.votedUp ? up : down)[k]++;
  }
  const max = niceMax(Math.max(1, ...up, ...down));
  const x = (t) => M.left + ((t - start) / (end - start)) * (W - M.left - M.right);
  const mid = M.top + (H - M.top - M.bottom) / 2;
  const half = (H - M.top - M.bottom) / 2;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "New reviews over time" });
  for (const v of [max, max / 2]) {
    for (const yy of [mid - (v / max) * half, mid + (v / max) * half]) svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: yy, y2: yy, class: "grid" }));
  }
  for (const [v, yy] of [[max, M.top], [0, mid], [max, H - M.bottom]]) {
    const t = svgEl("text", { x: M.left - 6, y: yy + 4, "text-anchor": "end" });
    t.textContent = v;
    svg.append(t);
  }
  const onSale = saleBands(svg, x, start, end);
  timeAxis(svg, x, start, end);
  releaseMarkers(svg, x, releases);
  const bw = Math.max(1, (W - M.left - M.right) / n - 2);
  const bar = (k, value, sign, color) => {
    if (!value) return;
    const bx = Math.max(M.left, x(b0 + k * bucket)) + 1;
    const hgt = Math.max(2, (value / max) * half);
    const r = Math.min(4, bw / 2, hgt);
    // Rounded only at the data end, anchored square on the zero line.
    const d = sign > 0
      ? `M${bx},${mid}V${mid - hgt + r}Q${bx},${mid - hgt} ${bx + r},${mid - hgt}H${bx + bw - r}Q${bx + bw},${mid - hgt} ${bx + bw},${mid - hgt + r}V${mid}Z`
      : `M${bx},${mid}V${mid + hgt - r}Q${bx},${mid + hgt} ${bx + r},${mid + hgt}H${bx + bw - r}Q${bx + bw},${mid + hgt} ${bx + bw},${mid + hgt - r}V${mid}Z`;
    svg.append(svgEl("path", { d, fill: color }));
  };
  for (let k = 0; k < n; k++) { bar(k, up[k], 1, "var(--fb-positive)"); bar(k, down[k], -1, "var(--fb-negative)"); }
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: mid, y2: mid, class: "base" }));
  const hit = svgEl("rect", { x: M.left, y: M.top, width: W - M.left - M.right, height: H - M.top - M.bottom, fill: "transparent" });
  svg.append(hit);
  const legend = h("div.legend", h("span", h("i", { style: "background:var(--fb-positive)" }), "Recommended"), h("span", h("i", { style: "background:var(--fb-negative)" }), "Not recommended"), onSale ? saleLegend() : null);
  const total = up.reduce((a, b) => a + b, 0) + down.reduce((a, b) => a + b, 0);
  const table = h("details", h("summary", "Data table"),
    h("table.data", h("tr", h("th", bucket === DAY ? "Day" : "Week of"), h("th", "👍"), h("th", "👎")),
      ...up.map((u, k) => [k, u, down[k]]).filter(([, u, d]) => u || d).reverse().map(([k, u, d]) => h("tr", h("td", fmtDate(b0 + k * bucket)), h("td", u), h("td", d)))));
  const { card, tip } = chartCard(`New reviews per ${bucket === DAY ? "day" : "week"}`, total ? `${total} in this range. Dashed lines are updates.` : "No reviews in this range.", legend, svg, table);
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const t = start + ((px - M.left) / (W - M.left - M.right)) * (end - start);
    const k = Math.floor((t - b0) / bucket);
    if (k < 0 || k >= n) return;
    showTip(card, tip, svg, px, mid - (up[k] / max) * half, [
      h("div.t", (bucket === DAY ? "" : "Week of ") + fmtDate(b0 + k * bucket)),
      h("div", h("b", up[k]), " recommended"),
      h("div", h("b", down[k]), " not recommended"),
    ]);
  });
  svg.addEventListener("pointerleave", () => { tip.style.display = "none"; });
  return card;
}


// ---------------------------------------------------------------------------
// Mount (called by src/views/FeedbackView.vue once the page is in the browser)
// ---------------------------------------------------------------------------

const SHELL = `
<div class="status" id="fb-status"></div>
<div class="fb-layout">
  <aside class="fb-side" aria-label="Games and views">
    <div id="fb-games-side"></div>
    <div class="side-label">Views</div>
    <nav class="nav-side" id="fb-nav-side" aria-label="Views"></nav>
  </aside>
  <div class="fb-main">
    <div class="strip" id="fb-games-strip" aria-label="Games"></div>
    <header class="top">
      <img id="fb-capsule" alt="" hidden>
      <div class="top-text"><h2 id="fb-title">Loading…</h2><div class="updated" id="fb-updated"></div></div>
      <div class="steam-links" id="fb-links"></div>
    </header>
    <section class="kpis" id="fb-stats" aria-label="Summary"></section>
    <div id="fb-expand"></div>
    <nav class="nav-top" id="fb-nav-top" aria-label="Views"></nav>
    <div id="fb-view"></div>
  </div>
</div>
<div class="toast" id="fb-toast" role="status"></div>`;

// The Steam menu is a <details>; close it when clicking elsewhere or pressing Escape.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".fb .steam-menu[open]").forEach((m) => { if (!m.contains(e.target)) m.open = false; });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".fb .steam-menu[open]").forEach((m) => { m.open = false; });
});

// Left open (on a TV, say), the page keeps itself current: every 5 minutes it asks GitHub for the
// newest data commit and, when there is one, reloads the data and redraws in place, keeping the
// game, view, filters, open chart and scroll position. Every 12 hours it reloads the whole page,
// to pick up changes to the dashboard itself.
const REFRESH_MS = 5 * 60 * 1000;
const FULL_RELOAD_MS = 12 * 3600 * 1000;
let refreshTimer = null;
const loadedAt = Date.now();

async function refresh() {
  if (!document.getElementById("fb-view")) return clearInterval(refreshTimer); // left the page
  if (!state.game) return;
  if (Date.now() - loadedAt > FULL_RELOAD_MS && !window.getSelection().toString()) return location.reload();
  const before = DATA;
  await dataBase();
  if (DATA !== before) {
    try {
      const index = await getJson("index.json");
      const appId = state.game.appId;
      const game = await getJson(`games/${appId}.json`);
      state.index = index;
      state.games = { [appId]: game }; // other games reload when picked
      state.game = { ...game, meta: index.games.find((g) => g.appId === appId) };
    } catch {
      return; // try again next time
    }
  }
  // Not while typing in a search box: a redraw would wipe it. Next round.
  if (document.activeElement?.matches?.(".fb input")) return;
  // Redraw either way, so "x min ago" stays true; keep the reader's place.
  const y = window.scrollY;
  renderStatus();
  render();
  window.scrollTo(0, y);
}

export function mount(root) {
  if (!document.getElementById("fb-dash-css")) {
    document.head.append(h("style", { id: "fb-dash-css" }, CSS));
  }
  root.innerHTML = SHELL;
  // Lets the site's header show a "Feedback" link in this browser from now on (SiteHeader.vue).
  store.set("visited", "1");
  init();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}
