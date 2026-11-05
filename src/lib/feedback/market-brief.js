// The dashboard's Market section, "Briefing" variant: the market answered in plain sentences, around
// the owner's three questions. A short "Today" summary on top, then:
//   1. What should I make next?  niches (user tags) ranked by how often their games become hits,
//      pulled toward Steam's average when a tag has few games, plus a tag-pair gap finder.
//   2. Who should I sign?        self-published games still to come out first, then released
//      self-published Godot games that could reach more players; published ones folded away.
//   3. How is Steam doing?       games released vs Steam's peak players (2018 = 100), and one tag's
//      share of releases vs its share of reviews.
// Same contract as market.js: marketTop(ctx) fills the header, marketView(ctx) returns one root that
// redraws itself. The data files come from server/steamdata/market.py.

const DAY = 86400;
const PREFIX = "mkv-brief-";
const INDIE = 492;
const PRIOR = 30;          // shrinkage: as if each niche also had 30 games at the base rate
const MIN_PAIR = 15;       // a niche needs this many games to be listed at all
const MIN_SINGLE = 20;
const SALES_PER_REVIEW = 30;
const NET_SHARE = 0.5;     // what's left of a sale after Steam's 30%, VAT, refunds and discounts
const HUGE = ["Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Realistic", "Photorealistic"];
const BIG = ["Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Co-op", "Third-Person Shooter", "Souls-like", "Sandbox", "Story Rich", "3D", "First-Person"];
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
// Tags that say how a game is sold or how players feel about it, not what it is.
const META = ["Indie", "Free to Play", "Early Access", "Replay Value", "Great Soundtrack", "Masterpiece", "Addictive", "Classic", "Beautiful", "Singleplayer", "Casual"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TABS = [
  ["make", "What should I make next?", "Niches where games often become hits"],
  ["sign", "Who should I sign?", "Self-published games worth a message"],
  ["steam", "How is Steam doing?", "Games released vs players"],
];

// ---------------------------------------------------------------------------
// Plain helpers (no DOM): also used by the smoke test
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const short = (n) => n == null ? "–" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)} million` : num(n);
const pct = (x, d = 0) => x == null ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const usd = (n) => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const dayShort = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };

// "1 in 4": a share said the way people say it.
export function oneIn(p) {
  if (p == null) return "–";
  if (p >= 0.5) return p >= 0.7 ? "most" : "more than half";
  if (p <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / p))}`;
}
// How sure: by how many games the number stands on.
export function confidence(n) { return n >= 100 ? "solid" : n >= 40 ? "likely" : "thin data"; }
// A tag's releases as a share of Steam's, against a year ago.
function growthWords(supply) {
  if (supply == null) return "no year-ago count";
  if (supply >= 2) return "growing much faster than Steam";
  if (supply >= 1.15) return "growing faster than Steam";
  if (supply >= 0.87) return "growing with Steam";
  if (supply >= 0.6) return "growing slower than Steam";
  return "losing ground on Steam";
}
// An upcoming game's release date, as precise as the store says.
function releaseText(day, kind) {
  if (day == null) return kind && !kind.startsWith("date_") ? kind.toLowerCase() : "no date yet";
  const t = new Date(day * DAY * 1000), y = t.getUTCFullYear();
  if (kind === "date_year") return `sometime in ${y}`;
  if (kind === "date_quarter") return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${y}`;
  if (kind === "date_month") return `${MONTHS[t.getUTCMonth()]} ${y}`;
  return dayDate(day);
}

const tagSets = (tagNames) => {
  const byName = new Map(Object.entries(tagNames || {}).map(([id, n]) => [n.toLowerCase(), Number(id)]));
  const ids = (list) => new Set(list.map((n) => byName.get(n.toLowerCase())).filter((x) => x != null));
  return { big: ids([...HUGE, ...BIG]), adult: ids(ADULT), meta: ids(META), byName };
};

// --- 1. Niches from trends.json -------------------------------------------------

// Every tag with a hit rate, best first. trends.hitRate is already pulled toward Steam's rate (as if
// the tag also had `priorGames` average games), so a tag with a handful of games can't top the list.
export function rankNiches(trends, tagNames, { small = true, sort = "odds" } = {}) {
  const s = tagSets(tagNames);
  const rows = (trends.tags || []).filter((r) => r.hitRate != null && r.hitGames >= MIN_SINGLE && !s.meta.has(r.tag) && !s.adult.has(r.tag) && (!small || !s.big.has(r.tag)))
    .map((r) => ({ ...r, conf: confidence(r.hitGames), lift: r.hitLift ?? r.hitRate / trends.baseHitRate }));
  const thinLast = (a, b) => (a.conf === "thin data") - (b.conf === "thin data");
  const by = {
    odds: (a, b) => b.hitRate - a.hitRate,
    typical: (a, b) => thinLast(a, b) || (b.medianReviews ?? 0) - (a.medianReviews ?? 0),
    // Growth and quiet only among niches that beat Steam's hit rate: a fast-growing tag nobody plays isn't news.
    growing: (a, b) => (b.lift >= 1.3) - (a.lift >= 1.3) || (b.supply ?? 0) - (a.supply ?? 0),
    quiet: (a, b) => (b.lift >= 1.5) - (a.lift >= 1.5) || thinLast(a, b) || a.releases - b.releases,
  }[sort] || ((a, b) => b.hitRate - a.hitRate);
  return rows.sort(by);
}

// --- 1b. The gap finder, from games.json ------------------------------------------

export function unpackGames(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  const top = file.topTags || 5;
  return file.rows.map((r) => ({
    appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price] || 0, reviews: r[col.reviews] || 0,
    pos: r[col.pos], top: (r[col.tags] || []).slice(0, top), flags: r[col.flags] || 0, hit: r[col.hit],
  }));
}

// Niches (single tags or pairs of a game's strongest tags) where games like that reached the goal
// more often than Steam's average. goal "hit": top 10% of their release fortnight (games out 2 weeks
// to 6 months); goal "money": earned about `target` dollars (paid games out 2 months to 2 years).
export function gapFinder(list, tagNames, { today, goal = "hit", target = 50000, pairs = true, small = true, must = null } = {}) {
  const s = tagSets(tagNames);
  const ok = goal === "hit"
    ? (g) => g.hit != null && g.day >= today - 180 && g.day <= today - 14
    : (g) => g.price > 0 && g.day >= today - 730 && g.day <= today - 60;
  const won = goal === "hit" ? (g) => g.hit >= 90 : (g) => g.reviews * SALES_PER_REVIEW * (g.price / 100) * NET_SHARE >= target;
  const keysOf = (g) => {
    const own = g.top.filter((t) => t !== INDIE && !s.meta.has(t) && t !== must);
    if (!pairs) return own.map(String);
    const out = [];
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) out.push(own[i] < own[j] ? `${own[i]}+${own[j]}` : `${own[j]}+${own[i]}`);
    return out;
  };
  const skip = (g) => g.top.some((t) => s.adult.has(t)) || (small && g.top.some((t) => s.big.has(t))) || (must != null && !g.top.includes(must));
  const niches = new Map(), recent = new Map(), ago = new Map();
  let n = 0, wins = 0, recentAll = 0, agoAll = 0;
  for (const g of list) {
    if (skip(g)) continue;
    const isRecent = g.day > today - 90, isAgo = g.day > today - 455 && g.day <= today - 365;
    const inPool = ok(g);
    if (!inPool && !isRecent && !isAgo) continue;
    const keys = keysOf(g);
    if (isRecent) { recentAll++; for (const k of keys) recent.set(k, (recent.get(k) || 0) + 1); }
    if (isAgo) { agoAll++; for (const k of keys) ago.set(k, (ago.get(k) || 0) + 1); }
    if (!inPool) continue;
    const w = won(g);
    n++; if (w) wins++;
    for (const k of keys) {
      let e = niches.get(k);
      if (!e) niches.set(k, e = { k, n: 0, wins: 0, reviews: [], best: null });
      e.n++; if (w) e.wins++;
      e.reviews.push(g.reviews);
      if (!e.best || g.reviews > e.best.reviews) e.best = g;
    }
  }
  const base = n ? wins / n : 0;
  const min = pairs ? MIN_PAIR : MIN_SINGLE;
  const rows = [...niches.values()].filter((e) => e.n >= min && base > 0).map((e) => {
    const adj = (e.wins + PRIOR * base) / (e.n + PRIOR);
    const r = recent.get(e.k) || 0, a = ago.get(e.k) || 0;
    return {
      k: e.k, name: e.k.split("+").map((id) => tagNames[id] || `Tag ${id}`).join(" + "), n: e.n, wins: e.wins,
      raw: e.wins / e.n, adj, lift: adj / base, conf: confidence(e.n), medianReviews: median(e.reviews), best: e.best,
      recent: r, growth: agoAll && recentAll ? ((r + 1) / recentAll) / ((a + 1) / agoAll) : null,
    };
  }).sort((x, y) => y.lift - x.lift);
  return { base, pool: n, wins, rows };
}

// --- 2. Leads ---------------------------------------------------------------------

export function unpackUpcoming(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  return file.rows.map((r) => ({
    appid: r[col.appid], name: r[col.name], day: r[col.day], display: r[col.display], price: r[col.price],
    tags: r[col.tags] || [], flags: r[col.flags] || 0, langs: r[col.langs], devs: r[col.devs] || [], pubs: r[col.pubs] || [],
    devGames: r[col.devGames] || 0, devBest: r[col.devBest] || 0, devReviews: r[col.devReviews] || 0, pubGames: r[col.pubGames] || 0,
    players: r[col.players],
  }));
}

const F = { linux: 1, mac: 2, deckOk: 4, demo: 128, godot: 64, self: 256 };

// The tag (of a game's strongest five) whose games most often become hits.
function hotTag(tags, hot) {
  let best = null;
  for (const t of tags.slice(0, 5)) { const r = hot.get(t); if (r && r.lift >= 1.4 && (!best || r.lift > best.lift)) best = r; }
  return best;
}
const hotMap = (trends) => new Map((trends?.tags || []).filter((r) => r.hitRate != null && r.tag !== INDIE).map((r) => [r.tag, { tag: r.tag, name: r.name, lift: r.hitLift, rate: r.hitRate, conf: confidence(r.hitGames) }]));

// Upcoming games, the ones worth a message first. "self": no outside publisher; "label": a small one
// (1–2 games); "published": a real publisher (3+ games), which go to the folded list.
export function upcomingLeads(list, trends, today, { godotOnly = true } = {}) {
  const hot = hotMap(trends);
  return list.filter((g) => !godotOnly || g.flags & F.godot).map((g) => {
    const deal = g.flags & F.self || !g.pubGames ? "self" : g.pubGames <= 2 ? "label" : "published";
    const until = g.day == null ? null : g.day - today;
    const exact = g.display === "date_full" || g.display === "date_month";
    const tag = hotTag(g.tags, hot);
    const demo = !!(g.flags & F.demo);
    let score = { self: 30, label: 14, published: 0 }[deal] + (g.flags & F.godot ? 20 : 0);
    score += until == null ? 1 : until < -30 ? 0 : !exact ? 4 : until <= 30 ? 15 : until <= 120 ? 12 : until <= 270 ? 8 : 4;
    if (tag) score += Math.min(15, (tag.lift - 1) * 10);
    score += g.devBest >= 1000 ? 15 : g.devBest >= 200 ? 11 : g.devBest >= 50 ? 7 : g.devGames ? 2 : 0;
    if (demo) score += 6;
    // The one-line reason.
    const who = `${deal === "self" ? "Self-published" : deal === "label" ? "Small-label" : "Published"}${g.flags & F.godot ? " Godot" : ""} game`;
    const when = until == null ? (demo ? "no date yet, but a demo is out" : "no date yet")
      : until < 0 ? `its date (${dayShort(g.day)}) just passed: still coming`
      : !exact ? `planned for ${releaseText(g.day, g.display)}`
      : until === 0 ? "out today" : until <= 60 ? `out in ${plural(until, "day")} (${dayShort(g.day)})` : `out ${releaseText(g.day, g.display)}`;
    const parts = [`${who}, ${when}`];
    if (tag) parts.push(`in ${tag.name}, where ${oneIn(tag.rate)} recent games became a hit`);
    if (g.devBest >= 50) parts.push(`the studio's best game has ${num(g.devBest)} reviews`);
    else if (!g.devGames) parts.push("the studio's first game");
    if (demo && until != null) parts.push("demo out");
    return { ...g, deal, until, tag, demo, score: Math.round(score), reason: parts.join("; ") + "." };
  }).sort((a, b) => (a.deal === "published") - (b.deal === "published") || b.score - a.score);
}

