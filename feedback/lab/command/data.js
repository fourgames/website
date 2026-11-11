// Data for the Command center prototype.
// loadData() first tries the real, gitignored data in feedback/data (served at /data by the fb-lab
// config) and maps it to the model below; otherwise it returns invented sample data in that model.
// Model per game: { id, name, hue, hourly[720] (players, oldest first), d: { pos, neg, wish, gross,
// units }[30] (daily, oldest first), reviewsTotal, pos, wishTotal, issues[], posts[], media[],
// updates[], achievements[], stats, curators[], bundles[], competitors[] }.

const DAY = 86400;
export const NOW = Math.floor(Date.now() / 1000);

// Importance of a post kind: what the ranking and the folding are built on.
export const WEIGHT = { review: 5, refund: 5, topic: 4, video: 4, reply: 2, comment: 1 };

// ---- sample data ------------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SAMPLE_GAMES = [
  { id: "101", name: "Ember Keep", hue: 18, scale: 1.0, price: 14.99, genre: "FPS tower defense" },
  { id: "102", name: "Tidewalk", hue: 196, scale: 0.45, price: 9.99, genre: "Cozy explorer" },
  { id: "103", name: "Moss & Gears", hue: 140, scale: 0.22, price: 7.99, genre: "Puzzle builder" },
  { id: "104", name: "Nightshift Diner", hue: 282, scale: 0.08, price: 4.99, genre: "Co-op cooking" },
];
const BUGS = [
  ["Crash when loading a save from before the last update", "urgent"], ["Controller stops responding after alt-tab", "high"],
  ["Enemies get stuck on the bridge in wave 12", "high"], ["Audio crackles on Steam Deck", "medium"],
  ["Achievement for finishing hard mode never unlocks", "medium"], ["Ultrawide: menu is cut off at 21:9", "medium"],
  ["Tooltip shows the wrong upgrade cost", "low"], ["Stutter when many towers fire at once", "high"],
  ["Co-op guest loses items on disconnect", "urgent"], ["Text overflows buttons in German", "low"],
  ["Mouse sensitivity resets every launch", "medium"], ["Black screen on first start with HDR on", "high"],
];
const IDEAS = [
  "Endless mode after the campaign", "Key rebinding for the build menu", "A speed-up button between waves", "Steam Workshop maps",
  "Photo mode", "Colour-blind option for enemy types", "Save slots per player in co-op", "A harder difficulty", "Mac version",
  "Show damage numbers per tower", "Skip the intro on later runs", "More music tracks",
];
const LOVED = [
  "The art style", "Building feels satisfying", "The soundtrack", "Fair price", "Runs great on Steam Deck", "Short, focused runs",
  "Co-op is a blast", "The upgrade tree", "Devs answer quickly",
];
const WHO = ["moss_goblin", "KettleKnight", "pixelfern", "Ravenbyte", "quietotter", "Jun_42", "torchmaker", "LazyComet", "bramble", "Okapi9", "nordlys", "Saffron", "dustmote", "Hexwren", "tinplate", "Yuzu"];
const CHANNELS = ["Indie Lantern", "Deck Reviews", "Two Button Hero", "Cozy Queue", "Wave Twelve", "Small Games Club"];
const SAY = {
  bug: ["It happened to me twice tonight, right after the update.", "Same here. I lost about an hour of progress.", "Still there on the newest build. Please look at this.", "Happens every time on my machine, video attached.", "I had to refund because of this, sadly."],
  idea: ["Would love this. It would keep me playing for weeks.", "Please add this, it's the one thing I miss.", "My whole group asked for this after our first session.", "Not a deal-breaker, but it would be a great addition."],
  loved: ["This is the best part of the game by far.", "I keep coming back just for this.", "Bought two more copies for friends because of it.", "Honestly better than games three times the price."],
};

