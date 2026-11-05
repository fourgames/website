// The dashboard's Market section: Steam as a whole, from the collector on the server
// (server/steamdata). The server works the numbers out once a day (server/steamdata/market.py) and
// hands the files to the signed-in owner (GET /v1/admin/market/<name>); everything here is worked
// out in the browser from those files. Loaded only when the section opens (dashboard.js imports it).
//
// Six views: Trends (alerts and which tags are heating up), Growth (Steam's releases and each tag's
// share over the years), Gaps (enter a goal, get the niches where games like that reached it),
// Hits (the hit index of new releases), Godot finder (Godot games and what we'd improve in each)
// and Leads (the studios behind them, and Godot games still to come out).

const DAY = 86400;
const COLORS = ["var(--sw-1)", "var(--sw-2)", "var(--sw-3)", "var(--sw-4)", "var(--sw-5)"];
const TABS = [["trends", "Trends"], ["growth", "Growth"], ["gaps", "Gap finder"], ["hits", "Hit index"], ["godot", "Godot finder"], ["leads", "Leads"]];
const NEEDS = { trends: ["trends"], growth: ["growth", "trends"], gaps: ["games"], hits: ["games"], godot: ["godot"], leads: ["godot"] };
// What a developer keeps of a sale, roughly: Steam's 30%, then VAT, refunds and discounts.
const NET_SHARE = 0.5;
// Scope: user tags that make a game a bigger job. "Small" leaves out both lists, "Medium" the first.
const HUGE = ["Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Realistic", "Photorealistic"];
const BIG = ["Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Co-op", "Third-Person Shooter", "Souls-like", "Open World", "Sandbox", "Story Rich", "3D", "First-Person"];
// Adult-only games, left out of the gap finder and hit list unless asked for.
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
const STYLES = ["2D", "3D", "Pixel Graphics", "Hand-drawn", "Cartoony", "Cute", "Low-poly", "Anime", "Minimalist", "Stylized", "Top-Down", "Isometric", "Side Scroller"];

let C; // the dashboard's helpers (see marketView)
const mk = {
  tab: "trends", files: {}, loading: {}, errors: {}, root: null,
  trends: { sort: "heat", q: "", shown: 40 },
  growth: { mode: "years", metric: "share", kind: "tags", picked: null },
  gaps: { target: 50000, mult: 30, months: 24, price: "any", scope: "small", adult: false, must: [], pairs: false, open: null, shown: 40 },
  hits: { days: 30, indie: true, godot: false, adult: false, q: "", shown: 50 },
  godot: { status: "released", self: false, q: "", open: null, shown: 50 },
  leads: { view: "studios", shown: 40, open: null },
};

const fmt = (n) => n == null ? "–" : C.fmtNum(Math.round(n));
const money = (cents) => cents == null ? "–" : cents === 0 ? "Free" : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const usd = (n) => n == null ? "–" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const dayDate = (d) => d == null ? "–" : C.fmtDate(d * DAY);
const pct = (x, digits = 0) => x == null ? "–" : `${(x * 100).toFixed(digits)}%`;
const times = (x) => x == null ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const store = (appid) => `https://store.steampowered.com/app/${appid}/`;
const tagName = (id) => mk.files.overview?.tags?.[id] || `Tag ${id}`;
const tagId = (name) => { const t = Object.entries(mk.files.overview?.tags || {}).find(([, n]) => n.toLowerCase() === String(name).trim().toLowerCase()); return t ? Number(t[0]) : null; };
const netOf = (reviews, price) => price ? reviews * mk.gaps.mult * (price / 100) * NET_SHARE : 0;
const today = () => mk.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);