// Released self-published (or small-label) Godot games: well liked but not reaching many players yet.
export function releasedLeads(godot, today) {
  return godot.filter((g) => !g.comingSoon && g.day != null && today - g.day <= 730 && g.reviews >= 10 && g.pos != null && g.pos >= 75
    && (g.selfPublished || g.publisherGames <= 2)).map((g) => {
    const trust = clamp(Math.log10(g.reviews + 1) / 2);
    const gaps = [];
    if (g.languages != null && g.languages < 5) gaps.push(`only ${plural(g.languages, "language")}`);
    const ports = [!g.mac && "Mac", !g.linux && "Linux"].filter(Boolean);
    if (ports.length) gaps.push(`no ${ports.join(" or ")} build`);
    if (!g.deck) gaps.push("no Steam Deck rating");
    const age = today - g.day;
    let score = 30 * clamp((g.pos - 75) / 20) * trust;
    score += 15 * clamp(1 - Math.log10(Math.max(g.reviews, 10)) / Math.log10(5000));
    score += Math.min(25, gaps.length * 8) * trust;
    score += age <= 180 ? 15 : age <= 365 ? 8 : 0;
    score += g.selfPublished ? 10 : 4;
    const reason = `${g.selfPublished ? "Self-published" : "On a small label"}, ${g.pos}% positive from ${num(g.reviews)} reviews, out for ${age < 60 ? plural(age, "day") : `${Math.round(age / 30.4)} months`}`
      + (gaps.length ? `, but ${gaps.join(", ")}: room to reach more players.` : ": well liked, still a small audience.");
    return { ...g, score: Math.round(score), reason };
  }).sort((a, b) => b.score - a.score);
}

