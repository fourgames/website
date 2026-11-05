// Market, "Scout board" variant: the Market section built around a publisher's workflow. Finding
// games to sign (a pipeline board by stage, with a shortlist) and niches to make games in (a map of
// tags), plus Steam's pulse (games vs players, and the day's alerts). Plain DOM, same contract as
// market.js: marketTop(ctx) fills the header, marketView(ctx) returns one root that redraws itself.
// The data files come from server/steamdata/market.py; everything else is worked out here, once.

const DAY = 86400;
const P = "mkv-scout-";
const INDIE = 492;
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
// A publisher with this many games on Steam or more is a real publisher, not a small label.
const REAL_PUB = 10;
// Shrinkage for tag pairs: like the server's priorGames, a pair starts as 30 games at Steam's rate.
const PRIOR = 30;
const MIN_PAIR = 15;
const TABS = [["board", "Scouting board"], ["niches", "Niche map"], ["pulse", "Steam pulse"], ["shortlist", "Shortlist"]];
const NEEDS = { board: ["upcoming", "godot", "trends", "games"], niches: ["trends"], pulse: ["growth", "trends", "godot"], shortlist: [] };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let C; // the dashboard's helpers
const S = {
  tab: "board", files: {}, loading: {}, errors: {}, root: null,
  board: { godot: true, self: true, pubs: false, col: "soon", shown: { soon: 8, fresh: 8, proven: 8 } },
  niche: { open: null, size: "all" },
  pulse: { all: false },
  shortlist: [],
};

// ---------------------------------------------------------------------------
// Small pure helpers (no DOM)
// ---------------------------------------------------------------------------

const num = (n) => n == null ? "–" : Math.round(n).toLocaleString("en-US");
const pct = (x, d = 0) => x == null ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dateOf = (day) => new Date(day * DAY * 1000);
const dayText = (day) => { const d = dateOf(day); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;
const capsule = (appid) => `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`;
const idsOf = (names, list) => { const want = new Set(list.map((s) => s.toLowerCase())); return new Set(Object.entries(names || {}).filter(([, n]) => want.has(n.toLowerCase())).map(([id]) => Number(id))); };

// How sure a rate is, from how many games it rests on.
function sureness(n) {
  if (n >= 100) return { level: 3, text: "sure", long: `based on ${num(n)} games: a solid sample` };
  if (n >= 40) return { level: 2, text: "fairly sure", long: `based on ${num(n)} games: fairly sure` };
  return { level: 1, text: "a hint", long: `based on only ${num(n)} games: a hint, not proof` };
}

// When a coming-soon game is due, in words, from its date and how precise the store's date is.
function whenText(day, display, today) {
  if (day == null || display === "Coming soon" || display === "To be announced") return "no date yet";
  const d = dateOf(day), left = day - today;
  if (left < 0) return "late (date passed)";
  if (display === "date_year") return `due ${d.getUTCFullYear()}`;
  if (display === "date_quarter") return `due Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (display === "date_month") return `due ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (left <= 1) return left ? "out tomorrow" : "out today";
  if (left <= 45) return `out in ${left} days`;
  return `out ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${d.getUTCFullYear() !== dateOf(today).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : ""}`;
}

// Unpacking the compact files, once per file.
const cache = new WeakMap();
function once(file, key, fn) {
  let m = cache.get(file);
  if (!m) cache.set(file, m = {});
  if (!(key in m)) m[key] = fn();
  return m[key];
}

function gamesList(file) {
  return once(file, "list", () => {
    const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
    const F = file.flags;
    return file.rows.map((r) => {
      const flags = r[col.flags] || 0, tags = r[col.tags] || [];
      return { appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price], reviews: r[col.reviews] || 0, pos: r[col.pos],
        tags, top: tags.slice(0, file.topTags || 5), langs: r[col.langs], hit: r[col.hit], gain7: r[col.gain7],
        godot: !!(flags & F.godot), self: !!(flags & F.self), linux: !!(flags & F.linux), mac: !!(flags & F.mac),
        deck: !!(flags & (F.deckOk | F.deckVerified)), early: !!(flags & F.earlyAccess), free: !!(flags & F.free), demo: !!(flags & F.demo) };
    });
  });
}

function upcomingList(file) {
  return once(file, "list", () => {
    const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
    return file.rows.map((r) => {
      const flags = r[col.flags] || 0;
      return { appid: r[col.appid], name: r[col.name], day: r[col.day], display: r[col.display], price: r[col.price], tags: r[col.tags] || [],
        godot: !!(flags & 64), self: !!(flags & 256), demo: !!(flags & 128), langs: r[col.langs], devs: r[col.devs] || [], pubs: r[col.pubs] || [],
        devGames: r[col.devGames] || 0, devBest: r[col.devBest] || 0, devReviews: r[col.devReviews] || 0, pubGames: r[col.pubGames] || 0 };
    });
  });
}

const trendMap = (trends) => once(trends, "map", () => new Map(trends.tags.map((t) => [t.tag, t])));
const godotMap = (godot) => once(godot, "map", () => new Map(godot.games.map((g) => [g.appid, g])));

// Self-published, a small label, or a real publisher.
// A publisher listed as a co-developer (developers "A, B", publisher "B") counts as a label.
function pubKind(self, pubGames, devs, pubs) {
  if (self && devs?.length > 1 && pubs?.length && !pubs.includes(devs[0])) return pubGames >= REAL_PUB ? "real" : "label";
  if (self) return "self";
  if (pubGames == null) return "real"; // not known: treat it as taken
  return pubGames >= REAL_PUB ? "real" : "label";
}
const PUB_RANK = { self: 0, label: 1, real: 2 };

// The hottest of a game's strongest tags, with enough games behind its hit rate to mean something.
function hotTag(top, trends) {
  const m = trendMap(trends);
  let best = null;
  for (const t of top) {
    if (t === INDIE) continue;
    const r = m.get(t);
    if (r && r.hitLift != null && r.hitGames >= 20 && (!best || r.hitLift > best.hitLift)) best = r;
  }
  return best;
}

// What we'd improve in a released game: things a publisher does cheaply.
function roomList(g) {
  const out = [];
  if (g.known) {
    if (!g.linux) out.push("no Linux build");
    if (!g.mac) out.push("no Mac build");
    if (!g.deck) out.push("no Steam Deck rating");
  }
  if (g.langs != null && g.langs < 5) out.push(g.langs === 1 ? "English only" : `only ${g.langs} languages`);
  return out;
}

// ---------------------------------------------------------------------------
// The board: three stages, each with its own score
// ---------------------------------------------------------------------------

// Coming soon: lead score 0–100 from the studio's record, the niche, how soon, and a demo.
function scoreUpcoming(u, trends, today) {
  const left = u.day == null ? null : u.day - today;
  const vague = u.display === "date_year" || u.display === "Coming soon" || u.display === "To be announced";
  let soon = left == null ? 0.3 : left < 0 ? 0.5 : left <= 90 ? 1 : left <= 180 ? 0.8 : left <= 365 ? 0.55 : 0.35;
  if (vague) soon *= 0.75;
  const track = u.devGames ? clamp(Math.log10(u.devBest + 1) / 3.5) : 0.3;
  const hot = hotTag(u.tags.slice(0, 5), trends);
  const niche = hot ? clamp((hot.hitLift - 0.6) / 1.8) : 0.2;
  const score = Math.round(100 * (0.3 * track + 0.25 * niche + 0.25 * soon + 0.2 * (u.demo ? 1 : 0)));
  const parts = [whenText(u.day, u.display, today) + (u.demo ? ", demo out" : "")];
  parts.push(u.devGames ? `studio's best game: ${num(u.devBest)} reviews` : "studio's first game");
  if (hot && hot.hitLift >= 1.2) parts.push(`${hot.name} games hit ${times(hot.hitLift)} Steam's rate`);
  return { score, why: parts.join(" · ") };
}