// The header above the view.
export function marketTop(ctx) {
  C = ctx;
  const o = mk.files.overview;
  document.getElementById("fb-capsule").hidden = true;
  document.getElementById("fb-title").replaceChildren("Market");
  document.getElementById("fb-updated").replaceChildren(o
    ? `${fmt(o.games)} games on Steam (${fmt(o.comingSoon)} coming soon), ${fmt(o.godot)} made with Godot · ${C.plural(o.historyDays, "day")} of history · worked out ${C.fmtDateTime(o.builtAt)}`
    : "All of Steam, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) document.getElementById(id).replaceChildren();
}

// The view: one element, kept while the section is open, that redraws itself.
export function marketView(ctx) {
  C = ctx;
  mk.tab = TABS.some(([id]) => id === C.store.get("market-tab")) ? C.store.get("market-tab") : mk.tab;
  mk.root = C.h("div.mk");
  draw();
  load(["overview", ...NEEDS[mk.tab]]);
  return mk.root;
}

async function load(names) {
  const wanted = names.filter((n) => !mk.files[n] && !mk.loading[n]);
  if (!wanted.length) return;
  for (const n of wanted) { mk.loading[n] = true; delete mk.errors[n]; }
  draw();
  await Promise.all(wanted.map(async (n) => {
    try {
      // A test copy (?data=<base url>, like the rest of the dashboard): <base>/market/<name>.json.
      if (C.dataOverride) {
        const res = await fetch(`${C.dataOverride}/market/${n}.json`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
        mk.files[n] = await res.json();
      } else mk.files[n] = await (await C.adminGet(`market/${n}`)).json();
    } catch (e) {
      if (!e.signedOut) mk.errors[n] = e.name === "TimeoutError" ? "The server didn't answer; try again." : /not_built|404/.test(e.message) ? "The market files aren't built yet: they're made once a day on the server (steamdata-market.timer)." : e.message;
    }
    mk.loading[n] = false;
  }));
  if (mk.files.overview) marketTop(C);
  draw();
}

function draw() {
  if (!mk.root) return;
  const y = window.scrollY;
  const h = C.h;
  const nav = C.chips(TABS, mk.tab, (v) => { mk.tab = v; C.store.set("market-tab", v); load(["overview", ...NEEDS[v]]); draw(); }, "Market view");
  const need = ["overview", ...NEEDS[mk.tab]];
  const error = need.map((n) => mk.errors[n]).find(Boolean);
  let body;
  if (error) body = h("p.empty", error, " ", h("button.btn", { type: "button", onclick: () => load(need) }, "Try again"));
  else if (need.some((n) => !mk.files[n])) body = h("p.empty", mk.tab === "gaps" || mk.tab === "hits" ? "Loading three years of releases (a few MB, once)…" : "Loading…");
  else body = { trends: trendsView, growth: growthView, gaps: gapsView, hits: hitsView, godot: godotView, leads: leadsView }[mk.tab]();
  mk.root.replaceChildren(h("div.filters.mk-nav", nav), body);
  window.scrollTo(0, y);
}

// A redraw that keeps the focus (and caret) in the box being typed in.
function redrawKeeping(e) {
  const key = e?.target?.dataset?.key, pos = e?.target?.selectionStart;
  draw();
  if (!key) return;
  const el = mk.root.querySelector(`[data-key="${key}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}
const search = (key, value, placeholder, onInput) => C.h("input", { type: "search", "data-key": key, value, placeholder, "aria-label": placeholder, oninput: (e) => { onInput(e.target.value); redrawKeeping(e); } });
const numberBox = (key, label, value, onInput, attrs = {}) => C.h("label.mk-field", C.h("span", label), C.h("input", { type: "number", "data-key": key, value, ...attrs, oninput: (e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) { onInput(v); redrawKeeping(e); } } }));
const toggle = (label, on, flip) => C.h("button.btn.mk-toggle", { type: "button", "aria-pressed": String(on), onclick: () => { flip(); draw(); } }, label);
const more = (shown, total, bump) => total > shown ? C.h("button.btn.more", { type: "button", onclick: () => { bump(); draw(); } }, `Show more (${fmt(total - shown)} left)`) : null;
const kpi = (label, value, sub) => C.h("div.kpi", C.h("div.label", label), C.h("div.value", value), sub ? C.h("div.sub", sub) : null);
const table = (head, rows) => C.h("div.mk-scroll", C.h("table.data.mk-table", C.h("thead", C.h("tr", ...head.map((x) => C.h("th", x)))), C.h("tbody", ...rows)));
const gameLink = (appid, name) => C.h("a", { href: store(appid), target: "_blank", rel: "noopener" }, name);
// "Indie" is on most of them and says little, so lists leave it out.
const tagList = (ids, n = 3) => (ids || []).filter((t) => t !== 492).slice(0, n).map(tagName).join(", ");

// ---------------------------------------------------------------------------
// Trends: the alerts, and each tag's momentum
// ---------------------------------------------------------------------------

function trendsView() {
  const h = C.h, t = mk.files.trends, f = mk.trends, o = mk.files.overview;
  const change = t.releasesYearAgo ? t.releasesNow / t.releasesYearAgo - 1 : null;
  const kinds = { godot: "Godot", tag: "Trend", breakout: "Breakout" };
  const alerts = t.alerts || [];
  const alertCard = (a) => h("div.mk-alert", { class: `mk-a-${a.kind}` },
    h("span.mk-kind", kinds[a.kind]),
    h("div", h("b", a.appid ? gameLink(a.appid, a.title) : a.title), h("div.mk-detail", a.detail),
      h("div.mk-since", a.since ? `First seen ${C.fmtDate(a.since)}` : "")));
  const sorts = { heat: (r) => r.heat ?? 0, supply: (r) => r.supply ?? 0, hits: (r) => r.hitLift ?? 0, demand: (r) => r.demand ?? 0, releases: (r) => r.releases };
  const q = f.q.trim().toLowerCase();
  const rows = t.tags.filter((r) => !q || r.name.toLowerCase().includes(q)).sort((a, b) => sorts[f.sort](b) - sorts[f.sort](a));
  const heatClass = (x) => x == null ? "" : x >= 2 ? "mk-hot" : x >= 1.25 ? "mk-warm" : x < 0.8 ? "mk-cold" : "";
  return h("div",
    C.about(`Built once a day from every game on Steam. A game counts for its first ${mk.files.games?.topTags || 5} user tags (the strongest). `,
      `Supply: the tag's share of releases in the last ${t.supplyWindow} days against the same ${t.supplyWindow} days a year ago (above 1: more of Steam's new games have it). `,
      `Hit rate: the share of its games released ${t.hitRateWindow[0]}–${t.hitRateWindow[1]} days ago with a hit index of 90 or more (top 10% of their release fortnight), against all new games (${pct(t.baseHitRate)}). `,
      `Reviews: the tag's share of all new reviews in the latest window against the window before; it needs 14 days of history (now ${o.historyDays}). `,
      "Heat combines what's there (a geometric mean). An alert is a tag with heat 2+ that both grows and hits, an indie breakout (hit index 99 within 30 days, under $30) or a Godot game taking off; new ones are posted to Discord when MARKET_DISCORD_WEBHOOK is set on the server."),
    h("div.kpis",
      kpi("Releases, last 90 days", fmt(t.releasesNow), change != null ? `${change >= 0 ? "+" : ""}${pct(change)} vs a year ago` : null),
      kpi("Alerts now", fmt(alerts.length), o.newAlerts ? `${o.newAlerts} new today` : "none new today"),
      kpi("History", C.plural(o.historyDays, "day"), t.window ? `reviews momentum over ${t.window} days` : "reviews momentum from day 14"),
      kpi("Base hit rate", pct(t.baseHitRate), "of new games reach hit index 90")),
    alerts.length ? h("div.chart-card", h("h3", "Alerts"), h("div.sub", "Godot games first, then tags, then breakouts."), h("div.mk-alerts", ...alerts.slice(0, 40).map(alertCard))) : null,
    h("div.chart-card",
      h("h3", "Tags heating up"),
      h("div.sub", `${fmt(t.tags.length)} tags with at least 15 releases in the last ${t.supplyWindow} days.`),
      h("div.filters", search("trend-q", f.q, "Find a tag", (v) => { f.q = v; }),
        C.chips([["heat", "Heat"], ["supply", "Supply"], ["hits", "Hit rate"], ["demand", "Reviews"], ["releases", "Releases"]], f.sort, (v) => { f.sort = v; draw(); }, "Sort by")),
      table(["Tag", "Releases (90 d)", "A year ago", "Supply", "Hit rate", "Reviews", "Median reviews", "Heat"],
        rows.slice(0, f.shown).map((r) => h("tr",
          h("td", r.name), h("td", fmt(r.releases)), h("td", fmt(r.releasesYearAgo)), h("td", times(r.supply)),
          h("td", r.hitRate == null ? "–" : `${pct(r.hitRate)} (${times(r.hitLift)})`), h("td", r.demand == null ? "–" : times(r.demand)),
          h("td", fmt(r.medianReviews)), h("td", { class: heatClass(r.heat) }, r.heat == null ? "–" : r.heat.toFixed(2))))),
      more(f.shown, rows.length, () => { f.shown += 40; })));
}

