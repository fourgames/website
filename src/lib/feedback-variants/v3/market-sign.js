// Market, "Who should I sign?": the games a small Godot publisher could sign, in three stages
// (coming soon, just out, proven) as a dense board or one filterable table, with a shortlist and a
// "not interested" list. Imported by market-merged.js: signView(ctx, files, redraw) returns one
// element (.mkv-sign); redraw() re-renders the page, which calls signView again. State lives here
// and in ctx.store under "mkv-merged-sign-". Heavy work (20k upcoming rows) is done once per file set.

const DAY = 86400;
const P = "mkv-merged-sign-";
const INDIE = 492;
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
import { isJoke } from "./market-merged.js";
// A publisher with this many games on Steam or more is a real publisher, not a small label.
const REAL_PUB = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STAGES = [
  ["soon", "Coming soon", "Not out yet: the best time to sign. Lead score: the studio's past results, how often its niche's games become hits, how soon it's out, and a demo."],
  ["fresh", "Just out (≤ 90 days)", "Released in the last 90 days. Hit score: how many games out the same fortnight it beats on reviews, lowered for weak reviews or games already too big."],
  ["proven", "Proven", "Out 3 months to 3 years, 80%+ positive, still small. Upside score: well liked, few reviews for that quality, and things a publisher fixes cheaply."],
];
const STAGE_NAME = { soon: "Coming soon", fresh: "Just out", proven: "Proven" };
const STAGE_RANK = { soon: 0, fresh: 1, proven: 2 };
const PUB_TEXT = { self: "Self-published", label: "Small label", real: "Has a publisher" };
const PUB_WHO = { self: "Self-published", label: "Small-label", real: "Published" };
const PUB_RANK = { self: 0, label: 1, real: 2 };

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

const num = (n) => n == null ? "–" : Math.round(n).toLocaleString("en-US");
const fmtK = (n) => n == null ? "–" : n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const pct = (x, d = 0) => x == null ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const dayShort = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;
const capsule = (appid) => `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`;
const ageWords = (age) => age < 60 ? plural(age, "day") : age < 730 ? `${Math.round(age / 30.4)} months` : `${(age / 365).toFixed(1)} years`;

// "1 in 4": a share said the way people say it.
function oneIn(p) {
  if (p == null) return "–";
  if (p >= 0.5) return p >= 0.7 ? "most" : "more than half";
  if (p <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / p))}`;
}

// A coming-soon date as the store means it. `kind` is the store's release_display kind
// ("date_full", "date_month", "date_quarter", "date_year", "Coming soon", "To be announced"):
// never shown raw. No day, or no announced date: "TBA".
function whenText(day, kind, today) {
  if (day == null || kind === "Coming soon" || kind === "To be announced") return { label: "TBA", days: null, exact: false, rough: true };
  const t = new Date(day * DAY * 1000), y = t.getUTCFullYear(), days = day - today;
  if (kind === "date_year") return { label: String(y), days, exact: false, rough: true };
  if (kind === "date_quarter") return { label: `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${y}`, days, exact: false, rough: true };
  if (kind === "date_month") return { label: `${MONTHS[t.getUTCMonth()]} ${y}`, days, exact: false, rough: false };
  return { label: dayDate(day), days, exact: true, rough: false };
}

// Self-published, a small label, or a real publisher. A publisher listed as a co-developer
// (developers "A, B", publisher "B") counts as a label, not as self-published.
function pubKind(self, pubGames, devs, pubs) {
  if (self && devs?.length > 1 && pubs?.length && !pubs.includes(devs[0])) return pubGames >= REAL_PUB ? "real" : "label";
  if (self) return "self";
  if (pubGames == null) return "real";
  return pubGames >= REAL_PUB ? "real" : "label";
}

// Tags with a hit rate. Hot = enough games to judge (20+) and hits 1.5× as often as Steam's average
// (the server's hit rate is already shrunk toward Steam's, so a handful of lucky games can't be hot).
function tagMap(trends) {
  return new Map((trends?.tags || []).filter((t) => t.hitRate != null && t.tag !== INDIE).map((t) => [t.tag, {
    tag: t.tag, name: t.name, lift: t.hitLift, rate: t.hitRate, n: t.hitGames, hot: t.hitGames >= 20 && t.hitLift >= 1.5 }]));
}
// The strongest of a game's top five tags, with enough games behind it to mean something.
function bestTag(tags, tm) {
  let best = null;
  for (const t of (tags || []).slice(0, 5)) { const r = tm.get(t); if (r && r.n >= 20 && (!best || r.lift > best.lift)) best = r; }
  return best;
}

// What a publisher could add to a released game, cheaply. Platforms and the Deck rating come from
// the store list (deck: 0 = no rating, 1 = unsupported); languages only once store details are in.
function upsideList(g) {
  const out = [];
  if (!g.mac && !g.linux) out.push("no Mac/Linux build");
  else if (!g.mac) out.push("no Mac build");
  else if (!g.linux) out.push("no Linux build");
  if (!g.deck) out.push("no Deck rating");
  else if (g.deck === 1) out.push("fails on Steam Deck");
  if (g.languages != null && g.languages < 5) out.push(g.languages <= 1 ? "1 language" : `only ${g.languages} languages`);
  return out;
}

const pubNameOf = (devs, pubs) => (pubs || []).filter((p) => !(devs || []).includes(p)).join(", ");

// Coming soon: lead score 0–100.
function scoreSoon(u, tm, today) {
  const w = whenText(u.day, u.display, today);
  const hot = bestTag(u.tags, tm);
  let soon = w.days == null ? 0.3 : w.days < 0 ? 0.5 : w.days <= 90 ? 1 : w.days <= 180 ? 0.8 : w.days <= 365 ? 0.55 : 0.35;
  if (w.rough) soon *= 0.75;
  const track = u.devGames ? clamp(Math.log10(u.devBest + 1) / 3.5) : 0.25;
  const niche = hot ? clamp((hot.lift - 0.8) / 1.7) : 0.15;
  const score = Math.round(100 * (0.3 * track + 0.25 * niche + 0.25 * soon + 0.2 * (u.demo ? 1 : 0)));
  const who = `${PUB_WHO[u.pub]}${u.godot ? " Godot" : ""} game`;
  let when;
  if (w.days == null) when = u.demo ? "no date yet, but a demo is out" : "no date yet";
  else if (w.days < 0) when = `planned for ${w.label}, date passed: still coming`;
  else if (!w.exact) when = `planned for ${w.label}`;
  else if (w.days === 0) when = "out today";
  else if (w.days <= 60) when = `out in ${plural(w.days, "day")} (${dayShort(u.day)})`;
  else when = `out ${w.label}`;
  const parts = [`${who}, ${when}`];
  if (hot && hot.lift >= 1.3) parts.push(`in ${hot.name}, where ${oneIn(hot.rate)} recent games became a hit`);
  if (u.devBest >= 50) parts.push(`the studio's best game has ${num(u.devBest)} reviews`);
  else if (!u.devGames) parts.push("the studio's first game");
  else parts.push(`the studio's earlier games are small (${num(u.devBest)} reviews at best)`);
  if (u.demo && w.days != null) parts.push("demo out");
  return { score, why: parts.join("; ") + ".", when: w, hot };
}

