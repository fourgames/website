// The dashboard's Market section, "Analyst" variant: a dense, explained data tool.
// Same contract as market.js: marketTop(ctx) fills the page header, marketView(ctx) returns one root
// element that redraws itself. The numbers come from server/steamdata/market.py (once a day).
//
// Five views:
// - Niches: every tag as a dot (how crowded × how often its games become hits), a sortable table with
//   every column explained, and a tag-pair gap finder that shrinks small samples toward Steam's rate.
// - Growth: games released vs Steam's peak users (both 2018 = 100), then picked tags' share of
//   releases against their share of reviews, year by year.
// - Godot & leads: Godot games ranked for scouting (upcoming and young self-published first), with why.
// - Upcoming: coming-soon games on any engine, self-published, in hot tags, by studios with a past game.
// - Releases: the hit index of new releases.

const DAY = 86400;
const INDIE = 492;
const PRIOR = 30; // pseudo-games at Steam's rate added to every niche (same as the server's priorGames)
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
const TABS = [["niches", "Niches"], ["growth", "Growth"], ["godot", "Godot & leads"], ["upcoming", "Upcoming"], ["releases", "Releases"]];
const NEEDS = { niches: ["trends"], growth: ["growth", "trends"], godot: ["godot", "trends"], upcoming: ["upcoming", "trends"], releases: ["games"] };
// Loaded after the view first draws (the view works without them, then gets better).
const WANTS = { niches: ["games"] };
const KEY = "mkv-analyst-";
const SER = { blue: "var(--sw-1)", orange: "var(--sw-2)", green: "var(--sw-3)", yellow: "var(--sw-4)", pink: "var(--sw-5)" };

// ---------------------------------------------------------------------------
// Pure helpers (no DOM): exported under _test for the smoke test
// ---------------------------------------------------------------------------

const fmtK = (n) => n == null || !Number.isFinite(n) ? "–" : Math.abs(n) < 1000 ? String(Math.round(n)) : Math.abs(n) < 1e6 ? `${+(n / 1000).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const pct = (x, d = 0) => x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null || !Number.isFinite(x) ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const dayDate = (d) => d == null ? "–" : new Date(d * DAY * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const money = (c) => c == null ? "–" : c === 0 ? "Free" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const shrink = (hits, n, base) => (hits + PRIOR * base) / (n + PRIOR);
// How sure: the share of the estimate that comes from the niche's own games (the rest is Steam's rate).
function confidence(n) {
  const w = n / (n + PRIOR);
  return { w, level: n >= 120 ? 3 : n >= 45 ? 2 : 1, word: n >= 120 ? "High" : n >= 45 ? "Medium" : "Low" };
}
// A rough 90% range for a shrunk rate, in percentage points.
const spread = (p, n) => 1.64 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / (n + PRIOR));
function growthWord(supply) {
  if (supply == null) return { word: "–", dir: 0 };
  if (supply >= 1.5) return { word: "Growing fast", dir: 2 };
  if (supply >= 1.1) return { word: "Growing", dir: 1 };
  if (supply > 0.9) return { word: "Steady", dir: 0 };
  if (supply > 0.67) return { word: "Shrinking", dir: -1 };
  return { word: "Shrinking fast", dir: -2 };
}
function whenText(day, display) {
  if (day == null) return display && !display.startsWith("date_") ? display : "No date";
  const d = new Date(day * DAY * 1000);
  const y = d.getUTCFullYear();
  if (display === "date_year") return String(y);
  if (display === "date_quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`;
  if (display === "date_month") return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  return dayDate(day);
}

function unpackGames(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  const F = file.flags, top = file.topTags || 5;
  return file.rows.map((r) => {
    const tags = r[col.tags] || [], fl = r[col.flags] || 0;
    return {
      appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price], reviews: r[col.reviews] || 0, pos: r[col.pos],
      tags, top: tags.slice(0, top), flags: fl, langs: r[col.langs], hit: r[col.hit], gain7: r[col.gain7], players: r[col.players],
      indie: tags.includes(INDIE), godot: !!(fl & F.godot), self: !!(fl & F.self), free: !!(fl & F.free),
      linux: !!(fl & F.linux), mac: !!(fl & F.mac), demo: !!(fl & F.demo),
    };
  });
}

// Each tag's numbers, with how sure we are. min: games judged for the hit rate.
function tagRows(trends, min = 30) {
  const base = trends.baseHitRate;
  return trends.tags.filter((r) => r.hitRate != null && r.hitGames >= min).map((r) => {
    const c = confidence(r.hitGames);
    return { ...r, lift: r.hitRate / base, conf: c, range: spread(r.hitRate, r.hitGames), growth: growthWord(r.supply) };
  });
}

// tag id → { lift, name, hitRate } for tags with enough games to trust (Indie left out: it's on everything).
function liftMap(trends, min = 30) {
  const m = new Map();
  for (const r of trends.tags) if (r.hitRate != null && r.hitGames >= min && r.tag !== INDIE) m.set(r.tag, { lift: r.hitRate / trends.baseHitRate, name: r.name, hitRate: r.hitRate, releases: r.releases });
  return m;
}
const bestTag = (tags, lifts) => tags.reduce((best, t) => { const x = lifts.get(t); return x && (!best || x.lift > best.lift) ? { ...x, tag: t } : best; }, null);

// Pairs of a game's strongest tags, judged on the same games and window as the server's hit rate
// (released 14-180 days ago), shrunk toward Steam's rate. Every pair with 10+ games; filter later.
function pairGaps(list, trends, names, today, adultIds = new Set()) {
  const [lo, hi] = trends.hitRateWindow || [14, 180];
  const base = trends.baseHitRate;
  const single = new Map(trends.tags.filter((r) => r.hitRate != null).map((r) => [r.tag, r.hitRate]));
  const pairs = new Map();
  const keysOf = (g) => {
    const own = g.top.filter((t) => t !== INDIE);
    if (own.some((t) => adultIds.has(t))) return [];
    const out = [];
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) out.push(own[i] < own[j] ? `${own[i]}+${own[j]}` : `${own[j]}+${own[i]}`);
    return out;
  };
  for (const g of list) {
    const age = today - g.day;
    const judged = age >= lo && age <= hi && g.hit != null;
    const recent = age >= 0 && age < 90;
    if (!judged && !recent) continue;
    for (const k of keysOf(g)) {
      let p = pairs.get(k);
      if (!p) pairs.set(k, p = { k, n: 0, hits: 0, rel90: 0, reviews: [], games: [] });
      if (recent) p.rel90++;
      if (judged) { p.n++; if (g.hit >= 90) p.hits++; p.reviews.push(g.reviews); p.games.push(g); }
    }
  }
  const out = [];
  for (const p of pairs.values()) {
    if (p.n < 10) continue;
    const [a, b] = p.k.split("+").map(Number);
    const rate = shrink(p.hits, p.n, base);
    const parts = Math.max(single.get(a) ?? base, single.get(b) ?? base);
    out.push({ ...p, a, b, name: `${names[a] || a} + ${names[b] || b}`, raw: p.hits / p.n, rate, lift: rate / base, bonus: rate / parts,
      conf: confidence(p.n), range: spread(rate, p.n), med: median(p.reviews), top: quantile(p.reviews, 0.9),
      // Gap: how much better than Steam, per unit of crowding (log of releases in the last 90 days).
      gap: (rate / base) / Math.log10(10 + p.rel90) });
  }
  return out.sort((x, y) => y.rate - x.rate);
}

// Godot games ranked for scouting: upcoming and young self-published first, big hits with a publisher last.
function scoreGodot(games, lifts, today) {
  return games.map((g) => {
    const why = [];
    let s = 0;
    const days = g.day != null ? g.day - today : null;
    if (g.comingSoon) {
      if (days != null && days >= -30 && days <= 180) { s += 40; why.push(days <= 0 ? "out any day" : `out in ${days} days`); }
      else if (days != null) { s += 32; why.push(`coming ${g.releaseDisplay || whenText(g.day, null)}`); }
      else { s += 26; why.push("coming soon, no date"); }
    } else {
      const age = today - (g.day ?? today - 9999);
      if (age <= 180) { s += 34; why.push(`released ${age} days ago`); }
      else if (age <= 540) s += 16;
      else s += 4;
    }
    if (g.selfPublished) { s += 20; why.push("self-published"); }
    else if (g.publisherGames < 5) { s += 8; why.push(`small label (${g.publisherGames} games)`); }
    else { s -= 25; why.push(`has a publisher (${g.publishers.filter((p) => !g.developers.includes(p))[0] || g.publishers[0]}, ${g.publisherGames} games)`); }
    const hot = bestTag((g.tags || []).slice(0, 5), lifts);
    if (hot) { s += clamp((hot.lift - 1) * 12, 0, 15); if (hot.lift >= 1.3) why.push(`${hot.name} hits ${times(hot.lift)} Steam's rate`); }
    if (!g.comingSoon) {
      if ((g.pos ?? 0) >= 85 && g.reviews >= 20) { s += 8; why.push(`${g.pos}% positive`); }
      const gaps = [];
      if (g.languages != null && g.languages < 5) gaps.push(`${g.languages} language${g.languages === 1 ? "" : "s"}`);
      if (!g.linux && !g.mac) gaps.push("no Mac/Linux");
      if (gaps.length && (g.pos ?? 0) >= 80 && g.reviews < 1500) { s += 4 * gaps.length; why.push(`weak reach: ${gaps.join(", ")}`); }
      if (g.reviews >= 5000) { s -= 25; why.push(`already big (${fmtK(g.reviews)} reviews)`); }
      else if (g.reviews >= 1000) s -= 8;
    }
    if (g.devGames > 0 && g.devReviews >= 100) { s += Math.min(10, 3 * Math.log10(g.devReviews)); why.push(`studio's other games: ${fmtK(g.devReviews)} reviews`); }
    return { ...g, score: Math.round(s), why, hot, days };
  }).sort((a, b) => b.score - a.score || b.reviews - a.reviews);
}