// ---------------------------------------------------------------------------
// Growth: Steam's releases, and each tag's (or genre's) share of them
// ---------------------------------------------------------------------------

function growthView() {
  const h = C.h, g = mk.files.growth, f = mk.growth;
  const years = f.mode === "years";
  const labels = years ? g.years.map(String) : g.months;
  const key = years ? "y" : "m", rkey = years ? "yr" : "mr";
  const pool = f.kind === "tags" ? g.tags : g.genres;
  if (!f.picked || !f.picked.every((id) => pool[id])) {
    // Start with the hottest big tags, so the chart says something at once.
    const hot = f.kind === "tags" ? (mk.files.trends?.tags || []).filter((r) => r.releases >= 60).slice(0, 4).map((r) => String(r.tag)).filter((id) => pool[id]) : [];
    f.picked = hot.length ? hot : Object.entries(pool).sort((a, b) => b[1].y.at(-1) - a[1].y.at(-1)).slice(0, 4).map(([id]) => id);
  }
  // This year (or month) so far, scaled up to a whole one, as a dashed line.
  const done = years ? g.yearDone : g.monthDone;
  const total = g.total[key];
  const steam = lineChart({
    labels, aria: "Steam releases per " + (years ? "year" : "month"),
    series: [{ name: "Games released", color: "var(--sw-1)", values: total }],
    pace: done > 0 && done < 1 ? { index: total.length - 1, value: total.at(-1) / done } : null,
    fmt: fmt,
  });
  const metricOf = (s, i) => f.metric === "share" ? (total[i] ? s[key][i] / total[i] : null)
    : f.metric === "reviewShare" ? (g.total[rkey][i] ? s[rkey][i] / g.total[rkey][i] : null)
    : f.metric === "perGame" ? (s[key][i] ? s[rkey][i] / s[key][i] : null)
    : s[key][i];
  const fmtMetric = (v) => v == null ? "–" : f.metric === "share" || f.metric === "reviewShare" ? `${(v * 100).toFixed(1)}%` : fmt(v);
  // By year from 2012: before that Steam had a few hundred games a year, so shares jump about.
  const from = years ? Math.max(0, g.years.indexOf(2012)) : 0;
  const series = f.picked.map((id, i) => ({ name: pool[id].name, color: COLORS[i % COLORS.length], values: labels.map((_, j) => metricOf(pool[id], j)).slice(from) }));
  const tagChart = lineChart({ labels: labels.slice(from), series, fmt: fmtMetric, aria: "Tags compared" });
  const options = Object.entries(pool).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const add = h("input", { list: "mk-pool", placeholder: f.kind === "tags" ? "Add a tag…" : "Add a genre…", "aria-label": "Add to the chart", onchange: (e) => {
    const found = options.find(([, s]) => s.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (found && !f.picked.includes(found[0])) { f.picked = [...f.picked, found[0]].slice(-5); draw(); }
    e.target.value = "";
  } });
  const sub = { share: "Share of each period's releases", reviewShare: "Share of the reviews that period's releases have today", perGame: "Reviews per game released (today's counts)", count: "Games released" }[f.metric];
  return h("div",
    C.about(g.note, " The last year (or month) is still going: the dashed line is its pace for a whole one. Share of releases shows what developers make; share of reviews shows what players buy, so a tag whose review share runs ahead of its release share is under-supplied. Genres are the store's own (only for games whose full metadata is in, which is all of them a few days after the collector started)."),
    h("div.filters", C.chips([["years", "By year"], ["months", "By month (6 years)"]], f.mode, (v) => { f.mode = v; draw(); }, "Period")),
    chartBox("Steam's growth", `${fmt(total.reduce((a, b) => a + b, 0))} games released ${labels[0]}–${labels.at(-1)}.`, steam),
    h("div.filters",
      C.chips([["tags", "Tags"], ["genres", "Genres"]], f.kind, (v) => { f.kind = v; f.picked = null; draw(); }, "Tags or genres"),
      C.chips([["share", "Share of releases"], ["reviewShare", "Share of reviews"], ["perGame", "Reviews per game"], ["count", "Releases"]], f.metric, (v) => { f.metric = v; draw(); }, "Measure")),
    chartBox(`${f.kind === "tags" ? "Tags" : "Genres"} against Steam`, sub, tagChart,
      h("div.mk-picked", ...f.picked.map((id, i) => h("button.btn.mk-tagbtn", { type: "button", title: "Remove", onclick: () => { f.picked = f.picked.filter((x) => x !== id); draw(); } },
        h("i", { style: `background:${COLORS[i % COLORS.length]}` }), pool[id].name, " ×")),
        f.picked.length < 5 ? add : null,
        h("datalist", { id: "mk-pool" }, ...options.map(([, s]) => h("option", { value: s.name }))))));
}

function chartBox(title, sub, chart, extra) {
  const card = C.h("div.chart-card", C.h("h3", title), C.h("div.sub", sub), extra || null, chart.legend, chart.svg, chart.table);
  card.append(chart.tip);
  chart.attach(card);
  return card;
}

// A line chart over evenly spaced labels: [{name, color, values}], with a hover readout.
function lineChart({ labels, series, fmt: f, aria, pace }) {
  const h = C.h, svgEl = C.svgEl;
  const W = 760, H = 260, M = { top: 16, right: 16, bottom: 26, left: 52 };
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (pace) all.push(pace.value);
  const max = niceMax(Math.max(...all, 0) || 1);
  const n = labels.length;
  const x = (i) => M.left + (n === 1 ? 0 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": aria });
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "grid" : "base" }));
    const t = svgEl("text", { x: M.left - 6, y: y(v) + 4, "text-anchor": "end" });
    t.textContent = f(v);
    svg.append(t);
  }
  const every = Math.max(1, Math.ceil(n / 10));
  labels.forEach((l, i) => {
    if (i % every && i !== n - 1) return;
    const t = svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" });
    t.textContent = l;
    svg.append(t);
  });
  for (const s of series) {
    let d = "", pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)},${y(v)}`; pen = true; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }));
  }
  if (pace) {
    const i = pace.index, v0 = series[0].values[i - 1];
    if (v0 != null) svg.append(svgEl("path", { d: `M${x(i - 1)},${y(v0)}L${x(i)},${y(pace.value)}`, fill: "none", stroke: series[0].color, "stroke-width": 1.5, "stroke-dasharray": "4 3" }));
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "cross", visibility: "hidden" });
  svg.append(cross);
  const tip = h("div.tip");
  const legend = series.length > 1 ? h("div.legend", ...series.map((s) => h("span", h("i", { style: `background:${s.color}` }), s.name))) : null;
  // The data table, newest first; the pace (when there is one) next to the period still going.
  const rows = labels.map((l, i) => h("tr", h("td", l), ...series.map((s) => h("td", f(s.values[i]))),
    pace ? h("td", i === pace.index ? f(pace.value) : "") : null)).reverse();
  const tableEl = h("details", h("summary", "Data table"),
    h("div.mk-scroll", h("table.data", h("tr", h("th", ""), ...series.map((s) => h("th", s.name)), pace ? h("th", "Pace") : null), ...rows)));
  return {
    svg, tip, legend, table: tableEl,
    attach(card) {
      const move = (ev) => {
        const box = svg.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        tip.replaceChildren(h("div.t", labels[i]), ...series.map((s) => h("div", h("b", { style: `color:${s.color}` }, f(s.values[i])), " ", s.name)),
          pace && i === pace.index ? h("div.t", `pace for the whole period: ${f(pace.value)}`) : null);
        tip.style.display = "block";
        const cbox = card.getBoundingClientRect();
        let left = box.left - cbox.left + (x(i) / W) * box.width + 12;
        if (left + tip.offsetWidth > cbox.width - 8) left -= tip.offsetWidth + 24;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${box.top - cbox.top + 8}px`;
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerleave", () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); });
    },
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 4, 5, 8, 10].map((m) => m * p).find((m) => m >= v);
}