// Just out: the hit index (reviews vs games out the same fortnight), lowered for poor reviews and
// for games already so big they're out of reach.
function scoreFresh(g, today) {
  const q = g.pos == null ? 0.7 : g.pos >= 80 ? 1 : g.pos >= 70 ? 0.85 : 0.6;
  const big = g.reviews > 3000 ? 0.6 : 1;
  const score = Math.round((g.hit ?? 40) * q * big);
  const age = today - g.day;
  const up = upsideList(g);
  const who = `${PUB_WHO[g.pub]}${g.godot ? " Godot" : ""} game`;
  const why = `${who}, out ${age === 0 ? "today" : ageWords(age)}: ${plural(g.reviews, "review")}${g.pos != null ? `, ${g.pos}% positive` : ""}`
    + (g.hit != null ? `, more reviews than ${g.hit}% of games out the same fortnight` : "")
    + (g.reviews > 3000 ? "; already big, likely out of reach" : up.length ? `; ${up.slice(0, 2).join(", ")}` : "") + ".";
  return { score, why, up };
}

// Proven: well liked, still small, with concrete things to improve.
function scoreProven(g, today) {
  const trust = clamp(Math.log10(g.reviews) / 2.5);
  const quality = clamp((g.pos - 78) / 20) * trust;
  const small = 1 - clamp(Math.log10(Math.max(g.reviews, 20)) / Math.log10(20000));
  const up = upsideList(g);
  const fix = clamp(up.length / 3);
  const hitf = clamp((g.hit ?? 50) / 100);
  const score = Math.round(100 * (0.35 * quality + 0.2 * small + 0.3 * fix + 0.15 * hitf));
  const age = today - g.day;
  const why = `${PUB_WHO[g.pub]}, ${g.pos}% positive from ${num(g.reviews)} reviews, out ${ageWords(age)}`
    + (up.length ? `; room to grow: ${up.join(", ")}` : ": well liked, still a small audience") + ".";
  return { score, why, up };
}