// Coming-soon games on any engine, ranked for scouting.
function scoreUpcoming(file, lifts, today) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  return file.rows.map((r) => {
    const g = Object.fromEntries(file.columns.map((c) => [c, r[col[c]]]));
    const fl = g.flags || 0;
    g.self = !!(fl & 256); g.godot = !!(fl & 64); g.demo = !!(fl & 128);
    g.devs = g.devs || []; g.pubs = g.pubs || []; g.tags = g.tags || [];
    const why = [];
    let s = 0;
    const hot = bestTag(g.tags.slice(0, 5), lifts);
    if (hot) { s += clamp((hot.lift - 1) * 20, 0, 30); if (hot.lift >= 1.3) why.push(`${hot.name} hits ${times(hot.lift)} Steam's rate`); }
    if (g.devBest > 0) { s += Math.min(30, 7.5 * Math.log10(1 + g.devBest)); why.push(`studio's best game: ${fmtK(g.devBest)} reviews`); }
    const days = g.day != null ? g.day - today : null;
    if (days != null) {
      s += days <= 90 ? 20 : days <= 180 ? 15 : days <= 365 ? 10 : 5;
      why.push(days <= 0 ? "due now" : `out ${whenText(g.day, g.display)}`);
    }
    if (g.demo) { s += 8; why.push("demo out"); }
    if (g.self) s += 10;
    else if (g.pubGames >= 5) { s -= 20; why.push(`has a publisher (${g.pubs[0]}, ${g.pubGames} games)`); }
    else if (g.pubGames > 0) s += 3;
    if (g.godot) { s += 5; why.unshift("Godot"); }
    return { ...g, score: Math.round(s), why, hot, days };
  }).sort((a, b) => b.score - a.score);
}

// Games released a year (this year at its pace) vs Steam's peak users, from 2018.
function growthAnswer(g) {
  const first = Math.max(g.years.indexOf(2018), g.users.y.findIndex((v) => v != null));
  const last = g.years.length - 1;
  const rel = g.total.y.map((n, i) => i === last && g.yearDone > 0 && g.yearDone < 1 ? n / g.yearDone : n).slice(first);
  const users = g.users.y.slice(first);
  const years = g.years.slice(first);
  const relX = rel.at(-1) / rel[0], usersX = users.at(-1) / users[0];
  const perGame = users.map((u, i) => u != null && rel[i] ? u / rel[i] : null);
  return { years, rel, users, relX, usersX, perGameX: perGame.at(-1) / perGame[0], perGame, partial: g.yearDone < 1 };
}

// A tag's share of each year's releases and of the reviews those releases have today.
function shares(g, id, from = 2018) {
  const i0 = Math.max(0, g.years.indexOf(from));
  const t = g.tags[id];
  if (!t) return null;
  const rel = g.years.map((_, i) => g.total.y[i] ? t.y[i] / g.total.y[i] : null).slice(i0);
  const rev = g.years.map((_, i) => g.total.yr[i] ? t.yr[i] / g.total.yr[i] : null).slice(i0);
  return { years: g.years.slice(i0), rel, rev };
}

export const _test = { unpackGames, tagRows, liftMap, pairGaps, scoreGodot, scoreUpcoming, growthAnswer, shares, whenText, confidence, growthWord };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let C;
const mk = {
  tab: "niches", files: {}, loading: {}, errors: {}, root: null, cache: {},
  niches: { min: 30, sort: "hitRate", dir: -1, q: "", sel: null, shown: 40, pairSort: "rate", pairQ: "", pairShown: 25, pairOpen: null, legend: true },
  growth: { picked: null },
  godot: { self: true, status: "all", hidePub: true, q: "", shown: 40, open: null },
  upcoming: { self: true, hidePub: true, within: 365, track: 100, hot: false, godot: false, demo: false, q: "", shown: 40, open: null },
  releases: { days: 30, indie: true, self: false, godot: false, adult: false, q: "", shown: 50 },
};
const VIEWS = ["niches", "growth", "godot", "upcoming", "releases"];
function restore() {
  const t = C.store.get(KEY + "tab");
  if (VIEWS.includes(t)) mk.tab = t;
  for (const v of VIEWS) {
    try { const saved = JSON.parse(C.store.get(KEY + v) || "null"); if (saved && typeof saved === "object") Object.assign(mk[v], saved); } catch {}
  }
}
// What's kept per view (not the "show more" counts or open rows).
const KEEP = { niches: ["min", "sort", "dir", "sel", "pairSort", "legend"], growth: ["picked"], godot: ["self", "status", "hidePub"], upcoming: ["self", "hidePub", "within", "track", "hot", "godot", "demo"], releases: ["days", "indie", "self", "godot", "adult"] };
function save(view) { C.store.set(KEY + view, JSON.stringify(Object.fromEntries(KEEP[view].map((k) => [k, mk[view][k]])))); }