// ---------------------------------------------------------------------------
// The games file: compact rows, unpacked once
// ---------------------------------------------------------------------------

let unpacked = null;
function games() {
  const file = mk.files.games;
  if (unpacked?.file === file) return unpacked.list;
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  const F = file.flags;
  const list = file.rows.map((r) => ({
    appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price], reviews: r[col.reviews] || 0, pos: r[col.pos],
    tags: r[col.tags] || [], top: (r[col.tags] || []).slice(0, file.topTags), flags: r[col.flags], langs: r[col.langs], hit: r[col.hit],
    gain7: r[col.gain7], gain28: r[col.gain28], players: r[col.players],
    indie: (r[col.tags] || []).includes(492), godot: !!(r[col.flags] & F.godot), free: !!(r[col.flags] & F.free),
  }));
  unpacked = { file, list };
  return list;
}

// ---------------------------------------------------------------------------
// Gap finder: a goal in, niches out
// ---------------------------------------------------------------------------

function gapsView() {
  const h = C.h, f = mk.gaps;
  const since = today() - Math.round(f.months * 30.44);
  const must = f.must.map(tagId).filter((x) => x != null);
  const priceOk = { any: () => true, low: (p) => p < 1000, mid: (p) => p >= 1000 && p < 2000, high: (p) => p >= 2000 }[f.price];
  const banned = new Set([...(f.scope !== "any" ? HUGE : []), ...(f.scope === "small" ? BIG : []), ...(f.adult ? [] : ADULT)].map(tagId).filter((x) => x != null));
  // Paid games old enough to have found their audience (60+ days), in the window, matching the goal.
  const pool = games().filter((g) => g.day >= since && g.day <= today() - 60 && g.price > 0 && priceOk(g.price)
    && must.every((t) => g.tags.includes(t)) && !g.top.some((t) => banned.has(t)));
  const reached = (g) => netOf(g.reviews, g.price) >= f.target;
  const base = pool.length ? pool.filter(reached).length / pool.length : null;
  // Each niche: a tag (or a pair of tags) among a game's strongest ones.
  const niches = new Map();
  for (const g of pool) {
    const own = g.top.filter((t) => !must.includes(t));
    const keys = f.pairs ? own.flatMap((a, i) => own.slice(i + 1).map((b) => a < b ? `${a}+${b}` : `${b}+${a}`)) : own.map(String);
    for (const k of keys) { let n = niches.get(k); if (!n) niches.set(k, n = []); n.push(g); }
  }
  const min = f.pairs ? 8 : 12;
  const rows = [...niches].filter(([, gs]) => gs.length >= min).map(([k, gs]) => {
    const hits = gs.filter(reached).length;
    // Odds shrunk toward the base rate, so a niche of 12 games doesn't beat one of 300 by luck.
    const odds = (hits + 5 * (base ?? 0.1)) / (gs.length + 5);
    const perMonth = gs.length / f.months;
    return { k, name: k.split("+").map(tagName).join(" + "), gs, n: gs.length, hits, odds, perMonth,
      medReviews: median(gs.map((g) => g.reviews)), medPrice: median(gs.map((g) => g.price)), medNet: median(gs.map((g) => netOf(g.reviews, g.price))),
      // Odds per unit of crowding: a niche where many reach the goal but few compete.
      score: odds / Math.log10(10 + perMonth) };
  }).sort((a, b) => b.score - a.score);
  const needed = (price) => Math.ceil(f.target / (f.mult * (price / 100) * NET_SHARE));
  const addMust = h("input", { list: "mk-tags", placeholder: "Must have a tag…", "aria-label": "Must have a tag", onchange: (e) => {
    const id = tagId(e.target.value);
    if (id != null && !f.must.includes(tagName(id))) { f.must = [...f.must, tagName(id)]; draw(); }
    e.target.value = "";
  } });
  const tagOptions = h("datalist", { id: "mk-tags" }, ...Object.values(mk.files.overview.tags).sort().map((n) => h("option", { value: n })));
  const open = rows.find((r) => r.k === f.open);
  return h("div",
    C.about(`Enter what you want a game to earn; this looks at paid games released in the last ${f.months} months (and at least 60 days ago, so they've found their audience) and asks, niche by niche, how many of them earned that much. `,
      `Earned is an estimate: reviews × ${f.mult} (sales per review; 20–60 is the usual range, lower for older and cheaper games) × the game's own price × ${NET_SHARE} (what's left after Steam's 30%, VAT, refunds and discounts). `,
      "A niche is one of a game's strongest 5 user tags (or a pair of them). Score is the odds of reaching the goal (shrunk toward the average for small niches) divided by how crowded it is (releases a month, on a log scale): high means games like this often reach it and few are made. ",
      `Scope: Small leaves out games whose strongest tags include ${[...HUGE, ...BIG].join(", ")}; Medium only the first ${HUGE.length}. Adult-only games (${ADULT.join(", ")}) are left out unless Adult games is on.`),
    h("div.filters.mk-goal",
      numberBox("target", "Goal, net $", f.target, (v) => { f.target = v; }, { step: 5000, min: 0 }),
      numberBox("mult", "Sales per review", f.mult, (v) => { f.mult = v || 30; }, { step: 5, min: 5, max: 100 }),
      C.chips([[12, "12 months"], [24, "24 months"], [36, "36 months"]], f.months, (v) => { f.months = v; draw(); }, "Released within"),
      C.chips([["any", "Any price"], ["low", "Under $10"], ["mid", "$10–20"], ["high", "$20+"]], f.price, (v) => { f.price = v; draw(); }, "Price"),
      C.chips([["small", "Small scope"], ["medium", "Medium"], ["any", "Any scope"]], f.scope, (v) => { f.scope = v; draw(); }, "Scope"),
      C.chips([[false, "Single tags"], [true, "Tag pairs"]], f.pairs, (v) => { f.pairs = v; f.open = null; draw(); }, "Niches"),
      toggle("Adult games", f.adult, () => { f.adult = !f.adult; })),
    h("div.filters",
      h("span.mk-label", "Art style:"),
      ...STYLES.filter((s) => tagId(s) != null).map((s) => toggle(s, f.must.includes(s), () => { f.must = f.must.includes(s) ? f.must.filter((x) => x !== s) : [...f.must, s]; })),
      ...f.must.filter((s) => !STYLES.includes(s)).map((s) => h("button.btn.mk-tagbtn", { type: "button", "aria-pressed": "true", onclick: () => { f.must = f.must.filter((x) => x !== s); draw(); } }, `${s} ×`)),
      addMust, tagOptions),
    h("div.kpis",
      kpi("Comparable games", fmt(pool.length), f.must.length ? `with ${f.must.join(" + ")}` : "paid, in the window"),
      kpi("Reached the goal", base == null ? "–" : pct(base, 1), `${fmt(pool.filter(reached).length)} games`),
      kpi("Reviews needed", `${fmt(needed(999))} / ${fmt(needed(1999))}`, "at $9.99 / $19.99"),
      kpi("Niches", fmt(rows.length), `with ${min}+ games`)),
    !rows.length ? h("p.empty", "No niche has enough games for these settings: widen the window, the price or the scope, or take a tag away.") :
    h("div.chart-card", h("h3", "Niches, best first"), h("div.sub", "Click a niche for its games."),
      table(["Niche", "Games", "A month", "Reached goal", "Odds", "Median reviews", "Median price", "Median net", "Score"],
        rows.slice(0, f.shown).flatMap((r) => [
          h("tr.mk-click", { "aria-expanded": String(f.open === r.k), onclick: () => { f.open = f.open === r.k ? null : r.k; draw(); } },
            h("td", h("b", r.name)), h("td", fmt(r.n)), h("td", r.perMonth.toFixed(1)), h("td", `${fmt(r.hits)} (${pct(r.hits / r.n)})`),
            h("td", pct(r.odds)), h("td", fmt(r.medReviews)), h("td", money(r.medPrice)), h("td", usd(r.medNet)), h("td", (r.score * 100).toFixed(1))),
          r === open ? h("tr.mk-sub", h("td", { colspan: 9 }, nicheGames(r))) : null,
        ])),
      more(f.shown, rows.length, () => { f.shown += 40; })));
}