function sampleGame(meta, seed) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)], k = meta.scale;
  const hourly = [];
  for (let i = 0; i < 720; i++) {
    const hour = new Date((NOW - (719 - i) * 3600) * 1000).getHours();
    const dayWave = 0.55 + 0.45 * Math.sin(((hour - 14) / 24) * Math.PI * 2);
    const trend = 0.8 + 0.4 * Math.sin(i / 110 + seed) + (i > 560 ? 0.25 : 0);
    hourly.push(Math.max(0, Math.round(k * 420 * dayWave * trend * (0.85 + r() * 0.3))));
  }
  const d = { pos: [], neg: [], wish: [], gross: [], units: [] };
  for (let i = 0; i < 30; i++) {
    const bump = (i > 22 ? 1.5 : 1) * (0.7 + r() * 0.6) * (1 + 0.3 * Math.sin(i / 4 + seed));
    const units = Math.round(k * 46 * bump);
    d.units.push(units); d.gross.push(Math.round(units * meta.price * 0.92));
    d.pos.push(Math.round(k * 5 * bump * r() * 1.6)); d.neg.push(r() < 0.35 * Math.min(1, k * 2) ? 1 + Math.floor(r() * 2 * k) : 0);
    d.wish.push(Math.round(k * 60 * bump - 8 * r()));
  }
  const posts = [], issues = [];
  let n = 0;
  const post = (kind, t, extra = {}) => { const p = { id: `p${meta.id}_${n++}`, kind, t, who: pick(WHO), ...extra }; posts.push(p); return p; };
  const age = (max) => NOW - Math.floor((r() ** 2) * max * DAY) - 600;
  const mk = (kind, title, urgency, mentions) => {
    const lastSeen = age(kind === "bug" ? 9 : 25);
    const issue = { id: `i${meta.id}_${issues.length}`, kind, title, urgency, mentions, status: "open", firstSeen: lastSeen - Math.floor(r() * 40 * DAY), lastSeen,
      refunds: kind === "bug" && r() < 0.4 ? 1 + Math.floor(r() * 3) : 0, negativeReviews: kind === "bug" ? Math.floor(r() * mentions * 0.5) : 0,
      summary: kind === "bug" ? "Players report it mostly after the latest update; several lost progress." : kind === "idea" ? "Asked for in reviews and threads, often by players with long playtime." : "Named again and again as a reason to recommend the game.", posts: [] };
    const count = Math.min(mentions, 3 + Math.floor(r() * 5));
    for (let j = 0; j < count; j++) {
      const roll = r(), k2 = kind === "bug" && roll < 0.12 ? "refund" : roll < 0.5 ? "review" : roll < 0.72 ? "topic" : "reply";
      const p = post(k2, j ? age(30) : lastSeen, { text: pick(SAY[kind]), up: kind === "loved" ? true : kind === "bug" ? r() < 0.3 : r() < 0.8,
        summary: `${kind === "bug" ? "Reports" : kind === "idea" ? "Asks for" : "Praises"}: ${title.toLowerCase()}`, hours: Math.round(r() * 60 * 10) / 10,
        title: k2 === "topic" ? title : null, issues: [issue.id] });
      issue.posts.push(p.id);
    }
    issues.push(issue);
    return issue;
  };
  const nb = 2 + Math.floor(k * 7 + r() * 2), ni = 3 + Math.floor(k * 5 + r() * 2), nl = 3 + Math.floor(r() * 4);
  const shuffled = (a) => [...a].sort(() => r() - 0.5);
  shuffled(BUGS).slice(0, nb).forEach(([t, u]) => mk("bug", t, u, 2 + Math.floor(r() * 30 * k + (u === "urgent" ? 8 : 0))));
  shuffled(IDEAS).slice(0, ni).forEach((t) => mk("idea", t, pick(["high", "medium", "medium", "low"]), 2 + Math.floor(r() * 24 * k)));
  shuffled(LOVED).slice(0, nl).forEach((t) => mk("loved", t, null, 4 + Math.floor(r() * 60 * k)));
  const back = issues.find((x) => x.urgency === "high");
  if (back && r() < 0.6) { back.status = "still_happening"; back.fixedIn = "1.4.2"; }
  // Threads get replies; a few loose reviews.
  for (const p of posts.filter((x) => x.kind === "topic")) for (let j = 0, m = Math.floor(r() * 5); j < m; j++)
    post("reply", p.t + Math.floor(r() * DAY), { text: pick([...SAY.bug, ...SAY.idea]), parent: p.id, issues: p.issues });
  for (let j = 0; j < Math.round(10 * k) + 2; j++) { const up = r() < 0.85; post("review", age(30), { up, text: up ? pick(SAY.loved) : "Not for me. It gets repetitive after a few hours.", summary: up ? "Recommends it; enjoys the core loop" : "Finds it repetitive", hours: Math.round(r() * 80 * 10) / 10, answered: !up && r() < 0.4, issues: [] }); }
  // Media: videos (each a post with comments), streams, articles.
  const media = [];
  for (let j = 0; j < Math.round(7 * k) + 1; j++) {
    const t = age(30), ch = pick(CHANNELS), title = pick([`${meta.name} review: worth it?`, `I played ${meta.name} for 10 hours`, `${meta.name} first look`, `Top 5 tips for ${meta.name}`, `${meta.name} on Steam Deck`]);
    const linked = shuffled(issues).slice(0, 2 + Math.floor(r() * 2));
    const v = post("video", t, { who: ch, title, text: "Claude read the transcript; the points below link to their moment in the video.", summary: `${ch} covers the game; ${linked.length} points found`, views: Math.round(k * 9000 * r() ** 2) + 120, issues: linked.map((x) => x.id),
      points: linked.map((x) => ({ kind: x.kind, text: x.title, at: `${Math.floor(r() * 14)}:${String(Math.floor(r() * 60)).padStart(2, "0")}` })) });
    linked.forEach((x) => x.posts.push(v.id));
    for (let c = 0, m = Math.floor(r() * 9); c < m; c++) post("comment", t + Math.floor(r() * 2 * DAY), { text: pick(["Looks fun, wishlisted.", "Is there co-op?", "Got it last week, can confirm.", "Great video!", "Does it run on Deck?"]), parent: v.id, issues: [] });
    media.push({ id: `m${v.id}`, source: "youtube", title, by: ch, t, views: v.views, post: v.id });
  }
  if (r() < 0.25 + k) media.push({ id: `m${meta.id}_live`, source: "twitch", title: `${meta.name} | first playthrough`, by: pick(WHO), t: NOW - 2400, viewers: Math.round(8 + r() * 180 * k), live: true });
  for (let j = 0; j < 1 + Math.round(3 * k); j++) media.push({ id: `m${meta.id}_n${j}`, source: pick(["news", "reddit", "twitch"]), title: pick([`${meta.name} is a small gem`, `Hidden indie picks this month`, `Thread: anyone else playing ${meta.name}?`, `${meta.name} stream highlights`]), by: pick(["Indie Wire", "r/indiegames", "Pixel Post", "GameLeaf"]), t: age(30) });
  const fixedCount = () => 1 + Math.floor(r() * 4);
  const updates = [3, 12, 26, 47].map((a, i) => ({ t: NOW - a * DAY, title: `Update 1.${5 - i}${i ? "" : ".1"}`, fixed: fixedCount(), notes: pick(["Fixes and balance", "New map and fixes", "Performance pass", "Quality of life"]) }));
  const achievements = ["First steps", "Halfway there", "Finish the campaign", "Hard mode", "Collector", "Speedrunner"].map((name, i) => ({ name, pct: Math.round(Math.max(1.5, 86 / (i * 1.3 + 1) - r() * 6) * 10) / 10 }));
  return { ...meta, hourly, d, reviewsTotal: Math.round(k * 2400) + 40, pos: Math.round(78 + r() * 18), wishTotal: Math.round(k * 31000) + 900,
    issues, posts, media, updates, achievements,
    stats: { median: `${(1.5 + r() * 5).toFixed(1)} h`, reach: [["10 min", 92], ["30 min", 81], ["1 h", 66], ["2 h", 51], ["5 h", 30], ["10 h", 16]].map(([l, p]) => [l, Math.round(p - r() * 8)]), refundRate: Math.round((4 + r() * 6) * 10) / 10 },
    curators: [["Cozy Corner", 41000, true], ["Deck Verified Picks", 128000, true], ["Tower Defense Fans", 9800, false]].slice(0, 1 + Math.floor(r() * 3)).map(([name, followers, up]) => ({ name, followers, up })),
    bundles: [["Four Games Collection", 3], ["Cozy Builders Pack", 2]].slice(0, 1 + Math.floor(r() * 2)).map(([name, games]) => ({ name, games, units: Math.round(k * 300 * r()) })),
    competitors: [["Sample Rival A", 92, 310], ["Sample Rival B", 81, 140], ["Sample Rival C", 88, 55]].map(([name, pos, players]) => ({ name, pos, players: Math.round(players * (0.5 + r())) })) };
}