// Just out: the hit index (reviews vs games out the same fortnight), dimmed for poor reviews and for
// games already so big they're out of reach.
function scoreFresh(g, today) {
  const q = g.pos == null ? 0.7 : g.pos >= 80 ? 1 : g.pos >= 70 ? 0.85 : 0.6;
  const big = g.reviews > 3000 ? 0.6 : 1;
  const score = Math.round((g.hit ?? 0) * q * big);
  const age = today - g.day;
  const room = roomList(g);
  const why = `${age ? `${age} days out` : "out today"} · ${num(g.reviews)} reviews${g.pos != null && g.reviews ? `, ${g.pos}% positive` : ""} · more than ${g.hit}% of games out the same fortnight${room.length ? ` · ${room[0]}` : ""}`;
  return { score, why };
}

// Proven: well liked, but with room to grow: few reviews for that quality, and things we'd fix.
function scoreProven(g) {
  const trust = clamp(Math.log10(g.reviews) / 2.3);
  const quality = clamp((g.pos - 75) / 20) * trust;
  const upside = 1 - clamp(Math.log10(Math.max(g.reviews, 10)) / Math.log10(20000));
  const room = roomList(g);
  const fix = clamp(room.length / 3);
  const score = Math.round(100 * (0.45 * quality + 0.3 * upside + 0.25 * fix));
  const why = `${g.pos}% positive from ${num(g.reviews)} reviews · ahead of ${g.hit}% of its launch fortnight${room.length ? ` · ${room.slice(0, 2).join(", ")}` : ""}`;
  return { score, why };
}

function buildBoard(F, opt, today) {
  const names = F.overview?.tags || {};
  const adult = idsOf(names, ADULT);
  const gd = F.godot ? godotMap(F.godot) : new Map();
  const ok = (e) => (!opt.godot || e.godot) && (e.pub === "self" || (!opt.self && (e.pub === "label" || opt.pubs))) && !e.tags.slice(0, 5).some((t) => adult.has(t));
  const order = (a, b) => (b.godot - a.godot) || (PUB_RANK[a.pub] - PUB_RANK[b.pub]) || (b.score - a.score) || ((b.pos ?? 0) - (a.pos ?? 0));
  const soon = [], fresh = [], proven = [];

  if (F.upcoming && F.trends) {
    const seen = new Set();
    for (const u of upcomingList(F.upcoming)) {
      seen.add(u.appid);
      const g = gd.get(u.appid);
      const e = { appid: u.appid, name: u.name, stage: "soon", godot: u.godot || !!g, tags: u.tags, studio: u.devs.join(", "),
        pub: pubKind(u.self, u.pubGames, u.devs, u.pubs), pubName: u.pubs.filter((p) => !u.devs.includes(p)).join(", ") };
      if (!ok(e)) continue;
      Object.assign(e, scoreUpcoming(u, F.trends, today), { meter: "Lead" });
      soon.push(e);
    }
    // Godot games coming soon that the upcoming file leaves out (no date in 18 months, no demo).
    for (const g of F.godot?.games || []) {
      if (!g.comingSoon || seen.has(g.appid)) continue;
      const u = { day: g.day, display: g.releaseDisplay ? "date_full" : "Coming soon", tags: g.tags, demo: !!g.demos, devGames: g.devGames, devBest: g.devReviews };
      const e = { appid: g.appid, name: g.name, stage: "soon", godot: true, tags: g.tags, studio: g.developers.join(", "),
        pub: pubKind(g.selfPublished, g.publisherGames, g.developers, g.publishers), pubName: g.publishers.filter((p) => !g.developers.includes(p)).join(", ") };
      if (!ok(e)) continue;
      Object.assign(e, scoreUpcoming(u, F.trends, today), { meter: "Lead" });
      if (g.releaseDisplay) e.why = e.why.replace(/^[^·,]+/, `due ${g.releaseDisplay}`);
      soon.push(e);
    }
  }

  if (F.games) {
    for (const r of gamesList(F.games)) {
      const age = today - r.day;
      if (age < 0 || r.hit == null) continue;
      const g0 = gd.get(r.appid);
      const g = { ...r, known: r.langs != null || !!g0?.details };
      if (g0) Object.assign(g, { linux: g0.linux, mac: g0.mac, deck: !!g0.deck && g0.deck > 1, langs: g0.languages ?? r.langs, known: !!g0.details || g.known });
      const pub = pubKind(g0 ? g0.selfPublished : r.self, g0 ? g0.publisherGames : null, g0?.developers, g0?.publishers);
      const base = { appid: r.appid, name: r.name, godot: r.godot || !!g0, tags: r.top, studio: g0 ? g0.developers.join(", ") : "", pub,
        pubName: g0 ? g0.publishers.filter((p) => !g0.developers.includes(p)).join(", ") : "", reviews: r.reviews, pos: r.pos };
      if (age <= 90) {
        if (r.reviews < 3) continue;
        const e = { ...base, stage: "fresh" };
        if (!ok(e)) continue;
        fresh.push(Object.assign(e, scoreFresh(g, today), { meter: "Hit index" }));
      } else if (r.pos != null && r.pos >= 80 && r.reviews >= 30 && r.reviews <= 20000 && r.hit >= 50) {
        const e = { ...base, stage: "proven" };
        if (!ok(e)) continue;
        proven.push(Object.assign(e, scoreProven(g), { meter: "Upside" }));
      }
    }
  }
  return { soon: soon.sort(order), fresh: fresh.sort(order), proven: proven.sort(order) };
}

// ---------------------------------------------------------------------------
// Niches: the tags, their hit rates, best games and strongest pairs
// ---------------------------------------------------------------------------

// Every tag with a hit rate, with its color position: log2 of the hit lift, clamped to ±1.5 (⅓× to 3×).
function nicheRows(trends) {
  return trends.tags.filter((t) => t.hitRate != null).map((t) => ({ ...t, tone: clamp(Math.log2(t.hitLift || 1) / 1.5, -1, 1), sure: sureness(t.hitGames) }));
}

// Small but hot: crowding under 60 releases a quarter, enough games to judge, best hit rate first
// (the server's hit rate is already shrunk toward Steam's, so a handful of lucky games can't top it).
function smallHot(trends) {
  return nicheRows(trends).filter((t) => t.releases < 60 && t.hitGames >= 20 && t.tag !== INDIE).sort((a, b) => b.hitRate - a.hitRate);
}

function tagDetail(tag, gamesFile, trends, today) {
  return once(gamesFile, `tag:${tag}`, () => {
    const [from, to] = trends.hitRateWindow || [14, 180];
    const base = trends.baseHitRate;
    const list = gamesList(gamesFile).filter((g) => g.top.includes(tag));
    const best = list.filter((g) => today - g.day <= 180 && today >= g.day && g.hit != null && g.reviews >= 5)
      .sort((a, b) => b.hit - a.hit || b.reviews - a.reviews).slice(0, 6);
    const pairs = new Map();
    for (const g of list) {
      const age = today - g.day;
      if (age < from || age > to || g.hit == null) continue;
      for (const t of g.top) {
        if (t === tag || t === INDIE) continue;
        let p = pairs.get(t);
        if (!p) pairs.set(t, p = { tag: t, n: 0, hits: 0, reviews: [] });
        p.n++; if (g.hit >= 90) p.hits++; p.reviews.push(g.reviews);
      }
    }
    const pairRows = [...pairs.values()].filter((p) => p.n >= MIN_PAIR)
      .map((p) => ({ tag: p.tag, n: p.n, hits: p.hits, raw: p.hits / p.n, rate: (p.hits + PRIOR * base) / (p.n + PRIOR), lift: (p.hits + PRIOR * base) / (p.n + PRIOR) / base, median: median(p.reviews), sure: sureness(p.n) }))
      .sort((a, b) => b.rate - a.rate);
    return { best, pairs: pairRows.slice(0, 6), pairCount: pairRows.length };
  });
}

