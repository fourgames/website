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
const state = { index: null, games: {}, game: null, tab: "issues", filters: { issues: { status: "active", q: "" }, suggestions: { status: "active", q: "" }, feed: { kind: "all", category: "all", q: "", shown: 50 }, stats: { range: 90 } } };

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


const ICONS = {
  issues: "M8 2l1.88 1.88M14.12 3.88 16 2M9 7.13v-1a3 3 0 1 1 6 0v1M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6M12 20v-9M6.53 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M20.97 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4",
  suggestions: "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5M9 18h6M10 22h4",
  feed: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  stats: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
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
    document.getElementById("fb-updated").textContent = "Data last changed " + ago(Date.parse(c.commit.committer.date) / 1000);
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
  state.tab = ["issues", "suggestions", "feed", "stats"].includes(hash.get("tab")) ? hash.get("tab") : state.tab;
  if (games.length) pickGame(games.some((g) => g.appId === wanted) ? wanted : games[0].appId);
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

function renderGames() {
  const games = state.index.games || [];
  const item = (g) => h("button.g-item", { type: "button", title: g.name, "aria-current": String(state.game?.appId === g.appId), onclick: () => pickGame(g.appId) },
    g.capsule ? h("img.g-thumb", { src: g.capsule, alt: "", loading: "lazy" }) : h("span.g-thumb"),
    h("span.g-name", g.name, h("span.g-sub", g.status === "upcoming" ? "Coming soon" : "Released")));
  document.getElementById("fb-games-side").replaceChildren(...games.map(item));
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
  document.getElementById("fb-title").replaceChildren(meta.name || "", h("span.pill", meta.status === "upcoming" ? "Coming soon" : "Released"));
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
    ...links.map(([label, href]) => h("a.btn.link-btn", { href, target: "_blank", rel: "noopener" }, label, " ↗")));
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
  const still = Object.values(g.issues || {}).filter((i) => i.status === "still_happening");
  const fresh = items().filter((i) => !i.dev && i.created >= t - DAY);
  // The newest numbered update; a launch post or an unnumbered one only when there's nothing else.
  const release = (g.releases || []).filter((r) => r.version).at(-1) || (g.releases || []).at(-1);

  const tile = (label, value, sub, trend, color) => h("div.kpi", h("div.label", label), h("div.value", value), sub ? h("div.sub", sub) : null, trend ? spark(trend, color) : null);
  const pct = totals && totals.positive + totals.negative ? Math.round((100 * totals.positive) / (totals.positive + totals.negative)) + "%" : "–";
  document.getElementById("fb-stats").replaceChildren(...[
    tile("Players now", current ?? "–", current != null ? `${peak} peak today` : "not released", peaks),
    tile("Positive reviews", pct, totals ? `${totals.positive} 👍 · ${totals.negative} 👎` : "no reviews yet", reviewsPerDay, "var(--fb-positive)"),
    tile("Open bugs", bugs.length, still.length ? `${still.length} still happening` : urgent.length ? `${urgent.length} high or urgent` : "none high or urgent"),
    tile("New posts", fresh.length, "last 24 h", postsPerDay),
    tile("Latest update", release ? (release.version ? "v" + release.version : "–") : "–", release ? `${release.version ? "" : release.name + " · "}${ago(release.time)}` : "none yet"),
  ].filter(Boolean));
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
  };
  const tabs = [["issues", "Issues"], ["suggestions", "Suggestions"], ["feed", "Feed"], ["stats", "Stats"]];
  const buttons = () => tabs.map(([id, label]) =>
    h("button.nav-btn", { type: "button", "aria-current": String(state.tab === id), onclick: () => { state.tab = id; render(); } },
      icon(id), h("span", label), counts[id] != null ? h("span.count", counts[id]) : null));
  document.getElementById("fb-nav-side").replaceChildren(...buttons());
  document.getElementById("fb-nav-top").replaceChildren(...buttons());
  setHash();
  const view = { issues: () => issueView("bug"), suggestions: () => issueView("suggestion"), feed: feedView, stats: statsView }[state.tab]();
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
        h("div.meta", urgencyBadge(issue.urgency), statusBadge(issue), h("span", issue.area), h("span", (issue.languages || []).join(", ")),
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

function postView(item) {
  const t = item.triage || {};
  const parent = item.topic ? state.game.items[item.topic] : null;
  const translated = t.english && t.english.trim() !== (item.text || "").trim();
  const flipped = (item.flips || []).at(-1);
  return h("div.post",
    h("div.meta",
      h("b", KIND[item.kind]),
      item.kind === "review" ? h(item.votedUp ? "span.vote-up" : "span.vote-down", item.votedUp ? "👍 Recommended" : "👎 Not recommended") : null,
      item.kind === "review" && item.playtime != null ? h("span", `${item.playtime} h played`) : null,
      item.author?.name ? h("span", item.author.name) : null,
      t.language ? h("span", t.language) : null,
      h("span", fmtDate(item.created)),
      item.edited ? h("span.badge", { title: `Edited · ${(item.versions || []).length} earlier version(s) kept` }, "edited") : null,
      flipped ? h("span.badge", { class: flipped.to === "negative" ? "s-still" : "s-fixed" }, `flipped ${flipped.to} ${fmtShort(flipped.at)}`) : null,
      item.deleted ? h("span.badge.s-still", "deleted on Steam") : null,
      item.dev ? h("span.badge", "Your post") : null,
      item.forum ? h("span", item.forum) : null,
      t.category ? h("span.badge", t.category) : null,
      t.urgency ? urgencyBadge(t.urgency) : null,
      h("a", { href: item.url, target: "_blank", rel: "noopener" }, "Open on Steam ↗")),
    parent ? h("div.meta", "in “", parent.title || "thread", "”") : null,
    item.title ? h("div", h("b", item.title)) : null,
    h("div.text", english(item)),
    translated ? h("details", h("summary", `Original (${t.language})`), h("div.text", item.text)) : null,
    (item.versions || []).length ? h("details", h("summary", `Earlier versions (${item.versions.length})`),
      ...item.versions.slice().reverse().map((v) => h("div.text", `${fmtDate(v.at)}${v.votedUp == null ? "" : v.votedUp ? " · 👍" : " · 👎"}\n${v.title ? v.title + "\n" : ""}${v.text}`))) : null,
    item.devResponse ? h("details", h("summary", "Your reply on Steam"), h("div.text", item.devResponse)) : null,
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

function statsView() {
  const f = state.filters.stats;
  const wrap = h("div");
  const body = h("div");
  const draw = () => {
    const end = now();
    const start = f.range ? end - f.range * DAY : Math.min(end - 7 * DAY, ...[...(state.game.players || []).map((p) => p[0]), ...items().map((i) => i.created)]);
    const releases = (state.game.releases || []).filter((r) => r.time >= start && r.time <= end);
    body.replaceChildren(
      playersChart(start, end, releases),
      reviewsChart(start, end, releases),
      h("div.grid-2", breakdown("Posts by category", start, (i) => i.triage?.category), breakdown("Posts by language", start, (i) => i.triage?.language)),
    );
  };
  const range = chips([[7, "7D"], [30, "30D"], [90, "90D"], [365, "1Y"], [0, "All"]], f.range, (v) => { f.range = v; draw(); }, "Time range");
  wrap.append(h("div.filters", range), body);
  draw();
  return wrap;
}

const W = 760, H = 220, M = { top: 18, right: 12, bottom: 24, left: 40 };

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

function releaseMarkers(svg, x, releases) {
  let lastLabel = -1e9;
  for (const r of releases) {
    const px = x(r.time);
    svg.append(svgEl("line", { x1: px, x2: px, y1: M.top - 4, y2: H - M.bottom, class: "release" }));
    if (px - lastLabel > 40) {
      const t = svgEl("text", { x: px + 3, y: M.top - 6, class: "release-label" });
      t.textContent = r.version ? "v" + r.version : r.name.slice(0, 18);
      svg.append(t);
      lastLabel = px;
    }
  }
}

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
  const { card, tip } = chartCard("Concurrent players", pts.length ? "Steam's current player count, sampled every run. Dashed lines are updates." : "No player data in this range.", null, svg, table);
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
  const legend = h("div.legend", h("span", h("i", { style: "background:var(--fb-positive)" }), "Recommended"), h("span", h("i", { style: "background:var(--fb-negative)" }), "Not recommended"));
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

function breakdown(title, start, key) {
  const counts = new Map();
  for (const i of items()) {
    if (i.dev || i.created < start) continue;
    const k = key(i) || "not triaged yet";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const rows = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return h("div.chart-card", h("h3", title), h("div.sub", rows.length ? "Posts in this range" : "No posts in this range."),
    h("div.bars", ...rows.flatMap(([k, v]) => [h("span", k), h("div", h("div.bar", { style: `width:${(100 * v) / max}%` })), h("span.n", v)])));
}

// ---------------------------------------------------------------------------
// Mount (called by src/views/FeedbackView.vue once the page is in the browser)
// ---------------------------------------------------------------------------

const SHELL = `
<div class="status" id="fb-status"></div>
<div class="fb-layout">
  <aside class="fb-side" aria-label="Games and views">
    <div class="side-label">Games</div>
    <div id="fb-games-side"></div>
    <div class="side-label">Views</div>
    <nav class="nav-side" id="fb-nav-side" aria-label="Views"></nav>
  </aside>
  <div class="fb-main">
    <div class="strip" id="fb-games-strip" aria-label="Games"></div>
    <header class="top">
      <img id="fb-capsule" alt="" hidden>
      <div><h2 id="fb-title">Loading…</h2><div class="updated" id="fb-updated"></div></div>
    </header>
    <div class="steam-links" id="fb-links"></div>
    <section class="kpis" id="fb-stats" aria-label="Summary"></section>
    <nav class="nav-top" id="fb-nav-top" aria-label="Views"></nav>
    <div id="fb-view"></div>
  </div>
</div>
<div class="toast" id="fb-toast" role="status"></div>`;

export function mount(root) {
  if (!document.getElementById("fb-dash-css")) {
    document.head.append(h("style", { id: "fb-dash-css" }, CSS));
  }
  root.innerHTML = SHELL;
  // Lets the site's header show a "Feedback" link in this browser from now on (SiteHeader.vue).
  store.set("visited", "1");
  init();
}