function nicheGames(r) {
  const h = C.h;
  const top = [...r.gs].sort((a, b) => b.reviews - a.reviews).slice(0, 12);
  return h("div.mk-scroll", h("table.data", h("tr", h("th", "Game"), h("th", "Released"), h("th", "Reviews"), h("th", "Positive"), h("th", "Price"), h("th", "Net (est.)"), h("th", "Tags")),
    ...top.map((g) => h("tr", h("td", gameLink(g.appid, g.name), g.godot ? h("span.mk-godot", "Godot") : null), h("td", dayDate(g.day)), h("td", fmt(g.reviews)),
      h("td", g.pos == null ? "–" : `${g.pos}%`), h("td", money(g.price)), h("td", usd(netOf(g.reviews, g.price))), h("td.mk-tags", tagList(g.top, 5))))));
}

// ---------------------------------------------------------------------------
// Hit index: new releases against the games released the same fortnight
// ---------------------------------------------------------------------------

function hitsView() {
  const h = C.h, f = mk.hits, t = today();
  const q = f.q.trim().toLowerCase();
  const qTag = q ? tagId(q) : null;
  const adult = new Set(ADULT.map(tagId).filter((x) => x != null));
  const list = games().filter((g) => t - g.day <= f.days && g.hit != null && (!f.indie || g.indie) && (!f.godot || g.godot) && (f.adult || !g.top.some((x) => adult.has(x)))
    && (!q || g.name.toLowerCase().includes(q) || (qTag != null && g.tags.includes(qTag))))
    .sort((a, b) => b.hit - a.hit || b.reviews - a.reviews);
  const anyGain = list.some((g) => g.gain7 != null);
  return h("div",
    C.about("The hit index is a game's review count as a percentile among every game released within a week of it (with or without reviews), so a game is only compared with games of the same age. 99 means more reviews than 99% of them. ",
      "Reviews come from the daily snapshot; +7 days needs a week of history. Net is the same estimate as the gap finder's."),
    h("div.filters",
      C.chips([[7, "Last 7 days"], [30, "30 days"], [90, "90 days"], [365, "A year"]], f.days, (v) => { f.days = v; draw(); }, "Released within"),
      toggle("Indie only", f.indie, () => { f.indie = !f.indie; }), toggle("Godot only", f.godot, () => { f.godot = !f.godot; }), toggle("Adult games", f.adult, () => { f.adult = !f.adult; }),
      search("hits-q", f.q, "Find a game or a tag", (v) => { f.q = v; })),
    h("div.kpis",
      kpi("Released", fmt(list.length), `in the last ${f.days} days`),
      kpi("Hit index 90+", fmt(list.filter((g) => g.hit >= 90).length)),
      kpi("Hit index 99", fmt(list.filter((g) => g.hit >= 99).length))),
    h("div.chart-card", h("h3", "New releases by hit index"),
      table(["Game", "Released", "Reviews", anyGain ? "+7 days" : null, "Positive", "Hit index", "Price", "Net (est.)", "Tags"].filter(Boolean),
        list.slice(0, f.shown).map((g) => h("tr",
          h("td", gameLink(g.appid, g.name), g.godot ? h("span.mk-godot", "Godot") : null), h("td", `${dayDate(g.day)} (${t - g.day} d)`), h("td", fmt(g.reviews)),
          anyGain ? h("td", g.gain7 == null ? "–" : `+${fmt(g.gain7)}`) : null, h("td", g.pos == null ? "–" : `${g.pos}%`),
          h("td", h("b", { class: g.hit >= 99 ? "mk-hot" : g.hit >= 90 ? "mk-warm" : "" }, g.hit)), h("td", money(g.price)),
          h("td", usd(netOf(g.reviews, g.price))), h("td.mk-tags", tagList(g.top, 4))))),
      more(f.shown, list.length, () => { f.shown += 50; })));
}