// Squarified treemap: items [{value}] sorted largest first → [{item, x, y, w, h}].
function squarify(items, X, Y, W, H) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1;
  const scaled = items.map((it) => ({ it, a: (it.value / total) * W * H }));
  const out = [];
  let x = X, y = Y, w = W, h = H, row = [];
  const worst = (r, len) => { if (!r.length) return Infinity; const s = r.reduce((a, b) => a + b.a, 0); let mx = 0, mn = Infinity; for (const q of r) { mx = Math.max(mx, q.a); mn = Math.min(mn, q.a); } return Math.max((len * len * mx) / (s * s), (s * s) / (len * len * mn)); };
  const lay = (r) => {
    const s = r.reduce((a, b) => a + b.a, 0);
    if (w >= h) { const cw = s / h; let cy = y; for (const q of r) { const ch = q.a / cw; out.push({ item: q.it, x, y: cy, w: cw, h: ch }); cy += ch; } x += cw; w -= cw; }
    else { const rh = s / w; let cx = x; for (const q of r) { const cw = q.a / rh; out.push({ item: q.it, x: cx, y, w: cw, h: rh }); cx += cw; } y += rh; h -= rh; }
  };
  for (const q of scaled) {
    const len = Math.min(w, h);
    if (!row.length || worst([...row, q], len) <= worst(row, len)) row.push(q);
    else { lay(row); row = [q]; }
  }
  if (row.length) lay(row);
  return out;
}

// ---------------------------------------------------------------------------
// Pulse: games vs players, and the alerts
// ---------------------------------------------------------------------------

function pulseSeries(g) {
  if (!g.users) return null;
  const first = Math.max(g.years.indexOf(2018), g.users.y.findIndex((v) => v != null));
  if (first < 0) return null;
  const last = g.years.length - 1;
  const partial = g.yearDone > 0 && g.yearDone < 1;
  const rel = g.total.y.map((n, i) => i === last && partial ? n / g.yearDone : n).slice(first);
  const users = g.users.y.slice(first);
  const years = g.years.slice(first);
  const idx = (xs) => { const b = xs.find((v) => v != null); return xs.map((v) => v == null || !b ? null : v / b); };
  const ir = idx(rel), iu = idx(users);
  const gr = ir.at(-1), gu = iu.filter((v) => v != null).at(-1);
  const per = (users.filter((v) => v != null).at(-1) / rel.at(-1)) / (users[0] / rel[0]);
  const sentence = gr > gu
    ? `No: since ${years[0]} the number of games released a year grew ${times(gr)}, Steam's peak players only ${times(gu)}, so each new game now shares the audience with more others (players per new game ${per < 1 ? "down" : "up"} ${pct(Math.abs(1 - per))}).`
    : `Yes: since ${years[0]} Steam's peak players grew ${times(gu)}, faster than the games released (${times(gr)}), so each new game has more players to go round (players per new game up ${pct(per - 1)}).`;
  return { years, rel, users, ir, iu, partial, sentence, raw: g.total.y.slice(first) };
}

// The alerts, ranked for a publisher: tags first (what to make), then self-published Godot games
// (who to sign), then breakouts (worth a look), then Godot games that already have a publisher.
function rankAlerts(trends, godot) {
  const gd = godot ? godotMap(godot) : new Map();
  const tm = trendMap(trends);
  const out = [];
  for (const a of trends.alerts || []) {
    if (a.kind === "tag") {
      const t = tm.get(a.tag);
      out.push({ ...a, group: 0, label: "Rising niche", head: t?.name || a.title,
        plain: t ? `${num(t.releases)} games out in 90 days, ${times(t.supply)} its share of releases a year ago, and its games become hits ${times(t.hitLift)} as often as Steam's (${sureness(t.hitGames).text}).` : a.detail });
    } else if (a.kind === "godot") {
      const g = gd.get(a.appid);
      const self = g?.selfPublished;
      out.push({ ...a, group: self ? 1 : 3, label: self ? "Self-published Godot" : "Godot, has a publisher", head: a.title.replace(/^Godot game taking off:\s*/, ""),
        plain: g ? `${num(g.reviews)} reviews (${g.pos ?? "?"}% positive), more than ${g.hit}% of games out the same fortnight. ${self ? `Self-published by ${g.developers.join(", ")}: no publisher yet.` : `Published by ${g.publishers.join(", ")}: probably taken.`}` : a.detail });
    } else {
      out.push({ ...a, group: 2, label: "Breakout", head: a.title.replace(/^Breakout:\s*/, ""), plain: `${a.detail.replace(/;?\s*hit index 99\.?/, "")}: ahead of 99% of its launch fortnight. Likely out of reach; worth studying.` });
    }
  }
  return out.sort((a, b) => a.group - b.group || (b.score ?? 0) - (a.score ?? 0));
}

export const _test = { gamesList, upcomingList, buildBoard, scoreUpcoming, scoreFresh, scoreProven, nicheRows, smallHot, tagDetail, squarify, pulseSeries, rankAlerts, whenText, pubKind };

// ---------------------------------------------------------------------------
// Header, view, loading
// ---------------------------------------------------------------------------

