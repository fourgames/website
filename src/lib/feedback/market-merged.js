// The dashboard's Market section, final merged design: the Briefing layout (a "Today" summary in
// sentences, then three big question tabs) with the best parts of the other designs:
//   1. What should I make next?  every tag as a dot (crowding vs hit rate; click one to jump to its
//      card), niche cards in sentences with "how sure" as a word plus a ± range, and the tag-pair gap
//      finder as cards or a table with a gap score.
//   2. Who should I sign?        market-sign.js (its own state and CSS).
//   3. How is Steam doing?       games released vs Steam's peak players (this year as a dashed pace),
//      what's doing well right now (releases by hit index), and all of today's alerts, folded.
// Same contract as market.js: marketTop(ctx) fills the header, marketView(ctx) returns one root that
// redraws itself. The data files come from server/steamdata/market.py.

import { signView } from "./market-sign.js";

const DAY = 86400;
const PREFIX = "mkv-merged-";
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
// Joke and crude games (e.g. "Penis Bird") stay out of the Today box and sink to the end of the alerts.
const CRUDE = /\b(penis|dick|cock|boobs?|tits|butt|fart|poop|hentai|waifu|sex|sexy|nsfw|porn|nude|horny|manhole|wiener|weiner)\b/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TABS = [
  ["make", "What should I make next?", "Niches where games often become hits"],
  ["sign", "Who should I sign?", "Self-published games worth a message"],
  ["steam", "How is Steam doing?", "Games vs players, what's working now"],
];
const F = { linux: 1, mac: 2, deckOk: 4, godot: 64, demo: 128, self: 256 };

// ---------------------------------------------------------------------------
// Plain helpers (no DOM): also used by the smoke test
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const short = (n) => n == null ? "–" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)} million` : num(n);
const fmtK = (n) => n == null || !Number.isFinite(n) ? "–" : Math.abs(n) < 1000 ? String(Math.round(n)) : Math.abs(n) < 1e6 ? `${+(n / 1000).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const pct = (x, d = 0) => x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null || !Number.isFinite(x) ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const usd = (n) => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const money = (c) => c == null ? "–" : c === 0 ? "Free" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const dayShort = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };
export const isJoke = (name) => CRUDE.test(name || "");

// "1 in 4": a share said the way people say it.
export function oneIn(p) {
  if (p == null) return "–";
  if (p >= 0.5) return p >= 0.7 ? "most" : "more than half";
  if (p <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / p))}`;
}
// How sure: by how many games the number stands on.
export function confidence(n) { return n >= 100 ? "solid" : n >= 40 ? "likely" : "thin data"; }
// A rough 90% range for a shrunk rate (as a fraction; ×100 for percentage points).
export const spread = (p, n) => 1.64 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / (n + PRIOR));
// "likely · ±7 pts": the word and the range together.
export const sureLabel = (p, n) => `${confidence(n)} · ±${Math.max(1, Math.round(spread(p, n) * 100))} pts`;
// A tag's releases as a share of Steam's, against a year ago.
function growthWords(supply) {
  if (supply == null) return "no year-ago count";
  if (supply >= 2) return "growing much faster than Steam";
  if (supply >= 1.15) return "growing faster than Steam";
  if (supply >= 0.87) return "growing with Steam";
  if (supply >= 0.6) return "growing slower than Steam";
  return "losing ground on Steam";
}
const growthDir = (supply) => supply == null ? 0 : supply >= 1.1 ? 1 : supply <= 0.9 ? -1 : 0;
// An upcoming game's release date from its day number, as precise as the store's kind of date says.
// `kind` (release_display) is "date_full", "date_month", "date_quarter" or "date_year": never shown as is.
function releaseText(day, kind) {
  if (day == null) return kind && !String(kind).startsWith("date_") ? String(kind).toLowerCase() : "no date yet";
  const t = new Date(day * DAY * 1000), y = t.getUTCFullYear();
  if (kind === "date_year") return `sometime in ${y}`;
  if (kind === "date_quarter") return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${y}`;
  if (kind === "date_month") return `${MONTHS[t.getUTCMonth()]} ${y}`;
  return dayDate(day);
}

const tagSets = (tagNames) => {
  const byName = new Map(Object.entries(tagNames || {}).map(([id, n]) => [n.trim().toLowerCase(), Number(id)]));
  const ids = (list) => new Set(list.map((n) => byName.get(n.toLowerCase())).filter((x) => x != null));
  return { big: ids([...HUGE, ...BIG]), adult: ids(ADULT), meta: ids(META), byName };
};

// --- 1. Niches from trends.json -------------------------------------------------

// Every tag with a hit rate, best first. trends.hitRate is already pulled toward Steam's rate (as if
// the tag also had `priorGames` average games), so a tag with a handful of games can't top the list.
export function rankNiches(trends, tagNames, { small = true, sort = "odds" } = {}) {
  const s = tagSets(tagNames);
  const rows = (trends.tags || []).filter((r) => r.hitRate != null && r.hitGames >= MIN_SINGLE && !s.meta.has(r.tag) && !s.adult.has(r.tag) && (!small || !s.big.has(r.tag)))
    .map((r) => ({ ...r, conf: confidence(r.hitGames), sure: sureLabel(r.hitRate, r.hitGames), range: spread(r.hitRate, r.hitGames), lift: r.hitLift ?? r.hitRate / trends.baseHitRate, dir: growthDir(r.supply) }));
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
  return file.rows.map((r) => {
    const tags = r[col.tags] || [];
    return {
      appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price] || 0, reviews: r[col.reviews] || 0,
      pos: r[col.pos], top: tags.slice(0, top), indie: tags.includes(INDIE), flags: r[col.flags] || 0, hit: r[col.hit],
    };
  });
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
      raw: e.wins / e.n, adj, lift: adj / base, conf: confidence(e.n), sure: sureLabel(adj, e.n), medianReviews: median(e.reviews), best: e.best,
      recent: r, growth: agoAll && recentAll ? ((r + 1) / recentAll) / ((a + 1) / agoAll) : null,
    };
  }).sort((x, y) => y.lift - x.lift);
  return { base, pool: n, wins, rows };
}

// The table's extra columns. gap: how much better than average per unit of crowding (log of the
// releases in the last 90 days), as in the Analyst design; bonus: the pair against the better of its
// two tags alone, judged on the same games and goal (null for single tags).
export function withGapScores(res, singles) {
  const single = new Map((singles?.rows || []).map((r) => [r.k, r.adj]));
  return res.rows.map((r) => {
    const parts = r.k.includes("+") ? r.k.split("+").map((k) => single.get(k) ?? res.base) : null;
    return { ...r, gap: r.lift / Math.log10(10 + r.recent), bonus: parts ? r.adj / Math.max(...parts) : null };
  });
}

// --- Leads for the Today box (the full "who to sign" view lives in market-sign.js) ----------

export function unpackUpcoming(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  return file.rows.map((r) => ({
    appid: r[col.appid], name: r[col.name], day: r[col.day], display: r[col.display], price: r[col.price],
    tags: r[col.tags] || [], flags: r[col.flags] || 0, langs: r[col.langs], devs: r[col.devs] || [], pubs: r[col.pubs] || [],
    devGames: r[col.devGames] || 0, devBest: r[col.devBest] || 0, devReviews: r[col.devReviews] || 0, pubGames: r[col.pubGames] || 0,
  }));
}

function hotTag(tags, hot) {
  let best = null;
  for (const t of tags.slice(0, 5)) { const r = hot.get(t); if (r && r.lift >= 1.4 && (!best || r.lift > best.lift)) best = r; }
  return best;
}
const hotMap = (trends) => new Map((trends?.tags || []).filter((r) => r.hitRate != null && r.tag !== INDIE).map((r) => [r.tag, { tag: r.tag, name: r.name, lift: r.hitLift, rate: r.hitRate }]));