const tagName = (id) => mk.files.overview?.tags?.[id] || `Tag ${id}`;
const today = () => mk.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;
const tagList = (ids, n = 3) => (ids || []).filter((t) => t !== INDIE).slice(0, n).map(tagName).join(", ");
const adultIds = () => new Set(Object.entries(mk.files.overview?.tags || {}).filter(([, n]) => ADULT.includes(n)).map(([id]) => Number(id)));
function cached(name, deps, make) {
  const c = mk.cache[name];
  if (c && c.deps.length === deps.length && c.deps.every((d, i) => d === deps[i])) return c.value;
  const value = make();
  mk.cache[name] = { deps, value };
  return value;
}
const games = () => cached("games", [mk.files.games], () => unpackGames(mk.files.games));
const lifts = () => cached("lifts", [mk.files.trends], () => liftMap(mk.files.trends));

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export function marketTop(ctx) {
  C = ctx;
  const o = mk.files.overview;
  const set = (id, ...kids) => { const el = document.getElementById(id); if (el) el.replaceChildren(...kids); };
  const cap = document.getElementById("fb-capsule");
  if (cap) cap.hidden = true;
  set("fb-title", "Market");
  set("fb-updated", o
    ? `${fmtK(o.games)} games on Steam (${fmtK(o.comingSoon)} coming soon) · Godot detection: ${fmtK(o.withMetadata)} of ${fmtK(o.games)} checked so far (${pct(o.withMetadata / o.games)}) · worked out ${C.fmtDateTime(o.builtAt)}`
    : "All of Steam, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) set(id);
}

export function marketView(ctx) {
  C = ctx;
  injectStyle();
  restore();
  mk.root = C.h("div.mk.mkv-analyst");
  draw();
  load(["overview", ...NEEDS[mk.tab]]).then(() => load(WANTS[mk.tab] || []));
  return mk.root;
}

async function load(names) {
  const wanted = names.filter((n) => !mk.files[n] && !mk.loading[n]);
  if (!wanted.length) return;
  for (const n of wanted) { mk.loading[n] = true; delete mk.errors[n]; }
  draw();
  await Promise.all(wanted.map(async (n) => {
    try {
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
  const nav = h("nav.mka-tabs", { "aria-label": "Market view" }, ...TABS.map(([id, label]) => h("button", {
    type: "button", "aria-pressed": String(id === mk.tab),
    onclick: () => { mk.tab = id; C.store.set(KEY + "tab", id); load(["overview", ...NEEDS[id]]).then(() => load(WANTS[id] || [])); draw(); },
  }, label)));
  const need = ["overview", ...NEEDS[mk.tab]];
  const error = need.map((n) => mk.errors[n]).find(Boolean);
  let body;
  if (error) body = h("p.mka-empty", error, " ", h("button.btn", { type: "button", onclick: () => load(need) }, "Try again"));
  else if (need.some((n) => !mk.files[n])) body = h("p.mka-empty", mk.tab === "releases" ? "Loading three years of releases (a few MB, once)…" : "Loading…");
  else {
    try { body = { niches: nichesView, growth: growthView, godot: godotView, upcoming: upcomingView, releases: releasesView }[mk.tab](); }
    catch (e) { console.error(e); body = h("p.mka-empty", `This view hit an error: ${e.message}`); }
  }
  mk.root.replaceChildren(nav, body);
  window.scrollTo(0, y);
}

function redrawKeeping(e) {
  const key = e?.target?.dataset?.key, pos = e?.target?.selectionStart;
  draw();
  if (!key) return;
  const el = mk.root.querySelector(`[data-key="${key}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

const search = (key, value, placeholder, onInput) => C.h("input.mka-search", { type: "search", "data-key": key, value, placeholder, "aria-label": placeholder, oninput: (e) => { onInput(e.target.value); redrawKeeping(e); } });
const toggle = (label, on, flip, title) => C.h("button.mka-toggle", { type: "button", "aria-pressed": String(on), title, onclick: () => { flip(); draw(); } }, h0("span.mka-check", on ? "✓" : ""), label);
const h0 = (...a) => C.h(...a);
function seg(label, options, value, onChange) {
  const h = C.h;
  return h("div.mka-seg", { role: "group", "aria-label": label }, h("span.mka-seg-l", label),
    ...options.map(([v, text]) => h("button", { type: "button", "aria-pressed": String(v === value), onclick: () => { onChange(v); draw(); } }, text)));
}
const more = (shown, total, bump) => total > shown ? C.h("button.btn.mka-more", { type: "button", onclick: () => { bump(); draw(); } }, `Show ${Math.min(40, total - shown)} more (${fmtK(total - shown)} left)`) : null;
const gameLink = (appid, name) => C.h("a", { href: storeUrl(appid), target: "_blank", rel: "noopener" }, name);
const card = (title, sub, ...kids) => C.h("section.mka-card", C.h("h3", title), sub ? C.h("p.mka-sub", sub) : null, ...kids);
const stat = (label, value, meaning) => C.h("div.mka-stat", C.h("div.mka-stat-l", label), C.h("div.mka-stat-v", value), meaning ? C.h("div.mka-stat-m", meaning) : null);
const badge = (text, kind = "") => C.h("span.mka-badge", { class: kind ? `mka-b-${kind}` : null }, text);
// A bar inside a cell: value 0..1 of the column's max, the number beside it.
const barCell = (frac, text, color = SER.blue) => C.h("td.mka-num", C.h("div.mka-barcell", C.h("span.mka-bar", C.h("i", { style: `width:${clamp(frac, 0, 1) * 100}%;background:${color}` })), C.h("span", text)));
const confCell = (c, extra) => C.h("td", { title: `${pct(c.w)} of this estimate comes from its own games; the rest is Steam's average` },
  C.h("span.mka-conf", { "data-level": c.level }, C.h("i"), C.h("i"), C.h("i")), " ", c.word, extra ? C.h("span.mka-dim", ` ${extra}`) : null);
const growthCell = (r) => C.h("td", { class: `mka-g${Math.sign(r.growth.dir)}` }, r.growth.dir > 0 ? "▲ " : r.growth.dir < 0 ? "▼ " : "■ ", r.growth.word, C.h("span.mka-dim", ` ${times(r.supply)}`));

// A sortable table. cols: [{key, label, tip, num}], sort {key, dir}, onSort(key).
function sortTable(cols, rows, sort, onSort, cls = "") {
  const h = C.h;
  return h("div.mka-scroll", h("table.mka-t", { class: cls },
    h("thead", h("tr", ...cols.map((c) => h("th", { title: c.tip || null, class: c.num ? "mka-num" : null, "aria-sort": sort && c.key === sort.key ? (sort.dir > 0 ? "ascending" : "descending") : null },
      c.key && onSort ? h("button", { type: "button", onclick: () => onSort(c.key) }, c.label, sort?.key === c.key ? (sort.dir > 0 ? " ↑" : " ↓") : "") : c.label)))),
    h("tbody", ...rows)));
}
// The plain-words column guide under a table.
function legend(cols, open, onToggle) {
  const h = C.h;
  const d = h("details.mka-legend", { open: open || null, ontoggle: (e) => onToggle?.(e.target.open) }, h("summary", "What the columns mean"),
    h("dl", ...cols.filter((c) => c.tip).flatMap((c) => [h("dt", c.label), h("dd", c.tip)])));
  return d;
}

// A tooltip living inside a card.
function tipFor(box) {
  let tip = box.querySelector(":scope > .mka-tip");
  if (!tip) { tip = C.h("div.mka-tip", { role: "status" }); box.append(tip); }
  return {
    show(nodes, ev) {
      tip.replaceChildren(...nodes);
      tip.style.display = "block";
      const b = box.getBoundingClientRect();
      let left = ev.clientX - b.left + 14, top = ev.clientY - b.top + 14;
      if (left + tip.offsetWidth > b.width - 6) left = ev.clientX - b.left - tip.offsetWidth - 14;
      if (top + tip.offsetHeight > b.height - 6) top = ev.clientY - b.top - tip.offsetHeight - 14;
      tip.style.left = `${Math.max(4, left)}px`; tip.style.top = `${Math.max(4, top)}px`;
    },
    hide() { tip.style.display = "none"; },
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v - 1e-12);
}
const svgText = (attrs, text) => { const t = C.svgEl("text", attrs); t.textContent = text; return t; };

// A line chart over evenly spaced labels, one y axis, direct labels at the right end, crosshair tooltip.
function lineChart({ labels, series, fmt, yTitle, ref, compact = false, W = 760, H = 280, aria }) {
  const svgEl = C.svgEl, h = C.h;
  const M = compact ? { top: 8, right: 10, bottom: 20, left: 40 } : { top: 20, right: 150, bottom: 34, left: 58 };
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  if (ref) vals.push(ref.value);
  const max = niceMax(Math.max(...vals, 0));
  const n = labels.length;
  const x = (i) => M.left + (n === 1 ? 0 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mka-chart", role: "img", "aria-label": aria || yTitle || "Chart" });
  const ticks = compact ? 2 : 4;
  for (let k = 0; k <= ticks; k++) {
    const v = (max / ticks) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mka-grid" : "mka-base" }));
    svg.append(svgText({ x: M.left - 6, y: y(v) + 4, "text-anchor": "end", class: "mka-ax" }, fmt(v)));
  }
  const every = Math.max(1, Math.ceil(n / (compact ? 4 : 10)));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) svg.append(svgText({ x: x(i), y: H - (compact ? 5 : 14), "text-anchor": "middle", class: "mka-ax" }, compact && i !== 0 && i !== n - 1 ? `’${String(l).slice(-2)}` : l)); });
  if (yTitle && !compact) svg.append(svgText({ x: M.left, y: 11, class: "mka-ax mka-axt" }, yTitle));
  if (ref) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(ref.value), y2: y(ref.value), class: "mka-ref" }));
    if (ref.label && !compact) svg.append(svgText({ x: M.left + 4, y: y(ref.value) - 4, class: "mka-ax" }, ref.label));
  }
  for (const s of series) {
    let d = "", pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash || null }));
    const li = s.values.findLastIndex((v) => v != null);
    if (li >= 0) svg.append(svgEl("circle", { cx: x(li), cy: y(s.values[li]), r: 3.5, fill: s.color, stroke: "var(--fb-card)", "stroke-width": 2 }));
  }
  // Direct labels at the right end, pushed apart so they don't overlap.
  if (!compact) {
    const ends = series.map((s) => { const li = s.values.findLastIndex((v) => v != null); return li < 0 ? null : { s, y: y(s.values[li]), v: s.values[li] }; }).filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
    for (const e of ends) {
      svg.append(svgEl("line", { x1: W - M.right + 8, x2: W - M.right + 18, y1: e.y, y2: e.y, stroke: e.s.color, "stroke-width": 2 }));
      svg.append(svgText({ x: W - M.right + 22, y: e.y + 4, class: "mka-dl" }, `${e.s.short || e.s.name} ${fmt(e.v)}`));
    }
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "mka-cross", visibility: "hidden" });
  svg.append(cross);
  return {
    svg,
    attach(box) {
      const tip = tipFor(box);
      svg.addEventListener("pointermove", (ev) => {
        const b = svg.getBoundingClientRect();
        const px = ((ev.clientX - b.left) / b.width) * W;
        const i = clamp(Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1)), 0, n - 1);
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        tip.show([h("div.mka-tip-t", String(labels[i])), ...series.map((s) => h("div", h("i.mka-key", { style: `background:${s.color}` }), h("b", fmt(s.values[i])), " ", s.name))], ev);
      });
      svg.addEventListener("pointerleave", () => { tip.hide(); cross.setAttribute("visibility", "hidden"); });
    },
  };
}

// ---------------------------------------------------------------------------
// Niches
// ---------------------------------------------------------------------------

const TAG_COLS = (base, med) => [
  { key: "name", label: "Tag", tip: "A Steam user tag. A game counts for a tag when it's among its 5 strongest tags." },
  { key: "hitRate", label: "Hit rate", num: true, tip: `The share of the tag's games (released 2–6 months ago) that became hits: top 10% for reviews among games released the same fortnight. Adjusted for sample size: ${PRIOR} average games are mixed in, so a tag with few games can't top the list by luck. Steam overall: ${pct(base)}.` },
  { key: "lift", label: "vs Steam", num: true, tip: "Hit rate divided by Steam's: ×2 means a game here becomes a hit twice as often as an average new game." },
  { key: "hitGames", label: "Games judged", num: true, tip: "How many of the tag's games the hit rate is based on (released 2–6 months ago)." },
  { key: "conf", label: "How sure", tip: `High: 120+ games judged; Medium: 45+; Low: fewer. The ± is a rough 90% range for the hit rate.` },
  { key: "medianReviews", label: "Typical game", num: true, tip: `Reviews of the middle game (median) after 2–6 months. Steam's typical game: ${fmtK(med)} reviews. This is per game, not the tag's total.` },
  { key: "topReviews", label: "Top 10% get", num: true, tip: "Reviews a game in the tag's top tenth has (90th percentile): what a hit here looks like." },
  { key: "releases", label: "Crowding", num: true, tip: "Games released with the tag in the last 90 days: how many you compete with." },
  { key: "supply", label: "Growing?", tip: "The tag's share of Steam's new releases vs the same 90 days a year ago. ▲ = developers make more of it; ▼ = fewer." },
];