function sample() {
  return { sample: true, games: SAMPLE_GAMES.map((m, i) => sampleGame(m, 7 + i * 31)) };
}

// ---- real data (feedback/data, gitignored) ----------------------------------------------------
const DATA = "../../data";
const get = async (p) => { try { const r = await fetch(`${DATA}/${p}`, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; } };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

function adapt(meta, g, sales, wish, sw, i) {
  const id = String(meta.appId), days = Array.from({ length: 30 }, (_, j) => iso(NOW - (29 - j) * DAY));
  const hourly = new Array(720).fill(0);
  for (const [t, n] of g.players || []) { const j = 719 - Math.floor((NOW - t) / 3600); if (j >= 0 && j < 720) hourly[j] = Math.max(hourly[j], n); }
  for (let j = 1; j < 720; j++) if (!hourly[j]) hourly[j] = hourly[j - 1];
  const rt = g.reviewTotals || {}, keys = Object.keys(rt).sort();
  const at = (day) => { const k = keys.filter((x) => x <= day).pop(); return k ? rt[k] : { positive: 0, negative: 0 }; };
  const d = { pos: [], neg: [], wish: [], gross: [], units: [] };
  days.forEach((day) => {
    const a = at(day), b = at(iso(Date.parse(day) / 1000 - DAY)), w = wish?.apps?.[id]?.days?.[day], s = sales?.days?.[day]?.[id];
    d.pos.push(Math.max(0, a.positive - b.positive)); d.neg.push(Math.max(0, a.negative - b.negative));
    d.wish.push(w ? (w.adds || 0) - (w.deletes || 0) - (w.purchases || 0) - (w.gifts || 0) : 0);
    d.gross.push(s?.gross || 0); d.units.push(s?.units || 0);
  });
  const last = at(days[29]), total = last.positive + last.negative;
  const items = Object.entries(g.items || {}).filter(([, x]) => !x.dev && !x.offTopic);
  const posts = items.map(([pid, x]) => ({ id: pid, kind: x.kind, t: x.created, who: x.author?.name || "", text: x.text || "", up: x.votedUp, summary: x.triage?.summary || "", title: x.title || null,
    hours: x.playtime != null ? Math.round(x.playtime / 6) / 10 : null, url: x.url, parent: x.parent || x.video || x.topic || null, views: x.views, answered: !!x.devResponse, issues: [],
    points: (x.triage?.points || []).map((p) => ({ kind: p.kind === "suggestion" ? "idea" : p.kind === "praise" ? "loved" : p.kind, text: p.text || p.title || "", at: p.at ?? "" })) }));
  const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
  const KIND = { bug: "bug", suggestion: "idea", praise: "loved" };
  const issues = Object.values(g.issues || {}).filter((x) => KIND[x.kind] && x.status !== "likely_fixed").map((x) => {
    (x.items || []).forEach((pid) => byId[pid]?.issues.push(x.id));
    return { id: x.id, kind: KIND[x.kind], title: x.title, urgency: x.urgency || null, mentions: x.mentions || 0, status: x.status, firstSeen: x.firstSeen, lastSeen: x.lastSeen, refunds: x.refunds || 0,
      negativeReviews: x.negativeReviews || 0, summary: x.summary || "", fixedIn: x.fixedIn, posts: (x.items || []).filter((pid) => byId[pid]) };
  });
  const media = Object.entries(g.media?.items || {}).filter(([, m]) => m.source !== "copy" && !m.own).map(([mid, m]) => ({ id: mid, source: m.source, title: m.title || m.url, by: m.author || m.channel || m.site || "", t: m.at, views: m.views, viewers: m.viewers, live: !!m.live, url: m.url, post: byId[mid] ? mid : null }));
  const play = (sw?.apps?.[id]?.pages?.playtime || []).flatMap((t) => t.rows);
  return { id, name: meta.name || g.meta?.name || id, hue: (i * 83 + 18) % 360, genre: "", hourly, d, reviewsTotal: total, pos: total ? Math.round((last.positive / total) * 100) : null,
    wishTotal: wish?.apps?.[id]?.total ?? null, issues, posts, media,
    updates: (g.releases || []).slice().sort((a, b) => b.time - a.time).slice(0, 6).map((u) => ({ t: u.time, title: u.title, fixed: (u.matched || []).length, notes: "", url: u.url })),
    achievements: (g.achievements || []).map((a) => ({ name: a.name, pct: a.percent ?? a.pct ?? 0 })).sort((a, b) => b.pct - a.pct).slice(0, 8),
    stats: { median: play.find((r) => /^Median time played/.test(r[0]))?.[1] || "–", reach: play.filter((r) => /^\d+ (minutes?|hours?)/.test(r[0]) && /%$/.test(r[1] || "")).slice(0, 6).map((r) => [r[0].replace(/ hours?/, " h").replace(/ minutes?/, " min"), parseFloat(r[1])]), refundRate: null },
    curators: (g.curators || []).slice(0, 5).map((c) => ({ name: c.name, followers: c.followers || 0, up: c.recommended !== false })), bundles: [], competitors: [] };
}

export async function loadData() {
  const index = await get("index.json");
  if (!index?.games?.length) return sample();
  const [sales, wish, sw] = await Promise.all([get("sales.json"), get("wishlists.json"), get("steamworks.json")]);
  const games = (await Promise.all(index.games.map(async (m, i) => { const g = await get(`games/${m.appId}.json`); try { return g && adapt(m, g, sales, wish, sw, i); } catch (e) { console.warn("Could not read", m.appId, e); return null; } }))).filter(Boolean);
  return games.length ? { sample: false, games } : sample();
}