// Upcoming games, the ones worth a message first. "self": no outside publisher; "label": a small one
// (1–2 games); "published": a real publisher (3+ games). Joke games are left out.
export function upcomingLeads(list, trends, today, { godotOnly = true, tagNames = {} } = {}) {
  const hot = hotMap(trends), adult = tagSets(tagNames).adult;
  return list.filter((g) => (!godotOnly || g.flags & F.godot) && !isJoke(g.name) && !g.tags.some((t) => adult.has(t))).map((g) => {
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
export function releasedLeads(godot, today, tagNames = {}) {
  const adult = tagSets(tagNames).adult;
  return godot.filter((g) => !g.comingSoon && g.day != null && today - g.day <= 730 && g.reviews >= 10 && g.pos != null && g.pos >= 75
    && (g.selfPublished || g.publisherGames <= 2) && !isJoke(g.name) && !(g.tags || []).some((t) => adult.has(t))).map((g) => {
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

// --- 3. Steam's growth, releases and alerts ------------------------------------------

export function steamGrowth(g) {
  if (!g?.users?.y) return null;
  const first = Math.max(g.years.indexOf(2018), g.users.y.findIndex((v) => v != null));
  if (first < 0) return null;
  const last = g.years.length - 1;
  const partial = g.yearDone > 0 && g.yearDone < 1;
  const rel = g.total.y.map((n, i) => i === last && partial ? n / g.yearDone : n).slice(first);
  const users = g.users.y.slice(first);
  const years = g.years.slice(first);
  const idx = (xs) => xs.map((v) => v == null ? null : (v / xs[0]) * 100);
  const lastUsers = users.filter((v) => v != null).at(-1);
  const gr = rel.at(-1) / rel[0], ur = lastUsers / users[0], per = ur / gr;
  const sentence = `Since ${years[0]}, the number of games released a year has grown ${times(gr)} (${num(rel[0])} to about ${num(rel.at(-1))} at this year's pace), while Steam's peak players grew ${times(ur)} (${short(users[0])} to ${short(lastUsers)}). `
    + (per < 0.95 ? `Games are arriving faster than players: each new game now shares the crowd with about ${pct(1 - per)} fewer players than in ${years[0]}.`
      : per > 1.05 ? `Players are arriving faster than games: about ${pct(per - 1)} more players per new game than in ${years[0]}.` : `Players and games have grown about as fast as each other.`);
  return { years, rel, users, relIdx: idx(rel), usersIdx: idx(users), gr, ur, per, sentence, partial, sofar: g.total.y.at(-1) };
}

// Recent releases ranked by the hit index (review-count percentile among games out within ±7 days).
export function releasesList(list, today, { days = 30, indie = true, self = false, godot = false, adult = false } = {}, adultIds = new Set()) {
  return list.filter((g) => today - g.day <= days && today - g.day >= 0 && g.hit != null && (!indie || g.indie) && (!self || g.flags & F.self) && (!godot || g.flags & F.godot)
    && (adult || (!g.top.some((t) => adultIds.has(t)) && !isJoke(g.name))))
    .sort((a, b) => b.hit - a.hit || b.reviews - a.reviews);
}

// The alerts, ranked for a publisher: rising niches first (what to make), then self-published Godot
// games (who to sign), then breakouts (worth a look), then Godot games that already have a publisher.
export function rankAlerts(trends, godotGames) {
  const gd = new Map((godotGames || []).map((g) => [g.appid, g]));
  const tm = new Map((trends.tags || []).map((t) => [t.tag, t]));
  const out = [];
  for (const a of trends.alerts || []) {
    if (a.kind === "tag") {
      const t = tm.get(a.tag);
      out.push({ ...a, group: 0, label: "Rising niche", head: t?.name || a.title,
        plain: t ? `${num(t.releases)} games out in the last 90 days, ${times(t.supply)} its share of releases a year ago, and its games become hits ${times(t.hitLift)} as often as Steam's (${t.hitRate != null ? sureLabel(t.hitRate, t.hitGames) : "no hit rate yet"}).` : a.detail });
    } else if (a.kind === "godot") {
      const g = gd.get(a.appid);
      const self = g?.selfPublished;
      out.push({ ...a, group: self ? 1 : 3, label: self ? "Self-published Godot" : "Godot, has a publisher", head: a.title.replace(/^Godot game taking off:\s*/, ""),
        plain: g ? `${num(g.reviews)} reviews (${g.pos ?? "?"}% positive), more than ${g.hit}% of the games out the same fortnight. ${self ? `Self-published by ${g.developers.join(", ")}: no publisher yet.` : `Published by ${g.publishers.join(", ")}: probably taken.`}` : a.detail });
    } else {
      out.push({ ...a, group: 2, label: "Breakout", head: a.title.replace(/^Breakout:\s*/, ""), plain: `${a.detail.replace(/;?\s*hit index \d+\.?/, "")}: ahead of 99% of its launch fortnight. Likely out of reach; worth studying.` });
    }
  }
  return out.map((a) => ({ ...a, joke: a.kind !== "tag" && isJoke(a.head) }))
    .sort((a, b) => a.joke - b.joke || a.group - b.group || (b.score ?? 0) - (a.score ?? 0));
}

// --- Today: the few things worth knowing ------------------------------------------

export function todayItems({ trends, tagNames, upcoming, godot, growth }) {
  const out = [];
  if (trends) {
    const n = rankNiches(trends, tagNames, { small: true }).find((r) => r.conf !== "thin data");
    if (n) out.push({ kind: "Niche", text: `Best niche right now: ${n.name}. ${num(n.hits)} of its ${num(n.hitGames)} recent games became hits, about ${oneIn(n.hitRate)} even after allowing for chance (Steam average: ${oneIn(trends.baseHitRate)}; ${n.sure}). New ones are ${growthWords(n.supply)}.`, tab: "make", tag: n.tag });
  }
  if (upcoming) {
    const l = upcoming.find((g) => g.deal !== "published");
    if (l) out.push({ kind: "Lead", text: `Best upcoming lead: ${l.name} by ${l.devs.join(", ") || "an unknown studio"}. ${l.reason}`, appid: l.appid, tab: "sign" });
  }
  if (godot) {
    const r = godot[0];
    if (r) out.push({ kind: "Lead", text: `Released and worth a look: ${r.name} by ${r.developers.join(", ") || "?"}. ${r.reason}`, appid: r.appid, tab: "sign" });
  }
  const b = (trends?.alerts || []).find((a) => a.kind === "breakout" && !isJoke(a.title));
  if (b) out.push({ kind: "Breakout", text: `${b.title.replace(/^Breakout: /, "")} is breaking out: ${b.detail.replace(/;?\s*hit index \d+\.?/, "").replace(/\.$/, "")}.`, appid: b.appid });
  if (growth) out.push({ kind: "Steam", text: growth.sentence.split(". ").slice(-1)[0], tab: "steam" });
  return out.slice(0, 5);
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let C;
const st = {
  files: {}, loading: {}, errors: {}, root: null, cache: {}, open: {},
  tab: "make", small: true, sort: "odds", shown: 6, q: "", sel: null,
  goal: "hit", target: 50000, pairs: true, gapShown: 8, must: "", gapView: "cards", gapSort: "lift", gapDir: -1,
  rel: { days: 30, indie: true, self: false, godot: false, adult: false }, relShown: 25,
};
const NEEDS = { make: ["trends", "games"], sign: ["trends", "upcoming", "godot"], steam: ["growth", "trends", "games", "godot"] };
const today = () => st.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const tagNames = () => st.files.overview?.tags || {};
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;

const save = (k, v) => { try { C.store.set(PREFIX + k, typeof v === "string" ? v : JSON.stringify(v)); } catch {} };
function restore() {
  const get = (k) => { try { const v = C.store.get(PREFIX + k); return v == null ? null : v; } catch { return null; } };
  const tab = get("tab"); if (TABS.some(([id]) => id === tab)) st.tab = tab;
  for (const k of ["small", "pairs"]) { const v = get(k); if (v === "true" || v === "false") st[k] = v === "true"; }
  const sort = get("sort"); if (["odds", "typical", "growing", "quiet"].includes(sort)) st.sort = sort;
  const goal = get("goal"); if (goal === "hit" || goal === "money") st.goal = goal;
  const target = Number(get("target")); if (target > 0) st.target = target;
  const gv = get("gapView"); if (gv === "cards" || gv === "table") st.gapView = gv;
  try { const r = JSON.parse(get("rel") || "null"); if (r && typeof r === "object") Object.assign(st.rel, r); } catch {}
  if (![7, 30, 90].includes(st.rel.days)) st.rel.days = 30;
}
function goTab(id) { st.tab = id; save("tab", id); load(NEEDS[id]); draw(); }

// Cached by inputs: the heavy work runs once per setting, not on every redraw.
function memo(key, fn) { if (!(key in st.cache)) st.cache[key] = fn(); return st.cache[key]; }
const gamesList = () => memo("games", () => unpackGames(st.files.games));
const upcomingList = () => memo("upcoming", () => unpackUpcoming(st.files.upcoming));
const upLeads = () => memo("up", () => upcomingLeads(upcomingList(), st.files.trends, today(), { godotOnly: true, tagNames: tagNames() }));
const relLeads = () => memo("rel", () => releasedLeads(st.files.godot.games, today(), tagNames()));
const growthNow = () => memo("growth", () => steamGrowth(st.files.growth));
const nichesNow = () => memo(`niches:${st.small}:${st.sort}`, () => rankNiches(st.files.trends, tagNames(), { small: st.small, sort: st.sort }));
const adultIds = () => memo("adult", () => tagSets(tagNames()).adult);

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
  st.root = C.h("div.mk.mkv-merged");
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
  const tabs = h("div.mm-tabs", { role: "tablist" }, ...TABS.map(([id, q, sub], i) => h("button.mm-tab", {
    type: "button", role: "tab", "aria-selected": String(st.tab === id), onclick: () => goTab(id),
  }, h("span.mm-tab-n", String(i + 1)), h("span.mm-tab-q", q), h("span.mm-tab-sub", sub))));
  const sign = ["overview", "trends", "upcoming", "godot"];
  const body = {
    make: () => waitFor(["overview", "trends"], "Loading the niches…", makeView),
    sign: () => waitFor(sign, "Loading the games still to come out…", signTab),
    steam: () => waitFor(["overview", "growth"], "Loading Steam's history…", steamView),
  }[st.tab]();
  st.root.replaceChildren(
    waitFor(["overview", "trends"], "Loading today's briefing…", todayView),
    tabs, h("div.mm-body", { role: "tabpanel" }, body), detectionNote());
  window.scrollTo(0, y);
}

// Tab 2 lives in market-sign.js; a bug there shouldn't blank the whole page.
function signTab() {
  try { return signView(C, { overview: st.files.overview, trends: st.files.trends, upcoming: st.files.upcoming, godot: st.files.godot }, draw); }
  catch (e) { console.error(e); return C.h("p.mm-note", `This view couldn't draw: ${e.message}`); }
}

function waitFor(names, text, fn) {
  const h = C.h;
  const err = names.map((n) => st.errors[n]).find(Boolean);
  if (err) return h("p.mm-note", err, " ", btn("Try again", () => load(names)));
  if (names.some((n) => !st.files[n])) return h("p.mm-note", text);
  return fn();
}

function redrawKeeping(e) {
  const key = e?.target?.dataset?.key, pos = e?.target?.selectionStart;
  draw();
  if (!key) return;
  const el = st.root.querySelector(`[data-key="${key}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}

// Jump to a niche's card (from a dot on the chart, or a "Rising niche" alert) and highlight it.
function pickTag(tag, { toggle = true } = {}) {
  if (toggle && st.sel === tag && st.tab === "make") { st.sel = null; draw(); return; }
  st.sel = tag;
  let rows = nichesNow();
  if (!rows.some((r) => r.tag === tag) && st.small) { st.small = false; save("small", false); rows = nichesNow(); }
  const q = st.q.trim().toLowerCase();
  if (q && !rows.some((r) => r.tag === tag && r.name.toLowerCase().includes(q))) st.q = "";
  const i = rows.findIndex((r) => r.tag === tag);
  if (i >= st.shown) st.shown = Math.ceil((i + 1) / 6) * 6;
  if (st.tab !== "make") goTab("make"); else draw();
  requestAnimationFrame(() => st.root?.querySelector(`.mm-card[data-tag="${tag}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// --- small UI pieces -----------------------------------------------------------------

const h0 = (...a) => C.h(...a);
const btn = (label, onclick, extra = {}) => C.h("button.mm-btn", { type: "button", onclick, ...extra }, label);
const link = (href, label) => C.h("a.mm-link", { href, target: "_blank", rel: "noopener" }, label);
function seg(options, value, onChange, label) {
  return C.h("div.mm-seg", { role: "group", "aria-label": label }, ...options.map(([v, text]) => C.h("button", {
    type: "button", "aria-pressed": String(v === value), onclick: () => { onChange(v); draw(); },
  }, text)));
}
const toggle = (label, on, flip) => C.h("button.mm-toggle", { type: "button", "aria-pressed": String(on), onclick: () => { flip(); draw(); } }, h0("span.mm-check", on ? "✓" : ""), label);
const SURE_TIP = { solid: "Based on 100+ games", likely: "Based on 40 to 99 games", "thin data": "Based on fewer than 40 games: could be luck" };
const confPill = (conf, label) => C.h("span.mm-conf", { class: conf === "solid" ? "is-solid" : conf === "likely" ? "is-likely" : "is-thin", title: `${SURE_TIP[conf]}. The ± is a rough 90% range for the rate, in percentage points.` }, label);
const more = (shown, total, bump) => total > shown ? btn(`Show more (${num(total - shown)} more)`, () => { bump(); draw(); }, { class: "mm-more" }) : null;
const section = (title, sub, ...kids) => C.h("section.mm-section", C.h("h2", title), sub ? C.h("p.mm-sub", sub) : null, ...kids);
const badge = (text, kind) => C.h("span.mm-badge", { class: kind ? `mm-b-${kind}` : null }, text);
// A <details> that stays open across redraws.
function fold(key, summary, ...kids) {
  return C.h("details.mm-details", { open: st.open[key] || null, ontoggle: (e) => { st.open[key] = e.target.open; } }, C.h("summary", summary), ...kids);
}
// A bar inside a table cell: value 0..1 of the column's max, the number beside it.
const barCell = (frac, text, color = "var(--sw-1)") => C.h("td.mm-num", C.h("div.mm-barcell", C.h("span.mm-cbar", C.h("i", { style: `width:${clamp(frac) * 100}%;background:${color}` })), C.h("span", text)));
// A table with sortable headers. cols: [{key, label, tip, num}].
function sortTable(cols, rows, sort, onSort) {
  const h = C.h;
  return h("div.mm-scroll", h("table.mm-table",
    h("thead", h("tr", ...cols.map((c) => h("th", { title: c.tip || null, class: c.num ? "mm-num" : null, "aria-sort": sort && c.key === sort.key ? (sort.dir > 0 ? "ascending" : "descending") : null },
      c.key && onSort ? h("button", { type: "button", onclick: () => onSort(c.key) }, c.label, sort?.key === c.key ? (sort.dir > 0 ? " ↑" : " ↓") : "") : c.label)))),
    h("tbody", ...rows)));
}

// A bar of the niche's hit chance, with Steam's average as a marker.
function oddsBar(rate, base, max) {
  const h = C.h, w = (x) => `${(clamp(x / max) * 100).toFixed(1)}%`;
  return h("div.mm-oddsrow",
    h("div.mm-bar", { role: "img", "aria-label": `${pct(rate)} against Steam's ${pct(base)}` },
      h("i", { style: `width:${w(rate)}` }), h("b", { style: `left:${w(base)}`, title: `Steam average ${pct(base)}` })),
    h("span.mm-barlabel", h("strong", pct(rate)), ` hit chance · Steam ${pct(base)}`));
}

// A tooltip living inside a positioned box.
function tipFor(box) {
  let tip = box.querySelector(":scope > .mm-tip");
  if (!tip) { tip = C.h("div.mm-tip", { role: "status" }); box.append(tip); }
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

function todayView() {
  const h = C.h;
  const items = todayItems({
    trends: st.files.trends, tagNames: tagNames(),
    upcoming: st.files.upcoming ? upLeads() : null,
    godot: st.files.godot ? relLeads() : null,
    growth: st.files.growth ? growthNow() : null,
  });
  return h("section.mm-today",
    h("div.mm-today-head", h("h2", "Today"), h("span.mm-sub", st.files.overview ? dayDate(today()) : "")),
    h("ul.mm-today-list", ...items.map((it) => h("li",
      h("span.mm-kind", { class: `k-${it.kind.toLowerCase()}` }, it.kind),
      h("span.mm-today-text", it.text, " ",
        it.appid ? link(storeUrl(it.appid), "Store page ↗") : null,
        it.tag != null ? btn("Show", () => pickTag(it.tag, { toggle: false }), { class: "mm-inline" })
          : it.tab && it.tab !== st.tab ? btn("More", () => goTab(it.tab), { class: "mm-inline" }) : null)))));
}

function detectionNote() {
  const o = st.files.overview;
  if (!o) return null;
  return C.h("p.mm-foot", `Godot detection: ${num(o.withMetadata)} of ${num(o.games)} games checked so far (${pct(o.withMetadata / o.games)}); the rest are checked over the coming days, so more Godot games will appear. ${num(o.historyDays)} ${o.historyDays === 1 ? "day" : "days"} of daily history so far.`);
}

// --- 1. What should I make next? ------------------------------------------------------

function makeView() {
  const h = C.h, t = st.files.trends;
  const all = nichesNow();
  const q = st.q.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  const max = Math.max(0.3, ...all.map((r) => r.hitRate));
  const [w0, w1] = t.hitRateWindow || [14, 180];
  const card = (r) => h("article.mm-card", { "data-tag": String(r.tag), class: r.tag === st.sel ? "is-sel" : null },
    h("div.mm-card-head", h("span.mm-rank", `#${all.indexOf(r) + 1}`), h("h3", r.name), confPill(r.conf, r.sure)),
    h("p.mm-big", `${num(r.hits)} of the ${num(r.hitGames)} ${r.name} games released ${w0} days to ${Math.round(w1 / 30)} months ago became hits. Allowing for chance, that's about ${oneIn(r.hitRate)} (Steam average: ${oneIn(t.baseHitRate)}).`),
    oddsBar(r.hitRate, t.baseHitRate, max),
    h("p.mm-line", `A typical one has ${plural(r.medianReviews, "review")}; a top-10% one has ${plural(r.topReviews, "review")}.`,
      r.medianReviews != null && t.baseMedianReviews ? ` (A typical Steam game: ${plural(t.baseMedianReviews, "review")}.)` : ""),
    h("p.mm-line", `${num(r.releases)} new ones in the last ${t.supplyWindow} days (${num(r.releasesYearAgo)} a year ago): ${growthWords(r.supply)}.`));
  return h("div",
    section("Niches where games often become hits",
      `A hit is a game in the top 10% by reviews among the games released the same fortnight; on Steam as a whole, ${oneIn(t.baseHitRate)} new games become one. A niche is a user tag among a game's five strongest. Hit chances are pulled toward Steam's average when a tag has few games (as if it also had ${t.priorGames || PRIOR} ordinary games), so a lucky handful can't top the list. How sure: "solid" = 100+ games, "likely" = 40+, "thin data" = fewer; ± is a rough 90% range.`,
      h("div.mm-controls",
        toggle("Small-team niches only", st.small, () => { st.small = !st.small; save("small", st.small); }),
        st.small ? h("span.mm-small.mm-inline-note", { title: [...HUGE, ...BIG].join(", ") }, "leaves out big-build tags like MMO, open world, multiplayer") : null),
      scatterCard(all, t.baseHitRate),
      h("div.mm-controls",
        seg([["odds", "Best hit chance"], ["typical", "Most reviews for a typical game"], ["growing", "Good odds, growing fastest"], ["quiet", "Good odds, least crowded"]], st.sort, (v) => { st.sort = v; st.shown = 6; save("sort", v); }, "Sort niches"),
        h("input.mm-input", { type: "search", "data-key": "niche-q", value: st.q, placeholder: "Find a tag to compare", "aria-label": "Find a tag", oninput: (e) => { st.q = e.target.value; redrawKeeping(e); } })),
      rows.length ? h("div.mm-cards", ...rows.slice(0, q ? Math.max(12, st.shown) : st.shown).map(card)) : h("p.mm-note", "No tag matches."),
      q ? null : more(st.shown, rows.length, () => { st.shown += 6; }),
      compareTable(all, t)),
    gapSection());
}

// Every tag as a dot: crowding (x, log) against hit rate (y). Click a dot to jump to its card.
function scatterCard(rows, base) {
  const h = C.h, svgEl = C.svgEl, sel = rows.find((r) => r.tag === st.sel) || null;
  if (!rows.length) return null;
  const W = 760, H = 380, M = { top: 14, right: 14, bottom: 40, left: 48 };
  const xs = rows.map((r) => Math.max(1, r.releases));
  const lx0 = Math.log10(Math.max(1, Math.min(...xs) * 0.85)), lx1 = Math.log10(Math.max(...xs) * 1.15);
  const ymax = niceMax(Math.max(...rows.map((r) => r.hitRate), base * 2));
  const x = (v) => M.left + ((Math.log10(Math.max(1, v)) - lx0) / (lx1 - lx0)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / ymax) * (H - M.top - M.bottom);
  const rad = (m) => 3 + 1.25 * Math.log2(1 + (m ?? 0));
  const xSplit = median(xs), ySplit = base * 1.5;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-svg", role: "img", "aria-label": "Every tag: crowding against hit rate" });
  const text = (attrs, s) => { const el = svgEl("text", attrs); el.textContent = s; svg.append(el); return el; };
  svg.append(svgEl("rect", { x: M.left, y: M.top, width: x(xSplit) - M.left, height: y(ySplit) - M.top, class: "mm-gapzone" }));
  for (let k = 0; k <= 5; k++) {
    const v = (ymax / 5) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mm-grid" : "mm-base" }));
    text({ x: M.left - 6, y: y(v) + 4, "text-anchor": "end", class: "mm-axis" }, pct(v));
  }
  for (const v of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
    if (Math.log10(v) < lx0 || Math.log10(v) > lx1) continue;
    svg.append(svgEl("line", { x1: x(v), x2: x(v), y1: M.top, y2: H - M.bottom, class: "mm-grid" }));
    text({ x: x(v), y: H - M.bottom + 15, "text-anchor": "middle", class: "mm-axis" }, fmtK(v));
  }
  text({ x: (M.left + W - M.right) / 2, y: H - 6, "text-anchor": "middle", class: "mm-axis mm-axis-title" }, "Crowding: games released with the tag in the last 90 days (log scale) →");
  text({ x: M.left, y: 10, class: "mm-axis mm-axis-title" }, "↑ Hit chance (allowing for chance)");
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(base), y2: y(base), class: "mm-ref" }));
  text({ x: W - M.right - 4, y: y(base) - 4, "text-anchor": "end", class: "mm-axis" }, `Steam average ${pct(base)}`);
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(ySplit), y2: y(ySplit), class: "mm-split" }));
  svg.append(svgEl("line", { x1: x(xSplit), x2: x(xSplit), y1: M.top, y2: H - M.bottom, class: "mm-split" }));
  const quadBoxes = []; // the corner labels: tag labels keep clear of them
  const quad = (tx, ty, anchor, title, sub) => { const w = Math.max(title.length * 6.6, sub.length * 5.6); quadBoxes.push(anchor === "end" ? [tx - w, ty - 11, tx, ty + 16] : [tx, ty - 11, tx + w, ty + 16]); text({ x: tx, y: ty, "text-anchor": anchor, class: "mm-quad" }, title); text({ x: tx, y: ty + 13, "text-anchor": anchor, class: "mm-axis" }, sub); };
  quad(M.left + 8, M.top + 16, "start", "Quiet and rewarding = gaps", "few games, many hits");
  quad(W - M.right - 8, M.top + 16, "end", "Crowded but rewarding", "big demand, big competition");
  quad(W - M.right - 8, H - M.bottom - 24, "end", "Crowded and hard", "lots of games, few hits");
  quad(M.left + 8, H - M.bottom - 24, "start", "Quiet and hard", "few games, few hits");
  const color = (r) => r.dir > 0 ? "var(--sw-3)" : r.dir < 0 ? "var(--sw-2)" : "var(--fb-muted)";
  const dots = svgEl("g");
  for (const r of [...rows].sort((a, b) => (b.medianReviews ?? 0) - (a.medianReviews ?? 0))) { // big ones under small ones
    const cx = x(r.releases), cy = y(r.hitRate), rr = rad(r.medianReviews), on = r === sel;
    const g = svgEl("g", { class: "mm-dot", "data-tag": r.tag, tabindex: "0", role: "button", "aria-label": `${r.name}: hit chance ${pct(r.hitRate)}, ${r.releases} releases. Show its card.` });
    g.append(svgEl("circle", { cx, cy, r: rr, fill: color(r), "fill-opacity": on ? 1 : 0.62, stroke: on ? "var(--fb-ink)" : "var(--fb-card)", "stroke-width": on ? 2.5 : 1.5 }));
    g.append(svgEl("circle", { cx, cy, r: Math.max(rr + 4, 9), fill: "transparent" }));
    g.__row = r;
    dots.append(g);
  }
  svg.append(dots);
  // Direct labels: the best by hit chance, the most crowded, and the picked one; skipped where they'd overlap.
  const placed = [...quadBoxes];
  const want = [...new Set([sel, ...[...rows].sort((a, b) => b.hitRate - a.hitRate).slice(0, 12), ...[...rows].sort((a, b) => b.releases - a.releases).slice(0, 4)].filter(Boolean))];
  for (const r of want) {
    const w = r.name.length * 6.3 + 4, cx = x(r.releases) + rad(r.medianReviews) + 3, cy = y(r.hitRate) + 4;
    const left = cx + w > W - M.right ? cx - w - 2 * rad(r.medianReviews) - 6 : cx;
    const b = [left, cy - 11, left + w, cy + 2];
    if (r !== sel && placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1])) continue;
    placed.push(b);
    text({ x: left, y: cy, class: `mm-dl${r === sel ? " mm-dl-sel" : ""}` }, r.name);
  }
  const box = h("div.mm-chart",
    h("div.mm-legend",
      h("span", h("i.mm-key", { style: "background:var(--sw-3)" }), "Growing share of releases"),
      h("span", h("i.mm-key", { style: "background:var(--fb-muted)" }), "Steady"),
      h("span", h("i.mm-key", { style: "background:var(--sw-2)" }), "Shrinking"),
      h("span", h("i.mm-key.mm-key-ring"), "Bigger dot = more reviews for a typical game"),
      h("span", h("i.mm-key.mm-key-zone"), `Gap corner: below-median crowding, ${times(1.5)} Steam's hit chance or better`)),
    svg,
    h("p.mm-small.mm-tight", `Each dot is a tag (${rows.length} shown). Click one to jump to its card below.`));
  const tip = tipFor(box);
  const find = (ev) => ev.target.closest?.(".mm-dot")?.__row;
  svg.addEventListener("pointermove", (ev) => {
    const r = find(ev);
    if (!r) return tip.hide();
    tip.show([h("div.mm-tip-t", r.name),
      h("div", h("b", pct(r.hitRate)), ` become hits (${times(r.lift)} Steam's)`),
      h("div", `${fmtK(r.releases)} released in 90 days · ${growthWords(r.supply)}`),
      h("div", `Typical game ${fmtK(r.medianReviews)} reviews, top 10% ${fmtK(r.topReviews)}`),
      h("div.mm-tip-raw", `How sure: ${r.sure} (${num(r.hitGames)} games)`)], ev);
  });
  svg.addEventListener("pointerleave", () => tip.hide());
  svg.addEventListener("click", (ev) => { const r = find(ev); if (r) pickTag(r.tag); });
  svg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { const r = find(ev); if (r) { ev.preventDefault(); pickTag(r.tag); } } });
  return box;
}