const today = () => S.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const tagName = (id) => S.files.overview?.tags?.[id] || `Tag ${id}`;
const sget = (k, d) => { try { const v = C.store.get(P + k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const sset = (k, v) => { try { C.store.set(P + k, JSON.stringify(v)); } catch {} };

export function marketTop(ctx) {
  C = ctx;
  const o = S.files.overview;
  const el = (id) => document.getElementById(id);
  if (el("fb-capsule")) el("fb-capsule").hidden = true;
  el("fb-title")?.replaceChildren("Market");
  el("fb-updated")?.replaceChildren(o
    ? `${num(o.games)} games on Steam (${num(o.comingSoon)} coming soon) · worked out ${C.fmtDateTime(o.builtAt)}`
    : "All of Steam, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) el(id)?.replaceChildren();
}

export function marketView(ctx) {
  C = ctx;
  injectStyle();
  const tab = sget("tab", "board");
  S.tab = TABS.some(([id]) => id === tab) ? tab : "board";
  Object.assign(S.board, sget("board", {}));
  S.board.shown = { soon: 8, fresh: 8, proven: 8 };
  S.niche.size = sget("niche-size", "all");
  S.niche.open = sget("niche-open", null);
  S.shortlist = sget("shortlist", []);
  S.root = C.h("div.mk.mkv-scout");
  draw();
  load(["overview", ...NEEDS[S.tab]]);
  return S.root;
}

async function load(names) {
  const wanted = names.filter((n) => !S.files[n] && !S.loading[n]);
  if (!wanted.length) return;
  for (const n of wanted) { S.loading[n] = true; delete S.errors[n]; }
  draw();
  // The small files first, so a view can draw before games.json (8 MB) is in.
  await Promise.all(wanted.map(async (n) => {
    try {
      if (C.dataOverride) {
        const res = await fetch(`${C.dataOverride}/market/${n}.json`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
        S.files[n] = await res.json();
      } else S.files[n] = await (await C.adminGet(`market/${n}`)).json();
    } catch (e) {
      if (!e.signedOut) S.errors[n] = e.name === "TimeoutError" ? "The server didn't answer; try again." : /not_built|404/.test(e.message) ? "The market files aren't built yet: they're made once a day on the server." : e.message;
    }
    S.loading[n] = false;
    if (n === "overview") marketTop(C);
    draw();
  }));
}

function setTab(v) { S.tab = v; sset("tab", v); load(["overview", ...NEEDS[v]]); draw(); }

function draw() {
  if (!S.root) return;
  const h = C.h, y = window.scrollY;
  const tabs = TABS.map(([id, label]) => [id, id === "shortlist" && S.shortlist.length ? `${label} (${S.shortlist.length})` : label]);
  const nav = h("div.sc-nav", C.chips(tabs, S.tab, setTab, "Market view"));
  const need = ["overview", ...NEEDS[S.tab]];
  const error = need.map((n) => S.errors[n]).find(Boolean);
  let body;
  if (error) body = h("p.sc-empty", error, " ", h("button.btn", { type: "button", onclick: () => load(need) }, "Try again"));
  else if (!S.files.overview) body = h("p.sc-empty", "Loading…");
  else body = { board: boardView, niches: nicheView, pulse: pulseView, shortlist: shortlistView }[S.tab]();
  S.root.replaceChildren(nav, body, tipEl());
  window.scrollTo(0, y);
}

let tip;
function tipEl() { if (!tip) tip = C.h("div.sc-tip", { role: "status" }); tip.style.display = "none"; return tip; }
function showTip(ev, kids) {
  tip.replaceChildren(...kids);
  tip.style.display = "block";
  const w = tip.offsetWidth, hh = tip.offsetHeight;
  let x = ev.clientX + 14, yy = ev.clientY + 14;
  if (x + w > window.innerWidth - 8) x = ev.clientX - w - 14;
  if (yy + hh > window.innerHeight - 8) yy = ev.clientY - hh - 14;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, yy)}px`;
}
const hideTip = () => { if (tip) tip.style.display = "none"; };
const avail = () => Math.max(300, (S.root?.clientWidth || document.getElementById("fb-view")?.clientWidth || window.innerWidth || 800));
const explain = (...kids) => C.h("p.sc-explain", ...kids);
const toggle = (label, on, flip, hint) => C.h("button.sc-toggle", { type: "button", "aria-pressed": String(on), title: hint || null, onclick: () => { flip(); draw(); } }, C.h("span.sc-sw", { "aria-hidden": "true" }), label);
const link = (appid, text) => C.h("a", { href: storeUrl(appid), target: "_blank", rel: "noopener" }, text);

// ---------------------------------------------------------------------------
// Scouting board
// ---------------------------------------------------------------------------

const STAGES = [
  ["soon", "Coming soon", "Not out yet: the best time to sign. Lead score = the studio's past results, how hot its niche is, how soon it's out and whether a demo is up."],
  ["fresh", "Just out (≤ 90 days)", "Released in the last 90 days. Hit index = how many games out the same fortnight it beats on reviews (96 = more than 96% of them); dimmed for poor reviews or games already too big to afford."],
  ["proven", "Proven", "Out 3 months to 3 years, 80%+ positive, but with room to grow. Upside = well liked + few reviews for that quality + things we'd fix (Linux, Mac, Deck, languages)."],
];

let boardCache = { key: null, value: null };
function boardData() {
  const b = S.board;
  const key = [b.godot, b.self, b.pubs, ...["upcoming", "godot", "trends", "games"].map((n) => !!S.files[n])].join();
  if (boardCache.key !== key) boardCache = { key, value: buildBoard(S.files, b, today()) };
  return boardCache.value;
}

function boardView() {
  const h = C.h, b = S.board, o = S.files.overview;
  const save = () => { const { godot, self, pubs, col } = b; sset("board", { godot, self, pubs, col }); b.shown = { soon: 8, fresh: 8, proven: 8 }; };
  const data = boardData();
  const checked = o.withMetadata / o.games;
  const head = h("div.sc-bar",
    toggle("Godot only", b.godot, () => { b.godot = !b.godot; save(); }, "Only games a public source says are made with Godot"),
    toggle("Self-published only", b.self, () => { b.self = !b.self; if (b.self) b.pubs = false; save(); }, "No publisher on the store page"),
    toggle("Show real publishers", b.pubs, () => { b.pubs = !b.pubs; if (b.pubs) b.self = false; save(); }, `Also games with a publisher of ${REAL_PUB}+ games (usually taken)`),
    h("span.sc-note", `Godot detection: ${num(o.withMetadata)} of ${num(o.games)} games checked so far (${pct(checked)}), so many Godot games aren't marked yet; it finishes in about a week.`));
  const legend = explain(b.self ? "Showing self-published games only. " : b.pubs ? "Showing every game; self-published first, then small labels, then real publishers. " : `Showing self-published games and small labels (publishers with under ${REAL_PUB} games). `,
    b.godot ? "Godot games only." : "Godot games first, then every engine.", " Star a card to put it on your shortlist.");
  const picker = h("div.sc-colpick", C.chips(STAGES.map(([id, label]) => [id, `${label.replace(/ \(.*\)/, "")} (${num(data[id].length)})`]), b.col, (v) => { b.col = v; save(); draw(); }, "Stage"));
  const cols = STAGES.map(([id, label, about]) => {
    const list = data[id];
    const missing = (id === "soon" ? !S.files.upcoming || !S.files.trends : !S.files.games);
    const shown = b.shown[id];
    return h("section.sc-col", { class: b.col === id ? "sc-on" : "" },
      h("header.sc-colhead", h("h3", label, h("span.sc-count", missing ? "…" : num(list.length))), h("p", about)),
      missing ? h("p.sc-empty", id === "soon" ? "Loading the coming-soon games…" : "Loading three years of releases (8 MB, once)…")
        : !list.length ? h("p.sc-empty", "Nothing here with these filters. Try turning off Godot only.")
        : h("div.sc-cards", ...list.slice(0, shown).map(card)),
      !missing && list.length > shown ? h("button.btn.sc-more", { type: "button", onclick: () => { b.shown[id] += 8; draw(); } }, `Show 8 more (${num(list.length - shown)} left)`) : null);
  });
  return h("div.sc-board-wrap", head, legend, picker, h("div.sc-board", ...cols));
}

const PUB_TEXT = { self: "Self-published", label: "Small label", real: "Has a publisher" };
const isStarred = (appid) => S.shortlist.some((x) => x.appid === appid);
function star(e) {
  if (isStarred(e.appid)) S.shortlist = S.shortlist.filter((x) => x.appid !== e.appid);
  else S.shortlist = [{ appid: e.appid, name: e.name, stage: e.stage, studio: e.studio, pub: e.pub, pubName: e.pubName, godot: e.godot,
    tags: (e.tags || []).filter((t) => t !== INDIE).slice(0, 5).map(tagName), score: e.score, meter: e.meter, why: e.why, added: Math.floor(Date.now() / 1000) }, ...S.shortlist];
  sset("shortlist", S.shortlist);
  draw();
}

function card(e) {
  const h = C.h;
  const trends = S.files.trends ? trendMap(S.files.trends) : new Map();
  const tagIds = Array.isArray(e.tags) && typeof e.tags[0] === "number" ? e.tags.filter((t) => t !== INDIE).slice(0, 3) : null;
  const chips = tagIds ? tagIds.map((t) => { const r = trends.get(t); const hot = r && r.hitGames >= 20 && r.hitLift >= 1.5;
    return h("button.sc-chip", { type: "button", class: hot ? "sc-hot" : "", title: r ? `${r.name}: hits ${times(r.hitLift)} Steam's rate. Open on the niche map` : tagName(t),
      onclick: () => { if (!r) return; S.niche.open = t; sset("niche-open", t); setTab("niches"); } }, tagName(t)); })
    : (e.tags || []).slice(0, 3).map((t) => h("span.sc-chip", t));
  const img = h("img", { src: capsule(e.appid), alt: "", loading: "lazy", decoding: "async", width: 231, height: 87 });
  img.addEventListener("error", () => { img.parentElement?.classList.add("sc-noimg"); img.remove(); });
  const on = isStarred(e.appid);
  return h("article.sc-card", { class: `sc-${e.stage}` },
    h("a.sc-cap", { href: storeUrl(e.appid), target: "_blank", rel: "noopener", tabindex: "-1", "aria-hidden": "true" }, img),
    h("button.sc-star", { type: "button", "aria-pressed": String(on), "aria-label": on ? `Remove ${e.name} from the shortlist` : `Add ${e.name} to the shortlist`, title: on ? "On your shortlist" : "Add to shortlist", onclick: () => star(e) }, on ? "★" : "☆"),
    h("div.sc-body",
      h("h4", link(e.appid, e.name)),
      h("div.sc-who", e.studio ? h("span", e.studio) : null, h("span.sc-badge", { class: `sc-p-${e.pub}`, title: e.pubName ? `Publisher: ${e.pubName}` : null }, PUB_TEXT[e.pub]), e.godot ? h("span.sc-badge.sc-godot", "Godot") : null),
      h("div.sc-meter", { title: `${e.meter} ${e.score} of 100` }, h("span.sc-ml", e.meter), h("span.sc-track", h("i", { style: `width:${clamp(e.score / 100) * 100}%` })), h("b", e.score)),
      h("div.sc-chips", ...chips),
      h("p.sc-why", e.why)));
}

// ---------------------------------------------------------------------------
// Niche map
// ---------------------------------------------------------------------------

function tone(t) {
  // Diverging: cold (fewer hits than Steam) ← gray → hot (more hits).
  const p = Math.round(Math.abs(t) * 100);
  return `color-mix(in oklab, var(${t >= 0 ? "--sc-hot" : "--sc-cold"}) ${p}%, var(--sc-mid))`;
}

function nicheView() {
  const h = C.h, tr = S.files.trends, f = S.niche;
  if (!tr) return h("p.sc-empty", "Loading the tags…");
  if (!S.files.games && !S.loading.games) setTimeout(() => load(["games"]), 0);
  const all = nicheRows(tr);
  const rows = all.filter((t) => t.tag !== INDIE && (f.size === "all" || (f.size === "small" ? t.releases < 60 : t.releases >= 60))).sort((a, b) => b.releases - a.releases);
  const open = all.find((t) => t.tag === f.open);
  const wide = avail() >= 900;
  const W = Math.round(wide ? avail() * 0.62 : avail()), H = wide ? 520 : Math.round(Math.min(640, W * 1.3));
  const svg = C.svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "sc-map", role: "img", "aria-label": "Tags: tile size is how many games came out, color is how often they become hits" });
  for (const r of squarify(rows.map((t) => ({ value: Math.sqrt(t.releases), t })), 0, 0, W, H)) {
    const t = r.item.t;
    const g = C.svgEl("g", { class: `sc-tile${t.tag === f.open ? " sc-sel" : ""}`, tabindex: "0", role: "button", "aria-label": `${t.name}: ${t.releases} releases, hits ${times(t.hitLift)} Steam's rate` });
    g.append(C.svgEl("rect", { x: r.x + 1, y: r.y + 1, width: Math.max(0, r.w - 2), height: Math.max(0, r.h - 2), rx: 3, style: `fill:${tone(t.tone)}` }));
    const strong = Math.abs(t.tone) > 0.55;
    if (r.w > 38 && r.h > 16) {
      const chars = Math.floor((r.w - 8) / 6.4);
      const label = t.name.length > chars ? t.name.slice(0, Math.max(1, chars - 1)) + "…" : t.name;
      const tx = C.svgEl("text", { x: r.x + 5, y: r.y + 14, class: strong ? "sc-on-strong" : "" });
      tx.textContent = label;
      g.append(tx);
      if (r.h > 32) {
        const t2 = C.svgEl("text", { x: r.x + 5, y: r.y + 28, class: `sc-sub${strong ? " sc-on-strong" : ""}` });
        t2.textContent = `${times(t.hitLift)} · ${t.releases}`;
        g.append(t2);
      }
    }
    const pick = () => { f.open = t.tag; sset("niche-open", t.tag); hideTip(); draw(); };
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    g.addEventListener("pointermove", (ev) => showTip(ev, [h("b", t.name), h("div", `${pct(t.hitRateRaw)} of its games became hits (Steam: ${pct(tr.baseHitRate)})`), h("div", `${num(t.releases)} games out in 90 days`), h("div.sc-muted", `${times(t.hitLift)} Steam's hit rate, ${t.sure.text}`)]));
    g.addEventListener("pointerleave", hideTip);
    svg.append(g);
  }
  const legend = h("div.sc-legend",
    h("div.sc-ramp-wrap", h("div.sc-ramp", { "aria-hidden": "true" }),
      h("div.sc-ramp-labels", h("span", "⅓× Steam's hit rate"), h("span", `same as Steam (${pct(tr.baseHitRate)})`), h("span", "3× or more"))),
    h("p", "Color: how often a tag's games become hits (top 10% of reviews among games out the same fortnight) against all of Steam. Size: how many games with it came out in the last 90 days (square-root scale, so small tags stay visible). Small bright-orange tiles are small but hot."));
  const tagOptions = h("datalist", { id: "sc-tags" }, ...all.map((t) => h("option", { value: t.name })));
  const find = h("input.sc-find", { list: "sc-tags", placeholder: "Find a tag…", "aria-label": "Find a tag", onchange: (e) => { const t = all.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase()); if (t) { f.open = t.tag; sset("niche-open", t.tag); draw(); } } });
  const hot = smallHot(tr).slice(0, 8);
  return h("div",
    h("div.sc-bar", C.chips([["all", "All tags"], ["small", "Small (under 60 a quarter)"], ["big", "Big (60+)"]], f.size, (v) => { f.size = v; sset("niche-size", v); draw(); }, "Tag size"), find, tagOptions),
    h("div.sc-niche", { class: wide ? "sc-wide" : "" },
      h("div.sc-mapcard", h("h3", "Where games become hits"), legend, svg),
      h("aside.sc-panel", open ? nichePanel(open) : h("div", h("h3", "Pick a tag"), h("p.sc-muted", "Click a tile to see the tag in plain words: its hit rate, what a typical game gets, its best recent games and the tags it pairs best with.")))),
    h("div.sc-hotlist", h("h3", "Small but hot, ranked"),
      explain(`Tags with under 60 releases in 90 days and at least 20 games old enough to judge, best hit rate first. The hit rate is pulled toward Steam's ${pct(tr.baseHitRate)} as if each tag had ${tr.priorGames || 30} extra average games, so a tag with a handful of lucky games can't top the list.`),
      h("ol", ...hot.map((t) => h("li", h("button.sc-linkbtn", { type: "button", onclick: () => { f.open = t.tag; sset("niche-open", t.tag); draw(); window.scrollTo({ top: S.root.offsetTop, behavior: "smooth" }); } }, t.name),
        ` ${pct(t.hitRate)} become hits (${times(t.hitLift)} Steam), ${num(t.releases)} out in 90 days, typical game ${num(t.medianReviews)} reviews `, h("span.sc-sure", { class: `sc-s${t.sure.level}` }, t.sure.text))))));
}