// ---------------------------------------------------------------------------
// Godot finder: what's worth acquiring, and what we'd improve
// ---------------------------------------------------------------------------

// What we'd fix in a game, each with a weight (how much it should help, and how cheap it is for us).
function fixes(g) {
  const out = [];
  const add = (label, weight, why) => out.push({ label, weight, why });
  if (g.comingSoon) return out;
  if (!g.linux) add("Linux build", 1, "Godot exports to Linux as is; Steam Deck players use it too");
  if (!g.mac) add("macOS build", 1, "Godot exports to macOS; needs signing and notarizing");
  if (!g.deck) add("Steam Deck check", 1.5, "no Deck rating yet: test and ask Valve for a review");
  else if (g.deck === 1) add("Steam Deck support", 2, "rated Unsupported on Deck");
  if (g.languages != null && g.languages < 5) add(`Localization (${g.languages} language${g.languages === 1 ? "" : "s"})`, 2, "few languages: our pipeline does 30");
  if (g.achievements === 0) add("Achievements", 0.5, "none on Steam");
  if (g.details && !g.controller) add("Controller support", 1, "no controller support listed");
  if (g.details && !g.demos && g.reviews < 500) add("A demo", 0.5, "no demo on the store");
  if (g.earlyAccess && g.day != null && today() - g.day > 365) add("Leave Early Access", 1.5, "in Early Access over a year");
  if (g.price != null && g.price > 0 && g.price < 500 && (g.pos ?? 0) >= 85 && g.reviews >= 100) add("Price", 0.5, "well liked at under $5");
  return out;
}