function nichesView() {
  const h = C.h, f = mk.niches, t = mk.files.trends, base = t.baseHitRate;
  const all = tagRows(t, f.min);
  const q = f.q.trim().toLowerCase();
  const sel = all.find((r) => r.tag === f.sel) || null;
  const sortKey = { name: (r) => r.name, conf: (r) => r.hitGames, lift: (r) => r.lift, supply: (r) => r.supply ?? 0 }[f.sort] || ((r) => r[f.sort] ?? -1);
  const rows = all.filter((r) => !q || r.name.toLowerCase().includes(q)).sort((a, b) => {
    const x = sortKey(a), y = sortKey(b);
    return (typeof x === "string" ? x.localeCompare(y) : x - y) * f.dir;
  });
  const best = [...all].sort((a, b) => b.hitRate - a.hitRate)[0];
  const quietBest = [...all].filter((r) => r.releases < median(all.map((x) => x.releases))).sort((a, b) => b.hitRate - a.hitRate)[0];
  const minCtl = seg("At least", [[15, "15 games"], [30, "30"], [60, "60"], [120, "120"]], f.min, (v) => { f.min = v; save("niches"); });
  const maxOf = (k) => Math.max(...all.map((r) => r[k] ?? 0), 1);
  const mx = { hit: maxOf("hitRate"), med: Math.log1p(maxOf("medianReviews")), top: Math.log1p(maxOf("topReviews")), rel: Math.log1p(maxOf("releases")) };
  const cols = TAG_COLS(base, t.baseMedianReviews);
  const tableRows = rows.slice(0, f.shown).map((r) => h("tr.mka-click", { "aria-selected": String(r.tag === f.sel), onclick: () => { f.sel = r.tag === f.sel ? null : r.tag; save("niches"); draw(); } },
    h("td", h("b", r.name)),
    barCell(r.hitRate / mx.hit, `${pct(r.hitRate)}`, r.lift >= 1.5 ? SER.green : SER.blue),
    h("td.mka-num", h("b", times(r.lift))),
    h("td.mka-num", fmtK(r.hitGames), h("span.mka-dim", ` (${r.hits} hits)`)),
    confCell(r.conf, `±${(r.range * 100).toFixed(0)} pts`),
    barCell(Math.log1p(r.medianReviews ?? 0) / mx.med, fmtK(r.medianReviews), SER.yellow),
    barCell(Math.log1p(r.topReviews ?? 0) / mx.top, fmtK(r.topReviews), SER.yellow),
    barCell(Math.log1p(r.releases) / mx.rel, fmtK(r.releases), "var(--fb-muted)"),
    growthCell(r)));
  return h("div.mka-view",
    h("p.mka-lede", `Which tags give a new game the best odds? A "hit" is a game in the top 10% for reviews among games released the same fortnight; across Steam ${pct(base)} of new games make it. `,
      best ? h("span", h("b", best.name), ` has the best odds (${pct(best.hitRate)}, ${times(best.lift)} Steam's)`) : null,
      quietBest ? h("span", `; among the less crowded tags, `, h("b", quietBest.name), ` (${pct(quietBest.hitRate)} with ${quietBest.releases} releases in 90 days).`) : "."),
    h("div.mka-bar-row", minCtl, h("span.mka-dim", `judged for the hit rate · ${all.length} tags shown`)),
    scatterCard(all, base, sel),
    sel ? tagDetail(sel, base) : null,
    card("All tags", "Click a column to sort, a row to see the tag on the chart and its best recent games.",
      h("div.mka-bar-row", search("niche-q", f.q, "Find a tag", (v) => { f.q = v; })),
      sortTable(cols, tableRows, { key: f.sort, dir: f.dir }, (k) => { if (f.sort === k) f.dir = -f.dir; else { f.sort = k; f.dir = k === "name" ? 1 : -1; } save("niches"); draw(); }),
      more(f.shown, rows.length, () => { f.shown += 40; }),
      legend(cols, f.legend, (open) => { f.legend = open; save("niches"); })),
    pairCard(base));
}

function scatterCard(rows, base, sel) {
  const h = C.h, svgEl = C.svgEl;
  const W = 760, H = 440, M = { top: 18, right: 18, bottom: 44, left: 56 };
  const xs = rows.map((r) => r.releases);
  const lx0 = Math.log10(Math.max(1, Math.min(...xs) * 0.85)), lx1 = Math.log10(Math.max(...xs) * 1.15);
  const ymax = niceMax(Math.max(...rows.map((r) => r.hitRate), base * 2));
  const x = (v) => M.left + ((Math.log10(v) - lx0) / (lx1 - lx0)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / ymax) * (H - M.top - M.bottom);
  const r = (m) => 3 + 1.25 * Math.log2(1 + (m ?? 0));
  const xSplit = median(xs), ySplit = base * 1.5;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mka-chart", role: "img", "aria-label": "Tags: crowding against hit rate" });
  // Quadrant shading for the "gap" corner.
  svg.append(svgEl("rect", { x: M.left, y: M.top, width: x(xSplit) - M.left, height: y(ySplit) - M.top, class: "mka-gapzone" }));
  for (let k = 0; k <= 5; k++) {
    const v = (ymax / 5) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mka-grid" : "mka-base" }));
    svg.append(svgText({ x: M.left - 6, y: y(v) + 4, "text-anchor": "end", class: "mka-ax" }, pct(v)));
  }
  for (const v of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
    if (Math.log10(v) < lx0 || Math.log10(v) > lx1) continue;
    svg.append(svgEl("line", { x1: x(v), x2: x(v), y1: M.top, y2: H - M.bottom, class: "mka-grid" }));
    svg.append(svgText({ x: x(v), y: H - M.bottom + 15, "text-anchor": "middle", class: "mka-ax" }, fmtK(v)));
  }
  svg.append(svgText({ x: (M.left + W - M.right) / 2, y: H - 6, "text-anchor": "middle", class: "mka-ax mka-axt" }, "Crowding: games released with the tag in the last 90 days (log scale) →"));
  svg.append(svgText({ x: M.left, y: 11, class: "mka-ax mka-axt" }, "↑ Hit rate (adjusted for sample size)"));
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(base), y2: y(base), class: "mka-ref" }));
  svg.append(svgText({ x: W - M.right - 4, y: y(base) - 4, "text-anchor": "end", class: "mka-ax" }, `Steam average ${pct(base)}`));
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(ySplit), y2: y(ySplit), class: "mka-split" }));
  svg.append(svgEl("line", { x1: x(xSplit), x2: x(xSplit), y1: M.top, y2: H - M.bottom, class: "mka-split" }));
  const q = (tx, ty, anchor, title, sub) => { svg.append(svgText({ x: tx, y: ty, "text-anchor": anchor, class: "mka-quad" }, title)); svg.append(svgText({ x: tx, y: ty + 13, "text-anchor": anchor, class: "mka-ax" }, sub)); };
  q(M.left + 8, M.top + 16, "start", "Quiet and rewarding = gaps", "few games, many hits");
  q(W - M.right - 8, M.top + 16, "end", "Crowded but rewarding", "big demand, big competition");
  q(W - M.right - 8, H - M.bottom - 24, "end", "Crowded and hard", "lots of games, few hits");
  q(M.left + 8, H - M.bottom - 24, "start", "Quiet and hard", "few games, few hits");
  const color = (row) => row.growth.dir > 0 ? SER.green : row.growth.dir < 0 ? SER.orange : "var(--fb-muted)";
  const dots = svgEl("g");
  const sorted = [...rows].sort((a, b) => (b.medianReviews ?? 0) - (a.medianReviews ?? 0)); // big ones under small ones
  for (const row of sorted) {
    const cx = x(row.releases), cy = y(row.hitRate), rr = r(row.medianReviews);
    const g = svgEl("g", { class: "mka-dot", "data-tag": row.tag, tabindex: "0", role: "button", "aria-label": `${row.name}: hit rate ${pct(row.hitRate)}, ${row.releases} releases` });
    g.append(svgEl("circle", { cx, cy, r: rr, fill: color(row), "fill-opacity": row.tag === sel?.tag ? 1 : 0.62, stroke: row.tag === sel?.tag ? "var(--fb-ink)" : "var(--fb-card)", "stroke-width": row.tag === sel?.tag ? 2.5 : 1.5 }));
    g.append(svgEl("circle", { cx, cy, r: Math.max(rr + 4, 9), fill: "transparent" }));
    g.__row = row;
    dots.append(g);
  }
  svg.append(dots);
  // Direct labels: the best by hit rate, the most crowded, and the picked one; skipped where they'd overlap.
  const placed = [];
  const want = [...new Set([sel, ...[...rows].sort((a, b) => b.hitRate - a.hitRate).slice(0, 12), ...[...rows].sort((a, b) => b.releases - a.releases).slice(0, 4)].filter(Boolean))];
  for (const row of want) {
    const w = row.name.length * 6.3 + 4, cx = x(row.releases) + r(row.medianReviews) + 3, cy = y(row.hitRate) + 4;
    const left = cx + w > W - M.right ? cx - w - 2 * r(row.medianReviews) - 6 : cx;
    const box = [left, cy - 11, left + w, cy + 2];
    if (row !== sel && placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
    placed.push(box);
    svg.append(svgText({ x: left, y: cy, class: `mka-dl${row === sel ? " mka-dl-sel" : ""}` }, row.name));
  }
  const box = card("Every tag: crowding against odds",
    "Each dot is a tag. Right = more games to compete with; up = a bigger share of its games become hits. Dot size = reviews of a typical game. Click a dot for the tag in plain words.",
    h("div.mka-legend-inline",
      h("span", h("i.mka-key", { style: `background:${SER.green}` }), "Growing share of releases"),
      h("span", h("i.mka-key", { style: "background:var(--fb-muted)" }), "Steady"),
      h("span", h("i.mka-key", { style: `background:${SER.orange}` }), "Shrinking"),
      h("span", h("i.mka-key.mka-key-ring"), "Bigger dot = more reviews per typical game"),
      h("span", h("i.mka-key.mka-key-zone"), `Gap corner: below-median crowding, ${times(1.5)} Steam's hit rate or better`)),
    h("div.mka-plot", svg));
  const tip = tipFor(box);
  const find = (ev) => ev.target.closest?.(".mka-dot")?.__row;
  svg.addEventListener("pointermove", (ev) => {
    const row = find(ev);
    if (!row) return tip.hide();
    tip.show([h("div.mka-tip-t", row.name),
      h("div", h("b", pct(row.hitRate)), ` become hits (${times(row.lift)} Steam's)`),
      h("div", `${fmtK(row.releases)} released in 90 days · ${row.growth.word.toLowerCase()}`),
      h("div", `Typical game ${fmtK(row.medianReviews)} reviews, top 10% ${fmtK(row.topReviews)}`),
      h("div.mka-dim", `${row.hitGames} games judged · ${row.conf.word.toLowerCase()} confidence`)], ev);
  });
  svg.addEventListener("pointerleave", () => tip.hide());
  const pick = (row) => { if (!row) return; mk.niches.sel = row.tag === mk.niches.sel ? null : row.tag; save("niches"); draw(); };
  svg.addEventListener("click", (ev) => pick(find(ev)));
  svg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(find(ev)); } });
  return box;
}