function compareTable(rows, t) {
  const h = C.h;
  return fold("compare", `Compare all ${rows.length} niches in one table`,
    h("div.mm-scroll", h("table.mm-table",
      h("thead", h("tr", ...["Niche", "Hit chance", "How sure", "Games counted", "Typical game", "Top 10%", `New (${t.supplyWindow} days)`, "Vs Steam"].map((x) => h("th", x)))),
      h("tbody", ...rows.map((r) => h("tr", h("td", r.name), h("td", `${pct(r.hitRate)} (${oneIn(r.hitRate)})`), h("td", r.sure), h("td", num(r.hitGames)),
        h("td", `${num(r.medianReviews)} reviews`), h("td", `${num(r.topReviews)} reviews`), h("td", num(r.releases)), h("td", growthWords(r.supply))))))));
}

function gapSection() {
  const h = C.h, title = "Tag pairs: the gap finder";
  if (st.errors.games) return section(title, null, h("p.mm-note", st.errors.games, " ", btn("Try again", () => load(["games"]))));
  if (!st.files.games) return section(title, null, h("p.mm-note", "Loading three years of releases (a few MB, once)…"));
  const names = tagNames();
  const mustId = st.must ? tagSets(names).byName.get(st.must.trim().toLowerCase()) ?? null : null;
  const opts = { today: today(), goal: st.goal, target: st.target, small: st.small, must: mustId };
  const key = `gap:${st.goal}:${st.target}:${st.small}:${mustId}`;
  const res = memo(`${key}:${st.pairs}`, () => gapFinder(gamesList(), names, { ...opts, pairs: st.pairs }));
  const goalWord = st.goal === "hit" ? "became a hit" : `earned about ${usd(st.target)}`;
  const rateWord = st.goal === "hit" ? "Hit chance" : "Earn chance";
  const max = Math.max(0.3, ...res.rows.slice(0, 30).map((r) => r.adj));
  const card = (r) => h("article.mm-gap",
    h("div.mm-card-head", h("h3", r.name), confPill(r.conf, r.sure)),
    h("p.mm-line.mm-strong", `${num(r.wins)} of ${num(r.n)} ${goalWord}: about ${oneIn(r.adj)} allowing for chance, ${times(r.lift)} the average (${oneIn(res.base)}).`),
    oddsBar(r.adj, res.base, max),
    h("p.mm-line", `Typical game: ${plural(r.medianReviews, "review")}. ${num(r.recent)} new ones in the last 90 days${r.growth != null ? `, ${growthWords(r.growth)}` : ""}. Biggest: `, link(storeUrl(r.best.appid), r.best.name), ` (${num(r.best.reviews)} reviews).`));
  let list;
  if (st.gapView === "table") {
    const singles = st.pairs ? memo(`${key}:false`, () => gapFinder(gamesList(), names, { ...opts, pairs: false })) : null;
    const scored = memo(`${key}:${st.pairs}:scored`, () => withGapScores(res, singles));
    const sk = st.gapSort, dir = st.gapDir;
    const val = { name: (r) => r.name, conf: (r) => r.n }[sk] || ((r) => r[sk] ?? -Infinity);
    const sorted = [...scored].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir; });
    const mxr = Math.max(...sorted.map((r) => r.adj), 0.01), mxc = Math.log1p(Math.max(...sorted.map((r) => r.recent), 1));
    const cols = [
      { key: "name", label: st.pairs ? "Pair of tags" : "Tag", tip: "Tags among a game's 5 strongest (Indie, adult and how-it's-sold tags left out)." },
      { key: "adj", label: rateWord, num: true, tip: `Share of its games that ${goalWord}, with ${PRIOR} average games mixed in so small niches are pulled toward the average (${pct(res.base)}).` },
      st.pairs ? { key: "bonus", label: "vs its tags", num: true, tip: "The pair's chance against the better of its two tags alone. Above ×1: the combination does better than either part." } : null,
      { key: "n", label: "Games judged", num: true, tip: "Games the chance is based on. Fewer games = the number leans more on the average." },
      { key: "conf", label: "How sure", tip: "Solid: 100+ games; likely: 40+; thin data: fewer. ± is a rough 90% range." },
      { key: "medianReviews", label: "Typical game", num: true, tip: "Median reviews of its games." },
      { key: "recent", label: "Crowding", num: true, tip: "Games released with it in the last 90 days." },
      { key: "gap", label: "Gap score", num: true, tip: "Chance vs the average, divided by crowding (log): high = often wins and few made." },
    ].filter(Boolean);
    const body = sorted.slice(0, st.gapShown * 3).map((r) => h("tr",
      h("td", h("b", r.name)), barCell(r.adj / mxr, pct(r.adj), r.lift >= 1.5 ? "var(--sw-3)" : "var(--sw-1)"),
      st.pairs ? h("td.mm-num", { class: r.bonus >= 1.1 ? "mm-up" : r.bonus < 0.9 ? "mm-down" : null }, times(r.bonus)) : null,
      h("td.mm-num", num(r.n), h("span.mm-dim", ` (${r.wins})`)), h("td", r.sure),
      h("td.mm-num", fmtK(r.medianReviews)), barCell(Math.log1p(r.recent) / mxc, fmtK(r.recent), "var(--fb-muted)"), h("td.mm-num", h("b", r.gap.toFixed(2)))));
    list = h("div", sortTable(cols, body, { key: sk, dir }, (k) => { if (st.gapSort === k) st.gapDir = -st.gapDir; else { st.gapSort = k; st.gapDir = k === "name" ? 1 : -1; } draw(); }),
      more(st.gapShown * 3, sorted.length, () => { st.gapShown += 8; }));
  } else {
    list = h("div", res.rows.length ? h("div.mm-gaps", ...res.rows.slice(0, st.gapShown).map(card)) : null, more(st.gapShown, res.rows.length, () => { st.gapShown += 8; }));
  }
  return section(title,
    `Combinations of a game's strongest tags, with how often games like that ${st.goal === "hit" ? "became hits (released 2 weeks to 6 months ago)" : `earned the goal (paid games released 2 months to 2 years ago; earned = reviews × ${SALES_PER_REVIEW} sales a review × price × ${NET_SHARE} kept after Steam's cut, VAT and refunds)`}. A pair needs ${MIN_PAIR}+ games to show, and every rate is pulled toward the average as if it also had ${PRIOR} ordinary games, so "dwarves + fishing" with 3 lucky games isn't called a gap.`,
    h("div.mm-controls",
      seg([["hit", "Goal: become a hit"], ["money", "Goal: earn"]], st.goal, (v) => { st.goal = v; st.gapShown = 8; save("goal", v); }, "Goal"),
      st.goal === "money" ? h("label.mm-field", h("span", "at least $"), h("input.mm-input.mm-num-in", { type: "number", min: 1000, step: 5000, value: st.target, "data-key": "gap-target", "aria-label": "Target revenue in dollars",
        onchange: (e) => { const v = Number(e.target.value); if (v > 0) { st.target = v; save("target", String(v)); redrawKeeping(e); } } })) : null,
      seg([[true, "Tag pairs"], [false, "Single tags"]], st.pairs, (v) => { st.pairs = v; st.gapShown = 8; save("pairs", v); }, "Niche size"),
      h("input.mm-input", { list: "mm-tags", "data-key": "gap-must", value: st.must, placeholder: "Must include a tag…", "aria-label": "Must include a tag",
        onchange: (e) => { st.must = e.target.value; st.gapShown = 8; redrawKeeping(e); } }),
      h("datalist", { id: "mm-tags" }, ...Object.values(names).sort().map((n) => h("option", { value: n.trim() }))),
      seg([["cards", "Cards"], ["table", "Table"]], st.gapView, (v) => { st.gapView = v; save("gapView", v); }, "Show as")),
    h("p.mm-small", `${num(res.pool)} comparable games${mustId != null ? ` with ${names[mustId]}` : ""}; ${num(res.wins)} of them ${goalWord} (${pct(res.base, 1)}). ${num(res.rows.length)} niches have enough games to judge.`),
    res.rows.length ? list : h("p.mm-note", "Not enough games for these settings: take a tag away, switch to single tags or lower the goal."));
}

// --- 3. How is Steam doing? ------------------------------------------------------------

function steamView() {
  const h = C.h, g = st.files.growth, s = growthNow();
  const out = [];
  if (!s) out.push(h("p.mm-note", "No player numbers yet."));
  else {
    const chart = lineChart({
      labels: s.years.map(String), yLabel: `${s.years[0]} = 100`, fmt: (v) => v == null ? "–" : String(Math.round(v)),
      series: [
        { name: "Games released", color: "var(--sw-1)", values: s.relIdx, raw: s.rel, rawFmt: (v) => `${num(v)} games`, pace: s.partial },
        { name: "Steam's peak players", color: "var(--sw-3)", values: s.usersIdx, raw: s.users, rawFmt: (v) => `${short(v)} players` },
      ],
      note: s.partial ? `${s.years.at(-1)} is still going: its games line is dashed, this year's pace for a whole year (${num(s.sofar)} out so far).` : null,
    });
    out.push(section("More games, or more players?", null,
      h("p.mm-big", s.sentence),
      chartCard(chart),
      fold("sources", "Where the player numbers come from",
        h("p.mm-line", "Steam's all-time record of users online at once as of each year's end, as Valve reported it at the time (quoted in the press). From November 2026 the server keeps each day's peak from Steam's own stats feed."),
        h("ul.mm-sources", ...(g.users.records || []).map((r) => h("li", `${r.date}: ${short(r.users)} `, link(r.source, "source")))))));
  }
  out.push(releasesSection(), alertsFold());
  return h("div", ...out);
}