function godotScore(g) {
  if (g.comingSoon || !g.reviews || g.pos == null) return { score: 0, quality: 0, upside: 0, fix: 0, list: fixes(g) };
  const list = fixes(g);
  // How much to trust it: 10 reviews is a hint (about half), 100 is a signal.
  const trust = Math.min(1, Math.log10(g.reviews + 1) / 2);
  // Quality: how well liked.
  const quality = 40 * Math.max(0, Math.min(1, (g.pos - 70) / 25)) * trust;
  // Upside: few reviews for that quality means it hasn't found its audience yet.
  const upside = 30 * Math.max(0, Math.min(1, 1 - Math.log10(Math.max(g.reviews, 10)) / Math.log10(20000)));
  const fix = Math.min(30, list.reduce((a, x) => a + x.weight, 0) * 5) * trust;
  return { score: Math.round(quality + upside + fix), quality, upside, fix, list };
}

function godotView() {
  const h = C.h, f = mk.godot;
  const q = f.q.trim().toLowerCase();
  const all = mk.files.godot.games.map((g) => ({ ...g, s: godotScore(g) }));
  const list = all.filter((g) => (f.status === "all" || (f.status === "released") === !g.comingSoon) && (!f.self || g.selfPublished)
    && (!q || g.name.toLowerCase().includes(q) || g.developers.some((d) => d.toLowerCase().includes(q)) || g.tags.some((t) => tagName(t).toLowerCase() === q)))
    .sort((a, b) => b.s.score - a.s.score || b.reviews - a.reviews);
  const sources = { pcgamingwiki: "PCGamingWiki", store_legal: "store legal notice", store_text: "store description", manual: "added by hand" };
  const detail = (g) => h("div.mk-detail-box",
    g.about ? h("p", g.about) : null,
    h("p", h("b", "Why it scores "), `${g.s.score}: quality ${Math.round(g.s.quality)}/40, upside ${Math.round(g.s.upside)}/30, things to improve ${Math.round(g.s.fix)}/30.`),
    g.s.list.length ? h("ul", ...g.s.list.map((x) => h("li", h("b", x.label), ` – ${x.why}`))) : h("p", "Nothing obvious to improve from the store data."),
    h("p", h("b", "Studio: "), `${g.developers.join(", ") || "?"}${g.selfPublished ? " (self-published)" : `, published by ${g.publishers.join(", ")}`}; ${C.plural(g.devGames, "other game")} on Steam with ${fmt(g.devReviews)} reviews${g.devGodotGames ? `, ${g.devGodotGames} of them in Godot` : ""}.`),
    h("p", h("b", "Godot, says: "), g.signals.map((s) => `${sources[s.source] || s.source}${s.evidence ? ` ("${s.evidence}")` : ""}`).join("; ") || "?"),
    h("p", [g.languages != null ? `${g.languages} languages${g.fullAudio ? ` (${g.fullAudio} with audio)` : ""}` : "languages not fetched yet", g.achievements != null ? `${g.achievements} achievements` : null, g.controller ? `controller: ${g.controller}` : null, g.dlc ? `${g.dlc} DLC` : null, g.metacritic ? `Metacritic ${g.metacritic}` : null, g.players ? `most players seen: ${fmt(g.players)}` : null].filter(Boolean).join(" · ")),
    h("div.gd-actions", h("a.btn", { href: store(g.appid), target: "_blank", rel: "noopener" }, "Store page ↗"),
      h("button.btn", { type: "button", onclick: (e) => C.copy(leadText([g]), e.currentTarget) }, "Copy for Claude")));
  return h("div",
    C.about("Every game a public source says is made with Godot (PCGamingWiki, the store's legal notice or description; README in server/steamdata). ",
      "Score (0–100) = quality (well reviewed) + upside (fewer reviews than that quality deserves) + what we'd improve: builds Godot makes easy (Linux, macOS, Steam Deck), localization, achievements, controller support, a demo, Early Access. ",
      "Quality and things to improve count fully from 100 reviews (about half at 10). The things to improve need the store's full metadata, which every game has a few days after the collector started; until then some are unknown and left out."),
    h("div.filters",
      C.chips([["released", "Released"], ["soon", "Coming soon"], ["all", "All"]], f.status, (v) => { f.status = v; draw(); }, "Status"),
      toggle("Self-published", f.self, () => { f.self = !f.self; }),
      search("godot-q", f.q, "Find a game, studio or tag", (v) => { f.q = v; })),
    h("div.kpis",
      kpi("Godot games", fmt(all.length), `${fmt(all.filter((g) => g.comingSoon).length)} coming soon`),
      kpi("Score 60+", fmt(all.filter((g) => g.s.score >= 60).length)),
      kpi("Self-published", fmt(all.filter((g) => g.selfPublished && !g.comingSoon).length), "released")),
    h("div.chart-card", h("h3", "Godot games, most promising first"), h("div.sub", "Click a game for why, and what we'd do."),
      table(["Game", "Score", "Reviews", "Positive", "Hit", "Price", "Released", "We'd improve"],
        list.slice(0, f.shown).flatMap((g) => [
          h("tr.mk-click", { "aria-expanded": String(f.open === g.appid), onclick: () => { f.open = f.open === g.appid ? null : g.appid; draw(); } },
            h("td", h("b", g.name), h("div.mk-tags", g.developers.join(", "))), h("td", h("b", { class: g.s.score >= 60 ? "mk-hot" : g.s.score >= 45 ? "mk-warm" : "" }, g.s.score)),
            h("td", fmt(g.reviews)), h("td", g.pos == null ? "–" : `${g.pos}%`), h("td", g.hit ?? "–"), h("td", money(g.price)),
            h("td", g.comingSoon ? (g.releaseDisplay || "coming soon") : dayDate(g.day)),
            h("td", ...g.s.list.slice(0, 4).map((x) => h("span.mk-fix", x.label)))),
          f.open === g.appid ? h("tr.mk-sub", h("td", { colspan: 8 }, detail(g))) : null,
        ])),
      more(f.shown, list.length, () => { f.shown += 50; })));
}