// Godot games that already have a real publisher (3+ games): shown last, folded.
export function publishedGodot(godot) {
  return godot.filter((g) => !g.selfPublished && g.publisherGames >= 3).sort((a, b) => (b.comingSoon - a.comingSoon) || b.reviews - a.reviews);
}

// --- 3. Steam's growth --------------------------------------------------------------

export function steamGrowth(g) {
  const first = Math.max(g.years.indexOf(2018), g.users.y.findIndex((v) => v != null));
  if (first < 0) return null;
  const last = g.years.length - 1;
  const rel = g.total.y.map((n, i) => i === last && g.yearDone > 0 && g.yearDone < 1 ? n / g.yearDone : n).slice(first);
  const users = g.users.y.slice(first);
  const years = g.years.slice(first);
  const idx = (xs) => xs.map((v) => v == null ? null : (v / xs[0]) * 100);
  const gr = rel.at(-1) / rel[0], ur = users.at(-1) / users[0], per = ur / gr;
  const sentence = `Since ${years[0]}, the number of games released a year has grown ${times(gr)} (${num(rel[0])} to about ${num(rel.at(-1))} at this year's pace), while Steam's peak players grew ${times(ur)} (${short(users[0])} to ${short(users.at(-1))}). `
    + (per < 0.95 ? `Games are arriving faster than players: each new game now shares the crowd with about ${pct(1 - per)} fewer players than in ${years[0]}.`
      : per > 1.05 ? `Players are arriving faster than games: about ${pct(per - 1)} more players per new game than in ${years[0]}.` : `Players and games have grown about as fast as each other.`);
  return { years, rel, users, relIdx: idx(rel), usersIdx: idx(users), gr, ur, per, sentence, partial: g.yearDone < 1 };
}

export function tagShare(g, tagId, from = 2018) {
  const s = g.tags[tagId];
  if (!s) return null;
  const i0 = Math.max(0, g.years.indexOf(from));
  const years = g.years.slice(i0);
  const rel = years.map((_, j) => g.total.y[i0 + j] ? s.y[i0 + j] / g.total.y[i0 + j] : null);
  const rev = years.map((_, j) => g.total.yr[i0 + j] ? s.yr[i0 + j] / g.total.yr[i0 + j] : null);
  const a = rel.at(-1), b = rev.at(-1), r = a ? b / a : null;
  const sentence = `${s.name} games were ${pct(a, 1)} of ${years.at(-1)}'s releases and earned ${pct(b, 1)} of their reviews: `
    + (r == null ? "not enough data." : r >= 1.3 ? `players review it ${times(r)} more than its share of games, so there's room for more.`
      : r <= 0.77 ? `players review it less than its share of games (${times(r)}), so it's crowded for what it earns.` : "players and developers are about in balance.");
  return { name: s.name, years, rel, rev, sentence };
}

// --- Today: the few things worth knowing ------------------------------------------