function releasesSection() {
  const h = C.h, f = st.rel, title = "What's doing well right now";
  if (st.errors.games) return section(title, null, h("p.mm-note", st.errors.games, " ", btn("Try again", () => load(["games"]))));
  if (!st.files.games) return section(title, null, h("p.mm-note", "Loading the recent releases (a few MB, once)…"));
  const d = today();
  const list = memo(`releases:${JSON.stringify(f)}`, () => releasesList(gamesList(), d, f, adultIds()));
  const names = tagNames();
  const set = (k, v) => { f[k] = v; st.relShown = 25; save("rel", f); };
  const rows = list.slice(0, st.relShown).map((g) => h("tr",
    h("td", link(storeUrl(g.appid), g.name), g.flags & F.godot ? badge("Godot", "godot") : null),
    barCell(g.hit / 100, String(g.hit), g.hit >= 99 ? "var(--sw-3)" : "var(--sw-1)"),
    h("td.mm-num", fmtK(g.reviews)), h("td.mm-num", g.pos ? `${g.pos}%` : "–"),
    h("td", dayDate(g.day), h("span.mm-dim", ` · ${d - g.day} d`)), h("td.mm-num", money(g.price)),
    h("td", g.flags & F.self ? badge("Self", "self") : h("span.mm-dim", "publisher")),
    h("td.mm-dim", g.top.filter((t) => t !== INDIE).slice(0, 3).map((t) => names[t]).filter(Boolean).join(", "))));
  const cols = [
    { label: "Game", tip: "The release, with a Godot mark when detected." },
    { label: "Hit index", num: true, tip: "Its review count as a percentile among games released within a week of it: 99 = more reviews than 99% of them. 90+ counts as a hit." },
    { label: "Reviews", num: true }, { label: "Positive", num: true }, { label: "Released" }, { label: "Price", num: true },
    { label: "Publisher", tip: "Self = self-published." }, { label: "Tags" },
  ];
  const hits = list.filter((g) => g.hit >= 90).length, breaks = list.filter((g) => g.hit >= 99).length;
  return section(title,
    "New releases ranked by the hit index: how many reviews they got against the games that came out the same week (99 = more than 99% of them; 90+ is a hit). Good for seeing what's working; released hits are rarely signable.",
    h("div.mm-controls",
      seg([[7, "7 days"], [30, "30 days"], [90, "90 days"]], f.days, (v) => set("days", v), "Released within"),
      toggle("Indie", f.indie, () => set("indie", !f.indie)),
      toggle("Self-published", f.self, () => set("self", !f.self)),
      toggle("Godot", f.godot, () => set("godot", !f.godot)),
      toggle("Adult and joke games", f.adult, () => set("adult", !f.adult))),
    h("p.mm-small", `${num(list.length)} released in the last ${f.days} days with these filters; ${num(hits)} hits (top 10% of their week), ${num(breaks)} breakouts (top 1%).`),
    list.length ? sortTable(cols, rows, null, null) : h("p.mm-note", "Nothing with these filters."),
    more(st.relShown, list.length, () => { st.relShown += 25; }));
}