// Every lead in every stage, unfiltered and scored, once per file set.
function buildEntries(files) {
  const o = files.overview || {}, today = o.today ?? Math.floor(Date.now() / 1000 / DAY);
  const names = o.tags || {};
  const adultWant = new Set(ADULT.map((s) => s.toLowerCase()));
  const adult = new Set(Object.entries(names).filter(([, n]) => adultWant.has(String(n).trim().toLowerCase())).map(([id]) => Number(id)));
  const tm = tagMap(files.trends);
  const gd = new Map((files.godot?.games || []).map((g) => [g.appid, g]));
  const out = [];
  const seen = new Set();
  const isAdult = (tags, name) => (tags || []).slice(0, 5).some((t) => adult.has(t)) || isJoke(name);
  const addSoon = (u) => {
    u.pub = pubKind(u.self, u.pubGames, u.devs, u.pubs);
    const s = scoreSoon(u, tm, today);
    out.push({ appid: u.appid, name: u.name, stage: "soon", godot: u.godot, pub: u.pub, pubName: pubNameOf(u.devs, u.pubs), pubGames: u.pubGames,
      studio: u.devs.join(", "), tags: u.tags, adult: isAdult(u.tags, u.name), demo: u.demo, day: u.day, days: s.when.days, whenLabel: s.when.label,
      devGames: u.devGames, devBest: u.devBest, reviews: null, pos: null, hot: s.hot, score: s.score, why: s.why, up: [], langs: u.langs });
  };
  const up = files.upcoming;
  if (up?.rows) {
    const col = Object.fromEntries(up.columns.map((c, i) => [c, i]));
    for (const r of up.rows) {
      const fl = r[col.flags] || 0, appid = r[col.appid];
      seen.add(appid);
      const g = gd.get(appid);
      addSoon({ appid, name: r[col.name], day: r[col.day], display: r[col.display], tags: r[col.tags] || [], self: !!(fl & 256), demo: !!(fl & 128),
        godot: !!(fl & 64) || !!g, devs: r[col.devs] || [], pubs: r[col.pubs] || [], devGames: r[col.devGames] || 0, devBest: r[col.devBest] || 0,
        pubGames: r[col.pubGames] ?? null, langs: r[col.langs] });
    }
  }
  for (const g of files.godot?.games || []) {
    const tags = g.tags || [];
    if (g.comingSoon) {
      if (seen.has(g.appid)) continue;
      // Godot games the upcoming file leaves out (no date within 18 months and no demo).
      addSoon({ appid: g.appid, name: g.name, day: g.day, display: g.releaseDisplay || (g.day != null ? "date_full" : "Coming soon"), tags, self: g.selfPublished,
        demo: !!g.demos, godot: true, devs: g.developers || [], pubs: g.publishers || [], devGames: g.devGames || 0, devBest: g.devReviews || 0,
        pubGames: g.publisherGames ?? null, langs: g.languages });
      continue;
    }
    if (g.day == null) continue;
    const age = today - g.day;
    if (age < 0 || g.reviews == null) continue;
    const pub = pubKind(g.selfPublished, g.publisherGames, g.developers, g.publishers);
    const e = { ...g, godot: true, pub };
    let stage, s;
    if (age <= 90) { if (g.reviews < 3) continue; stage = "fresh"; s = scoreFresh(e, today); }
    else if (age <= 1095 && g.pos != null && g.pos >= 80 && g.reviews >= 20 && g.reviews <= 15000) { stage = "proven"; s = scoreProven(e, today); }
    else continue;
    // The studio's best other game, roughly: its total reviews minus this one's.
    const other = (g.devGames || 0) > 1 ? Math.max(0, (g.devReviews || 0) - g.reviews) : 0;
    out.push({ appid: g.appid, name: g.name, stage, godot: true, pub, pubName: pubNameOf(g.developers, g.publishers), pubGames: g.publisherGames,
      studio: (g.developers || []).join(", "), tags, adult: isAdult(tags, g.name), demo: !!g.demos, day: g.day, days: -age, whenLabel: dayDate(g.day),
      devGames: Math.max(0, (g.devGames || 0) - 1), devBest: other, reviews: g.reviews, pos: g.pos, hit: g.hit, hot: bestTag(tags, tm),
      score: s.score, why: s.why, up: s.up, langs: g.languages });
  }
  return { list: out, today, byId: new Map(out.map((e) => [e.appid, e])) };
}

const order = (a, b) => (b.godot - a.godot) || (PUB_RANK[a.pub] - PUB_RANK[b.pub]) || (b.score - a.score) || ((b.pos ?? 0) - (a.pos ?? 0)) || a.appid - b.appid;

// The shared filters. mode: "all" | "short" (only starred, whatever the filters) | "hidden".
function filterEntries(list, f, starred, hidden) {
  let out;
  if (f.mode === "hidden") out = list.filter((e) => hidden.has(e.appid));
  else if (f.mode === "short") out = list.filter((e) => starred.has(e.appid) && !hidden.has(e.appid));
  else out = list.filter((e) => !e.adult && !hidden.has(e.appid) && (!f.godot || e.godot)
    && (e.pub === "self" || (!f.self && (e.pub === "label" || f.pubs))));
  return out.sort(order);
}

// The table's own filters on top.
function tableFilter(list, t, tagName = (id) => String(id)) {
  const q = (t.q || "").trim().toLowerCase();
  return list.filter((e) => (t.stage === "all" || e.stage === t.stage)
    && (!t.hot || e.hot?.hot) && (!t.demo || e.demo)
    && (!t.within || (e.stage === "soon" && e.days != null && e.days >= -30 && e.days <= t.within))
    && (e.devBest || 0) >= (t.track || 0)
    && (!q || e.name.toLowerCase().includes(q) || e.studio.toLowerCase().includes(q) || e.tags.some((x) => tagName(x).toLowerCase().includes(q))));
}

const SORTS = {
  score: (e) => e.score,
  stage: (e) => -STAGE_RANK[e.stage],
  when: (e) => e.day ?? Infinity,
  reviews: (e) => e.reviews ?? -1,
  best: (e) => e.devBest || 0,
};
function sortRows(list, sort) {
  if (!sort || !SORTS[sort.key]) return list;
  const v = SORTS[sort.key];
  return [...list].sort((a, b) => { const x = v(a), y = v(b); return (x === y ? order(a, b) : (x < y ? -1 : 1) * sort.dir); });
}

// The shortlist as a request Claude can work through.
function shortlistText(items, tagName = (id) => String(id)) {
  const lines = [`I run a small Godot studio and want to sign or publish small indie games. Here is my shortlist from the Steam market data (${plural(items.length, "game")}). For each one: look up the studio (other games, socials, a contact), say whether it fits a small Godot-only publisher and what we could offer (ports, languages, Steam Deck, marketing), and draft a short, friendly first message.`, ""];
  items.forEach((e, i) => {
    lines.push(`${i + 1}. ${e.name}: ${storeUrl(e.appid)}`);
    if (e.studio != null) {
      lines.push(`   Studio: ${e.studio || "?"}; ${e.pub === "self" ? "self-published" : `publisher: ${e.pubName || "?"}${e.pubGames ? ` (${e.pubGames} games)` : ""}`}${e.godot ? "; made with Godot" : ""}`);
      lines.push(`   Stage: ${STAGE_NAME[e.stage]}, ${e.stage === "soon" ? `release ${e.whenLabel}` : `released ${e.whenLabel}, ${e.reviews} reviews, ${e.pos ?? "?"}% positive`}`);
      lines.push(`   Tags: ${(e.tags || []).filter((t) => t !== INDIE).slice(0, 5).map(tagName).join(", ")}`);
      lines.push(`   Why: ${e.why}`);
    } else lines.push(`   (No longer in the market data; was ${STAGE_NAME[e.stage] || "a lead"}.)`);
  });
  return lines.join("\n");
}