export function todayItems({ trends, tagNames, upcoming, godot, growth, today }) {
  const out = [];
  if (trends) {
    const n = rankNiches(trends, tagNames, { small: true }).find((r) => r.conf !== "thin data");
    if (n) out.push({ kind: "Niche", text: `Best niche right now: ${n.name}. ${num(n.hits)} of its ${num(n.hitGames)} recent games became hits, about ${oneIn(n.hitRate)} even after allowing for chance (Steam average: ${oneIn(trends.baseHitRate)}). New ones are ${growthWords(n.supply)}.`, tab: "make" });
  }
  if (upcoming) {
    const l = upcoming.find((g) => g.deal !== "published");
    if (l) out.push({ kind: "Lead", text: `Best upcoming lead: ${l.name} by ${l.devs.join(", ") || "an unknown studio"}. ${l.reason}`, appid: l.appid, tab: "sign" });
  }
  if (godot) {
    const r = godot[0];
    if (r) out.push({ kind: "Lead", text: `Released and worth a look: ${r.name} by ${r.developers.join(", ") || "?"}. ${r.reason}`, appid: r.appid, tab: "sign" });
  }
  const b = (trends?.alerts || []).find((a) => a.kind === "breakout");
  if (b) out.push({ kind: "Breakout", text: `${b.title.replace(/^Breakout: /, "")} is breaking out: ${b.detail.replace(/; hit index \d+/, "")}`, appid: b.appid });
  if (growth) out.push({ kind: "Steam", text: growth.sentence.split(". ").slice(-1)[0], tab: "steam" });
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let C;
const st = {
  files: {}, loading: {}, errors: {}, root: null, cache: {},
  tab: "make", small: true, sort: "odds", shown: 6, q: "",
  goal: "hit", target: 50000, pairs: true, gapShown: 8, must: "",
  godotOnly: true, upShown: 8, relShown: 6, shareTag: null,
};
const NEEDS = { make: ["trends", "games"], sign: ["trends", "upcoming", "godot"], steam: ["growth", "trends"] };
const today = () => st.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const tagNames = () => st.files.overview?.tags || {};
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;
const devUrl = (dev) => `https://store.steampowered.com/search/?developer=${encodeURIComponent(dev)}`;

const save = (k, v) => C.store.set(PREFIX + k, typeof v === "string" ? v : JSON.stringify(v));
function restore() {
  const get = (k) => { try { const v = C.store.get(PREFIX + k); return v == null ? null : v; } catch { return null; } };
  const tab = get("tab"); if (TABS.some(([id]) => id === tab)) st.tab = tab;
  for (const k of ["small", "pairs", "godotOnly"]) { const v = get(k); if (v === "true" || v === "false") st[k] = v === "true"; }
  const sort = get("sort"); if (["odds", "typical", "growing", "quiet"].includes(sort)) st.sort = sort;
  const goal = get("goal"); if (goal === "hit" || goal === "money") st.goal = goal;
  const target = Number(get("target")); if (target > 0) st.target = target;
  const tag = get("shareTag"); if (tag) st.shareTag = tag;
}

// Cached by inputs: the heavy work runs once per setting, not on every redraw.
function memo(key, fn) { if (!(key in st.cache)) st.cache[key] = fn(); return st.cache[key]; }
const gamesList = () => memo("games", () => unpackGames(st.files.games));
const upcomingList = () => memo("upcoming", () => unpackUpcoming(st.files.upcoming));
const upLeads = (godotOnly) => memo(`up:${godotOnly}`, () => upcomingLeads(upcomingList(), st.files.trends, today(), { godotOnly }));
const relLeads = () => memo("rel", () => releasedLeads(st.files.godot.games, today()));
const growthNow = () => memo("growth", () => steamGrowth(st.files.growth));

export function marketTop(ctx) {
  C = ctx;
  const o = st.files.overview;
  const set = (id, ...kids) => { const el = document.getElementById(id); if (el) el.replaceChildren(...kids); };
  const cap = document.getElementById("fb-capsule"); if (cap) cap.hidden = true;
  set("fb-title", "Market");
  set("fb-updated", o ? `All of Steam: ${num(o.games)} games, ${num(o.comingSoon)} still to come out. Updated ${C.fmtDateTime(o.builtAt)}.` : "All of Steam, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) set(id);
}

export function marketView(ctx) {
  C = ctx;
  injectStyle();
  restore();
  st.root = C.h("div.mk.mkv-brief");
  draw();
  load(["overview", "trends", "upcoming", "godot", "growth", ...NEEDS[st.tab]]);
  return st.root;
}

async function load(names) {
  const wanted = [...new Set(names)].filter((n) => !st.files[n] && !st.loading[n]);
  if (!wanted.length) return;
  for (const n of wanted) { st.loading[n] = true; delete st.errors[n]; }
  await Promise.all(wanted.map(async (n) => {
    try {
      if (C.dataOverride) {
        const res = await fetch(`${C.dataOverride}/market/${n}.json`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
        st.files[n] = await res.json();
      } else st.files[n] = await (await C.adminGet(`market/${n}`)).json();
      st.cache = {};
    } catch (e) {
      if (!e.signedOut) st.errors[n] = e.name === "TimeoutError" ? "The server didn't answer; try again." : /not_built|404/.test(e.message) ? "The market files aren't built yet: the server makes them once a day." : e.message;
    }
    st.loading[n] = false;
    if (n === "overview") marketTop(C);
    draw();
  }));
}

function draw() {
  if (!st.root) return;
  const y = window.scrollY, h = C.h;
  const missing = (names) => names.find((n) => !st.files[n]);
  const err = (names) => names.map((n) => st.errors[n]).find(Boolean);
  const waitFor = (names, text, fn) => err(names) ? h("p.mb-note", err(names), " ", btn("Try again", () => load(names)))
    : missing(names) ? h("p.mb-note", text) : fn();
  const tabs = h("div.mb-tabs", { role: "tablist" }, ...TABS.map(([id, q, sub], i) => h("button.mb-tab", {
    type: "button", role: "tab", "aria-selected": String(st.tab === id),
    onclick: () => { st.tab = id; save("tab", id); load(NEEDS[id]); draw(); },
  }, h("span.mb-tab-n", String(i + 1)), h("span.mb-tab-q", q), h("span.mb-tab-sub", sub))));
  const body = {
    make: () => waitFor(["overview", "trends"], "Loading the niches…", makeView),
    sign: () => waitFor(["overview", "trends", "upcoming", "godot"], "Loading the games still to come out…", signView),
    steam: () => waitFor(["overview", "growth"], "Loading Steam's history…", steamView),
  }[st.tab]();
  st.root.replaceChildren(
    waitFor(["overview", "trends"], "Loading today's briefing…", todayView),
    tabs, h("div.mb-body", { role: "tabpanel" }, body), detectionNote());
  window.scrollTo(0, y);
}

function redrawKeeping(e) {
  const key = e?.target?.dataset?.key, pos = e?.target?.selectionStart;
  draw();
  if (!key) return;
  const el = st.root.querySelector(`[data-key="${key}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}

// --- small UI pieces -----------------------------------------------------------------

const btn = (label, onclick, extra = {}) => C.h("button.mb-btn", { type: "button", onclick, ...extra }, label);
const link = (href, label) => C.h("a.mb-link", { href, target: "_blank", rel: "noopener" }, label);
function seg(options, value, onChange, label) {
  return C.h("div.mb-seg", { role: "group", "aria-label": label }, ...options.map(([v, text]) => C.h("button", {
    type: "button", "aria-pressed": String(v === value), onclick: () => { onChange(v); draw(); },
  }, text)));
}
const toggle = (label, on, flip) => C.h("button.mb-toggle", { type: "button", "aria-pressed": String(on), onclick: () => { flip(); draw(); } }, h0("span.mb-check", on ? "✓" : ""), label);
const h0 = (...a) => C.h(...a);
const confPill = (c) => C.h("span.mb-conf", { class: c === "solid" ? "is-solid" : c === "likely" ? "is-likely" : "is-thin", title: c === "solid" ? "Based on 100+ games" : c === "likely" ? "Based on 40 to 99 games" : "Based on fewer than 40 games: could be luck" }, c);
const more = (shown, total, bump) => total > shown ? btn(`Show more (${num(total - shown)} more)`, () => { bump(); draw(); }, { class: "mb-more" }) : null;
const section = (title, sub, ...kids) => C.h("section.mb-section", C.h("h2", title), sub ? C.h("p.mb-sub", sub) : null, ...kids);

// A bar of the niche's hit chance, with Steam's average as a marker.
function oddsBar(rate, base, max) {
  const h = C.h, w = (x) => `${(clamp(x / max) * 100).toFixed(1)}%`;
  return h("div.mb-oddsrow",
    h("div.mb-bar", { role: "img", "aria-label": `${pct(rate)} against Steam's ${pct(base)}` },
      h("i", { style: `width:${w(rate)}` }), h("b", { style: `left:${w(base)}`, title: `Steam average ${pct(base)}` })),
    h("span.mb-barlabel", h("strong", pct(rate)), ` hit chance · Steam ${pct(base)}`));
}

function todayView() {
  const h = C.h;
  const items = todayItems({
    trends: st.files.trends, tagNames: tagNames(), today: today(),
    upcoming: st.files.upcoming ? upLeads(true) : null,
    godot: st.files.godot ? relLeads() : null,
    growth: st.files.growth ? growthNow() : null,
  });
  return h("section.mb-today",
    h("div.mb-today-head", h("h2", "Today"), h("span.mb-sub", st.files.overview ? dayDate(today()) : "")),
    h("ul.mb-today-list", ...items.map((it) => h("li",
      h("span.mb-kind", { class: `k-${it.kind.toLowerCase()}` }, it.kind),
      h("span.mb-today-text", it.text, " ",
        it.appid ? link(storeUrl(it.appid), "Store page ↗") : null,
        it.tab && it.tab !== st.tab ? btn("More", () => { st.tab = it.tab; save("tab", it.tab); load(NEEDS[it.tab]); draw(); }, { class: "mb-inline" }) : null)))));
}

function detectionNote() {
  const o = st.files.overview;
  if (!o) return null;
  return C.h("p.mb-foot", `Godot detection: ${num(o.withMetadata)} of ${num(o.games)} games checked so far (${pct(o.withMetadata / o.games)}); the rest are checked over the coming days, so more Godot games will appear. ${num(o.historyDays)} ${o.historyDays === 1 ? "day" : "days"} of daily history so far.`);
}

// --- 1. What should I make next? ------------------------------------------------------

function makeView() {
  const h = C.h, t = st.files.trends;
  const all = memo(`niches:${st.small}:${st.sort}`, () => rankNiches(t, tagNames(), { small: st.small, sort: st.sort }));
  const q = st.q.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  const max = Math.max(0.3, ...all.map((r) => r.hitRate));
  const [w0, w1] = t.hitRateWindow || [14, 180];
  const card = (r, i) => h("article.mb-card",
    h("div.mb-card-head", h("span.mb-rank", `#${all.indexOf(r) + 1}`), h("h3", r.name), confPill(r.conf)),
    h("p.mb-big", `${num(r.hits)} of the ${num(r.hitGames)} ${r.name} games released ${w0} days to ${Math.round(w1 / 30)} months ago became hits. Allowing for chance, that's about ${oneIn(r.hitRate)} (Steam average: ${oneIn(t.baseHitRate)}).`),
    oddsBar(r.hitRate, t.baseHitRate, max),
    h("p.mb-line", `A typical one has ${plural(r.medianReviews, "review")}; a top-10% one has ${plural(r.topReviews, "review")}.`,
      r.medianReviews != null && t.baseMedianReviews ? ` (A typical Steam game: ${plural(t.baseMedianReviews, "review")}.)` : ""),
    h("p.mb-line", `${num(r.releases)} new ones in the last ${t.supplyWindow} days (${num(r.releasesYearAgo)} a year ago): ${growthWords(r.supply)}.`));
  return h("div",
    section("Niches where games often become hits",
      `A hit is a game in the top 10% by reviews among the games released the same fortnight, so new and old games are compared fairly. On Steam as a whole, ${oneIn(t.baseHitRate)} new games become one. A niche here is a user tag among a game's five strongest. Ranked by hit chance, pulled toward Steam's average when a tag has few games (as if it also had ${t.priorGames || PRIOR} ordinary games), so a tag with a lucky handful can't top the list. "Solid" means 100+ games behind the number, "likely" 40+, "thin data" fewer.`,
      h("div.mb-controls",
        seg([["odds", "Best hit chance"], ["typical", "Most reviews for a typical game"], ["growing", "Good odds, growing fastest"], ["quiet", "Good odds, least crowded"]], st.sort, (v) => { st.sort = v; st.shown = 6; save("sort", v); }, "Sort niches"),
        toggle("Small-team niches only", st.small, () => { st.small = !st.small; save("small", st.small); }),
        h("input.mb-input", { type: "search", "data-key": "niche-q", value: st.q, placeholder: "Find a tag to compare", "aria-label": "Find a tag", oninput: (e) => { st.q = e.target.value; redrawKeeping(e); } })),
      st.small ? h("p.mb-small", `Small-team niches only: leaves out tags that mean a big build (${[...HUGE, ...BIG].join(", ")}).`) : null,
      rows.length ? h("div.mb-cards", ...rows.slice(0, q ? 12 : st.shown).map(card)) : h("p.mb-note", "No tag matches."),
      q ? null : more(st.shown, rows.length, () => { st.shown += 6; }),
      compareTable(all, t)),
    gapSection());
}

function compareTable(rows, t) {
  const h = C.h;
  return h("details.mb-details", h("summary", `Compare all ${rows.length} niches in one table`),
    h("div.mb-scroll", h("table.mb-table",
      h("thead", h("tr", ...["Niche", "Hit chance", "Sure?", "Games counted", "Typical game", "Top 10%", `New (${t.supplyWindow} days)`, "Vs Steam"].map((x) => h("th", x)))),
      h("tbody", ...rows.map((r) => h("tr", h("td", r.name), h("td", `${pct(r.hitRate)} (${oneIn(r.hitRate)})`), h("td", r.conf), h("td", num(r.hitGames)),
        h("td", `${num(r.medianReviews)} reviews`), h("td", `${num(r.topReviews)} reviews`), h("td", num(r.releases)), h("td", growthWords(r.supply))))))));
}

function gapSection() {
  const h = C.h;
  if (st.errors.games) return section("Tag pairs: the gap finder", null, h("p.mb-note", st.errors.games, " ", btn("Try again", () => load(["games"]))));
  if (!st.files.games) return section("Tag pairs: the gap finder", null, h("p.mb-note", "Loading three years of releases (a few MB, once)…"));
  const names = tagNames();
  const mustId = st.must ? tagSets(names).byName.get(st.must.trim().toLowerCase()) ?? null : null;
  const key = `gap:${st.goal}:${st.target}:${st.pairs}:${st.small}:${mustId}`;
  const res = memo(key, () => gapFinder(gamesList(), names, { today: today(), goal: st.goal, target: st.target, pairs: st.pairs, small: st.small, must: mustId }));
  const goalWord = st.goal === "hit" ? "became a hit" : `earned about ${usd(st.target)}`;
  const max = Math.max(0.3, ...res.rows.slice(0, 30).map((r) => r.adj));
  const row = (r) => h("article.mb-gap",
    h("div.mb-card-head", h("h3", r.name), confPill(r.conf)),
    h("p.mb-line.mb-strong", `${num(r.wins)} of ${num(r.n)} ${goalWord}: about ${oneIn(r.adj)} allowing for chance, ${times(r.lift)} the average (${oneIn(res.base)}).`),
    oddsBar(r.adj, res.base, max),
    h("p.mb-line", `Typical game: ${plural(r.medianReviews, "review")}. ${num(r.recent)} new ones in the last 90 days${r.growth != null ? `, ${growthWords(r.growth)}` : ""}. Biggest: `, link(storeUrl(r.best.appid), r.best.name), ` (${num(r.best.reviews)} reviews).`));
  return section("Tag pairs: the gap finder",
    `Combinations of a game's strongest tags, with how often games like that ${st.goal === "hit" ? "became hits (released 2 weeks to 6 months ago)" : `earned the goal (paid games released 2 months to 2 years ago; earned = reviews × ${SALES_PER_REVIEW} sales a review × price × ${NET_SHARE} kept after Steam's cut, VAT and refunds)`}. A pair needs ${MIN_PAIR}+ games to show, and every rate is pulled toward the average as if it also had ${PRIOR} ordinary games, so "dwarves + fishing" with 3 lucky games isn't called a gap.`,
    h("div.mb-controls",
      seg([["hit", "Goal: become a hit"], ["money", "Goal: earn"]], st.goal, (v) => { st.goal = v; st.gapShown = 8; save("goal", v); }, "Goal"),
      st.goal === "money" ? h("label.mb-field", h("span", "at least $"), h("input.mb-input.mb-num", { type: "number", min: 1000, step: 5000, value: st.target, "data-key": "gap-target", "aria-label": "Target revenue in dollars",
        onchange: (e) => { const v = Number(e.target.value); if (v > 0) { st.target = v; save("target", String(v)); redrawKeeping(e); } } })) : null,
      seg([[true, "Tag pairs"], [false, "Single tags"]], st.pairs, (v) => { st.pairs = v; st.gapShown = 8; save("pairs", v); }, "Niche size"),
      h("input.mb-input", { list: "mb-tags", "data-key": "gap-must", value: st.must, placeholder: "Must include a tag…", "aria-label": "Must include a tag",
        onchange: (e) => { st.must = e.target.value; st.gapShown = 8; redrawKeeping(e); } }),
      h("datalist", { id: "mb-tags" }, ...Object.values(names).sort().map((n) => h("option", { value: n })))),
    h("p.mb-small", `${num(res.pool)} comparable games${mustId != null ? ` with ${names[mustId]}` : ""}; ${num(res.wins)} of them ${goalWord} (${pct(res.base, 1)}). ${num(res.rows.length)} niches have enough games to judge.`),
    res.rows.length ? h("div.mb-gaps", ...res.rows.slice(0, st.gapShown).map(row)) : h("p.mb-note", "Not enough games for these settings: take a tag away, switch to single tags or lower the goal."),
    more(st.gapShown, res.rows.length, () => { st.gapShown += 8; }));
}

// --- 2. Who should I sign? ---------------------------------------------------------------

function leadText(g, released) {
  return released
    ? [`${g.name} (${storeUrl(g.appid)})`, `Developer: ${g.developers.join(", ") || "?"}; ${g.selfPublished ? "self-published" : `publisher: ${g.publishers.join(", ")}`}`, `Released ${dayDate(g.day)}; ${g.reviews} reviews, ${g.pos}% positive`, `Why: ${g.reason}`].join("\n")
    : [`${g.name} (${storeUrl(g.appid)})`, `Developer: ${g.devs.join(", ") || "?"}; ${g.deal === "self" ? "self-published" : `publisher: ${g.pubs.join(", ")}`}`, `Release: ${releaseText(g.day, g.display)}`, `Why: ${g.reason}`].join("\n");
}

function leadCard(g, released) {
  const h = C.h;
  const devs = released ? g.developers : g.devs;
  const tags = g.tags.filter((t) => t !== INDIE).slice(0, 4).map((t) => tagNames()[t]).filter(Boolean).join(" · ");
  return h("article.mb-lead",
    h("div.mb-card-head", h("h3", link(storeUrl(g.appid), g.name)), h("span.mb-score", { title: "Lead score out of 100" }, `${g.score}`)),
    h("p.mb-line.mb-who", `by ${devs.join(", ") || "unknown studio"}`, tags ? ` · ${tags}` : ""),
    h("p.mb-big.mb-reason", g.reason),
    h("div.mb-actions", link(storeUrl(g.appid), "Store page ↗"), devs[0] ? link(devUrl(devs[0]), "The studio's games ↗") : null,
      btn("Copy for Claude", (e) => C.copy(leadText(g, released), e.currentTarget))));
}

function signView() {
  const h = C.h;
  const up = upLeads(st.godotOnly);
  const open = up.filter((g) => g.deal !== "published");
  const rel = relLeads();
  const published = publishedGodot(st.files.godot.games);
  const upPub = up.filter((g) => g.deal === "published");
  return h("div",
    section("Coming soon: sign them before they ship",
      `Games not out yet, the best leads first. Score out of 100: self-published (30) or on a tiny label (14), made with Godot (20), coming out soon (up to 15), in a niche where games often become hits (up to 15), a studio whose earlier game did well (up to 15), a demo out (6). Steam doesn't show wishlists, so they can't count.`,
      h("div.mb-controls", toggle("Godot games only", st.godotOnly, () => { st.godotOnly = !st.godotOnly; st.upShown = 8; save("godotOnly", st.godotOnly); })),
      st.godotOnly ? null : h("p.mb-small", "All engines: Godot isn't detected for most games yet, so check the engine on the store page."),
      h("p.mb-small", `${num(open.length)} ${st.godotOnly ? "Godot " : ""}games coming without a big publisher.`),
      open.length ? h("div.mb-leads", ...open.slice(0, st.upShown).map((g) => leadCard(g, false))) : h("p.mb-note", "None right now."),
      more(st.upShown, open.length, () => { st.upShown += 8; })),
    section("Released: well liked, still small",
      "Self-published (or tiny-label) Godot games from the last two years, 75%+ positive, that could reach more players: few languages, no Mac or Linux build, no Steam Deck rating. Ranked by how well liked, how much room there is to grow, and how recent.",
      rel.length ? h("div.mb-leads", ...rel.slice(0, st.relShown).map((g) => leadCard(g, true))) : h("p.mb-note", "None right now."),
      more(st.relShown, rel.length, () => { st.relShown += 6; })),
    h("details.mb-details",
      h("summary", `Already published: ${num(published.length + (st.godotOnly ? 0 : upPub.length))} games with a real publisher (3+ games), probably not ours to sign`),
      h("div.mb-scroll", h("table.mb-table",
        h("thead", h("tr", ...["Game", "Studio", "Publisher", "Status"].map((x) => h("th", x)))),
        h("tbody", ...published.slice(0, 80).map((g) => h("tr", h("td", link(storeUrl(g.appid), g.name)), h("td", g.developers.join(", ")),
          h("td", `${g.publishers.join(", ")} (${num(g.publisherGames)} games)`),
          h("td", g.comingSoon ? `coming ${g.releaseDisplay || "soon"}` : `${num(g.reviews)} reviews, ${g.pos ?? "?"}%`))))))));
}

// --- 3. How is Steam doing? ------------------------------------------------------------

function steamView() {
  const h = C.h, g = st.files.growth, s = growthNow();
  if (!s) return h("p.mb-note", "No player numbers yet.");
  const chart1 = lineChart({
    labels: s.years.map(String), yLabel: `${s.years[0]} = 100`, fmt: (v) => v == null ? "–" : String(Math.round(v)),
    series: [
      { name: "Games released", color: "var(--sw-1)", values: s.relIdx, raw: s.rel, rawFmt: (v) => `${num(v)} games` },
      { name: "Steam's peak players", color: "var(--sw-3)", values: s.usersIdx, raw: s.users, rawFmt: (v) => `${short(v)} players` },
    ],
    note: s.partial ? `${s.years.at(-1)} is this year's pace for a whole year.` : null,
  });
  // The second chart: one tag's share of releases vs of reviews.
  const names = tagNames();
  if (!st.shareTag || !g.tags[st.shareTag]) {
    const best = st.files.trends ? rankNiches(st.files.trends, names, { small: true }).find((r) => r.conf !== "thin data" && g.tags[r.tag]) : null;
    st.shareTag = best ? String(best.tag) : Object.keys(g.tags)[0];
  }
  const share = tagShare(g, st.shareTag);
  const chart2 = share ? lineChart({
    labels: share.years.map(String), yLabel: "share of the year", fmt: (v) => v == null ? "–" : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`,
    series: [
      { name: "Share of games released", color: "var(--sw-1)", values: share.rel },
      { name: "Share of reviews", color: "var(--sw-2)", values: share.rev },
    ],
  }) : null;
  const pool = Object.entries(g.tags).map(([id, t]) => [id, t.name]).sort((a, b) => a[1].localeCompare(b[1]));
  return h("div",
    section("More games, or more players?", null,
      h("p.mb-big", s.sentence),
      chartCard(chart1),
      h("details.mb-details", h("summary", "Where the player numbers come from"),
        h("p.mb-line", "Steam's all-time record of users online at once as of each year's end, as Valve reported it at the time (quoted in the press). From November 2026 the server keeps each day's peak from Steam's own stats feed."),
        h("ul.mb-sources", ...(g.users.records || []).map((r) => h("li", `${r.date}: ${short(r.users)} `, link(r.source, "source")))))),
    share ? section("Is a niche over- or under-made?",
      "One tag's share of each year's new games next to its share of the reviews those games got. When the reviews line runs above the games line, players want more of it than developers make.",
      h("div.mb-controls", h("label.mb-field", h("span", "Tag"),
        h("input.mb-input", { list: "mb-share-tags", value: share.name, "aria-label": "Pick a tag", "data-key": "share-tag",
          onchange: (e) => { const hit = pool.find(([, n]) => n.toLowerCase() === e.target.value.trim().toLowerCase()); if (hit) { st.shareTag = hit[0]; save("shareTag", hit[0]); } redrawKeeping(e); } }),
        h("datalist", { id: "mb-share-tags" }, ...pool.map(([, n]) => h("option", { value: n }))))),
      h("p.mb-big", share.sentence),
      chartCard(chart2)) : null);
}

// --- Charts ----------------------------------------------------------------------------

function chartCard(chart) {
  const card = C.h("div.mb-chart", chart.legend, chart.svg, chart.tip, chart.note ? C.h("p.mb-small", chart.note) : null, chart.table);
  chart.attach(card);
  return card;
}

// Lines over evenly spaced labels, labeled at their ends, with a crosshair readout and a data table.
function lineChart({ labels, series, fmt, yLabel, note }) {
  const h = C.h, svgEl = C.svgEl;
  const W = 760, H = 300, M = { top: 18, right: 150, bottom: 34, left: 56 };
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const max = niceMax(Math.max(...vals, 0) * 1.05 || 1);
  const n = labels.length;
  const x = (i) => M.left + (n === 1 ? 0 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mb-svg", role: "img", "aria-label": series.map((s) => s.name).join(" and ") });
  const text = (attrs, s) => { const t = svgEl("text", attrs); t.textContent = s; svg.append(t); return t; };
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mb-grid" : "mb-base" }));
    text({ x: M.left - 8, y: y(v) + 4, "text-anchor": "end", class: "mb-axis" }, fmt(v));
  }
  text({ x: M.left, y: 12, class: "mb-axis mb-axis-title" }, yLabel || "");
  const every = Math.max(1, Math.ceil(n / 9));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) text({ x: x(i), y: H - 10, "text-anchor": "middle", class: "mb-axis" }, l); });
  // End labels, pushed apart when they'd overlap.
  const ends = series.map((s) => { const i = s.values.findLastIndex((v) => v != null); return { s, i, y: y(s.values[i]) }; }).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 30) ends[k].y = ends[k - 1].y + 30;
  for (const s of series) {
    let d = "";
    s.values.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  for (const e of ends) {
    svg.append(svgEl("circle", { cx: x(e.i), cy: y(e.s.values[e.i]), r: 4, fill: e.s.color, stroke: "var(--fb-card)", "stroke-width": 2 }));
    text({ x: x(e.i) + 10, y: e.y + 4, class: "mb-endlabel" }, `${fmt(e.s.values[e.i])}`);
    text({ x: x(e.i) + 10, y: e.y + 19, class: "mb-endname" }, e.s.name);
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "mb-cross", visibility: "hidden" });
  const dots = series.map((s) => svgEl("circle", { r: 5, fill: s.color, stroke: "var(--fb-card)", "stroke-width": 2, visibility: "hidden" }));
  svg.append(cross, ...dots);
  const tip = h("div.mb-tip", { role: "status" });
  const legend = h("div.mb-legend", ...series.map((s) => h("span", h("i", { style: `background:${s.color}` }), s.name)));
  const table = h("details.mb-details", h("summary", "Data table"), h("div.mb-scroll", h("table.mb-table",
    h("thead", h("tr", h("th", ""), ...series.map((s) => h("th", s.name)))),
    h("tbody", ...labels.map((l, i) => h("tr", h("td", l), ...series.map((s) => h("td", fmt(s.values[i]), s.raw ? ` (${s.rawFmt(s.raw[i])})` : "")))).reverse()))));
  return {
    svg, tip, legend, table, note,
    attach(card) {
      const move = (ev) => {
        const box = svg.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        series.forEach((s, k) => { const v = s.values[i]; dots[k].setAttribute("visibility", v == null ? "hidden" : "visible"); if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); } });
        tip.replaceChildren(h("div.mb-tip-t", labels[i]), ...series.map((s) => h("div", h("i", { style: `background:${s.color}` }), h("b", fmt(s.values[i])), ` ${s.name}`, s.raw ? h("span.mb-tip-raw", ` · ${s.rawFmt(s.raw[i])}`) : null)));
        tip.style.display = "block";
        const cbox = card.getBoundingClientRect();
        let left = box.left - cbox.left + (x(i) / W) * box.width + 14;
        if (left + tip.offsetWidth > cbox.width - 8) left -= tip.offsetWidth + 28;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${box.top - cbox.top + 10}px`;
      };
      const hide = () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerdown", move);
      svg.addEventListener("pointerleave", hide);
    },
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}

// --- Style -----------------------------------------------------------------------------

const CSS = `
.mkv-brief { color: var(--fb-ink); font-size: 16px; line-height: 1.6; max-width: 960px; margin: 0 auto; padding-bottom: 40px; }
.mkv-brief *, .mkv-brief *::before, .mkv-brief *::after { box-sizing: border-box; }
.mkv-brief h2 { font-size: 1.45rem; line-height: 1.3; margin: 0 0 6px; color: var(--fb-title); font-weight: 700; }
.mkv-brief h3 { font-size: 1.15rem; line-height: 1.35; margin: 0; color: var(--fb-title); font-weight: 650; overflow-wrap: anywhere; }
.mkv-brief p { margin: 0; }
.mkv-brief a.mb-link { color: var(--fb-link); text-decoration: none; }
.mkv-brief a.mb-link:hover { text-decoration: underline; }
.mkv-brief .mb-sub { color: var(--fb-ink-2); max-width: 70ch; margin-bottom: 18px; }
.mkv-brief .mb-small { color: var(--fb-muted); font-size: 0.92rem; margin: 10px 0 14px; max-width: 75ch; }
.mkv-brief .mb-note { color: var(--fb-ink-2); padding: 24px 0; }
.mkv-brief .mb-foot { color: var(--fb-muted); font-size: 0.85rem; margin-top: 40px; border-top: 1px solid var(--fb-line); padding-top: 14px; }
.mkv-brief .mb-big { font-size: 1.16rem; line-height: 1.55; color: var(--fb-ink); margin: 10px 0 12px; max-width: 68ch; }
.mkv-brief .mb-line { color: var(--fb-ink-2); margin-top: 6px; }
.mkv-brief .mb-strong { color: var(--fb-ink); font-weight: 550; }

.mkv-brief .mb-today { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 18px; padding: 24px 26px; margin: 4px 0 28px; }
.mkv-brief .mb-today-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 8px; }
.mkv-brief .mb-today-head .mb-sub { margin: 0; }
.mkv-brief .mb-today-list { list-style: none; margin: 0; padding: 0; }
.mkv-brief .mb-today-list li { display: grid; grid-template-columns: 92px 1fr; gap: 14px; padding: 14px 0; border-top: 1px solid var(--fb-line); font-size: 1.06rem; line-height: 1.55; }
.mkv-brief .mb-today-list li:first-child { border-top: 0; }
.mkv-brief .mb-kind { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fb-muted); padding-top: 4px; }
.mkv-brief .mb-kind.k-niche { color: var(--sw-1); }
.mkv-brief .mb-kind.k-lead { color: var(--fb-good-text); }
.mkv-brief .mb-kind.k-breakout { color: var(--fb-warning); }
.mkv-brief .mb-today-text a { margin-left: 4px; white-space: nowrap; }

.mkv-brief .mb-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 32px; }
.mkv-brief .mb-tab { display: grid; grid-template-columns: auto 1fr; column-gap: 12px; text-align: left; padding: 16px 18px; border-radius: 14px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; cursor: pointer; }
.mkv-brief .mb-tab:hover { background: var(--fb-hover); }
.mkv-brief .mb-tab[aria-selected="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-brief .mb-tab-n { grid-row: span 2; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--fb-card-2); color: var(--fb-ink-2); font-weight: 700; font-size: 0.9rem; }
.mkv-brief .mb-tab[aria-selected="true"] .mb-tab-n { background: var(--fb-accent); color: var(--fb-card); }
.mkv-brief .mb-tab-q { font-weight: 700; font-size: 1.04rem; line-height: 1.3; color: var(--fb-title); }
.mkv-brief .mb-tab-sub { color: var(--fb-muted); font-size: 0.88rem; line-height: 1.35; margin-top: 2px; }

.mkv-brief .mb-section { margin: 0 0 48px; }
.mkv-brief .mb-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 4px 0 12px; }
.mkv-brief .mb-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--fb-line); border-radius: 10px; overflow: hidden; background: var(--fb-card); }
.mkv-brief .mb-seg button { font: inherit; font-size: 0.92rem; padding: 7px 12px; border: 0; background: transparent; color: var(--fb-ink-2); cursor: pointer; border-right: 1px solid var(--fb-line); }
.mkv-brief .mb-seg button:last-child { border-right: 0; }
.mkv-brief .mb-seg button[aria-pressed="true"] { background: var(--fb-accent); color: var(--fb-card); font-weight: 600; }
.mkv-brief .mb-toggle, .mkv-brief .mb-btn { font: inherit; font-size: 0.92rem; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
.mkv-brief .mb-toggle:hover, .mkv-brief .mb-btn:hover { background: var(--fb-hover); }
.mkv-brief .mb-check { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid var(--fb-muted); display: inline-grid; place-items: center; font-size: 11px; line-height: 1; }
.mkv-brief .mb-toggle[aria-pressed="true"] .mb-check { background: var(--fb-accent); border-color: var(--fb-accent); color: var(--fb-card); }
.mkv-brief .mb-btn.mb-inline { padding: 1px 10px; font-size: 0.85rem; margin-left: 6px; vertical-align: 1px; }
.mkv-brief .mb-btn.mb-more { margin-top: 16px; }
.mkv-brief .mb-input { font: inherit; font-size: 0.95rem; padding: 7px 12px; border-radius: 10px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); min-width: 0; width: 220px; max-width: 100%; }
.mkv-brief .mb-num { width: 120px; }
.mkv-brief .mb-field { display: inline-flex; align-items: center; gap: 8px; color: var(--fb-ink-2); font-size: 0.95rem; }

.mkv-brief .mb-cards, .mkv-brief .mb-gaps, .mkv-brief .mb-leads { display: grid; gap: 16px; }
.mkv-brief .mb-cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); }
.mkv-brief .mb-card, .mkv-brief .mb-gap, .mkv-brief .mb-lead { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 16px; padding: 20px 22px; min-width: 0; }
.mkv-brief .mb-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mkv-brief .mb-card-head h3 { flex: 1 1 auto; min-width: 0; }
.mkv-brief .mb-rank { color: var(--fb-muted); font-weight: 700; font-size: 0.95rem; }
.mkv-brief .mb-score { font-weight: 700; color: var(--fb-ink-2); background: var(--fb-card-2); border-radius: 999px; padding: 2px 10px; font-size: 0.9rem; }
.mkv-brief .mb-conf { font-size: 0.78rem; font-weight: 650; border-radius: 999px; padding: 2px 10px; border: 1px solid currentColor; white-space: nowrap; }
.mkv-brief .mb-conf.is-solid { color: var(--fb-good-text); }
.mkv-brief .mb-conf.is-likely { color: var(--fb-ink-2); }
.mkv-brief .mb-conf.is-thin { color: var(--fb-warning); }
.mkv-brief .mb-oddsrow { display: grid; gap: 6px; margin: 4px 0 8px; }
.mkv-brief .mb-bar { position: relative; height: 10px; border-radius: 5px; background: var(--fb-card-2); }
.mkv-brief .mb-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 5px; background: var(--sw-1); }
.mkv-brief .mb-bar > b { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--fb-ink); }
.mkv-brief .mb-barlabel { font-size: 0.88rem; color: var(--fb-muted); }
.mkv-brief .mb-barlabel strong { color: var(--fb-ink); }
.mkv-brief .mb-who { margin-top: 2px; font-size: 0.93rem; }
.mkv-brief .mb-reason { font-size: 1.08rem; }
.mkv-brief .mb-actions { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin-top: 8px; font-size: 0.95rem; }

.mkv-brief .mb-details { margin-top: 18px; }
.mkv-brief .mb-details > summary { cursor: pointer; color: var(--fb-link); font-size: 0.95rem; padding: 6px 0; }
.mkv-brief .mb-scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
.mkv-brief .mb-table { border-collapse: collapse; width: 100%; font-size: 0.92rem; margin-top: 8px; }
.mkv-brief .mb-table th { text-align: left; color: var(--fb-muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; }
.mkv-brief .mb-table td { padding: 8px 10px; border-bottom: 1px solid var(--fb-line); color: var(--fb-ink); white-space: nowrap; }
.mkv-brief .mb-sources { color: var(--fb-ink-2); font-size: 0.9rem; padding-left: 20px; }

.mkv-brief .mb-chart { position: relative; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 16px; padding: 18px 18px 10px; margin-top: 8px; }
.mkv-brief .mb-svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
.mkv-brief .mb-grid { stroke: var(--fb-line); stroke-width: 1; }
.mkv-brief .mb-base { stroke: var(--fb-muted); stroke-width: 1; }
.mkv-brief .mb-cross { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.mkv-brief .mb-axis { fill: var(--fb-muted); font-size: 13px; }
.mkv-brief .mb-axis-title { font-weight: 600; }
.mkv-brief .mb-endlabel { fill: var(--fb-ink); font-size: 15px; font-weight: 700; }
.mkv-brief .mb-endname { fill: var(--fb-ink-2); font-size: 12.5px; }
.mkv-brief .mb-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 0.92rem; color: var(--fb-ink-2); margin-bottom: 8px; }
.mkv-brief .mb-legend i, .mkv-brief .mb-tip i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.mkv-brief .mb-tip { display: none; position: absolute; pointer-events: none; z-index: 5; background: var(--fb-card); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 10px; padding: 8px 12px; font-size: 0.88rem; line-height: 1.5; box-shadow: 0 6px 20px rgba(0,0,0,0.18); white-space: nowrap; }
.mkv-brief .mb-tip-t { font-weight: 700; margin-bottom: 2px; }
.mkv-brief .mb-tip-raw { color: var(--fb-muted); }

@media (max-width: 720px) {
  .mkv-brief .mb-tabs { grid-template-columns: 1fr; }
  .mkv-brief .mb-today { padding: 18px 16px; }
  .mkv-brief .mb-today-list li { grid-template-columns: 1fr; gap: 2px; }
  .mkv-brief .mb-card, .mkv-brief .mb-gap, .mkv-brief .mb-lead { padding: 16px; }
  .mkv-brief .mb-big { font-size: 1.06rem; }
  .mkv-brief .mb-input { width: 100%; }
  .mkv-brief .mb-chart { padding: 12px 8px 6px; }
}
`;

function injectStyle() {
  if (document.getElementById("mk-brief-style")) return;
  const el = document.createElement("style");
  el.id = "mk-brief-style";
  el.textContent = CSS;
  document.head.append(el);
}

export const _test = { oneIn, confidence, rankNiches, unpackGames, gapFinder, unpackUpcoming, upcomingLeads, releasedLeads, publishedGodot, steamGrowth, tagShare, todayItems };