function tagDetail(r, base) {
  const h = C.h, t = mk.files.trends;
  const [lo, hi] = t.hitRateWindow || [14, 180];
  const gw = r.growth;
  const lines = [
    h("li", h("b", `${pct(r.hitRate)} become hits. `), `Of its ${r.hitGames} games released ${Math.round(lo / 30) || "½"}–${Math.round(hi / 30)} months ago, ${r.hits} (${pct(r.hitRateRaw)}) made the top 10% of their fortnight. With sample size taken into account that's ${pct(r.hitRate)} (±${(r.range * 100).toFixed(0)} points), ${times(r.lift)} Steam's ${pct(base)}. Confidence: ${r.conf.word.toLowerCase()}.`),
    h("li", h("b", `A typical game gets ${fmtK(r.medianReviews)} reviews; a top-10% one ${fmtK(r.topReviews)}. `), `Across Steam a typical new game has ${fmtK(t.baseMedianReviews)}. These are per game, 2–6 months after release, not the tag's total.`),
    h("li", h("b", `${fmtK(r.releases)} games came out with it in the last 90 days `), `(${fmtK(r.releasesYearAgo)} in the same 90 days a year ago). Its share of Steam's releases is ${times(r.supply)} a year ago: ${gw.word.toLowerCase()}.`),
    r.demand != null ? h("li", h("b", `Players: `), `its share of new reviews is ${times(r.demand)} the window before.`) : null,
  ];
  let gamesBox;
  if (!mk.files.games) gamesBox = h("p.mka-dim", mk.errors.games ? `Recent games couldn't load: ${mk.errors.games}` : "Loading its recent games…");
  else {
    const d = today();
    const list = games().filter((g) => g.top.includes(r.tag) && d - g.day <= 180 && d - g.day >= 0).sort((a, b) => (b.hit ?? 0) - (a.hit ?? 0) || b.reviews - a.reviews).slice(0, 8);
    gamesBox = h("div.mka-scroll", h("table.mka-t.mka-t-sm",
      h("thead", h("tr", h("th", "Best games, last 6 months"), h("th.mka-num", { title: "Review count percentile among games released the same fortnight" }, "Hit index"), h("th.mka-num", "Reviews"), h("th.mka-num", "Positive"), h("th", "Released"), h("th", "Published by"))),
      h("tbody", ...list.map((g) => h("tr", h("td", gameLink(g.appid, g.name), g.godot ? badge("Godot", "godot") : null), h("td.mka-num", h("b", g.hit ?? "–")),
        h("td.mka-num", fmtK(g.reviews)), h("td.mka-num", g.pos ? `${g.pos}%` : "–"), h("td", dayDate(g.day)), h("td", g.self ? badge("Self", "self") : "a publisher"))))));
  }
  return h("section.mka-card.mka-detail",
    h("div.mka-detail-head", h("h3", r.name), h("button.btn", { type: "button", onclick: () => { mk.niches.sel = null; save("niches"); draw(); } }, "Close")),
    h("ul.mka-plain", ...lines), gamesBox);
}

const PAIR_COLS = (base) => [
  { key: "name", label: "Pair of tags", tip: "Two tags that are both among a game's 5 strongest (Indie and adult tags left out)." },
  { key: "rate", label: "Hit rate", num: true, tip: `Share of the pair's games (released 2–6 months ago) that became hits, with ${PRIOR} average games mixed in so small pairs are pulled toward Steam's ${pct(base)}.` },
  { key: "bonus", label: "vs its tags", num: true, tip: "The pair's hit rate against the better of its two tags alone. Above ×1: the combination does better than either part." },
  { key: "n", label: "Games judged", num: true, tip: "Games the hit rate is based on. Fewer games = the number leans more on Steam's average." },
  { key: "conf", label: "How sure", tip: "High: 120+ games; Medium: 45+; Low: fewer. ± is a rough 90% range." },
  { key: "med", label: "Typical game", num: true, tip: "Median reviews of the pair's games after 2–6 months." },
  { key: "rel90", label: "Crowding", num: true, tip: "Games released with both tags in the last 90 days." },
  { key: "gap", label: "Gap score", num: true, tip: "Hit rate vs Steam's, divided by crowding (log): high = often hits and few made." },
];