function nichePanel(t) {
  const h = C.h, tr = S.files.trends;
  const grow = t.supply == null ? null : t.supply >= 1.15 ? `growing: ${times(t.supply)} its share of new releases a year ago (${num(t.releasesYearAgo)} → ${num(t.releases)} games a quarter)` : t.supply <= 0.87 ? `shrinking: ${times(t.supply)} its share of new releases a year ago (${num(t.releasesYearAgo)} → ${num(t.releases)})` : `steady: about the same share of new releases as a year ago (${num(t.releasesYearAgo)} → ${num(t.releases)})`;
  const facts = [
    [`${pct(t.hitRateRaw)}`, `of its games become hits, vs ${pct(tr.baseHitRate)} on Steam (${num(t.hits)} of ${num(t.hitGames)} games${t.hitGames < 100 ? `; adjusted for the small sample: ${pct(t.hitRate)}` : ""}).`],
    [num(t.medianReviews), `reviews for a typical game (the median; Steam's is ${num(tr.baseMedianReviews)}).`],
    [num(t.topReviews), "reviews for a top-10% game in it."],
    [num(t.releases), `games came out with it in the last 90 days: ${grow}.`],
  ];
  let extra;
  if (!S.files.games) extra = h("p.sc-muted", "Loading the releases for its best games and pairs…");
  else {
    const d = tagDetail(t.tag, S.files.games, tr, today());
    extra = h("div",
      h("h4", "Best recent games"),
      d.best.length ? h("ul.sc-plain", ...d.best.map((g) => h("li", link(g.appid, g.name), g.godot ? h("span.sc-badge.sc-godot", "Godot") : null, g.self ? h("span.sc-badge.sc-p-self", "Self") : null,
        h("span.sc-muted", ` ${num(g.reviews)} reviews, beats ${g.hit}% of its fortnight`)))) : h("p.sc-muted", "None in the last 6 months."),
      h("h4", "Best tags to pair it with"),
      d.pairs.length ? h("div.sc-pairs", ...d.pairs.map((p) => h("div.sc-pair",
        h("span.sc-pn", `+ ${tagName(p.tag)}`),
        h("span.sc-track", h("i", { style: `width:${clamp(p.rate / 0.4) * 100}%;background:${tone(clamp(Math.log2(p.lift) / 1.5, -1, 1))}` })),
        h("span", `${pct(p.rate)} hits`), h("span.sc-muted", `${num(p.n)} games`), h("span.sc-sure", { class: `sc-s${p.sure.level}` }, p.sure.text))))
        : h("p.sc-muted", `No pair has ${MIN_PAIR}+ games old enough to judge.`),
      h("p.sc-muted", `Pairs need ${MIN_PAIR}+ games released ${tr.hitRateWindow?.[0] ?? 14}–${tr.hitRateWindow?.[1] ?? 180} days ago, and their rate is pulled toward Steam's as if each had ${PRIOR} extra average games.`));
  }
  return h("div",
    h("div.sc-panelhead", h("h3", t.name), h("span.sc-sure", { class: `sc-s${t.sure.level}` }, t.sure.long)),
    h("p.sc-lead", `${pct(t.hitRateRaw)} of its games become hits${t.hitGames < 100 ? ` (${pct(t.hitRate)} once its small sample is allowed for)` : ""} vs ${pct(tr.baseHitRate)} on Steam; a typical game gets ${num(t.medianReviews)} reviews, a top-10% one ${num(t.topReviews)}; ${t.supply == null ? "" : `${t.supply >= 1 ? "growing" : "shrinking"} ${times(t.supply)}`}.`),
    h("dl.sc-facts", ...facts.flatMap(([v, txt]) => [h("dt", v), h("dd", txt)])),
    extra);
}