function alertsFold() {
  const h = C.h, t = st.files.trends;
  if (!t) return null;
  const alerts = memo("alerts", () => rankAlerts(t, st.files.godot?.games));
  return fold("alerts", `All of today's alerts (${alerts.length})`,
    h("p.mm-small.mm-tight", "Ranked for a publisher: rising niches first (what to make), then self-published Godot games taking off (who to talk to), then breakouts (what to study), then Godot games that already have a publisher."),
    alerts.length ? h("ol.mm-alerts", ...alerts.map((a) => h("li.mm-alert", { class: `mm-g${a.group}` },
      h("span.mm-kind", a.label),
      h("div", h("b", a.kind === "tag" ? h("button.mm-linkbtn", { type: "button", onclick: () => pickTag(a.tag, { toggle: false }) }, a.head) : link(storeUrl(a.appid), a.head)),
        h("p", a.plain))))) : h("p.mm-note", "No alerts today."));
}

// --- Charts ----------------------------------------------------------------------------

function chartCard(chart) {
  const card = C.h("div.mm-chart", chart.legend, chart.svg, chart.tip, chart.note ? C.h("p.mm-small.mm-tight", chart.note) : null, chart.table);
  chart.attach(card);
  return card;
}

// Lines over evenly spaced labels, labeled at their ends, with a crosshair readout and a data table.
// A series with `pace` draws its last step dashed (this year, extrapolated to a whole year).
function lineChart({ labels, series, fmt, yLabel, note }) {
  const h = C.h, svgEl = C.svgEl;
  const W = 760, H = 280, M = { top: 18, right: 150, bottom: 30, left: 50 };
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const max = niceMax(Math.max(...vals, 0) * 1.05 || 1);
  const n = labels.length;
  const x = (i) => M.left + (n === 1 ? 0 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-svg", role: "img", "aria-label": series.map((s) => s.name).join(" and ") });
  const text = (attrs, s) => { const t = svgEl("text", attrs); t.textContent = s; svg.append(t); return t; };
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mm-grid" : "mm-base" }));
    text({ x: M.left - 8, y: y(v) + 4, "text-anchor": "end", class: "mm-axis" }, fmt(v));
  }
  text({ x: M.left, y: 12, class: "mm-axis mm-axis-title" }, yLabel || "");
  const every = Math.max(1, Math.ceil(n / 9));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) text({ x: x(i), y: H - 8, "text-anchor": "middle", class: "mm-axis" }, l); });
  const isPace = (s, i) => s.pace && i === n - 1;
  // End labels, pushed apart when they'd overlap.
  const ends = series.map((s) => { const i = s.values.findLastIndex((v) => v != null); return { s, i, y: y(s.values[i]) }; }).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 30) ends[k].y = ends[k - 1].y + 30;
  for (const s of series) {
    const solidTo = s.pace ? n - 2 : n - 1;
    let d = "";
    s.values.forEach((v, i) => { if (v != null && i <= solidTo) d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    if (s.pace && n > 1 && s.values[n - 2] != null && s.values[n - 1] != null)
      svg.append(svgEl("path", { d: `M${x(n - 2).toFixed(1)},${y(s.values[n - 2]).toFixed(1)}L${x(n - 1).toFixed(1)},${y(s.values[n - 1]).toFixed(1)}`, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-dasharray": "5 4", "stroke-linecap": "round" }));
  }
  for (const e of ends) {
    const paced = isPace(e.s, e.i);
    svg.append(svgEl("circle", { cx: x(e.i), cy: y(e.s.values[e.i]), r: 4, fill: paced ? "var(--fb-card)" : e.s.color, stroke: paced ? e.s.color : "var(--fb-card)", "stroke-width": 2 }));
    text({ x: x(e.i) + 10, y: e.y + 4, class: "mm-endlabel" }, `${fmt(e.s.values[e.i])}`);
    text({ x: x(e.i) + 10, y: e.y + 18, class: "mm-endname" }, paced ? `${e.s.name} (pace)` : e.s.name);
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "mm-cross", visibility: "hidden" });
  const dots = series.map((s) => svgEl("circle", { r: 5, fill: s.color, stroke: "var(--fb-card)", "stroke-width": 2, visibility: "hidden" }));
  svg.append(cross, ...dots);
  const tip = h("div.mm-tip", { role: "status" });
  const legend = h("div.mm-legend", ...series.map((s) => h("span", h("i.mm-line-key", { style: `background:${s.color}` }), s.name)),
    series.some((s) => s.pace) ? h("span", h("i.mm-line-key.mm-dash-key"), "this year's pace") : null);
  const rawText = (s, i) => s.raw ? `${s.rawFmt(s.raw[i])}${isPace(s, i) ? " (pace)" : ""}` : "";
  const table = fold(`table:${yLabel}`, "Data table", h("div.mm-scroll", h("table.mm-table",
    h("thead", h("tr", h("th", ""), ...series.map((s) => h("th", s.name)))),
    h("tbody", ...labels.map((l, i) => h("tr", h("td", l), ...series.map((s) => h("td", fmt(s.values[i]), s.raw ? ` (${rawText(s, i)})` : "")))).reverse()))));
  return {
    svg, tip, legend, table, note,
    attach(card) {
      const move = (ev) => {
        const box = svg.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        series.forEach((s, k) => { const v = s.values[i]; dots[k].setAttribute("visibility", v == null ? "hidden" : "visible"); if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); } });
        tip.replaceChildren(h("div.mm-tip-t", labels[i]), ...series.map((s) => h("div", h("i.mm-line-key", { style: `background:${s.color}` }), h("b", fmt(s.values[i])), ` ${s.name}`, s.raw ? h("span.mm-tip-raw", ` · ${rawText(s, i)}`) : null)));
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
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v - 1e-12);
}

// --- Style -----------------------------------------------------------------------------

const CSS = `
.mkv-merged { color: var(--fb-ink); font-size: 15px; line-height: 1.5; max-width: 980px; margin: 0 auto; padding-bottom: 20px; }
.mkv-merged *, .mkv-merged *::before, .mkv-merged *::after { box-sizing: border-box; }
.mkv-merged h2 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 4px; color: var(--fb-title); font-weight: 700; }
.mkv-merged h3 { font-size: 1.04rem; line-height: 1.3; margin: 0; color: var(--fb-title); font-weight: 650; overflow-wrap: anywhere; }
.mkv-merged p { margin: 0; }
.mkv-merged a.mm-link { color: var(--fb-link); text-decoration: none; }
.mkv-merged a.mm-link:hover { text-decoration: underline; }
.mkv-merged .mm-sub { color: var(--fb-ink-2); font-size: 0.93rem; max-width: 80ch; margin-bottom: 8px; }
.mkv-merged .mm-small { color: var(--fb-muted); font-size: 0.86rem; margin: 6px 0 8px; max-width: 80ch; }
.mkv-merged .mm-tight { margin: 4px 0 0; }
.mkv-merged .mm-inline-note { margin: 0; }
.mkv-merged .mm-note { color: var(--fb-ink-2); padding: 10px 0; }
.mkv-merged .mm-foot { color: var(--fb-muted); font-size: 0.82rem; margin-top: 16px; border-top: 1px solid var(--fb-line); padding-top: 8px; }
.mkv-merged .mm-big { font-size: 1.02rem; line-height: 1.5; color: var(--fb-ink); margin: 6px 0; max-width: 72ch; }
.mkv-merged .mm-line { color: var(--fb-ink-2); margin-top: 3px; font-size: 0.94rem; }
.mkv-merged .mm-strong { color: var(--fb-ink); font-weight: 550; }
.mkv-merged .mm-dim { color: var(--fb-muted); font-weight: 400; }

.mkv-merged .mm-today { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 14px; padding: 12px 16px 6px; margin: 0 0 12px; }
.mkv-merged .mm-today-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mkv-merged .mm-today-head .mm-sub { margin: 0; }
.mkv-merged .mm-today-list { list-style: none; margin: 0; padding: 0; }
.mkv-merged .mm-today-list li { display: grid; grid-template-columns: 82px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--fb-line); line-height: 1.45; }
.mkv-merged .mm-today-list li:first-child { border-top: 0; }
.mkv-merged .mm-kind { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fb-muted); padding-top: 3px; }
.mkv-merged .mm-kind.k-niche { color: var(--sw-1); }
.mkv-merged .mm-kind.k-lead { color: var(--fb-good-text); }
.mkv-merged .mm-kind.k-breakout { color: var(--fb-warning); }
.mkv-merged .mm-today-text a { margin-left: 4px; white-space: nowrap; }

.mkv-merged .mm-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0 0 16px; }
.mkv-merged .mm-tab { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; text-align: left; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; cursor: pointer; }
.mkv-merged .mm-tab:hover { background: var(--fb-hover); }
.mkv-merged .mm-tab[aria-selected="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-merged .mm-tab-n { grid-row: span 2; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--fb-card-2); color: var(--fb-ink-2); font-weight: 700; font-size: 0.85rem; }
.mkv-merged .mm-tab[aria-selected="true"] .mm-tab-n { background: var(--fb-accent); color: var(--fb-card); }
.mkv-merged .mm-tab-q { font-weight: 700; font-size: 1rem; line-height: 1.3; color: var(--fb-title); }
.mkv-merged .mm-tab-sub { color: var(--fb-muted); font-size: 0.84rem; line-height: 1.3; }

.mkv-merged .mm-section { margin: 0 0 22px; }
.mkv-merged .mm-controls { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 6px 0 8px; }
.mkv-merged .mm-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--fb-line); border-radius: 9px; overflow: hidden; background: var(--fb-card); }
.mkv-merged .mm-seg button { font: inherit; font-size: 0.88rem; padding: 5px 10px; border: 0; background: transparent; color: var(--fb-ink-2); cursor: pointer; border-right: 1px solid var(--fb-line); }
.mkv-merged .mm-seg button:last-child { border-right: 0; }
.mkv-merged .mm-seg button[aria-pressed="true"] { background: var(--fb-accent); color: var(--fb-card); font-weight: 600; }
.mkv-merged .mm-toggle, .mkv-merged .mm-btn { font: inherit; font-size: 0.88rem; padding: 5px 10px; border-radius: 9px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.mkv-merged .mm-toggle:hover, .mkv-merged .mm-btn:hover { background: var(--fb-hover); }
.mkv-merged .mm-check { width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--fb-muted); display: inline-grid; place-items: center; font-size: 10px; line-height: 1; }
.mkv-merged .mm-toggle[aria-pressed="true"] .mm-check { background: var(--fb-accent); border-color: var(--fb-accent); color: var(--fb-card); }
.mkv-merged .mm-btn.mm-inline { padding: 0 8px; font-size: 0.82rem; margin-left: 6px; vertical-align: 1px; }
.mkv-merged .mm-btn.mm-more { margin-top: 8px; }
.mkv-merged .mm-linkbtn { font: inherit; font-weight: 700; color: var(--fb-link); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.mkv-merged .mm-linkbtn:hover { text-decoration: underline; }
.mkv-merged .mm-input { font: inherit; font-size: 0.9rem; padding: 5px 10px; border-radius: 9px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); min-width: 0; width: 210px; max-width: 100%; }
.mkv-merged .mm-num-in { width: 110px; }
.mkv-merged .mm-field { display: inline-flex; align-items: center; gap: 6px; color: var(--fb-ink-2); font-size: 0.9rem; }

.mkv-merged .mm-cards, .mkv-merged .mm-gaps { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 400px), 1fr)); }
.mkv-merged .mm-card, .mkv-merged .mm-gap { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px 14px; min-width: 0; scroll-margin: 80px; }
.mkv-merged .mm-card.is-sel { border-color: var(--fb-accent); box-shadow: 0 0 0 2px var(--fb-accent); }
.mkv-merged .mm-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mkv-merged .mm-card-head h3 { flex: 1 1 auto; min-width: 0; }
.mkv-merged .mm-rank { color: var(--fb-muted); font-weight: 700; font-size: 0.9rem; }
.mkv-merged .mm-conf { font-size: 0.76rem; font-weight: 650; border-radius: 999px; padding: 1px 8px; border: 1px solid currentColor; white-space: nowrap; }
.mkv-merged .mm-conf.is-solid { color: var(--fb-good-text); }
.mkv-merged .mm-conf.is-likely { color: var(--fb-ink-2); }
.mkv-merged .mm-conf.is-thin { color: var(--fb-warning); }
.mkv-merged .mm-oddsrow { display: grid; gap: 3px; margin: 4px 0; }
.mkv-merged .mm-bar { position: relative; height: 8px; border-radius: 4px; background: var(--fb-card-2); }
.mkv-merged .mm-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--sw-1); }
.mkv-merged .mm-bar > b { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--fb-ink); }
.mkv-merged .mm-barlabel { font-size: 0.84rem; color: var(--fb-muted); }
.mkv-merged .mm-barlabel strong { color: var(--fb-ink); }

.mkv-merged .mm-details { margin-top: 8px; }
.mkv-merged .mm-details > summary { cursor: pointer; color: var(--fb-link); font-size: 0.92rem; padding: 3px 0; }
.mkv-merged .mm-scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
.mkv-merged .mm-table { border-collapse: collapse; width: 100%; font-size: 0.88rem; margin-top: 4px; font-variant-numeric: tabular-nums; }
.mkv-merged .mm-table th { text-align: left; color: var(--fb-muted); font-weight: 600; padding: 5px 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; vertical-align: bottom; }
.mkv-merged .mm-table th[title] { cursor: help; }
.mkv-merged .mm-table th button { appearance: none; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.mkv-merged .mm-table th[aria-sort] { color: var(--fb-title); }
.mkv-merged .mm-table td { padding: 5px 8px; border-bottom: 1px solid var(--fb-line); color: var(--fb-ink); white-space: nowrap; }
.mkv-merged .mm-table .mm-num { text-align: right; }
.mkv-merged .mm-barcell { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
.mkv-merged .mm-cbar { display: inline-block; width: 52px; height: 6px; border-radius: 3px; background: var(--fb-card-2); overflow: hidden; }
.mkv-merged .mm-cbar i { display: block; height: 100%; border-radius: 3px; }
.mkv-merged .mm-up { color: var(--fb-good-text); }
.mkv-merged .mm-down { color: var(--fb-negative); }
.mkv-merged .mm-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 0 6px; margin-left: 6px; border-radius: 10px; border: 1px solid var(--fb-line); color: var(--fb-ink-2); white-space: nowrap; vertical-align: 1px; }
.mkv-merged td > .mm-badge:first-child { margin-left: 0; }
.mkv-merged .mm-b-self { border-color: var(--fb-good-text); color: var(--fb-good-text); }
.mkv-merged .mm-b-godot { border-color: var(--sw-1); color: var(--fb-link); }
.mkv-merged .mm-sources { color: var(--fb-ink-2); font-size: 0.88rem; padding-left: 20px; margin: 4px 0; }

.mkv-merged .mm-alerts { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 6px; }
.mkv-merged .mm-alert { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; padding: 7px 10px; border-radius: 8px; background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-warning); }
.mkv-merged .mm-alert.mm-g1 { border-left-color: var(--fb-good-text); }
.mkv-merged .mm-alert.mm-g2 { border-left-color: var(--sw-1); }
.mkv-merged .mm-alert.mm-g3 { border-left-color: var(--fb-line); }
.mkv-merged .mm-alert p { margin: 2px 0 0; font-size: 0.88rem; color: var(--fb-ink-2); line-height: 1.4; }
.mkv-merged .mm-alert a { color: var(--fb-link); text-decoration: none; }

.mkv-merged .mm-chart { position: relative; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 12px 8px; margin: 6px 0 10px; }
.mkv-merged .mm-svg { display: block; width: 100%; height: auto; touch-action: pan-y; overflow: visible; }
.mkv-merged .mm-svg text { font-family: inherit; }
.mkv-merged .mm-grid { stroke: var(--fb-line); stroke-width: 1; }
.mkv-merged .mm-base { stroke: var(--fb-muted); stroke-width: 1; }
.mkv-merged .mm-cross { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.mkv-merged .mm-ref { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 4 3; }
.mkv-merged .mm-split { stroke: var(--fb-ink-2); stroke-width: 1; stroke-dasharray: 2 4; opacity: .7; }
.mkv-merged .mm-gapzone { fill: var(--sw-3); opacity: .08; }
.mkv-merged .mm-axis { fill: var(--fb-muted); font-size: 12px; }
.mkv-merged .mm-axis-title { fill: var(--fb-ink-2); font-weight: 600; }
.mkv-merged .mm-quad { fill: var(--fb-ink-2); font-size: 12px; font-weight: 700; }
.mkv-merged .mm-dl { fill: var(--fb-ink); font-size: 11.5px; font-weight: 600; paint-order: stroke; stroke: var(--fb-card); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
.mkv-merged .mm-dl-sel { fill: var(--fb-title); font-size: 13px; }
.mkv-merged .mm-dot { cursor: pointer; outline: none; }
.mkv-merged .mm-dot:hover circle:first-child, .mkv-merged .mm-dot:focus circle:first-child { fill-opacity: 1; stroke: var(--fb-ink); }
.mkv-merged .mm-endlabel { fill: var(--fb-ink); font-size: 14px; font-weight: 700; }
.mkv-merged .mm-endname { fill: var(--fb-ink-2); font-size: 12px; }
.mkv-merged .mm-legend { display: flex; flex-wrap: wrap; gap: 3px 14px; font-size: 0.84rem; color: var(--fb-ink-2); margin-bottom: 4px; }
.mkv-merged .mm-key { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
.mkv-merged .mm-key-ring { background: none; border: 2px solid var(--fb-muted); width: 13px; height: 13px; vertical-align: -3px; }
.mkv-merged .mm-key-zone { background: var(--sw-3); opacity: .35; border-radius: 2px; }
.mkv-merged .mm-line-key { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.mkv-merged .mm-dash-key { background: repeating-linear-gradient(90deg, var(--fb-ink-2) 0 4px, transparent 4px 7px); }
.mkv-merged .mm-tip { display: none; position: absolute; pointer-events: none; z-index: 5; background: var(--fb-card); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; font-size: 0.84rem; line-height: 1.45; box-shadow: 0 6px 20px rgba(0,0,0,0.18); max-width: 300px; }
.mkv-merged .mm-tip-t { font-weight: 700; color: var(--fb-title); margin-bottom: 1px; }
.mkv-merged .mm-tip-raw { color: var(--fb-muted); }

@media (max-width: 720px) {
  .mkv-merged .mm-tabs { grid-template-columns: 1fr; gap: 6px; }
  .mkv-merged .mm-tab { padding: 8px 12px; }
  .mkv-merged .mm-today { padding: 10px 12px 4px; }
  .mkv-merged .mm-today-list li { grid-template-columns: 1fr; gap: 0; }
  .mkv-merged .mm-card, .mkv-merged .mm-gap { padding: 10px 12px; }
  .mkv-merged .mm-input { width: 100%; }
  .mkv-merged .mm-chart { padding: 8px 6px 6px; }
  .mkv-merged .mm-alert { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .mkv-merged .mm-axis, .mkv-merged .mm-quad { font-size: 15px; }
  .mkv-merged .mm-dl { font-size: 14px; }
}
`;

function injectStyle() {
  if (document.getElementById("mk-merged-style")) return;
  const el = document.createElement("style");
  el.id = "mk-merged-style";
  el.textContent = CSS;
  document.head.append(el);
}

export const _test = { oneIn, confidence, spread, sureLabel, isJoke, rankNiches, unpackGames, gapFinder, withGapScores, unpackUpcoming, upcomingLeads, releasedLeads, steamGrowth, releasesList, rankAlerts, todayItems, releaseText };