function pairCard(base) {
  const h = C.h, f = mk.niches;
  if (!mk.files.games) return card("Tag-pair gap finder", "Which two tags together do better than either alone?",
    h("p.mka-dim", mk.errors.games ? `Couldn't load the releases: ${mk.errors.games}` : "Loading three years of releases (a few MB, once)…"));
  const all = cached("pairs", [mk.files.games, mk.files.trends], () => pairGaps(games(), mk.files.trends, mk.files.overview.tags, today(), adultIds()));
  const q = f.pairQ.trim().toLowerCase();
  const rows = all.filter((p) => p.n >= f.min && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => f.pairSort === "name" ? a.name.localeCompare(b.name) : f.pairSort === "conf" ? b.n - a.n : (b[f.pairSort] ?? 0) - (a[f.pairSort] ?? 0));
  const mxr = Math.max(...rows.map((p) => p.rate), 0.01), mxc = Math.log1p(Math.max(...rows.map((p) => p.rel90), 1));
  const cols = PAIR_COLS(base);
  const body = rows.slice(0, f.pairShown).flatMap((p) => [
    h("tr.mka-click", { "aria-expanded": String(f.pairOpen === p.k), onclick: () => { f.pairOpen = f.pairOpen === p.k ? null : p.k; draw(); } },
      h("td", h("b", p.name)), barCell(p.rate / mxr, pct(p.rate), p.lift >= 1.5 ? SER.green : SER.blue),
      h("td.mka-num", { class: p.bonus >= 1.1 ? "mka-g1" : p.bonus < 0.9 ? "mka-g-1" : null }, times(p.bonus)),
      h("td.mka-num", fmtK(p.n), h("span.mka-dim", ` (${p.hits} hits)`)), confCell(p.conf, `±${(p.range * 100).toFixed(0)} pts`),
      h("td.mka-num", fmtK(p.med)), barCell(Math.log1p(p.rel90) / mxc, fmtK(p.rel90), "var(--fb-muted)"), h("td.mka-num", h("b", p.gap.toFixed(2)))),
    f.pairOpen === p.k ? h("tr.mka-sub", h("td", { colspan: 8 }, h("ul.mka-plain",
      h("li", `${p.hits} of ${p.n} games with both ${tagName(p.a)} and ${tagName(p.b)} became hits (${pct(p.raw)} as counted, ${pct(p.rate)} adjusted). A top-10% game here has ${fmtK(p.top)} reviews.`),
      h("li", "Its biggest games: ", ...[...p.games].sort((a, b) => b.reviews - a.reviews).slice(0, 5).flatMap((g, i) => [i ? ", " : "", gameLink(g.appid, g.name), ` (${fmtK(g.reviews)})`]))))) : null,
  ]);
  return card("Tag-pair gap finder", `Pairs of tags, judged like the tags above. A pair needs ${f.min}+ games (the "At least" control above); smaller pairs lean on Steam's average, so a handful of lucky games can't make a fake gap.`,
    h("div.mka-bar-row",
      seg("Rank by", [["rate", "Hit rate"], ["gap", "Gap score"], ["bonus", "Beats its tags"]], ["rate", "gap", "bonus"].includes(f.pairSort) ? f.pairSort : null, (v) => { f.pairSort = v; save("niches"); }),
      search("pair-q", f.pairQ, "Pairs with a tag…", (v) => { f.pairQ = v; }),
      h("span.mka-dim", `${fmtK(rows.length)} pairs`)),
    sortTable(cols, body, { key: f.pairSort, dir: -1 }, (k) => { f.pairSort = k; save("niches"); draw(); }),
    more(f.pairShown, rows.length, () => { f.pairShown += 25; }),
    legend(cols, false));
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

function growthView() {
  const h = C.h, g = mk.files.growth, f = mk.growth;
  const a = growthAnswer(g);
  const index = (xs) => { const b = xs.find((v) => v != null); return xs.map((v) => v == null || !b ? null : (v / b) * 100); };
  const years = a.years.map(String);
  const chart = lineChart({
    labels: years, yTitle: `Index, ${years[0]} = 100`, ref: { value: 100, label: `${years[0]} level` }, aria: "Games released and Steam's peak users, indexed",
    series: [
      { name: "Games released a year", short: "Games", color: SER.blue, values: index(a.rel) },
      { name: "Steam's peak users online", short: "Players", color: SER.green, values: index(a.users) },
    ],
    fmt: (v) => v == null ? "–" : String(Math.round(v)),
  });
  const faster = a.relX > a.usersX;
  const answer = h("p.mka-answer",
    h("b", faster ? "No: games are growing faster than players. " : "Yes: players are keeping up with the games. "),
    `Since ${years[0]} the number of games released a year went ${times(a.relX)} (to ${fmtK(a.rel.at(-1))}${a.partial ? `, this year's pace` : ""}), while Steam's peak users went ${times(a.usersX)} (to ${fmtK(a.users.at(-1))}). `,
    `So each new game shares the crowd with ${pct(Math.abs(1 - a.perGameX))} ${a.perGameX < 1 ? "fewer" : "more"} players than in ${years[0]}: ${fmtK(a.perGame[0])} → ${fmtK(a.perGame.at(-1))} peak players per new game.`);
  const box = card("More games, or more players?", "Both lines start at 100 in 2018 (the first full year of Steam Direct), so you see which grew faster. Hover for the numbers.",
    answer, h("div.mka-plot", chart.svg),
    h("details.mka-legend", h("summary", "Where the numbers come from"),
      h("p", `Games: every release that year (this year scaled up to a full year). Players: Steam's all-time record of users online at once by each year's end, as Valve reported it in the press; from November 2026 the server keeps each day's peak itself.`),
      h("ul", ...g.users.records.slice(-6).map((r) => h("li", `${r.date}: ${fmtK(r.users)} `, h("a", { href: r.source, target: "_blank", rel: "noopener" }, "source"))))));
  chart.attach(box);
  // Small multiples: picked tags' share of releases vs share of reviews.
  const pool = g.tags;
  if (!Array.isArray(f.picked) || !f.picked.length || !f.picked.every((id) => pool[id])) {
    const good = tagRows(mk.files.trends, 60).filter((r) => pool[r.tag] && r.tag !== INDIE).sort((x, y) => y.hitRate - x.hitRate).slice(0, 6).map((r) => String(r.tag));
    f.picked = good.length ? good : Object.keys(pool).slice(0, 6);
  }
  const options = Object.entries(pool).sort((x, y) => x[1].name.localeCompare(y[1].name));
  const add = h("input.mka-search", { list: "mka-growth-tags", placeholder: "Add a tag…", "aria-label": "Add a tag", onchange: (e) => {
    const found = options.find(([, s]) => s.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (found && !f.picked.includes(found[0])) { f.picked = [...f.picked, found[0]].slice(-9); save("growth"); draw(); }
    e.target.value = "";
  } });
  const panels = f.picked.map((id) => sharePanel(id, pool[id].name));
  return h("div.mka-view", box,
    card("Is a tag under-supplied?", "For each tag: its share of the games released each year (blue) against its share of the reviews those games got (orange). When orange runs above blue, players review it more than developers make it: under-supplied.",
      h("div.mka-bar-row",
        h("div.mka-legend-inline", h("span", h("i.mka-key", { style: `background:${SER.blue}` }), "Share of releases"), h("span", h("i.mka-key", { style: `background:${SER.orange}` }), "Share of reviews")),
        add, h("datalist", { id: "mka-growth-tags" }, ...options.map(([, s]) => h("option", { value: s.name })))),
      h("div.mka-multiples", ...panels)));
}

function sharePanel(id, name) {
  const h = C.h, g = mk.files.growth, f = mk.growth;
  const s = shares(g, id);
  // The verdict on the last full year (this year's games are still collecting reviews).
  const li = s.years.length - (g.yearDone < 1 ? 2 : 1);
  const ratio = s.rel[li] ? s.rev[li] / s.rel[li] : null;
  const verdict = ratio == null ? "–" : ratio >= 1.25 ? ["Under-supplied", 1] : ratio <= 0.8 ? ["Over-supplied", -1] : ["In balance", 0];
  const chart = lineChart({
    labels: s.years.map(String), compact: true, W: 300, H: 140, aria: `${name}: share of releases and reviews`,
    series: [{ name: "of releases", color: SER.blue, values: s.rel }, { name: "of reviews", color: SER.orange, values: s.rev }],
    fmt: (v) => v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`,
  });
  const box = h("div.mka-panel",
    h("div.mka-panel-head", h("b", name), h("button.mka-x", { type: "button", "aria-label": `Remove ${name}`, onclick: () => { f.picked = f.picked.filter((x) => x !== id); save("growth"); draw(); } }, "×")),
    h("div.mka-panel-v", { class: `mka-g${verdict[1] ?? 0}` }, verdict[0] ?? "–",
      ratio != null ? h("span.mka-dim", ` · in ${s.years[li]}: ${pct(s.rel[li], 1)} of releases, ${pct(s.rev[li], 1)} of reviews`) : null),
    chart.svg);
  chart.attach(box);
  return box;
}

// ---------------------------------------------------------------------------
// Godot & leads
// ---------------------------------------------------------------------------

function contactText(g, kind) {
  const devs = (g.developers || g.devs || []).join(", ") || "?";
  return [
    `${g.name} (${storeUrl(g.appid)})`,
    `Studio: ${devs}${kind === "godot" ? `; publisher: ${g.selfPublished ? "self-published" : g.publishers.join(", ")}` : `; publisher: ${g.self ? "self-published" : (g.pubs || []).join(", ")}`}`,
    `Why now: ${g.why.join("; ")}`,
    `Tags: ${tagList(g.tags, 6)}`,
    kind === "godot" && !g.comingSoon ? `Released ${dayDate(g.day)}: ${g.reviews} reviews, ${g.pos ?? "?"}% positive; ${g.languages ?? "?"} languages; Linux ${g.linux ? "yes" : "no"}, Mac ${g.mac ? "yes" : "no"}` : `Release: ${kind === "godot" ? g.releaseDisplay || whenText(g.day, null) : whenText(g.day, g.display)}`,
  ].join("\n");
}

function godotView() {
  const h = C.h, f = mk.godot, o = mk.files.overview, d = today();
  const all = cached("godotScored", [mk.files.godot, mk.files.trends], () => scoreGodot(mk.files.godot.games, lifts(), d));
  const q = f.q.trim().toLowerCase();
  const young = (g) => !g.comingSoon && g.day != null && d - g.day <= 180;
  const list = all.filter((g) => (!f.self || g.selfPublished) && (!f.hidePub || g.selfPublished || g.publisherGames < 5)
    && (f.status === "all" || (f.status === "upcoming" ? g.comingSoon : young(g)))
    && (!q || g.name.toLowerCase().includes(q) || g.developers.some((x) => x.toLowerCase().includes(q)) || g.tags.some((t) => tagName(t).toLowerCase().includes(q))));
  const mxs = Math.max(...all.map((g) => g.score), 1);
  const cols = [
    { label: "Game", tip: "The game and its studio (the developer: who you'd talk to)." },
    { label: "Scout score", num: true, tip: "Higher = worth contacting sooner. Points for: not out yet or out under 6 months, self-published, in a tag whose games often become hits, well reviewed but with weak reach (few languages, no Mac/Linux), and a studio with past games. Points off for a real publisher or being big already." },
    { label: "Stage", tip: "Upcoming (with its planned date) or how long ago it came out." },
    { label: "Publisher", tip: "Self = the studio publishes itself. A small label has under 5 games; a real publisher 5+." },
    { label: "Reviews", num: true, tip: "Steam reviews and the share that are positive." },
    { label: "Why now", tip: "The reasons behind the score, in order." },
  ];
  const pubCell = (g) => g.selfPublished ? badge("Self", "self") : g.publisherGames < 5 ? badge(`Small label · ${g.publisherGames}`, "label") : badge(`${g.publishers.filter((p) => !g.developers.includes(p))[0] || g.publishers[0]} · ${g.publisherGames}`, "pub");
  const stage = (g) => g.comingSoon ? h("span", badge("Upcoming", "up"), " ", g.releaseDisplay || whenText(g.day, null)) : h("span", young(g) ? badge("New", "new") : null, " ", g.day != null ? `${fmtK(d - g.day)} days ago` : "–");
  const rows = list.slice(0, f.shown).flatMap((g) => [
    h("tr.mka-click", { "aria-expanded": String(f.open === g.appid), onclick: () => { f.open = f.open === g.appid ? null : g.appid; draw(); } },
      h("td", h("b", g.name), h("div.mka-dim", g.developers.join(", ") || "?")),
      barCell(g.score / mxs, String(g.score), g.score >= 60 ? SER.green : SER.blue),
      h("td", stage(g)), h("td", pubCell(g)),
      h("td.mka-num", g.comingSoon ? "–" : `${fmtK(g.reviews)}${g.pos ? ` · ${g.pos}%` : ""}`),
      h("td.mka-why", g.why.slice(0, 3).join(" · "))),
    f.open === g.appid ? h("tr.mka-sub", h("td", { colspan: 6 }, godotDetail(g))) : null,
  ]);
  const pubOk = all.filter((g) => (!f.self || g.selfPublished) && (!f.hidePub || g.selfPublished || g.publisherGames < 5));
  const counts = { upcoming: pubOk.filter((g) => g.comingSoon).length, young: pubOk.filter(young).length };
  return h("div.mka-view",
    h("p.mka-lede", "Godot games to sign, best scouted before release: not out yet or out under 6 months, self-published, in a tag that does well. Big hits with a publisher sink to the bottom (or are hidden)."),
    h("div.mka-bar-row.mka-filters",
      toggle("Self-published only", f.self, () => { f.self = !f.self; save("godot"); }),
      toggle("Hide real publishers (5+ games)", f.hidePub, () => { f.hidePub = !f.hidePub; save("godot"); }),
      seg("Status", [["upcoming", `Upcoming (${counts.upcoming})`], ["young", `Out < 6 months (${counts.young})`], ["all", "All"]], f.status, (v) => { f.status = v; save("godot"); }),
      search("godot-q", f.q, "Find a game, studio or tag", (v) => { f.q = v; })),
    card(`${fmtK(list.length)} Godot games, best lead first`, "Click a game for who to contact and a summary to copy.",
      sortTable(cols, rows, null, null), more(f.shown, list.length, () => { f.shown += 40; }), legend(cols, false)),
    h("p.mka-note", `Godot detection is still running: ${fmtK(o.withMetadata)} of ${fmtK(o.games)} Steam games checked so far (${pct(o.withMetadata / o.games)}), so this list will grow. A few big games are flagged by PCGamingWiki by mistake; they rank last.`));
}

function godotDetail(g) {
  const h = C.h;
  const facts = [
    g.comingSoon ? `Coming ${g.releaseDisplay || "soon"}` : `Released ${dayDate(g.day)}: ${fmtK(g.reviews)} reviews, ${g.pos ?? "?"}% positive, hit index ${g.hit ?? "–"}, ${money(g.price)}`,
    g.languages != null ? `${g.languages} languages` : null, g.linux ? "Linux" : "no Linux", g.mac ? "Mac" : "no Mac",
    g.deck === 3 ? "Deck Verified" : g.deck === 2 ? "Deck Playable" : null, g.demos ? "has a demo" : null,
  ].filter(Boolean).join(" · ");
  return h("div.mka-detail-box",
    g.about ? h("p", g.about) : null,
    h("p", h("b", "Who to contact: "), `${g.developers.join(", ") || "?"} (the developer), via the store page's links. `,
      g.selfPublished ? "They publish themselves." : `Published by ${g.publishers.join(", ")}.`,
      g.devGames ? ` ${g.devGames} other game${g.devGames === 1 ? "" : "s"} on Steam with ${fmtK(g.devReviews)} reviews in all.` : " Their first game on Steam."),
    h("p", h("b", "Why now: "), g.why.join("; ") || "–"),
    h("p.mka-dim", facts, " · tags: ", tagList(g.tags, 6)),
    h("div.mka-actions", h("a.btn", { href: storeUrl(g.appid), target: "_blank", rel: "noopener" }, "Store page ↗"),
      h("button.btn", { type: "button", onclick: (e) => C.copy(contactText(g, "godot"), e.currentTarget) }, "Copy lead summary")));
}

// ---------------------------------------------------------------------------
// Upcoming (all engines)
// ---------------------------------------------------------------------------

function upcomingView() {
  const h = C.h, f = mk.upcoming, d = today();
  const all = cached("upcomingScored", [mk.files.upcoming, mk.files.trends], () => scoreUpcoming(mk.files.upcoming, lifts(), d));
  const q = f.q.trim().toLowerCase();
  const list = all.filter((g) => (!f.self || g.self) && (!f.hidePub || g.self || g.pubGames < 5)
    && (f.within === 0 ? true : g.days != null && g.days <= f.within) && g.devBest >= f.track
    && (!f.hot || (g.hot && g.hot.lift >= 1.5)) && (!f.godot || g.godot) && (!f.demo || g.demo)
    && (!q || g.name.toLowerCase().includes(q) || g.devs.some((x) => x.toLowerCase().includes(q)) || g.tags.some((t) => tagName(t).toLowerCase().includes(q))));
  const mxs = Math.max(...list.slice(0, 200).map((g) => g.score), 1);
  const cols = [
    { label: "Game", tip: "The game and its studio." },
    { label: "Scout score", num: true, tip: "Points for a hot tag (its games hit more often than Steam's average), the studio's best past game, an early release date, a demo, self-publishing and Godot. Points off for a real publisher." },
    { label: "Release", tip: "The planned date as the store shows it (a year or quarter when that's all it says)." },
    { label: "Studio's best game", num: true, tip: "Reviews of the studio's best released game: a track record says they can ship and sell." },
    { label: "Hot tag", tip: "Its strongest tag by hit rate, with how often that tag's games become hits vs Steam's average." },
    { label: "Why", tip: "The reasons behind the score." },
  ];
  const rows = list.slice(0, f.shown).flatMap((g) => [
    h("tr.mka-click", { "aria-expanded": String(f.open === g.appid), onclick: () => { f.open = f.open === g.appid ? null : g.appid; draw(); } },
      h("td", h("b", g.name), g.godot ? badge("Godot", "godot") : null, g.demo ? badge("Demo", "new") : null, h("div.mka-dim", g.devs.join(", ") || "?")),
      barCell(g.score / mxs, String(g.score), g.score >= 60 ? SER.green : SER.blue),
      h("td", whenText(g.day, g.display), g.days != null ? h("div.mka-dim", g.days <= 0 ? "due now" : `in ${g.days} days`) : null),
      h("td.mka-num", g.devBest ? fmtK(g.devBest) : "–", g.devGames ? h("div.mka-dim", `${g.devGames} game${g.devGames === 1 ? "" : "s"}`) : null),
      h("td", g.hot ? h("span", g.hot.name, h("span.mka-dim", ` ${times(g.hot.lift)}`)) : "–"),
      h("td.mka-why", g.why.slice(0, 3).join(" · "))),
    f.open === g.appid ? h("tr.mka-sub", h("td", { colspan: 6 }, h("div.mka-detail-box",
      h("p", h("b", "Who: "), `${g.devs.join(", ") || "?"}`, g.self ? " (self-published)" : `, published by ${g.pubs.join(", ")}${g.pubGames ? ` (${g.pubGames} games)` : ""}`, g.devGames ? `. ${g.devGames} released game${g.devGames === 1 ? "" : "s"}, ${fmtK(g.devReviews)} reviews in all.` : ". No released game yet."),
      h("p", h("b", "Why: "), g.why.join("; ") || "–"),
      h("p.mka-dim", `Tags: ${tagList(g.tags, 6)}${g.langs != null ? ` · ${g.langs} languages` : ""}${g.price ? ` · ${money(g.price)}` : ""}`),
      h("div.mka-actions", h("a.btn", { href: storeUrl(g.appid), target: "_blank", rel: "noopener" }, "Store page ↗"),
        h("button.btn", { type: "button", onclick: (e) => C.copy(contactText(g, "upcoming"), e.currentTarget) }, "Copy lead summary"))))) : null,
  ]);
  return h("div.mka-view",
    h("p.mka-lede", `Games not out yet, on any engine: ${fmtK(all.length)} with a date in the next 18 months or a demo out. The best leads are self-published, in a tag whose games often become hits, by a studio that already shipped something people bought.`),
    h("div.mka-bar-row.mka-filters",
      toggle("Self-published only", f.self, () => { f.self = !f.self; save("upcoming"); }),
      toggle("Hide real publishers", f.hidePub, () => { f.hidePub = !f.hidePub; save("upcoming"); }),
      toggle("Hot tags only", f.hot, () => { f.hot = !f.hot; save("upcoming"); }, "A strongest tag whose hit rate is 1.5× Steam's or more"),
      toggle("Godot only", f.godot, () => { f.godot = !f.godot; save("upcoming"); }),
      toggle("Demo out", f.demo, () => { f.demo = !f.demo; save("upcoming"); })),
    h("div.mka-bar-row.mka-filters",
      seg("Out within", [[90, "3 months"], [180, "6"], [365, "12"], [540, "18"], [0, "Any, incl. no date"]], f.within, (v) => { f.within = v; save("upcoming"); }),
      seg("Studio's best game", [[0, "Any"], [10, "10+ reviews"], [100, "100+"], [1000, "1k+"]], f.track, (v) => { f.track = v; save("upcoming"); }),
      search("up-q", f.q, "Find a game, studio or tag", (v) => { f.q = v; })),
    card(`${fmtK(list.length)} upcoming games, best lead first`, "Click a game for who to contact and a summary to copy.",
      sortTable(cols, rows, null, null), more(f.shown, list.length, () => { f.shown += 40; }), legend(cols, false)));
}

// ---------------------------------------------------------------------------
// Releases: the hit index
// ---------------------------------------------------------------------------

function releasesView() {
  const h = C.h, f = mk.releases, d = today();
  const q = f.q.trim().toLowerCase();
  const adult = adultIds();
  const list = games().filter((g) => d - g.day <= f.days && g.hit != null && (!f.indie || g.indie) && (!f.self || g.self) && (!f.godot || g.godot)
    && (f.adult || !g.top.some((x) => adult.has(x))) && (!q || g.name.toLowerCase().includes(q) || g.top.some((t) => tagName(t).toLowerCase().includes(q))))
    .sort((a, b) => b.hit - a.hit || b.reviews - a.reviews);
  const cols = [
    { label: "Game", tip: "The release, with a Godot mark when detected." },
    { label: "Hit index", num: true, tip: "Its review count as a percentile among games released within a week of it: 99 = more reviews than 99% of them. 90+ counts as a hit." },
    { label: "Reviews", num: true, tip: "Steam reviews so far." },
    { label: "Positive", num: true, tip: "Share of positive reviews." },
    { label: "Released", tip: "Release date and days since." },
    { label: "Price", num: true, tip: "Price at full price." },
    { label: "Publisher", tip: "Self = self-published." },
    { label: "Tags", tip: "Its strongest tags (Indie left out)." },
  ];
  const rows = list.slice(0, f.shown).map((g) => h("tr",
    h("td", gameLink(g.appid, g.name), g.godot ? badge("Godot", "godot") : null),
    barCell(g.hit / 100, String(g.hit), g.hit >= 99 ? SER.green : SER.blue),
    h("td.mka-num", fmtK(g.reviews)), h("td.mka-num", g.pos ? `${g.pos}%` : "–"),
    h("td", dayDate(g.day), h("span.mka-dim", ` · ${d - g.day} d`)), h("td.mka-num", money(g.price)),
    h("td", g.self ? badge("Self", "self") : "publisher"), h("td.mka-dim", tagList(g.top, 3))));
  return h("div.mka-view",
    h("p.mka-lede", "New releases ranked by the hit index: how they do against games that came out the same week. Good for seeing what's working right now; already-released hits are rarely signable."),
    h("div.mka-bar-row.mka-filters",
      seg("Released within", [[7, "7 days"], [30, "30"], [90, "90"], [365, "A year"]], f.days, (v) => { f.days = v; save("releases"); }),
      toggle("Indie", f.indie, () => { f.indie = !f.indie; save("releases"); }),
      toggle("Self-published", f.self, () => { f.self = !f.self; save("releases"); }),
      toggle("Godot", f.godot, () => { f.godot = !f.godot; save("releases"); }),
      toggle("Adult games", f.adult, () => { f.adult = !f.adult; save("releases"); }),
      search("rel-q", f.q, "Find a game or tag", (v) => { f.q = v; })),
    h("div.mka-stats",
      stat("Released", fmtK(list.length), `in the last ${f.days} days, with these filters`),
      stat("Hits (90+)", fmtK(list.filter((g) => g.hit >= 90).length), "top 10% of their week"),
      stat("Breakouts (99)", fmtK(list.filter((g) => g.hit >= 99).length), "top 1%")),
    card("New releases by hit index", null, sortTable(cols, rows, null, null), more(f.shown, list.length, () => { f.shown += 50; }), legend(cols, false)));
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

function injectStyle() {
  if (document.getElementById("mk-analyst-style")) return;
  const s = document.createElement("style");
  s.id = "mk-analyst-style";
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.mkv-analyst { color: var(--fb-ink); font-size: 14px; line-height: 1.45; min-width: 0; }
.mkv-analyst * { box-sizing: border-box; }
.mkv-analyst .mka-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--fb-line); margin: 0 0 14px; overflow-x: auto; scrollbar-width: none; }
.mkv-analyst .mka-tabs button { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; color: var(--fb-ink-2); font: inherit; font-weight: 600; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
.mkv-analyst .mka-tabs button:hover { color: var(--fb-ink); }
.mkv-analyst .mka-tabs button[aria-pressed="true"] { color: var(--fb-title); border-bottom-color: var(--fb-accent); }
.mkv-analyst .mka-view { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.mkv-analyst .mka-lede { margin: 0; color: var(--fb-ink-2); max-width: 75ch; }
.mkv-analyst .mka-lede b, .mkv-analyst .mka-answer b { color: var(--fb-title); }
.mkv-analyst .mka-empty { color: var(--fb-muted); padding: 24px 0; }
.mkv-analyst .mka-card { position: relative; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.mkv-analyst .mka-card h3 { margin: 0 0 2px; font-size: 15px; color: var(--fb-title); }
.mkv-analyst .mka-sub { margin: 0 0 10px; color: var(--fb-muted); font-size: 13px; max-width: 80ch; }
.mkv-analyst .mka-answer { margin: 4px 0 10px; padding: 10px 12px; background: var(--fb-card-2); border-radius: 8px; max-width: 85ch; }
.mkv-analyst .mka-note { margin: 0; color: var(--fb-muted); font-size: 12px; }
.mkv-analyst .mka-dim { color: var(--fb-muted); font-weight: 400; }
.mkv-analyst .mka-bar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-bottom: 8px; }
.mkv-analyst .mka-filters { margin: 0; }
.mkv-analyst .mka-seg { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 0; border: 1px solid var(--fb-line); border-radius: 8px; overflow: hidden; background: var(--fb-card); }
.mkv-analyst .mka-seg-l { padding: 4px 8px; color: var(--fb-muted); font-size: 12px; border-right: 1px solid var(--fb-line); }
.mkv-analyst .mka-seg button { appearance: none; border: 0; background: none; color: var(--fb-ink-2); font: inherit; font-size: 13px; padding: 4px 10px; cursor: pointer; }
.mkv-analyst .mka-seg button + button { border-left: 1px solid var(--fb-line); }
.mkv-analyst .mka-seg button[aria-pressed="true"] { background: var(--fb-accent); color: var(--fb-card); font-weight: 600; }
.mkv-analyst .mka-toggle { appearance: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink-2); border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 13px; cursor: pointer; }
.mkv-analyst .mka-toggle[aria-pressed="true"] { color: var(--fb-title); border-color: var(--fb-accent); }
.mkv-analyst .mka-check { display: inline-grid; place-items: center; width: 14px; height: 14px; border: 1px solid var(--fb-line); border-radius: 3px; font-size: 11px; line-height: 1; }
.mkv-analyst .mka-toggle[aria-pressed="true"] .mka-check { background: var(--fb-accent); border-color: var(--fb-accent); color: var(--fb-card); }
.mkv-analyst .mka-search { font: inherit; font-size: 13px; padding: 5px 10px; border: 1px solid var(--fb-line); border-radius: 8px; background: var(--fb-card); color: var(--fb-ink); min-width: 0; width: 220px; max-width: 100%; }
.mkv-analyst .mka-scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
.mkv-analyst table.mka-t { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
.mkv-analyst .mka-t th { text-align: left; font-weight: 600; color: var(--fb-muted); font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; cursor: help; vertical-align: bottom; }
.mkv-analyst .mka-t th button { appearance: none; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.mkv-analyst .mka-t th[aria-sort] { color: var(--fb-title); }
.mkv-analyst .mka-t td { padding: 6px 8px; border-bottom: 1px solid var(--fb-line); vertical-align: top; }
.mkv-analyst .mka-t .mka-num { text-align: right; white-space: nowrap; }
.mkv-analyst .mka-t-sm td, .mkv-analyst .mka-t-sm th { padding: 4px 6px; }
.mkv-analyst .mka-click { cursor: pointer; }
.mkv-analyst .mka-click:hover td { background: var(--fb-hover); }
.mkv-analyst .mka-click[aria-selected="true"] td, .mkv-analyst .mka-click[aria-expanded="true"] td { background: var(--fb-card-2); }
.mkv-analyst .mka-sub > td { background: var(--fb-card-2); }
.mkv-analyst .mka-why { color: var(--fb-ink-2); min-width: 220px; }
.mkv-analyst .mka-barcell { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
.mkv-analyst .mka-bar { display: inline-block; width: 56px; height: 6px; border-radius: 3px; background: var(--fb-card-2); overflow: hidden; }
.mkv-analyst .mka-bar i { display: block; height: 100%; border-radius: 3px; }
.mkv-analyst .mka-conf { display: inline-flex; gap: 2px; vertical-align: middle; }
.mkv-analyst .mka-conf i { width: 5px; height: 10px; border-radius: 1px; background: var(--fb-line); }
.mkv-analyst .mka-conf[data-level="1"] i:nth-child(-n+1), .mkv-analyst .mka-conf[data-level="2"] i:nth-child(-n+2), .mkv-analyst .mka-conf[data-level="3"] i { background: var(--fb-ink-2); }
.mkv-analyst .mka-g1 { color: var(--fb-good-text); }
.mkv-analyst .mka-g-1 { color: var(--fb-negative); }
.mkv-analyst .mka-g0 { color: var(--fb-ink-2); }
.mkv-analyst .mka-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; margin-left: 6px; border-radius: 10px; border: 1px solid var(--fb-line); color: var(--fb-ink-2); white-space: nowrap; vertical-align: 1px; }
.mkv-analyst td > .mka-badge:first-child, .mkv-analyst span > .mka-badge:first-child { margin-left: 0; }
.mkv-analyst .mka-b-self { border-color: var(--fb-good-text); color: var(--fb-good-text); }
.mkv-analyst .mka-b-pub { color: var(--fb-muted); }
.mkv-analyst .mka-b-godot { border-color: var(--sw-1); color: var(--fb-link); }
.mkv-analyst .mka-b-up, .mkv-analyst .mka-b-new { border-color: var(--sw-4); color: var(--fb-ink); }
.mkv-analyst .mka-chart { display: block; width: 100%; height: auto; overflow: visible; }
.mkv-analyst .mka-plot { min-width: 0; }
.mkv-analyst .mka-chart text { font-family: inherit; }
.mkv-analyst .mka-ax { fill: var(--fb-muted); font-size: 11px; }
.mkv-analyst .mka-axt { fill: var(--fb-ink-2); font-size: 12px; }
.mkv-analyst .mka-dl { fill: var(--fb-ink); font-size: 11.5px; font-weight: 600; paint-order: stroke; stroke: var(--fb-card); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
.mkv-analyst .mka-dl-sel { fill: var(--fb-title); font-size: 13px; }
.mkv-analyst .mka-quad { fill: var(--fb-ink-2); font-size: 12px; font-weight: 700; }
.mkv-analyst .mka-grid { stroke: var(--fb-line); stroke-width: 1; opacity: .6; }
.mkv-analyst .mka-base { stroke: var(--fb-line); stroke-width: 1; }
.mkv-analyst .mka-ref { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 4 3; }
.mkv-analyst .mka-split { stroke: var(--fb-ink-2); stroke-width: 1; stroke-dasharray: 2 4; opacity: .7; }
.mkv-analyst .mka-gapzone { fill: var(--sw-3); opacity: .08; }
.mkv-analyst .mka-cross { stroke: var(--fb-muted); stroke-width: 1; }
.mkv-analyst .mka-dot { cursor: pointer; outline: none; }
.mkv-analyst .mka-dot:hover circle:first-child, .mkv-analyst .mka-dot:focus circle:first-child { fill-opacity: 1; stroke: var(--fb-ink); }
.mkv-analyst .mka-tip { position: absolute; display: none; z-index: 5; pointer-events: none; background: var(--fb-card); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.5; box-shadow: var(--fb-shadow, 0 4px 14px rgba(0,0,0,.15)); max-width: 280px; }
.mkv-analyst .mka-tip-t { font-weight: 700; color: var(--fb-title); margin-bottom: 2px; }
.mkv-analyst .mka-key { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.mkv-analyst .mka-key-ring { background: none; border: 2px solid var(--fb-muted); width: 14px; height: 14px; vertical-align: -3px; }
.mkv-analyst .mka-key-zone { background: var(--sw-3); opacity: .35; border-radius: 2px; }
.mkv-analyst .mka-legend-inline { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 12px; color: var(--fb-ink-2); margin: 0 0 6px; }
.mkv-analyst .mka-legend { margin-top: 10px; font-size: 12px; color: var(--fb-ink-2); }
.mkv-analyst .mka-legend summary { cursor: pointer; color: var(--fb-link); }
.mkv-analyst .mka-legend dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 8px 0 0; }
.mkv-analyst .mka-legend dt { font-weight: 600; color: var(--fb-ink); }
.mkv-analyst .mka-legend dd { margin: 0; }
.mkv-analyst .mka-legend p, .mkv-analyst .mka-legend ul { margin: 6px 0; }
.mkv-analyst .mka-detail { border-color: var(--fb-accent); }
.mkv-analyst .mka-detail-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.mkv-analyst .mka-plain { margin: 8px 0 12px; padding-left: 18px; max-width: 90ch; }
.mkv-analyst .mka-plain li { margin: 3px 0; }
.mkv-analyst .mka-plain b { color: var(--fb-title); }
.mkv-analyst .mka-detail-box p { margin: 4px 0; max-width: 90ch; }
.mkv-analyst .mka-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.mkv-analyst .mka-more { margin-top: 8px; }
.mkv-analyst .mka-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.mkv-analyst .mka-stat { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; padding: 10px 12px; }
.mkv-analyst .mka-stat-l { font-size: 12px; color: var(--fb-muted); }
.mkv-analyst .mka-stat-v { font-size: 22px; font-weight: 700; color: var(--fb-title); font-variant-numeric: tabular-nums; }
.mkv-analyst .mka-stat-m { font-size: 12px; color: var(--fb-ink-2); }
.mkv-analyst .mka-multiples { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.mkv-analyst .mka-panel { position: relative; border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px 4px; min-width: 0; }
.mkv-analyst .mka-panel-head { display: flex; justify-content: space-between; align-items: center; }
.mkv-analyst .mka-panel-v { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.mkv-analyst .mka-x { appearance: none; border: 0; background: none; color: var(--fb-muted); font-size: 16px; cursor: pointer; padding: 0 4px; }
.mkv-analyst .mka-x:hover { color: var(--fb-ink); }
@media (max-width: 640px) {
  .mkv-analyst .mka-card { padding: 12px; }
  .mkv-analyst .mka-search { width: 100%; }
  .mkv-analyst .mka-legend dl { grid-template-columns: 1fr; }
  .mkv-analyst .mka-legend dd { margin-bottom: 6px; }
  .mkv-analyst .mka-quad { font-size: 15px; }
  .mkv-analyst .mka-ax { font-size: 14px; }
  .mkv-analyst .mka-dl { font-size: 14px; }
}
`;