// ---------------------------------------------------------------------------
// Steam pulse
// ---------------------------------------------------------------------------

function pulseView() {
  const h = C.h, g = S.files.growth, tr = S.files.trends;
  if (!g || !tr) return h("p.sc-empty", "Loading…");
  const p = pulseSeries(g);
  const alerts = rankAlerts(tr, S.files.godot);
  const shown = S.pulse.all ? alerts : alerts.slice(0, 10);
  return h("div.sc-pulse",
    p ? h("section.sc-chartcard",
      h("h3", "Do more players cancel out more games?"),
      h("p.sc-lead", p.sentence),
      lineChart(p),
      h("p.sc-muted", `Both lines start at ${p.years[0]} (×1, the first full year of Steam Direct). Players: Steam's record of users online at once, as reported each year. ${p.partial ? `${p.years.at(-1)} is still going: its releases are this year's pace for a whole year (dashed).` : ""}`)) : null,
    h("section.sc-feed",
      h("h3", "Today's alerts"),
      explain("Ranked for a publisher: rising niches first (what to make), then self-published Godot games taking off (who to talk to), then breakouts (what to study), then Godot games that already have a publisher."),
      alerts.length ? h("ol.sc-alerts", ...shown.map((a) => h("li.sc-alert", { class: `sc-g${a.group}` },
        h("span.sc-kind", a.label),
        h("div", h("b", a.kind === "tag" ? h("button.sc-linkbtn", { type: "button", onclick: () => { S.niche.open = a.tag; sset("niche-open", a.tag); setTab("niches"); } }, a.head) : link(a.appid, a.head)),
          h("p", a.plain))))) : h("p.sc-empty", "No alerts today."),
      alerts.length > 10 ? h("button.btn.sc-more", { type: "button", onclick: () => { S.pulse.all = !S.pulse.all; draw(); } }, S.pulse.all ? "Show the top 10" : `Show all ${alerts.length}`) : null));
}

function lineChart(p) {
  const h = C.h, svgEl = C.svgEl;
  const W = Math.min(900, Math.max(320, avail() - 32)), H = W < 500 ? 240 : 300;
  const M = { top: 14, right: W < 500 ? 70 : 120, bottom: 28, left: 40 };
  const n = p.years.length;
  const max = Math.ceil(Math.max(...p.ir, ...p.iu.filter((v) => v != null)) + 0.2);
  const x = (i) => M.left + (i / (n - 1)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "sc-line", role: "img", "aria-label": "Games released and Steam's peak players, both indexed to 2018" });
  for (let k = 0; k <= max; k++) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(k), y2: y(k), class: k ? "sc-grid" : "sc-base" }));
    const t = svgEl("text", { x: M.left - 6, y: y(k) + 4, "text-anchor": "end", class: "sc-axis" });
    t.textContent = `×${k}`;
    svg.append(t);
  }
  const every = Math.max(1, Math.ceil(n / (W < 500 ? 5 : 10)));
  p.years.forEach((yr, i) => { if (i % every && i !== n - 1) return; const t = svgEl("text", { x: x(i), y: H - 8, "text-anchor": "middle", class: "sc-axis" }); t.textContent = String(yr); svg.append(t); });
  const series = [{ name: "Games released", values: p.ir, cls: "sc-s-rel", color: "var(--sw-1)", raw: p.rel }, { name: "Steam's peak players", values: p.iu, cls: "sc-s-usr", color: "var(--sw-2)", raw: p.users }];
  for (const s of series) {
    const solidTo = s === series[0] && p.partial ? n - 2 : n - 1;
    let d = "";
    s.values.forEach((v, i) => { if (v == null || i > solidTo) return; d += `${d ? "L" : "M"}${x(i)},${y(v)}`; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round" }));
    if (solidTo < n - 1) svg.append(svgEl("path", { d: `M${x(n - 2)},${y(s.values[n - 2])}L${x(n - 1)},${y(s.values[n - 1])}`, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-dasharray": "4 3" }));
    const lastI = s.values.map((v, i) => v != null ? i : -1).filter((i) => i >= 0).at(-1);
    svg.append(svgEl("circle", { cx: x(lastI), cy: y(s.values[lastI]), r: 4, fill: s.color, stroke: "var(--fb-card)", "stroke-width": 2 }));
    const lab = svgEl("text", { x: x(lastI) + 8, y: y(s.values[lastI]) + 4, class: "sc-dlabel" });
    lab.textContent = `${W < 500 ? (s === series[0] ? "Games" : "Players") : s.name} ${times(s.values[lastI])}`;
    svg.append(lab);
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "sc-cross", visibility: "hidden" });
  svg.append(cross);
  const hit = svgEl("rect", { x: M.left, y: 0, width: W - M.left - M.right, height: H, fill: "transparent" });
  svg.append(hit);
  hit.addEventListener("pointermove", (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    const ppg = p.users[i] != null ? Math.round(p.users[i] / p.rel[i]) : null;
    showTip(ev, [h("b", String(p.years[i])),
      h("div", h("i.sc-dot", { style: "background:var(--sw-1)" }), `${num(p.rel[i])} games${i === n - 1 && p.partial ? " (pace)" : ""} · ${times(p.ir[i])}`),
      h("div", h("i.sc-dot", { style: "background:var(--sw-2)" }), `${p.users[i] == null ? "–" : num(p.users[i])} players at the peak · ${times(p.iu[i])}`),
      ppg ? h("div.sc-muted", `${num(ppg)} peak players per new game`) : null]);
  });
  hit.addEventListener("pointerleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); });
  const legend = h("div.sc-keys", ...series.map((s) => h("span", h("i.sc-dot", { style: `background:${s.color}` }), s.name)));
  const table = h("details.sc-table", h("summary", "Data table"), h("div.sc-scroll", h("table.data",
    h("tr", h("th", "Year"), h("th", "Games released"), h("th", "Peak players"), h("th", "Players per new game")),
    ...p.years.map((yr, i) => h("tr", h("td", String(yr)), h("td", `${num(p.rel[i])}${i === n - 1 && p.partial ? " (pace)" : ""}`), h("td", num(p.users[i])), h("td", p.users[i] ? num(p.users[i] / p.rel[i]) : "–"))).reverse())));
  return h("div", legend, svg, table);
}

// ---------------------------------------------------------------------------
// Shortlist
// ---------------------------------------------------------------------------

const STAGE_TEXT = { soon: "Coming soon", fresh: "Just out", proven: "Proven" };
function shortlistText(list) {
  const date = new Date().toISOString().slice(0, 10);
  return [`My shortlist of games to consider signing as a small Godot publisher (from my Market scout board, ${date}). For each: research the studio, judge whether a publishing deal makes sense and what we'd offer (ports to Linux/Mac/Steam Deck, localization into 30 languages, marketing), and draft a short first message.`,
    ...list.map((g, i) => [`${i + 1}. ${g.name} (${storeUrl(g.appid)})`,
      `   Stage: ${STAGE_TEXT[g.stage] || g.stage}${g.godot ? "; made with Godot" : ""}`,
      `   Studio: ${g.studio || "see the store page"}; ${g.pub === "self" ? "self-published" : `publisher: ${g.pubName || PUB_TEXT[g.pub]}`}`,
      g.tags?.length ? `   Tags: ${g.tags.join(", ")}` : null,
      `   ${g.meter} ${g.score}/100. Why: ${g.why}`].filter(Boolean).join("\n"))].join("\n\n");
}

function shortlistView() {
  const h = C.h, list = S.shortlist;
  if (!list.length) return h("div.sc-empty-box", h("h3", "Your shortlist is empty"), h("p", "Star games on the scouting board (☆ on a card) to collect the ones worth a message. They stay here on this browser."), h("button.btn", { type: "button", onclick: () => setTab("board") }, "Open the scouting board"));
  const text = shortlistText(list);
  return h("div",
    h("div.sc-bar", h("button.btn.primary", { type: "button", onclick: (e) => C.copy(text, e.currentTarget) }, "Copy for Claude"),
      h("button.btn", { type: "button", onclick: () => { if (confirm("Empty the shortlist?")) { S.shortlist = []; sset("shortlist", []); draw(); } } }, "Clear"),
      h("span.sc-note", `${list.length} game${list.length === 1 ? "" : "s"}, newest first. Copy for Claude puts them on the clipboard with a request to research each studio and draft a first message.`)),
    h("div.sc-cards.sc-grid", ...list.map((g) => card({ ...g, tags: g.tags }))),
    h("details.sc-table", h("summary", "The text that gets copied"), h("pre.sc-pre", text)));
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function injectStyle() {
  if (document.getElementById("mk-scout-style")) return;
  document.head.append(Object.assign(document.createElement("style"), { id: "mk-scout-style", textContent: CSS }));
}

const CSS = `
.mkv-scout { --sc-hot: #e0592a; --sc-cold: #2a78d6; --sc-mid: #ebe9e4; --sc-radius: var(--radius-card, 12px); display: flex; flex-direction: column; gap: 14px; min-width: 0; }
@media (prefers-color-scheme: dark) { .mkv-scout { --sc-hot: #f0703e; --sc-cold: #3f8fe8; --sc-mid: #3a3a37; } }
.mkv-scout h3 { margin: 0; font-size: 1rem; color: var(--fb-title); }
.mkv-scout h4 { margin: 14px 0 6px; font-size: .875rem; color: var(--fb-title); }
.mkv-scout .sc-muted { color: var(--fb-muted); }
.mkv-scout .sc-explain { margin: 0; color: var(--fb-ink-2); font-size: .8125rem; line-height: 1.45; }
.mkv-scout .sc-empty { color: var(--fb-muted); padding: 18px 4px; margin: 0; }
.mkv-scout .sc-empty-box { background: var(--fb-card); box-shadow: var(--fb-shadow); border-radius: var(--sc-radius); padding: 24px; text-align: center; }
.mkv-scout .sc-empty-box p { color: var(--fb-ink-2); }
.mkv-scout .sc-nav { overflow-x: auto; max-width: 100%; }
.mkv-scout .sc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.mkv-scout .sc-note { flex: 1 1 240px; color: var(--fb-muted); font-size: .75rem; line-height: 1.4; }
.mkv-scout .sc-toggle { display: inline-flex; align-items: center; gap: 8px; background: var(--fb-card); box-shadow: var(--fb-shadow); color: var(--fb-ink); border: 0; border-radius: 999px; padding: 6px 12px 6px 6px; font-size: .8125rem; font-weight: 600; cursor: pointer; }
.mkv-scout .sc-toggle:hover { background: var(--fb-hover); }
.mkv-scout .sc-sw { width: 28px; height: 16px; border-radius: 999px; background: var(--fb-line); position: relative; flex: none; transition: background .15s; }
.mkv-scout .sc-sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 2px rgba(0,0,0,.3); }
.mkv-scout .sc-toggle[aria-pressed="true"] .sc-sw { background: var(--fb-accent); }
.mkv-scout .sc-toggle[aria-pressed="true"] .sc-sw::after { transform: translateX(12px); }

/* Board */
.mkv-scout .sc-board-wrap { display: flex; flex-direction: column; gap: 12px; }
.mkv-scout .sc-board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; align-items: start; }
.mkv-scout .sc-colpick { display: none; }
.mkv-scout .sc-col { background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: var(--sc-radius); padding: 10px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.mkv-scout .sc-colhead h3 { display: flex; align-items: center; gap: 8px; }
.mkv-scout .sc-colhead p { margin: 4px 0 0; color: var(--fb-muted); font-size: .75rem; line-height: 1.4; }
.mkv-scout .sc-count { font-size: .75rem; font-weight: 700; color: var(--fb-ink-2); background: var(--fb-card); border-radius: 999px; padding: 1px 8px; }
.mkv-scout .sc-cards { display: flex; flex-direction: column; gap: 10px; }
.mkv-scout .sc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.mkv-scout .sc-card { position: relative; background: var(--fb-card); box-shadow: var(--fb-shadow); border-radius: var(--sc-radius); overflow: hidden; min-width: 0; }
.mkv-scout .sc-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--sw-3); z-index: 1; }
.mkv-scout .sc-card.sc-fresh::before { background: var(--sw-1); }
.mkv-scout .sc-card.sc-proven::before { background: var(--sw-4); }
.mkv-scout .sc-cap { display: block; aspect-ratio: 231 / 87; background: var(--fb-card-2); }
.mkv-scout .sc-cap img { display: block; width: 100%; height: 100%; object-fit: cover; }
.mkv-scout .sc-cap.sc-noimg { display: none; }
.mkv-scout .sc-star { position: absolute; top: 6px; right: 6px; z-index: 2; width: 32px; height: 32px; border-radius: 50%; border: 0; background: color-mix(in srgb, var(--fb-card) 88%, transparent); color: var(--fb-ink-2); font-size: 18px; line-height: 1; cursor: pointer; box-shadow: var(--fb-shadow); }
.mkv-scout .sc-star[aria-pressed="true"] { color: #e8a300; }
.mkv-scout .sc-star:hover { background: var(--fb-hover); }
.mkv-scout .sc-noimg ~ .sc-body, .mkv-scout .sc-card:not(:has(.sc-cap img)) .sc-body { padding-right: 44px; }
.mkv-scout .sc-body { padding: 10px 12px 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.mkv-scout .sc-body h4 { margin: 0; font-size: .9375rem; line-height: 1.25; overflow-wrap: anywhere; }
.mkv-scout .sc-body h4 a { color: var(--fb-title); text-decoration: none; }
.mkv-scout .sc-body h4 a:hover { text-decoration: underline; }
.mkv-scout .sc-who { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: .75rem; color: var(--fb-ink-2); min-width: 0; }
.mkv-scout .sc-who > span:first-child:not(.sc-badge) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.mkv-scout .sc-badge { display: inline-block; font-size: .6875rem; font-weight: 700; border-radius: 4px; padding: 1px 6px; margin-left: 4px; background: var(--fb-card-2); color: var(--fb-ink-2); border: 1px solid var(--fb-line); white-space: nowrap; }
.mkv-scout .sc-who .sc-badge { margin-left: 0; }
.mkv-scout .sc-p-self { color: var(--fb-good-text); border-color: color-mix(in srgb, var(--fb-good-text) 40%, transparent); }
.mkv-scout .sc-p-real { color: var(--fb-muted); }
.mkv-scout .sc-godot { color: var(--fb-link); border-color: color-mix(in srgb, var(--fb-link) 40%, transparent); }
.mkv-scout .sc-meter { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; font-size: .75rem; color: var(--fb-ink-2); }
.mkv-scout .sc-meter b { color: var(--fb-title); font-size: .8125rem; min-width: 2ch; text-align: right; }
.mkv-scout .sc-track { display: block; height: 6px; border-radius: 3px; background: var(--fb-line); overflow: hidden; min-width: 40px; }
.mkv-scout .sc-track i { display: block; height: 100%; border-radius: 3px; background: var(--fb-accent); }
.mkv-scout .sc-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.mkv-scout .sc-chip { font: inherit; font-size: .6875rem; border: 1px solid var(--fb-line); background: var(--fb-card-2); color: var(--fb-ink-2); border-radius: 999px; padding: 1px 8px; cursor: pointer; }
.mkv-scout .sc-chip:hover { background: var(--fb-hover); color: var(--fb-ink); }
.mkv-scout .sc-chip.sc-hot { border-color: var(--sc-hot); color: var(--fb-ink); }
.mkv-scout .sc-chip.sc-hot::before { content: "▲ "; color: var(--sc-hot); font-size: .625rem; }
.mkv-scout .sc-why { margin: 0; font-size: .75rem; line-height: 1.4; color: var(--fb-ink); }
.mkv-scout .sc-more { align-self: center; }
@media (max-width: 860px) {
  .mkv-scout .sc-colpick { display: block; }
  .mkv-scout .sc-board { grid-template-columns: minmax(0, 1fr); }
  .mkv-scout .sc-col { display: none; }
  .mkv-scout .sc-col.sc-on { display: flex; }
}

/* Niche map */
.mkv-scout .sc-find { min-height: 34px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); min-width: 0; flex: 1 1 160px; max-width: 260px; }
.mkv-scout .sc-niche { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.mkv-scout .sc-niche.sc-wide { grid-template-columns: minmax(0, 62fr) minmax(0, 38fr); align-items: start; }
.mkv-scout .sc-mapcard, .mkv-scout .sc-panel, .mkv-scout .sc-hotlist, .mkv-scout .sc-chartcard, .mkv-scout .sc-feed { background: var(--fb-card); box-shadow: var(--fb-shadow); border-radius: var(--sc-radius); padding: 14px; min-width: 0; }
.mkv-scout .sc-panel { position: sticky; top: 12px; max-height: calc(100vh - 24px); overflow-y: auto; }
.mkv-scout .sc-map { display: block; width: 100%; height: auto; margin-top: 10px; }
.mkv-scout .sc-tile { cursor: pointer; outline: none; }
.mkv-scout .sc-tile rect { stroke: var(--fb-card); stroke-width: 1; }
.mkv-scout .sc-tile:hover rect, .mkv-scout .sc-tile:focus-visible rect { stroke: var(--fb-ink); stroke-width: 2; }
.mkv-scout .sc-tile.sc-sel rect { stroke: var(--fb-title); stroke-width: 3; }
.mkv-scout .sc-tile text { font-size: 11px; font-weight: 600; fill: var(--fb-ink); pointer-events: none; }
.mkv-scout .sc-tile text.sc-sub { font-weight: 400; font-size: 10px; fill: var(--fb-ink-2); }
.mkv-scout .sc-tile text.sc-on-strong { fill: #fff; }
.mkv-scout .sc-legend { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.mkv-scout .sc-legend p { margin: 0; font-size: .75rem; color: var(--fb-muted); line-height: 1.4; }
.mkv-scout .sc-ramp { height: 10px; border-radius: 5px; background: linear-gradient(90deg, var(--sc-cold), var(--sc-mid), var(--sc-hot)); max-width: 420px; }
.mkv-scout .sc-ramp-labels { display: flex; justify-content: space-between; max-width: 420px; font-size: .6875rem; color: var(--fb-ink-2); margin-top: 3px; gap: 6px; }
.mkv-scout .sc-panelhead { display: flex; flex-direction: column; gap: 6px; }
.mkv-scout .sc-panelhead h3 { font-size: 1.125rem; }
.mkv-scout .sc-lead { margin: 10px 0; font-size: .9375rem; line-height: 1.45; color: var(--fb-ink); }
.mkv-scout .sc-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; margin: 0; font-size: .8125rem; }
.mkv-scout .sc-facts dt { font-weight: 800; color: var(--fb-title); text-align: right; font-variant-numeric: tabular-nums; }
.mkv-scout .sc-facts dd { margin: 0; color: var(--fb-ink-2); line-height: 1.4; }
.mkv-scout .sc-sure { display: inline-block; font-size: .6875rem; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--fb-line); color: var(--fb-ink-2); white-space: nowrap; align-self: flex-start; }
.mkv-scout .sc-s3 { color: var(--fb-good-text); border-color: color-mix(in srgb, var(--fb-good-text) 45%, transparent); }
.mkv-scout .sc-s1 { color: var(--fb-muted); border-style: dashed; }
.mkv-scout .sc-plain { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 5px; font-size: .8125rem; }
.mkv-scout .sc-plain a, .mkv-scout .sc-alert a { color: var(--fb-link); }
.mkv-scout .sc-pairs { display: flex; flex-direction: column; gap: 6px; font-size: .75rem; }
.mkv-scout .sc-pair { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(40px, 1fr) auto auto auto; gap: 8px; align-items: center; }
.mkv-scout .sc-pn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fb-ink); font-weight: 600; }
.mkv-scout .sc-hotlist ol { margin: 10px 0 0; padding-left: 22px; display: flex; flex-direction: column; gap: 6px; font-size: .8125rem; color: var(--fb-ink-2); }
.mkv-scout .sc-linkbtn { font: inherit; font-weight: 700; color: var(--fb-link); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.mkv-scout .sc-linkbtn:hover { text-decoration: underline; }

/* Pulse */
.mkv-scout .sc-pulse { display: flex; flex-direction: column; gap: 14px; }
.mkv-scout .sc-line { display: block; width: 100%; height: auto; }
.mkv-scout .sc-line .sc-grid { stroke: var(--fb-line); stroke-width: 1; opacity: .6; }
.mkv-scout .sc-line .sc-base { stroke: var(--fb-line); stroke-width: 1; }
.mkv-scout .sc-line .sc-axis { font-size: 11px; fill: var(--fb-muted); }
.mkv-scout .sc-line .sc-dlabel { font-size: 12px; font-weight: 700; fill: var(--fb-ink); }
.mkv-scout .sc-line .sc-cross { stroke: var(--fb-muted); stroke-dasharray: 3 3; }
.mkv-scout .sc-keys { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: .75rem; color: var(--fb-ink-2); margin: 4px 0 6px; }
.mkv-scout .sc-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
.mkv-scout .sc-alerts { list-style: none; padding: 0; margin: 10px 0; display: flex; flex-direction: column; gap: 8px; }
.mkv-scout .sc-alert { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 10px; padding: 10px; border-radius: 8px; background: var(--fb-card-2); border-left: 3px solid var(--sc-hot); }
.mkv-scout .sc-alert.sc-g1 { border-left-color: var(--fb-good-text); }
.mkv-scout .sc-alert.sc-g2 { border-left-color: var(--sw-1); }
.mkv-scout .sc-alert.sc-g3 { border-left-color: var(--fb-line); }
.mkv-scout .sc-alert p { margin: 3px 0 0; font-size: .8125rem; color: var(--fb-ink-2); line-height: 1.4; }
.mkv-scout .sc-kind { font-size: .6875rem; font-weight: 800; text-transform: uppercase; letter-spacing: .03em; color: var(--fb-ink-2); padding-top: 2px; }
@media (max-width: 560px) { .mkv-scout .sc-alert { grid-template-columns: minmax(0, 1fr); gap: 4px; } }

/* Shared */
.mkv-scout .sc-table summary { cursor: pointer; color: var(--fb-ink-2); font-size: .8125rem; margin-top: 8px; }
.mkv-scout .sc-scroll { overflow-x: auto; max-width: 100%; }
.mkv-scout .sc-pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .75rem; background: var(--fb-card-2); color: var(--fb-ink); padding: 12px; border-radius: 8px; max-height: 360px; overflow: auto; }
.mkv-scout .sc-tip { position: fixed; z-index: 50; pointer-events: none; background: var(--fb-card); color: var(--fb-ink); box-shadow: 0 4px 16px rgba(0,0,0,.18); border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px; font-size: .75rem; line-height: 1.45; max-width: 260px; }
.mkv-scout .sc-tip b { color: var(--fb-title); }
`;