// ---------------------------------------------------------------------------
// Leads: the studios behind the Godot games, and Godot games still to come
// ---------------------------------------------------------------------------

function leadText(list) {
  return list.map((g) => [
    `${g.name} (https://store.steampowered.com/app/${g.appid}/)`,
    `Developer: ${g.developers.join(", ") || "?"}; publisher: ${g.selfPublished ? "self-published" : g.publishers.join(", ")}`,
    g.comingSoon ? `Coming soon (${g.releaseDisplay || "no date"})` : `Released ${dayDate(g.day)}; ${g.reviews} reviews, ${g.pos ?? "?"}% positive; price ${money(g.price)}`,
    `Tags: ${tagList(g.tags, 8)}`,
    `Platforms: Windows${g.linux ? ", Linux" : ""}${g.mac ? ", macOS" : ""}; Steam Deck: ${["unknown", "unsupported", "playable", "verified"][g.deck ?? 0]}; languages: ${g.languages ?? "?"}`,
    `What we'd improve: ${fixes(g).map((x) => x.label).join(", ") || "nothing obvious"}`,
    g.about ? `About: ${g.about}` : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function leadsView() {
  const h = C.h, f = mk.leads;
  const list = mk.files.godot.games.map((g) => ({ ...g, s: godotScore(g) }));
  const studios = new Map();
  for (const g of list) {
    const key = g.developers[0] || "(unknown)";
    let s = studios.get(key);
    if (!s) studios.set(key, s = { name: key, games: [], reviews: 0 });
    s.games.push(g);
    s.reviews += g.reviews;
  }
  const rows = [...studios.values()].map((s) => {
    const best = s.games.reduce((a, b) => b.s.score > a.s.score ? b : a);
    const soon = s.games.filter((g) => g.comingSoon);
    const latest = Math.max(...s.games.map((g) => g.day ?? 0));
    return { ...s, best, soon, latest, self: s.games.every((g) => g.selfPublished), others: best.devGames - (s.games.length - 1),
      // A lead: the best game's score, more for a studio that's still making games in Godot.
      score: best.s.score + (soon.length ? 10 : 0) + (today() - latest < 365 ? 5 : 0) };
  }).sort((a, b) => b.score - a.score);
  const upcoming = list.filter((g) => g.comingSoon).sort((a, b) => (a.day ?? 1e9) - (b.day ?? 1e9));
  const studioRow = (s) => [
    h("tr.mk-click", { "aria-expanded": String(f.open === s.name), onclick: () => { f.open = f.open === s.name ? null : s.name; draw(); } },
      h("td", h("b", s.name)), h("td", fmt(s.score)), h("td", s.games.length), h("td", fmt(s.reviews)), h("td", s.best.name),
      h("td", s.soon.length ? s.soon.map((g) => g.name).join(", ") : "–"), h("td", s.self ? "yes" : "no"), h("td", s.latest ? dayDate(s.latest) : "–")),
    f.open === s.name ? h("tr.mk-sub", h("td", { colspan: 8 }, h("div.mk-detail-box",
      h("p", `${s.best.devGames + 1} games on Steam in all${s.best.devReviews ? `, ${fmt(s.best.devReviews + s.best.reviews)} reviews` : ""}.`),
      h("ul", ...s.games.map((g) => h("li", gameLink(g.appid, g.name), ` – ${g.comingSoon ? `coming ${g.releaseDisplay || "soon"}` : `${fmt(g.reviews)} reviews, ${g.pos ?? "?"}%`}; score ${g.s.score}`))),
      h("div.gd-actions", h("button.btn", { type: "button", onclick: (e) => C.copy(`Studio: ${s.name}\n\n${leadText(s.games)}`, e.currentTarget) }, "Copy for Claude"))))) : null,
  ];
  return h("div",
    C.about("Studios: everyone with a Godot game on Steam, best lead first (their best game's Godot finder score, plus 10 if they have a Godot game coming and 5 if they released one in the last year). Self-published studios are the ones a publishing deal is for. ",
      "Coming soon: Godot games not out yet, soonest first: publishing leads before they ship. Copy for Claude puts a studio's facts on the clipboard, for drafting a first message. Steam doesn't show wishlists, so this can't rank by them."),
    h("div.filters", C.chips([["studios", `Studios (${studios.size})`], ["soon", `Coming soon (${upcoming.length})`]], f.view, (v) => { f.view = v; f.shown = 40; draw(); }, "Leads")),
    f.view === "studios"
      ? h("div.chart-card", h("h3", "Studios making Godot games"),
        table(["Studio", "Lead score", "Godot games", "Reviews", "Best game", "Coming soon", "Self-published", "Latest"], rows.slice(0, f.shown).flatMap(studioRow)),
        more(f.shown, rows.length, () => { f.shown += 40; }))
      : h("div.chart-card", h("h3", "Godot games coming soon"),
        table(["Game", "Studio", "Release", "Publisher", "Tags", ""], upcoming.slice(0, f.shown).map((g) => h("tr",
          h("td", gameLink(g.appid, g.name)), h("td", g.developers.join(", ") || "?"), h("td", g.releaseDisplay || dayDate(g.day)),
          h("td", g.selfPublished ? "self" : g.publishers.join(", ")), h("td.mk-tags", tagList(g.tags, 4)),
          h("td", h("button.btn", { type: "button", onclick: (e) => C.copy(leadText([g]), e.currentTarget) }, "Copy"))))),
        more(f.shown, upcoming.length, () => { f.shown += 40; })));
}