export const _test = { whenText, pubKind, tagMap, bestTag, upsideList, scoreSoon, scoreFresh, scoreProven, buildEntries, filterEntries, tableFilter, sortRows, shortlistText, oneIn };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let C, R; // ctx, redraw
const S = {
  ready: false,
  view: "board", godot: true, self: true, pubs: false, mode: "all", col: "soon",
  shown: { soon: 8, fresh: 8, proven: 8 },
  t: { stage: "all", hot: false, demo: false, within: 0, track: 0, q: "", sort: { key: "score", dir: -1 }, shown: 40 },
  starred: [], // [{appid, name, stage, added}], newest first
  hidden: {}, // appid → name
  refocus: null,
};
const badImg = new Set();
let built = { key: null, value: null };
let filtered = { key: null, value: null };

const sget = (k, d) => { try { const v = C.store.get(P + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const sset = (k, v) => { try { C.store.set(P + k, JSON.stringify(v)); } catch {} };
function restore() {
  if (S.ready) return;
  S.ready = true;
  const f = sget("filters", {});
  for (const k of ["view", "godot", "self", "pubs", "col"]) if (f[k] != null) S[k] = f[k];
  Object.assign(S.t, sget("table", {}), { q: "", shown: 40 });
  S.starred = sget("shortlist", []);
  S.hidden = sget("hidden", {});
}
const saveFilters = () => sset("filters", { view: S.view, godot: S.godot, self: S.self, pubs: S.pubs, col: S.col });
const saveTable = () => { const { stage, hot, demo, within, track, sort } = S.t; sset("table", { stage, hot, demo, within, track, sort }); };
const resetShown = () => { S.shown = { soon: 8, fresh: 8, proven: 8 }; S.t.shown = 40; };

let fileIds = new WeakMap(), nextId = 1;
const idOf = (o) => { if (!o) return 0; let id = fileIds.get(o); if (!id) fileIds.set(o, id = nextId++); return id; };

function data(files) {
  const key = ["overview", "trends", "upcoming", "godot"].map((n) => idOf(files[n])).join(",");
  if (built.key !== key) { built = { key, value: buildEntries(files) }; filtered = { key: null, value: null }; }
  const starred = new Set(S.starred.map((x) => x.appid));
  const hidden = new Set(Object.keys(S.hidden).map(Number));
  const fkey = [key, S.godot, S.self, S.pubs, S.mode, [...starred].join("."), [...hidden].join(".")].join("|");
  if (filtered.key !== fkey) filtered = { key: fkey, value: filterEntries(built.value.list, S, starred, hidden) };
  return { all: built.value, list: filtered.value, starred, hidden };
}

const tagNameOf = (files) => (id) => files.overview?.tags?.[id] || `Tag ${id}`;

function toggleStar(e) {
  if (S.starred.some((x) => x.appid === e.appid)) S.starred = S.starred.filter((x) => x.appid !== e.appid);
  else S.starred = [{ appid: e.appid, name: e.name, stage: e.stage, added: Math.floor(Date.now() / 1000) }, ...S.starred];
  sset("shortlist", S.starred);
  if (S.mode === "short" && !S.starred.length) S.mode = "all";
  R();
}
function toggleHide(e) {
  if (S.hidden[e.appid] != null) delete S.hidden[e.appid];
  else { S.hidden[e.appid] = e.name; S.starred = S.starred.filter((x) => x.appid !== e.appid); sset("shortlist", S.starred); }
  sset("hidden", S.hidden);
  if (S.mode === "hidden" && !Object.keys(S.hidden).length) S.mode = "all";
  R();
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export function signView(ctx, files, redraw) {
  C = ctx; R = redraw || (() => {});
  injectStyle();
  restore();
  const h = C.h;
  if (!files?.overview || !files?.upcoming || !files?.godot || !files?.trends) return h("div.mkv-sign", h("p.mks-empty", "Loading the leads…"));
  lastTrends = files.trends;
  const d = data(files);
  const tagName = tagNameOf(files);
  const root = h("div.mkv-sign", toolbar(d, files, tagName), S.view === "table" ? tableView(d, tagName) : boardView(d, tagName));
  if (S.refocus) {
    const { key, pos } = S.refocus;
    S.refocus = null;
    requestAnimationFrame(() => { const el = document.querySelector(`.mkv-sign input[data-key="${key}"]`); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} } });
  }
  return root;
}

const toggle = (label, on, flip, title) => C.h("button.mks-toggle", { type: "button", "aria-pressed": String(!!on), title: title || null, onclick: () => { flip(); R(); } },
  C.h("span.mks-check", { "aria-hidden": "true" }, on ? "✓" : ""), label);

function toolbar(d, files, tagName) {
  const h = C.h, o = files.overview;
  const nStar = S.starred.length, nHidden = Object.keys(S.hidden).length;
  const starredEntries = () => S.starred.map((x) => d.all.byId.get(x.appid) || x).filter((x) => S.hidden[x.appid] == null);
  const row1 = h("div.mks-bar",
    C.chips([["board", "Board"], ["table", "Table"]], S.view, (v) => { S.view = v; saveFilters(); R(); }, "Layout"),
    h("span.mks-sep", { "aria-hidden": "true" }),
    C.chips([[true, "Godot only"], [false, "Any engine"]], S.godot, (v) => { S.godot = v; saveFilters(); resetShown(); R(); }, "Engine"),
    toggle("Self-published only", S.self, () => { S.self = !S.self; if (S.self) S.pubs = false; saveFilters(); resetShown(); }, "No publisher on the store page"),
    toggle("Show real publishers", S.pubs, () => { S.pubs = !S.pubs; if (S.pubs) S.self = false; saveFilters(); resetShown(); }, `Also games with a publisher of ${REAL_PUB}+ games (usually taken)`),
    h("span.mks-spacer"),
    h("button.mks-toggle.mks-shortbtn", { type: "button", "aria-pressed": String(S.mode === "short"), disabled: nStar ? null : true, title: nStar ? "Show only the games you starred" : "Star a game (☆) to put it on your shortlist",
      onclick: () => { S.mode = S.mode === "short" ? "all" : "short"; resetShown(); R(); } }, `★ Shortlist (${nStar})`),
    nStar ? h("button.btn.mks-copy", { type: "button", title: "Copies the shortlist with a request to research each studio and draft a first message", onclick: (e) => C.copy(shortlistText(starredEntries(), tagName), e.currentTarget) }, "Copy for Claude") : null,
    nHidden ? h("button.mks-linkbtn", { type: "button", "aria-pressed": String(S.mode === "hidden"), onclick: () => { S.mode = S.mode === "hidden" ? "all" : "hidden"; resetShown(); R(); } },
      S.mode === "hidden" ? "back to all games" : `show hidden (${nHidden})`) : null);
  const what = S.mode === "short" ? "Your shortlist: every starred game, whatever the filters."
    : S.mode === "hidden" ? "Games you marked not interested. ↩ brings one back."
    : `${S.self ? "Self-published games only" : S.pubs ? "Every game: self-published first, then small labels, then real publishers" : `Self-published games and small labels (publishers with under ${REAL_PUB} games)`}, ${S.godot ? "made with Godot" : "any engine, Godot first"}. ☆ shortlists a game, ✕ hides it for good.`;
  const note = `Godot detection: ${num(o.withMetadata)} of ${num(o.games)} games checked so far (${pct(o.withMetadata / o.games)}), so many Godot games aren't marked yet.`;
  return h("div.mks-head", row1, h("p.mks-note", what, " ", h("span.mks-dim", note)));
}

// --- Board ---------------------------------------------------------------------------

function boardView(d, tagName) {
  const h = C.h;
  const by = { soon: [], fresh: [], proven: [] };
  for (const e of d.list) by[e.stage].push(e);
  const picker = h("div.mks-colpick", C.chips(STAGES.map(([id, label]) => [id, `${label.replace(/ \(.*\)/, "")} (${num(by[id].length)})`]), S.col, (v) => { S.col = v; saveFilters(); R(); }, "Stage"));
  const cols = STAGES.map(([id, label, about]) => {
    const list = by[id], shown = S.shown[id];
    const note = !S.godot && id !== "soon" && S.mode === "all" ? " Released games come from the Godot list only, so this column shows Godot games." : "";
    return h("section.mks-col", { class: `mks-${id}${S.col === id ? " mks-on" : ""}` },
      h("header.mks-colhead", h("h3", label, h("span.mks-count", num(list.length))), h("p", about, note)),
      list.length ? h("div.mks-cards", ...list.slice(0, shown).map((e) => card(e, d, tagName)))
        : h("p.mks-empty", S.mode === "all" ? "Nothing here with these filters." : "None."),
      list.length > shown ? h("button.btn.mks-more", { type: "button", onclick: () => { S.shown[id] += 8; R(); } }, `Show more (${num(list.length - shown)} left)`) : null);
  });
  return h("div.mks-boardwrap", picker, h("div.mks-board", ...cols));
}

function thumb(e) {
  if (badImg.has(e.appid)) return null;
  const h = C.h;
  const img = h("img", { src: capsule(e.appid), alt: "", loading: "lazy", decoding: "async", width: 120, height: 45 });
  const box = h("a.mks-thumb", { href: storeUrl(e.appid), target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" }, img);
  img.addEventListener("error", () => { badImg.add(e.appid); box.remove(); });
  return box;
}

function tagChips(e, tagName, n = 3) {
  const h = C.h, map = tagMapCache();
  return (e.tags || []).filter((t) => t !== INDIE).slice(0, n).map((t) => {
    const r = map.get(t);
    return h("span.mks-chip", { class: r?.hot ? "mks-hot" : null, title: r ? `${r.name}: ${pct(r.rate)} of its recent games became hits, ${times(r.lift)} Steam's average${r.hot ? " (a hot tag)" : ""}` : tagName(t) }, r?.hot ? "▲ " : "", tagName(t));
  });
}
let tmCache = { src: null, map: new Map() };
let lastTrends = null;
function tagMapCache() { if (tmCache.src !== lastTrends) tmCache = { src: lastTrends, map: tagMap(lastTrends) }; return tmCache.map; }

function iconButtons(e, d) {
  const h = C.h;
  const on = d.starred.has(e.appid), hid = d.hidden.has(e.appid);
  return [
    hid ? null : h("button.mks-icon.mks-star", { type: "button", "aria-pressed": String(on), title: on ? "On your shortlist: click to remove" : "Add to shortlist", "aria-label": on ? `Remove ${e.name} from the shortlist` : `Add ${e.name} to the shortlist`, onclick: () => toggleStar(e) }, on ? "★" : "☆"),
    h("button.mks-icon.mks-x", { type: "button", title: hid ? "Bring this game back" : "Not interested: hide this game for good", "aria-label": hid ? `Unhide ${e.name}` : `Hide ${e.name}`, onclick: () => toggleHide(e) }, hid ? "↩" : "✕"),
  ];
}

const meterName = { soon: "Lead", fresh: "Hit", proven: "Upside" };
function meter(e) {
  const h = C.h;
  return h("span.mks-meter", { title: `${meterName[e.stage]} score ${e.score} of 100` }, h("span.mks-ml", meterName[e.stage]), h("span.mks-track", h("i", { style: `width:${clamp(e.score / 100) * 100}%` })), h("b", e.score));
}
function badges(e) {
  const h = C.h;
  return [h("span.mks-badge", { class: `mks-p-${e.pub}`, title: e.pubName ? `Publisher: ${e.pubName}${e.pubGames ? ` (${e.pubGames} games on Steam)` : ""}` : "No outside publisher on the store page" }, PUB_TEXT[e.pub]),
    e.godot ? h("span.mks-badge.mks-godot", "Godot") : null];
}

function card(e, d, tagName) {
  const h = C.h;
  return h("article.mks-card", { class: `mks-${e.stage}` },
    h("div.mks-top", thumb(e),
      h("div.mks-main",
        h("div.mks-name", h("a", { href: storeUrl(e.appid), target: "_blank", rel: "noopener", title: e.name }, e.name), ...iconButtons(e, d)),
        h("div.mks-who", e.studio ? h("span.mks-studio", { title: e.studio }, e.studio) : null, ...badges(e)),
        h("div.mks-row2", meter(e), ...tagChips(e, tagName)))),
    h("p.mks-why", { title: e.why }, e.why));
}

// --- Table ---------------------------------------------------------------------------

function tableView(d, tagName) {
  const h = C.h, t = S.t;
  const tkey = [filtered.key, t.stage, t.hot, t.demo, t.within, t.track, t.q, t.sort.key, t.sort.dir].join("|");
  if (tableCache.key !== tkey) tableCache = { key: tkey, value: sortRows(tableFilter(d.list, t, tagName), t.sort) };
  const list = tableCache.value;
  const set = (k) => (v) => { t[k] = v; t.shown = 40; saveTable(); R(); };
  const filters = h("div.mks-bar.mks-tfilters",
    C.chips([["all", "All stages"], ["soon", "Coming soon"], ["fresh", "Just out"], ["proven", "Proven"]], t.stage, set("stage"), "Stage"),
    toggle("Hot tags only", t.hot, () => { t.hot = !t.hot; t.shown = 40; saveTable(); }, "Its strongest tag's games become hits 1.5× as often as Steam's average, or more"),
    toggle("Demo out", t.demo, () => { t.demo = !t.demo; t.shown = 40; saveTable(); }));
  const filters2 = h("div.mks-bar.mks-tfilters",
    h("span.mks-lab", "Out within"), C.chips([[0, "Any"], [90, "3 months"], [180, "6"], [365, "12"], [540, "18"]], t.within, set("within"), "Out within (coming soon only)"),
    h("span.mks-lab", "Studio's best game"), C.chips([[0, "Any"], [10, "10+ reviews"], [100, "100+"], [1000, "1k+"]], t.track, set("track"), "Studio's best past game"),
    h("input.mks-search", { type: "search", "data-key": "mks-q", value: t.q, placeholder: "Find a game, studio or tag", "aria-label": "Find a game, studio or tag",
      oninput: (ev) => { t.q = ev.target.value; t.shown = 40; S.refocus = { key: "mks-q", pos: ev.target.selectionStart ?? t.q.length }; R(); } }));
  const cols = [
    { label: "", tip: "Star to shortlist" },
    { label: "Game", tip: "The game, its studio, and who publishes it." },
    { key: "stage", label: "Stage", tip: "Coming soon, just out (90 days or less), or proven (out 3 months to 3 years, well liked)." },
    { key: "score", label: "Score", num: true, tip: "0–100 within its stage: Lead (coming soon), Hit (just out) or Upside (proven). See the board's column notes." },
    { key: "when", label: "Release", tip: "The planned date as precise as the store says (a year or quarter when that's all it gives; TBA when there's none), or the release date." },
    { key: "reviews", label: "Reviews", num: true, tip: "Released games: reviews and how many are positive." },
    { key: "best", label: "Studio's best", num: true, tip: "Reviews of the studio's best other released game: a track record says they can ship and sell." },
    { label: "Hot tag", tip: "Its strongest tag, with how often that tag's games become hits against Steam's average. ▲ = hot (1.5× or more)." },
    { label: "Why", tip: "The one-line reason." },
    { label: "", tip: "✕ hides a game for good" },
  ];
  const onSort = (key) => { t.sort = t.sort.key === key ? { key, dir: -t.sort.dir } : { key, dir: key === "when" ? 1 : -1 }; saveTable(); R(); };
  const head = h("tr", ...cols.map((c) => h("th", { title: c.tip, class: c.num ? "mks-num" : null, "aria-sort": c.key && t.sort.key === c.key ? (t.sort.dir > 0 ? "ascending" : "descending") : null },
    c.key ? h("button", { type: "button", onclick: () => onSort(c.key) }, c.label, t.sort.key === c.key ? (t.sort.dir > 0 ? " ↑" : " ↓") : "") : c.label)));
  const rows = list.slice(0, t.shown).map((e) => {
    const [starBtn, xBtn] = iconButtons(e, d);
    const hot = e.hot;
    return h("tr", { class: `mks-${e.stage}` },
      h("td.mks-ic", starBtn),
      h("td.mks-game", h("a", { href: storeUrl(e.appid), target: "_blank", rel: "noopener" }, e.name), h("div.mks-who", e.studio ? h("span.mks-studio", e.studio) : null, ...badges(e), e.demo && e.stage === "soon" ? h("span.mks-badge.mks-p-real", "Demo") : null)),
      h("td", h("span.mks-stage", STAGE_NAME[e.stage])),
      h("td.mks-num", meter(e)),
      h("td", e.whenLabel, h("div.mks-dim", e.stage === "soon" ? (e.days == null ? "no date yet" : e.days < 0 ? "date passed" : e.days === 0 ? "today" : `in ${plural(e.days, "day")}`) : `${ageWords(-e.days)} ago`)),
      h("td.mks-num", e.reviews != null ? fmtK(e.reviews) : "–", e.pos != null ? h("div.mks-dim", `${e.pos}% positive`) : null),
      h("td.mks-num", e.devBest ? fmtK(e.devBest) : "–", e.devGames ? h("div.mks-dim", plural(e.devGames, "game")) : h("div.mks-dim", "first game")),
      h("td", hot ? h("span", { class: hot.hot ? "mks-hottext" : null }, hot.hot ? "▲ " : "", hot.name, h("span.mks-dim", ` ${times(hot.lift)}`)) : "–"),
      h("td.mks-whycell", e.why),
      h("td.mks-ic", xBtn));
  });
  return h("div.mks-tablewrap", filters, filters2,
    h("p.mks-note", `${num(list.length)} games, ${t.sort.key === "score" ? "best score first" : `sorted by ${cols.find((c) => c.key === t.sort.key)?.label.toLowerCase()}`}. "Out within" keeps only coming-soon games due in that time. Hover a column title for what it means.`),
    list.length ? h("div.mks-scroll", h("table.mks-t", h("thead", head), h("tbody", ...rows))) : h("p.mks-empty", "No games with these filters."),
    list.length > t.shown ? h("button.btn.mks-more", { type: "button", onclick: () => { t.shown += 40; R(); } }, `Show ${Math.min(40, list.length - t.shown)} more (${num(list.length - t.shown)} left)`) : null);
}
let tableCache = { key: null, value: [] };

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const CSS = `
.mkv-sign { display: flex; flex-direction: column; gap: 10px; min-width: 0; color: var(--fb-ink); font-size: .9rem; }
.mkv-sign .mks-head { display: flex; flex-direction: column; gap: 6px; }
.mkv-sign .mks-bar { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; min-width: 0; }
.mkv-sign .mks-sep { width: 1px; height: 20px; background: var(--fb-line); margin: 0 2px; }
.mkv-sign .mks-spacer { flex: 1; }
.mkv-sign .mks-lab { font-size: .78rem; color: var(--fb-muted); }
.mkv-sign .mks-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: 1px solid var(--fb-line); border-radius: 999px; background: var(--fb-card); color: var(--fb-ink-2); font: inherit; font-size: .82rem; cursor: pointer; line-height: 1.3; }
.mkv-sign .mks-toggle:hover { background: var(--fb-hover); }
.mkv-sign .mks-toggle[aria-pressed="true"] { background: color-mix(in oklab, var(--fb-accent) 14%, var(--fb-card)); border-color: var(--fb-accent); color: var(--fb-ink); }
.mkv-sign .mks-toggle[disabled] { opacity: .55; cursor: default; }
.mkv-sign .mks-check { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid currentColor; display: inline-grid; place-items: center; font-size: 9px; line-height: 1; }
.mkv-sign .mks-shortbtn .mks-check { display: none; }
.mkv-sign .mks-linkbtn { background: none; border: 0; padding: 2px 4px; font: inherit; font-size: .8rem; color: var(--fb-link); cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.mkv-sign .mks-note { margin: 0; font-size: .8rem; line-height: 1.4; color: var(--fb-ink-2); }
.mkv-sign .mks-dim { color: var(--fb-muted); font-size: .76rem; }
.mkv-sign .mks-empty { margin: 0; padding: 8px 4px; color: var(--fb-muted); font-size: .84rem; }
.mkv-sign .mks-soon { --mks-stage: var(--sw-3); }
.mkv-sign .mks-fresh { --mks-stage: var(--sw-1); }
.mkv-sign .mks-proven { --mks-stage: var(--sw-4); }

.mkv-sign .mks-colpick { display: none; }
.mkv-sign .mks-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; align-items: start; }
.mkv-sign .mks-col { background: var(--fb-card-2); border: 1px solid var(--fb-line); border-top: 3px solid var(--mks-stage); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.mkv-sign .mks-colhead h3 { margin: 0; font-size: .95rem; display: flex; align-items: baseline; gap: 6px; color: var(--fb-title); }
.mkv-sign .mks-count { font-size: .8rem; font-weight: 600; color: var(--fb-muted); }
.mkv-sign .mks-colhead p { margin: 2px 0 0; font-size: .74rem; line-height: 1.35; color: var(--fb-muted); }
.mkv-sign .mks-cards { display: flex; flex-direction: column; gap: 5px; }
.mkv-sign .mks-card { background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--mks-stage); border-radius: 7px; padding: 5px 6px 5px 6px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.mkv-sign .mks-top { display: flex; gap: 8px; min-width: 0; align-items: flex-start; }
.mkv-sign .mks-thumb { flex: 0 0 120px; width: 120px; height: 45px; border-radius: 4px; overflow: hidden; background: var(--fb-card-2); }
.mkv-sign .mks-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
.mkv-sign .mks-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mkv-sign .mks-name { display: flex; align-items: center; gap: 2px; min-width: 0; }
.mkv-sign .mks-name a { flex: 1; min-width: 0; font-weight: 650; font-size: .88rem; color: var(--fb-ink); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mkv-sign .mks-name a:hover, .mkv-sign .mks-game a:hover { color: var(--fb-link); text-decoration: underline; }
.mkv-sign .mks-icon { flex: none; width: 22px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--fb-muted); font-size: .9rem; line-height: 1; cursor: pointer; }
.mkv-sign .mks-icon:hover { background: var(--fb-hover); color: var(--fb-ink); }
.mkv-sign .mks-x { font-size: .72rem; }
.mkv-sign .mks-star[aria-pressed="true"] { color: var(--fb-warning); }
.mkv-sign .mks-who { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 4px; font-size: .74rem; color: var(--fb-ink-2); min-width: 0; }
.mkv-sign .mks-studio { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mkv-sign .mks-card .mks-studio { max-width: 45%; }
.mkv-sign .mks-badge { font-size: .66rem; font-weight: 600; padding: 0 5px; border-radius: 999px; line-height: 1.55; white-space: nowrap; }
.mkv-sign .mks-p-self { color: var(--fb-good-text); background: color-mix(in oklab, var(--fb-positive) 16%, transparent); }
.mkv-sign .mks-p-label { color: var(--fb-ink-2); background: color-mix(in oklab, var(--fb-warning) 20%, transparent); }
.mkv-sign .mks-p-real { color: var(--fb-muted); border: 1px solid var(--fb-line); }
.mkv-sign .mks-godot { color: var(--fb-link); background: color-mix(in oklab, var(--fb-link) 13%, transparent); }
.mkv-sign .mks-row2 { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 5px; min-width: 0; }
.mkv-sign .mks-meter { display: inline-flex; align-items: center; gap: 4px; font-size: .7rem; color: var(--fb-muted); white-space: nowrap; }
.mkv-sign .mks-track { width: 34px; height: 4px; border-radius: 2px; background: var(--fb-line); overflow: hidden; }
.mkv-sign .mks-track i { display: block; height: 100%; background: var(--mks-stage); }
.mkv-sign .mks-meter b { color: var(--fb-ink); font-size: .76rem; font-variant-numeric: tabular-nums; }
.mkv-sign .mks-chip { font-size: .68rem; padding: 0 5px; border-radius: 4px; background: var(--fb-card-2); color: var(--fb-ink-2); white-space: nowrap; max-width: 110px; overflow: hidden; text-overflow: ellipsis; line-height: 1.6; }
.mkv-sign .mks-chip.mks-hot { background: color-mix(in oklab, var(--sw-2) 20%, transparent); color: var(--fb-ink); }
.mkv-sign .mks-hottext { color: var(--fb-ink); font-weight: 600; }
.mkv-sign .mks-why { margin: 0; font-size: .76rem; line-height: 1.35; color: var(--fb-ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mkv-sign .mks-more { align-self: stretch; font-size: .8rem; padding: 4px 8px; }

.mkv-sign .mks-tablewrap { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.mkv-sign .mks-search { flex: 1 1 200px; min-width: 0; max-width: 320px; padding: 5px 10px; border: 1px solid var(--fb-line); border-radius: 8px; background: var(--fb-card); color: var(--fb-ink); font: inherit; font-size: .84rem; }
.mkv-sign .mks-scroll { overflow-x: auto; border: 1px solid var(--fb-line); border-radius: 10px; background: var(--fb-card); max-width: 100%; }
.mkv-sign .mks-t { width: 100%; border-collapse: collapse; font-size: .82rem; }
.mkv-sign .mks-t th, .mkv-sign .mks-t td { padding: 5px 8px; border-bottom: 1px solid var(--fb-line); text-align: left; vertical-align: top; }
.mkv-sign .mks-t th { font-size: .74rem; font-weight: 600; color: var(--fb-muted); white-space: nowrap; background: var(--fb-card); }
.mkv-sign .mks-t th button { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.mkv-sign .mks-t th button:hover { color: var(--fb-ink); }
.mkv-sign .mks-t tbody tr:hover td { background: var(--fb-hover); }
.mkv-sign .mks-t tr td:first-child { border-left: 3px solid var(--mks-stage); }
.mkv-sign .mks-t .mks-num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.mkv-sign .mks-t .mks-ic { width: 24px; padding: 4px 2px; }
.mkv-sign .mks-game { min-width: 180px; }
.mkv-sign .mks-game a { font-weight: 600; color: var(--fb-ink); text-decoration: none; }
.mkv-sign .mks-stage { white-space: nowrap; font-size: .76rem; }
.mkv-sign .mks-stage::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--mks-stage); margin-right: 5px; }
.mkv-sign .mks-whycell { min-width: 260px; color: var(--fb-ink-2); font-size: .78rem; line-height: 1.35; }

@media (max-width: 900px) {
  .mkv-sign .mks-colpick { display: block; }
  .mkv-sign .mks-board { grid-template-columns: minmax(0, 1fr); }
  .mkv-sign .mks-col { display: none; }
  .mkv-sign .mks-col.mks-on { display: flex; }
  .mkv-sign .mks-spacer { display: none; }
}
@media (max-width: 420px) {
  .mkv-sign .mks-thumb { flex-basis: 96px; width: 96px; height: 36px; }
}
`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById("mk-sign-style")) return;
  const el = document.createElement("style");
  el.id = "mk-sign-style";
  el.textContent = CSS;
  document.head.append(el);
}
