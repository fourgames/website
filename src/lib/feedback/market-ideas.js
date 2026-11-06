// The Market page's "My game ideas": the owner types a game idea, the server asks Claude to score it
// against the real Steam market data, and keeps it. Each idea shows Claude's score and a sparkline of
// its daily market score (worked out by the server from that day's market files, no Claude), the Steam
// tags it maps to, its hook and what it already has, the sub-scores with their reasons, the verdict,
// pivots, alternatives and timing. The owner pins ideas and gives them 1-5 stars; "Your order" sorts
// pinned first, then by Claude's score moved by the stars (myRank).
//
// Contract: ideasView(ctx, files, redraw) returns one element (.mkv-ideas), kept and handed back on
// later calls (so a page redraw keeps the typed text and the open forms). files = { overview, trends,
// games, growth }. The server: ctx.adminGet("ideas") and ctx.adminSend("ideas…", method, body), see
// server/gamedata/ideas.py. With ctx.dataOverride set there is no server: a local fake keeps the ideas
// in memory and answers with a canned analysis built from the real files (tags found by keyword).

const PREFIX = "mkv-ideas-";
const MAX_IDEA = 2000; // the server's limit for one idea
const MAX_BOX = 20000; // several ideas pasted at once
// What Claude needs to score an idea well. No blank lines inside, so several filled-in copies
// separated by a blank line still count as several ideas.
export const IDEA_TEMPLATE = [
  "Working title:",
  "In one sentence:",
  "Genre (closest Steam tags):",
  "2D or 3D, camera (top-down, side, first/third person):",
  "Art style:",
  "Core loop (what you do minute to minute):",
  "Progression (upgrades, skill tree, unlocks):",
  "Modes (story, endless, free roam, missions):",
  "Players (solo, local co-op, online co-op, PvP; how many):",
  "Hook (what's new or different):",
  "Like these games:",
  "Scope (team, months to make, hours of play):",
  "Price:",
  "Extras (leaderboards, Steam Deck, mods, demo):",
].join("\n");
// A prompt to paste into Claude (claude.ai or the app): it grills the owner on an idea, one question at a
// time, and ends with the template filled in, ready for the box.
export const INTERVIEW_PROMPT = `I'm a small indie developer (a Godot studio) and I want to get a game idea scored against Steam market data. Before I score it, grill me on it so the idea is specific enough to judge.

Ask me ONE question at a time and wait for my answer. Cover everything in the template below, but don't just read it out: dig where my answers are vague, push back when something sounds generic, too big for a small team or unclear about what's new, and ask what similar games do better. Suggest concrete options when I'm unsure (e.g. "2D side view like X, or 3D top-down like Y?"). About 8-15 questions is plenty; stop sooner if the idea is clear.

When we're done, reply with ONLY the template below, filled in with my answers (short, concrete phrases; leave a line empty if we never settled it). No other text, so I can paste it straight into my dashboard.

${IDEA_TEMPLATE}

My idea, roughly: `;

// Several ideas in one paste: a numbered or bulleted list ("1. …", "2) …", "- …", "• …" at a line
// start), or else chunks separated by a blank line. Returns the ideas (2+), or [] when it's one idea.
export function splitIdeas(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!t) return [];
  const MARK = /^[ \t]*(?:\d{1,3}[.)]|[-*•])[ \t]+/;
  const lines = t.split("\n");
  const marked = lines.filter((l) => MARK.test(l)).length;
  let parts = [];
  if (marked >= 2 && MARK.test(lines[0])) {
    for (const l of lines) {
      if (MARK.test(l)) parts.push(l.replace(MARK, ""));
      else if (parts.length) parts[parts.length - 1] += `\n${l}`;
    }
  } else parts = t.split(/\n[ \t]*\n+/);
  parts = parts.map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : [];
}
// The ideas still to send, back in the box as a numbered list.
const joinIdeas = (list) => list.length === 1 ? list[0] : list.map((x, i) => `${i + 1}. ${x}`).join("\n\n");
const FAKE_MODEL = "test mode (no Claude)";
const SUBSCORES = [
  ["demand", "Demand", "Do players want this now? Share of new reviews going to these tags, and what a typical game gets."],
  ["competition", "Competition", "High = few rivals. How fast the tags' share of releases is growing."],
  ["hit_odds", "Hit odds", "How often a game with these tags lands in the top 10% of reviews."],
  ["small_team_fit", "Small-team fit", "Can 1-3 people make it in Godot in months?"],
  ["timing", "Timing", "Is now a good moment, or is it too early or too late?"],
];
const TIMING = { now: "Make it now", soon: "Soon: prepare, watch the signal", wait: "Wait" };
const BIG = ["Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Souls-like", "Realistic", "Photorealistic", "Story Rich"];
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature", "Gore", "Violent"];
// Stars move an idea in "Your order": 3 stars leave Claude's score as it is, each star more or less ±8.
const STAR_STEP = 8;
export const myRank = (idea) => (idea.analysis?.score ?? 40) + (idea.stars ? (idea.stars - 3) * STAR_STEP : 0);
const SORTS = {
  mine: ["Your order", "Pinned first, then Claude's score moved by your stars (5★ +16, 4★ +8, 3★ ±0, 2★ −8, 1★ −16)"],
  claude: ["Claude's score", "Claude's latest score only"],
  market: ["Market score", "Today's market score for its tags"],
  newest: ["Newest", "The most recently added first"],
};
export function sortIdeas(ideas, by = "mine") {
  const market = (i) => i.points?.length ? i.points[i.points.length - 1].score : -1;
  const key = { mine: myRank, claude: (i) => i.analysis?.score ?? -1, market, newest: (i) => i.created }[by] || myRank;
  return [...ideas].sort((x, y) => (by === "mine" ? Number(!!y.pinned) - Number(!!x.pinned) : 0) || key(y) - key(x) || y.created - x.created);
}
const META = ["Indie", "Singleplayer", "Casual", "2D", "3D", "Free to Play", "Early Access", "Great Soundtrack", "Addictive", "Replay Value", "Classic", "Beautiful", "Masterpiece"];

// ---------------------------------------------------------------------------
// The market score, the same formula as the server's (ideas.py, market_score)
// ---------------------------------------------------------------------------

const clamp = (x) => Math.max(0, Math.min(100, x));
const log2 = (x) => Math.log2(Math.max(x, 1e-3));
const round1 = (x) => Math.round(x * 10) / 10;

function marketOf(files) {
  const t = files.trends || {};
  return {
    tags: new Map((t.tags || []).map((r) => [r.tag, r])),
    base: t.baseHitRate || 0.1,
    baseMedian: t.baseMedianReviews || 0,
    prior: t.priorGames || 30,
    window: t.hitRateWindow || [14, 180],
    today: files.overview?.today,
  };
}

function tagScore(r, m) {
  const hit = clamp(50 + 25 * log2((r.hitRate || m.base) / m.base));
  const crowd = r.supply ? clamp(50 - 20 * log2(r.supply)) : 50;
  const demand = r.demand ? clamp(50 + 25 * log2(r.demand)) : 50;
  const reviews = clamp(50 + 12 * log2(((r.medianReviews || 0) + 1) / (m.baseMedian + 1)));
  return { id: r.tag, name: r.name, hit, crowd, demand, reviews, score: round1(0.45 * hit + 0.2 * crowd + 0.15 * demand + 0.2 * reviews) };
}

const ratedCache = new WeakMap();
function ratedGames(games) {
  if (!games?.rows) return [];
  if (ratedCache.has(games)) return ratedCache.get(games);
  const c = Object.fromEntries((games.columns || []).map((n, i) => [n, i]));
  const top = games.topTags || 5;
  const out = [];
  for (const row of games.rows) if (row[c.hit] != null && row[c.day] != null) out.push([new Set((row[c.tags] || []).slice(0, top)), row[c.day], row[c.hit]]);
  ratedCache.set(games, out);
  return out;
}

function bestPair(ids, files, m) {
  if (ids.length < 2 || typeof m.today !== "number") return null;
  const first = m.today - m.window[1], last = m.today - m.window[0];
  const pairs = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push({ tags: [ids[i], ids[j]], games: 0, hits: 0 });
  for (const [tags, day, hit] of ratedGames(files.games)) {
    if (day < first || day > last) continue;
    for (const p of pairs) if (tags.has(p.tags[0]) && tags.has(p.tags[1])) { p.games++; if (hit >= 90) p.hits++; }
  }
  let best = null;
  for (const p of pairs) {
    if (p.games < 10) continue;
    p.hitRate = (p.hits + m.prior * m.base) / (p.games + m.prior);
    if (!best || p.hitRate > best.hitRate) best = p;
  }
  if (best) {
    best.score = round1(clamp(50 + 25 * log2(best.hitRate / m.base)));
    const names = tagNames(files);
    best.names = best.tags.map((t) => names.get(t) || `Tag ${t}`);
  }
  return best;
}

export function marketScore(ids, files) {
  const m = marketOf(files);
  const parts = ids.filter((id) => m.tags.has(id)).map((id) => tagScore(m.tags.get(id), m));
  if (!parts.length) return null;
  const w = parts.map((_, i) => 1 / (1 + 0.25 * i));
  const tags = parts.reduce((s, p, i) => s + w[i] * p.score, 0) / w.reduce((a, b) => a + b, 0);
  const pair = bestPair(ids, files, m);
  return { score: Math.round(pair ? 0.7 * tags + 0.3 * pair.score : tags), tagsScore: round1(tags), tags: parts, pair };
}

// ---------------------------------------------------------------------------
// Test mode: tags by keyword, a canned analysis from the real numbers, an in-memory server
// ---------------------------------------------------------------------------

function tagNames(files) {
  const names = new Map(Object.entries(files.overview?.tags || {}).map(([k, v]) => [Number(k), v]));
  for (const r of files.trends?.tags || []) names.set(r.tag, r.name);
  return names;
}

// "dwarves" -> "dwarf", "zombies" -> "zombie", "farming" stays: a light stem for keyword matching.
const stem = (w) => w.replace(/([lr])ves$/, "$1f").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
const words = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).map(stem);

export function mapTags(text, files) {
  const said = new Set(words(text));
  const joined = " " + words(text).join(" ") + " ";
  const m = marketOf(files);
  const found = [];
  for (const [id, name] of tagNames(files)) {
    const w = words(name);
    if (!w.length || META.includes(name)) continue;
    // A one-word tag: that word; a longer one: all its words, or the phrase.
    const hit = w.length === 1 ? said.has(w[0]) : joined.includes(" " + w.join(" ") + " ") || w.every((x) => x.length > 2 && said.has(x));
    if (hit) found.push({ id, name, weight: w.length * 10 + (m.tags.get(id)?.releases || 0) / 1000 });
  }
  found.sort((a, b) => b.weight - a.weight);
  const ids = found.slice(0, 5).map((f) => f.id);
  if (!ids.length) for (const name of ["Indie", "Casual"]) { const id = [...tagNames(files)].find(([, n]) => n === name)?.[0]; if (id != null) ids.push(id); }
  return ids;
}

const pct = (x) => (x == null ? "?" : `${Math.round(100 * x)}%`);

export function cannedAnalysis(text, files, at = Math.floor(Date.now() / 1000)) {
  const m = marketOf(files);
  const names = tagNames(files);
  const ids = mapTags(text, files);
  const rated = ids.filter((id) => m.tags.has(id)).map((id) => ({ r: m.tags.get(id), s: tagScore(m.tags.get(id), m) }));
  const avg = (f) => (rated.length ? rated.reduce((s, x) => s + f(x), 0) / rated.length : 50);
  const big = ids.filter((id) => BIG.includes(names.get(id))).length;
  const core = rated[0];
  const sub = {
    demand: Math.round(avg((x) => (x.r.demand ? x.s.demand : x.s.reviews))),
    competition: Math.round(avg((x) => x.s.crowd)),
    hit_odds: Math.round(avg((x) => x.s.hit)),
    small_team_fit: clamp(75 - 15 * big),
    timing: Math.round(avg((x) => (x.s.crowd + x.s.demand) / 2)),
  };
  const score = Math.round(0.25 * sub.demand + 0.2 * sub.competition + 0.25 * sub.hit_odds + 0.15 * sub.small_team_fit + 0.15 * sub.timing);
  const line = (x) => `${x.r.name}: ${pct(x.r.hitRate)} of games hit (Steam ${pct(m.base)}), a typical game gets ${x.r.medianReviews} reviews`;
  const reasons = {
    demand: core ? `${core.r.name}: typical game ${core.r.medianReviews} reviews, top 10% ${core.r.topReviews}` : "No rated tag found in the idea",
    competition: core ? `${core.r.name}: ${core.r.releases} releases in 90 days, ${core.r.supply ? `×${core.r.supply.toFixed(1)}` : "?"} its share a year ago` : "No rated tag found",
    hit_odds: core ? line(core) : "No rated tag found",
    small_team_fit: big ? `${big} big-build tag${big > 1 ? "s" : ""} (multiplayer, open world…)` : "No big-build tags",
    timing: core?.r.demand ? `Demand ×${core.r.demand.toFixed(2)} vs the window before` : "Demand not known yet; judged on supply",
  };
  // Pivots and alternatives: the strongest rated tags with enough games that the idea doesn't have.
  const others = [...m.tags.values()].filter((r) => !ids.includes(r.tag) && !META.includes(r.name) && !BIG.includes(r.name) && !ADULT.includes(r.name) && (r.hitGames || 0) >= 40 && (r.releases || 0) >= 30)
    .map((r) => ({ r, s: tagScore(r, m) })).sort((a, b) => b.s.score - a.s.score);
  const pivots = others.slice(0, 2).map((x) => ({ change: `Add ${x.r.name}`, why: line(x) }));
  if (big) pivots.push({ change: "Cut it to single-player", why: "Multiplayer and big worlds are the heaviest scope for 1-3 people" });
  const alternatives = others.slice(2, 5).map((x) => ({ idea: `A small ${x.r.name.toLowerCase()} game`, why: line(x) }));
  const crowding = avg((x) => x.r.supply || 1);
  return {
    id: at, at, day: dayOf(files), model: FAKE_MODEL,
    tags: ids.map((id) => ({ id, name: names.get(id) || `Tag ${id}`, why: "keyword in the idea" })),
    hook: `Test mode: the hook would be named here (${ideaTitle(text)})`,
    has: ids.map((id) => names.get(id) || `Tag ${id}`),
    score,
    subscores: SUBSCORES.map(([key]) => ({ key, score: sub[key], reason: reasons[key] })),
    verdict: `Test mode, not Claude: a canned summary from today's numbers. ${core ? `The core tag ${core.r.name} scores ${Math.round(core.s.score)} on the market (50 is an average tag).` : "No tag in the data matched the idea's words."}`,
    risks: [crowding > 1.5 ? "The tags are getting crowded fast" : "Few rivals can also mean few players", big ? "Scope: big-build tags" : "Standing out without a clear hook"],
    pivots,
    alternatives,
    timing: { advice: crowding > 1.8 ? "wait" : sub.timing >= 55 ? "now" : "soon", detail: `The tags' share of releases is ×${crowding.toFixed(1)} a year ago.`, watch: core ? `${core.r.name}'s supply going over ×${Math.max(1.5, (core.r.supply || 1) + 0.5).toFixed(1)}` : "A matching tag appearing" },
  };
}

function dayOf(files) {
  const t = files.overview?.today;
  return typeof t === "number" ? new Date(t * 86400000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

// Test mode's "Make 5 top ideas": the strongest rated tags paired off, each pair's biggest games of the
// last year as the similar games. The server picks pairs from real pair stats and Claude writes the ideas.
export function cannedDrafts(files, direction = "") {
  const m = marketOf(files);
  const strong = [...m.tags.values()].filter((r) => !META.includes(r.name) && !BIG.includes(r.name) && !ADULT.includes(r.name) && (r.hitGames || 0) >= 40)
    .map((r) => ({ r, s: tagScore(r, m) })).sort((a, b) => b.s.score - a.s.score).slice(0, 16);
  const g = files.games;
  const c = Object.fromEntries((g?.columns || []).map((n, i) => [n, i]));
  const drafts = [];
  for (let i = 0; i + 1 < strong.length && drafts.length < 8; i += 2) {
    const [a, b] = [strong[i].r, strong[i + 1].r];
    const similar = (g?.rows || []).filter((row) => typeof m.today === "number" && m.today - row[c.day] <= 365 && row[c.tags]?.slice(0, 5).includes(a.tag) && row[c.tags]?.slice(0, 5).includes(b.tag))
      .sort((x, y) => (y[c.reviews] || 0) - (x[c.reviews] || 0)).slice(0, 4)
      .map((row) => ({ appid: row[c.appid], name: row[c.name], reviews: row[c.reviews] || 0, released: new Date(row[c.day] * 86400000).toISOString().slice(0, 10), url: `https://store.steampowered.com/app/${row[c.appid]}/` }));
    const title = `Test ${a.name} × ${b.name}`;
    const text = IDEA_TEMPLATE.split("\n").map((line) => line.startsWith("Working title") ? `${line} ${title}`
      : line.startsWith("Genre") ? `${line} ${a.name}, ${b.name}` : line.startsWith("Like these") ? `${line} ${similar.map((x) => x.name).join(", ")}`
      : line.startsWith("Scope") ? `${line} 1-2 people, 4 months` : `${line} test mode${direction ? ` (${direction})` : ""}`).join("\n");
    const score = marketScore([a.tag, b.tag], files)?.score ?? 50;
    drafts.push({ text, title, why: `Test mode, not Claude: ${a.name} ${pct(a.hitRate)} hit, ${b.name} ${pct(b.hitRate)} hit (Steam ${pct(m.base)}).`,
      pair: { tags: [a.tag, b.tag], names: [a.name, b.name], score }, similar });
  }
  return drafts;
}

// The in-memory server. A text with "fail" in it fails on purpose, to try the error path.
export function fakeApi(files, delay = 1500) {
  const ideas = [];
  let next = 1;
  const wait = () => new Promise((r) => setTimeout(r, delay));
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const points = (tags, days = 14) => {
    const p = marketScore(tags, files);
    if (!p) return [];
    const today = new Date(dayOf(files));
    // Made-up earlier days (test mode only), so the sparkline has a shape to draw.
    return Array.from({ length: days }, (_, i) => {
      const d = new Date(today.getTime() - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
      const wobble = i === days - 1 ? 0 : Math.round(6 * Math.sin(i * 0.9 + tags[0]) - (days - 1 - i) * 0.3);
      return { day: d, score: Math.round(clamp(p.score + wobble)), tagsScore: p.tagsScore, pair: p.pair, tags: p.tags };
    });
  };
  const analyse = (idea) => {
    if (/fail/i.test(idea.text)) throw Object.assign(new Error("Test mode: an idea with \"fail\" in it fails on purpose"), { status: 502 });
    const a = cannedAnalysis(idea.text, files, Math.floor(Date.now() / 1000) + idea.analyses.length);
    idea.analysis = a;
    idea.analyses.push({ id: a.id, at: a.at, day: a.day, model: a.model, text: idea.text, score: a.score });
    idea.tags = a.tags.map((t) => t.id);
    idea.points = points(idea.tags);
  };
  const find = (id) => {
    const idea = ideas.find((i) => i.id === id);
    if (!idea) throw Object.assign(new Error("no idea with that id"), { status: 404 });
    return idea;
  };
  return {
    test: true,
    async list() { return { ideas: copy([...ideas].sort((a, b) => b.created - a.created || b.id - a.id)), market: { day: dayOf(files) }, claude: false, model: FAKE_MODEL }; },
    async create(text, notes = "") {
      await wait();
      const now = Math.floor(Date.now() / 1000);
      const idea = { id: next++, text: text.trim(), notes, archived: false, pinned: false, stars: 0, tags: [], created: now, updated: now, analysis: null, analyses: [], points: [] };
      analyse(idea);
      ideas.push(idea);
      return copy(idea);
    },
    async rescore(id) { await wait(); const idea = find(id); analyse(idea); return copy(idea); },
    async generate(direction = "") {
      await wait();
      if (/fail/i.test(direction)) throw Object.assign(new Error("Test mode: a direction with \"fail\" in it fails on purpose"), { status: 502 });
      const drafts = cannedDrafts(files, direction);
      return { drafts, keep: Math.min(5, drafts.length), day: dayOf(files), model: FAKE_MODEL };
    },
    async update(id, changes) { const idea = find(id); Object.assign(idea, changes, { updated: Math.floor(Date.now() / 1000) }); return copy(idea); },
    async remove(id) { const i = ideas.findIndex((x) => x.id === id); if (i < 0) throw new Error("no idea with that id"); ideas.splice(i, 1); },
  };
}

function serverApi(ctx) {
  const json = async (res) => res.json();
  return {
    test: false,
    list: async () => json(await ctx.adminGet("ideas")),
    create: async (text, notes) => (await json(await ctx.adminSend("ideas", "POST", notes ? { text, notes } : { text }))).idea,
    rescore: async (id) => (await json(await ctx.adminSend(`ideas/${id}/score`, "POST", {}))).idea,
    // One Claude call for all eight drafts: give it as long as the server gives Claude (5 minutes).
    generate: async (direction) => json(await ctx.adminSend("ideas/generate", "POST", direction ? { direction } : {}, 310000)),
    update: async (id, changes) => (await json(await ctx.adminSend(`ideas/${id}`, "PUT", changes))).idea,
    remove: async (id) => { await ctx.adminSend(`ideas/${id}`, "DELETE", {}); },
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

let kept = null;

export function ideasView(ctx, files, redraw) {
  injectCss();
  const mode = ctx.dataOverride ? "test" : "server";
  if (kept && kept.mode === mode) {
    kept.ctx = ctx;
    kept.files = files;
    kept.redraw = redraw;
    return kept.root;
  }
  const v = { mode, ctx, files, redraw, api: ctx.dataOverride ? fakeApi(files) : serverApi(ctx),
    ideas: null, error: null, loading: false, claude: null, market: null,
    submitting: null, submitError: null, generating: null, made: null, open: new Set(), busy: new Map(), editing: new Set(), noteDrafts: new Map(), focusNotes: null, showArchived: false, flash: null, sort: "mine" };
  kept = v;
  const { h } = ctx;
  v.root = h("section.mkv-ideas", { "aria-label": "My game ideas" });
  v.box = h("textarea.mki-text", { rows: 5, maxlength: MAX_BOX, placeholder: "Describe the game: what you do, the hook, the look, the scope. E.g. \"A cozy organizing game in a dwarf mine: sort ore carts against a timer, 2 hours of content, made in 3 months.\"\nSeveral ideas? Paste them as a numbered list (1. … 2. …) or with a blank line between them.",
    "aria-label": "Your game idea", oninput: () => { store(v, "draft", v.box.value); paintComposer(v); } });
  v.box.value = load(v, "draft") || "";
  try { v.open = new Set(JSON.parse(load(v, "open") || "[]")); } catch {}
  if (SORTS[load(v, "sort")]) v.sort = load(v, "sort");
  v.box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { if (splitIdeas(v.box.value).length) submitAll(v); else submit(v); } });
  v.composer = h("div.mki-composer");
  v.list = h("div.mki-list");
  v.madeBox = h("div.mki-made-box", { hidden: true });
  v.root.append(
    h("div.mki-head",
      h("h2.mki-title", "My game ideas"),
      h("p.mki-sub", "Type a game idea and Claude scores it against today's Steam data: which tags it is, how many games in them become hits, how crowded they are and whether they're growing. It suggests pivots and other ideas. Ideas are kept and get a fresh market score every day, because timing matters: the same idea can flop early and hit a year later."),
      v.mode === "test" ? h("p.mki-test", h("b", "Test mode: not saved, not Claude."), " Ideas live in this tab only, the analysis is canned from the real market files (tags found by keyword), the earlier days of the sparkline are made up. Put \"fail\" in an idea to try the error (in a list of ideas, it stops there and keeps the unsent ones in the box).") : null),
    v.composer, v.madeBox, v.list);
  paintComposer(v);
  refresh(v);
  return v.root;
}

const store = (v, k, val) => { try { v.ctx.store?.set(PREFIX + k, val); } catch {} };
const load = (v, k) => { try { return v.ctx.store?.get(PREFIX + k); } catch { return null; } };

async function refresh(v) {
  v.loading = true;
  paintList(v);
  try {
    const body = await v.api.list();
    v.ideas = body.ideas || [];
    v.claude = body.claude;
    v.market = body.market;
    v.error = null;
  } catch (e) {
    if (e.signedOut) return;
    // 404/405: the server still runs code from before ideas.py (it needs a restart to pick it up).
    v.error = [404, 405].includes(e.status) || /HTTP 40[45]\b/.test(e.message || "")
      ? "The game-data server isn't running the ideas code yet: it needs the new package and a restart (see server/gamedata/README.md, My game ideas)."
      : `Couldn't load the ideas: ${e.message}`;
  } finally {
    v.loading = false;
  }
  paintComposer(v);
  paintList(v);
}

function errorText(e) {
  if (e.name === "TimeoutError") return "The server didn't answer in time. Claude may still be busy: try again in a minute.";
  return e.reason || e.message || String(e);
}

async function submit(v) {
  const text = v.box.value.trim();
  if (!text || v.submitting) return;
  v.submitting = { started: Date.now() };
  v.submitError = null;
  paintComposer(v);
  const timer = setInterval(() => tick(v.status), 1000);
  try {
    const idea = await v.api.create(text);
    v.ideas = [idea, ...(v.ideas || []).filter((i) => i.id !== idea.id)];
    v.box.value = "";
    store(v, "draft", "");
    v.flash = idea.id;
  } catch (e) {
    if (!e.signedOut) v.submitError = `Not scored: ${errorText(e)} Your text is still in the box.`;
  } finally {
    clearInterval(timer);
    v.submitting = null;
  }
  paintComposer(v);
  paintList(v);
}

// Several ideas, one after another (each takes the server 30-60 s). Typed ones: the box always holds
// exactly the ideas not yet scored, so a failure (or closing the page) loses nothing. Made ones ("Make 5
// top ideas"): the ones not scored are put in the box when it fails.
function submitAll(v) {
  const list = splitIdeas(v.box.value);
  if (list.length < 2 || list.some((x) => x.length > MAX_IDEA)) return;
  return scoreAll(v, list.map((text) => ({ text })), true);
}

async function scoreAll(v, items, fromBox) {
  if (v.submitting) return;
  const n = items.length, left = [...items];
  v.submitError = null;
  let done = 0;
  try {
    while (left.length) {
      v.submitting = { started: Date.now(), i: done + 1, n };
      paintComposer(v);
      paintMade(v);
      const timer = setInterval(() => tick(v.status), 1000);
      try {
        const idea = await v.api.create(left[0].text, left[0].notes);
        v.ideas = [idea, ...(v.ideas || []).filter((i) => i.id !== idea.id)];
        // Highlighted, not scrolled to: the owner is watching the progress, and the page shouldn't move.
        v.flash = idea.id;
        v.flashQuiet = true;
        if (left[0].made) left[0].made.idea = idea;
        left.shift();
        done++;
        if (fromBox) { v.box.value = joinIdeas(left.map((x) => x.text)); store(v, "draft", v.box.value); }
        paintList(v);
      } finally {
        clearInterval(timer);
      }
    }
  } catch (e) {
    if (!fromBox && left.length) {
      const cur = v.box.value.trim();
      v.box.value = [cur, joinIdeas(left.map((x) => x.text))].filter(Boolean).join("\n\n");
      store(v, "draft", v.box.value);
    }
    if (!e.signedOut) v.submitError = `Idea ${done + 1} of ${n} not scored: ${errorText(e).replace(/([^.!?])$/, "$1.")} ${done ? `${done} scored; the` : "The"} ${left.length === 1 ? "unsent idea is" : `${left.length} unsent ideas are`} ${fromBox ? "still" : "now"} in the box.`;
  } finally {
    v.submitting = null;
  }
  paintComposer(v);
  paintMade(v);
  paintList(v);
}

// "Make 5 top ideas": the server picks the strongest, most varied tag pairs in today's data and Claude
// drafts an idea on each; then each is scored and kept like a typed idea. Its similar games go in the
// idea's notes (as links), and the drafts stay on show above the list until closed.
async function generate(v) {
  if (v.submitting || v.generating) return;
  const direction = v.genDir.value.trim();
  v.generating = { started: Date.now() };
  v.submitError = null;
  paintComposer(v);
  const timer = setInterval(() => tick(v.status), 1000);
  let body = null;
  try {
    body = await v.api.generate(direction);
  } catch (e) {
    if (!e.signedOut) v.submitError = `No ideas made: ${errorText(e)}`;
  } finally {
    clearInterval(timer);
    v.generating = null;
  }
  if (!body?.drafts?.length) { paintComposer(v); return; }
  const keep = body.keep || Math.min(5, body.drafts.length);
  v.made = { day: body.day, direction, keep, drafts: body.drafts.map((d) => ({ ...d, idea: null, state: "waiting" })) };
  const notes = (d) => [`Made by "Make 5 top ideas" (${body.day}) on ${d.pair.names.join(" + ")}, market score ${d.pair.score}${direction ? `; your direction: ${direction}` : ""}.`,
    ...(d.similar?.length ? ["Similar games:", ...d.similar.map((g) => `- ${g.name}: ${g.url}`)] : [])].join("\n").slice(0, 4900);
  await scoreMade(v, notes);
}

// The drafts are scored two at a time (the server runs two Claude calls at once), then the best `keep`
// stay and the rest are archived (still there under "Show archived"). A draft that fails goes to the box.
async function scoreMade(v, notes) {
  const made = v.made, queue = [...made.drafts];
  const n = queue.length;
  let done = 0, failed = 0, lastError = null;
  v.submitting = { started: Date.now(), n, i: 1, made: true };
  v.submitError = null;
  paintComposer(v);
  paintMade(v);
  const timer = setInterval(() => tick(v.status), 1000);
  const worker = async () => {
    while (queue.length) {
      const d = queue.shift();
      d.state = "scoring";
      paintMade(v);
      try {
        const idea = await v.api.create(d.text, notes(d));
        d.idea = idea;
        d.state = "done";
        v.ideas = [idea, ...(v.ideas || []).filter((i) => i.id !== idea.id)];
        v.flash = idea.id;
        v.flashQuiet = true;
        paintList(v);
      } catch (e) {
        d.state = "failed";
        failed++;
        lastError = e;
        if (e.signedOut) queue.length = 0;
      }
      done++;
      v.submitting.i = Math.min(n, done + 1);
      v.submitting.done = done;
      paintComposer(v);
      paintMade(v);
    }
  };
  await Promise.all([worker(), worker()]);
  clearInterval(timer);
  // Keep the best: the others are archived, not deleted.
  const scored = made.drafts.filter((d) => d.state === "done").sort((x, y) => (y.idea.analysis?.score ?? -1) - (x.idea.analysis?.score ?? -1));
  for (const d of scored.slice(made.keep)) {
    try {
      d.idea = await v.api.update(d.idea.id, { archived: true });
      d.state = "archived";
      v.ideas = v.ideas.map((i) => (i.id === d.idea.id ? d.idea : i));
    } catch (e) { if (e.signedOut) break; }
  }
  made.ranked = true;
  const lost = made.drafts.filter((d) => d.state === "failed" || d.state === "waiting");
  if (lost.length) {
    const cur = v.box.value.trim();
    v.box.value = [cur, joinIdeas(lost.map((d) => d.text))].filter(Boolean).join("\n\n");
    store(v, "draft", v.box.value);
    if (lastError && !lastError.signedOut) v.submitError = `${lost.length} of ${n} ideas not scored: ${errorText(lastError).replace(/([^.!?])$/, "$1.")} ${lost.length === 1 ? "It is" : "They are"} in the box.`;
  }
  v.submitting = null;
  paintComposer(v);
  paintMade(v);
  paintList(v);
}

// The drafts just made: title, why, its tag pair, the similar games as links, and its score once in.
// Once all are scored they are shown best first, the ones not kept marked as archived.
function paintMade(v) {
  const { h } = v.ctx;
  if (!v.madeBox) return;
  if (!v.made) { v.madeBox.replaceChildren(); v.madeBox.hidden = true; return; }
  v.madeBox.hidden = false;
  const m = v.made;
  const shown = m.ranked ? [...m.drafts].sort((x, y) => (y.idea?.analysis?.score ?? -1) - (x.idea?.analysis?.score ?? -1)) : m.drafts;
  const kept = m.drafts.filter((d) => d.state === "done").length;
  const status = { waiting: "waiting to be scored", scoring: "scoring now", failed: "not scored (in the box)", archived: `archived: not in the best ${m.keep}`, done: m.ranked ? "kept" : "" };
  v.madeBox.replaceChildren(
    h("div.mki-made-head", h("h3", m.ranked ? `Just made: the best ${kept} of ${m.drafts.length} ideas` : `Making ${m.drafts.length} ideas, keeping the best ${m.keep}`),
      h("span.mki-muted", `Market data of ${m.day}${m.direction ? ` · direction: ${m.direction}` : ""}`),
      h("button.mki-link", { type: "button", disabled: !!v.submitting, onclick: () => { v.made = null; paintMade(v); } }, "Close")),
    h("ol.mki-made-list", shown.map((d) => {
      const s = d.idea?.analysis?.score;
      const [cls] = band(s);
      return h("li.mki-made", { class: d.state === "archived" || d.state === "failed" ? "mki-made-out" : null },
        h("div.mki-made-top", h("span.mki-s-score", { class: s != null ? `mki-${cls}` : null }, s ?? (d.state === "scoring" ? "…" : "–")),
          h("div", h("b", d.title), h("div.mki-muted", [`${d.pair.names.join(" + ")} · market ${d.pair.score}`, status[d.state]].filter(Boolean).join(" · ")))),
        d.why ? h("p.mki-made-why", d.why) : null,
        d.similar?.length ? h("p.mki-similar", h("b", "Similar games: "), ...d.similar.flatMap((g, j) => [j ? " · " : null,
          h("a", { href: g.url, target: "_blank", rel: "noopener noreferrer", title: `${(g.reviews || 0).toLocaleString()} reviews${g.released ? `, released ${g.released}` : ""}` }, g.name)]).filter(Boolean)) : null);
    })));
}

const STAGES = [[0, "Sending the idea and today's market data…"], [4, "Claude is mapping it to Steam tags…"], [15, "Claude is weighing demand, competition and hit odds…"], [35, "Writing pivots, alternatives and timing…"], [70, "Taking longer than usual, still waiting…"]];
const GEN_STAGES = [[0, "Picking the strongest tag pairs in today's data…"], [5, "Claude is drafting different ideas on them…"], [35, "Filling in the templates…"], [150, "Still writing (8 ideas take a while)…"]];
const stage = (s, stages = STAGES) => stages.filter(([at]) => s >= at).pop()[1];

// A progress bar that eases toward 95% (the real call has no progress to report) and names a stage.
// tick() repaints every .mki-progress inside a root in place, so nothing else is redrawn.
function progress(h, started, expected = 45, prefix = "", stages = STAGES) {
  const bar = h("span");
  const label = h("span.mki-progress-t");
  const el = h("div.mki-progress", { role: "status", "data-started": started }, h("div.mki-bar", bar), label);
  el._update = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    bar.style.width = `${(Math.min(0.95, 1 - Math.exp(-s / expected)) * 100).toFixed(1)}%`;
    label.textContent = `${prefix}${stage(s, stages)} ${s} s (usually 30-60 s)`;
  };
  el._update();
  return el;
}
const tick = (root) => root.querySelectorAll(".mki-progress").forEach((el) => el._update?.());

// The box itself is never re-inserted (that would lose focus and the cursor); only the button,
// the counter and the status line below it change.
function paintComposer(v) {
  const { h } = v.ctx;
  if (!v.button) {
    v.box.id = "mki-text";
    v.allButton = h("button.btn.primary", { type: "button", onclick: () => submitAll(v) });
    v.button = h("button.btn.primary", { type: "button", onclick: () => submit(v) });
    v.hint = h("span.mki-hint");
    v.status = h("div.mki-status");
    const useTemplate = h("button.btn", { type: "button", title: "Adds the template to the box: fill in what you know, leave the rest empty", onclick: () => {
      const cur = v.box.value.replace(/\s+$/, "");
      v.box.value = cur ? `${cur}\n\n${IDEA_TEMPLATE}` : IDEA_TEMPLATE;
      store(v, "draft", v.box.value); paintComposer(v); v.box.focus();
      const first = v.box.value.indexOf(":", v.box.value.lastIndexOf("Working title:")) + 1;
      v.box.setSelectionRange(first, first);
    } }, "Use the template");
    const copyTemplate = h("button.btn", { type: "button", title: "Copy the template, to fill in somewhere else first", onclick: (e) => v.ctx.copy?.(IDEA_TEMPLATE, e.currentTarget) }, "Copy template");
    const copyInterview = h("button.btn", { type: "button", title: "A prompt for Claude (claude.ai or the app): it asks you about the idea one question at a time, then gives you the filled-in template to paste here", onclick: (e) => v.ctx.copy?.(INTERVIEW_PROMPT, e.currentTarget) }, "Copy interview prompt");
    v.genDir = h("input.mki-gen-dir", { type: "text", maxlength: 300, placeholder: "Steer it (optional): e.g. cozy, solo, 3 months, no horror", "aria-label": "Direction for the new ideas",
      value: load(v, "gen-dir") || "", oninput: () => store(v, "gen-dir", v.genDir.value), onkeydown: (e) => { if (e.key === "Enter") generate(v); } });
    v.genButton = h("button.btn.primary", { type: "button", title: "Claude drafts 8 different ideas on the tag pairs most likely to score high in today's data; all 8 are scored like ideas you type and the best 5 are kept (the rest archived). About 5 minutes.", onclick: () => generate(v) }, "Make 5 top ideas");
    v.composer.append(h("div.mki-gen", h("div.mki-gen-t", h("b", "Out of ideas?"), " Make ideas aimed at the highest score: 8 drafts, each on a different strong, not-too-crowded tag pair from today's data, all scored, the best 5 kept. With similar recent games for inspiration."),
      h("div.mki-actions", v.genDir, v.genButton)));
    v.composer.append(h("div.mki-labelrow", h("label.mki-label", { for: "mki-text" }, "Your idea (or several)"), h("span.mki-tpl", useTemplate, copyTemplate, copyInterview)),
      h("p.mki-tip", "The more Claude knows, the better the score: 2D or 3D, the camera, solo or co-op, scope and what it's like. The template asks for all of it; fill in what you know. Not sure yet? \"Copy interview prompt\", paste it into Claude with your rough idea, answer its questions, and paste the template it gives back here."),
      v.box, h("div.mki-actions", v.allButton, v.button, v.hint), v.status);
  }
  const busy = !!v.submitting || !!v.generating;
  v.genButton.disabled = busy;
  v.genDir.disabled = busy;
  v.genButton.textContent = v.generating ? "Making ideas…" : v.submitting?.made ? `Scored ${v.submitting.done || 0} of ${v.submitting.n}…` : "Make 5 top ideas";
  const n = v.box.value.trim().length, many = splitIdeas(v.box.value), tooLong = many.filter((x) => x.length > MAX_IDEA).length;
  v.box.disabled = busy;
  v.allButton.style.display = many.length ? "" : "none";
  v.allButton.disabled = busy || !!tooLong;
  v.allButton.textContent = busy && v.submitting?.n && !v.submitting.made ? `Scoring ${v.submitting.i} of ${v.submitting.n}…` : `Score all ${many.length} ideas`;
  // With several ideas found, "as one" stays there (a long idea with paragraphs), as the second choice.
  v.button.className = many.length ? "btn" : "btn primary";
  v.button.disabled = busy || !n || n > MAX_IDEA;
  v.button.textContent = busy && v.submitting && !v.submitting.n ? "Scoring…" : many.length ? "Score it as one idea" : "Score this idea";
  v.hint.textContent = many.length
    ? `${many.length} ideas found (a list, or blank lines between them)${tooLong ? ` · ${tooLong} ${tooLong === 1 ? "is" : "are"} over ${MAX_IDEA} characters: shorten ${tooLong === 1 ? "it" : "them"}` : ""} · Ctrl+Enter scores all`
    : `${n}/${MAX_IDEA}${n > MAX_IDEA ? " · too long for one idea" : ""} · Ctrl+Enter to score`;
  const notice = v.claude === false && v.mode !== "test" ? h("p.mki-warn", "The server has no ANTHROPIC_API_KEY yet: scoring will fail until it's set in /etc/fourgames/gamedata.env (then restart gamedata).") : null;
  v.status.replaceChildren(
    ...[v.generating ? progress(h, v.generating.started, 50, "", GEN_STAGES) : null,
      v.submitting?.made ? progress(h, v.submitting.started, 25 * v.submitting.n, `${v.submitting.done || 0} of ${v.submitting.n} scored, two at a time: `) : null,
      v.submitting && !v.submitting.made ? progress(h, v.submitting.started, 45, v.submitting.n ? `${v.submitting.i} of ${v.submitting.n}: ` : "") : null,
      v.submitError ? h("p.mki-error", { role: "alert" }, v.submitError) : null,
      notice].filter(Boolean));
}

function paintList(v) {
  const { h } = v.ctx;
  if (v.loading && !v.ideas) { v.list.replaceChildren(h("p.mki-muted", "Loading your ideas…")); return; }
  if (v.error) { v.list.replaceChildren(h("p.mki-error", v.error), h("button.btn", { type: "button", onclick: () => refresh(v) }, "Try again")); return; }
  const all = v.ideas || [];
  const live = all.filter((i) => !i.archived);
  const archived = all.length - live.length;
  const shown = v.showArchived ? all : live;
  const head = h("div.mki-listhead",
    h("h3", all.length ? `${live.length} idea${live.length === 1 ? "" : "s"}` : "No ideas yet"),
    v.market?.day ? h("span.mki-muted", `Market data of ${v.market.day}`) : null,
    archived ? h("button.mki-link", { type: "button", onclick: () => { v.showArchived = !v.showArchived; paintList(v); } }, v.showArchived ? "Hide archived" : `Show ${archived} archived`) : null,
    all.length > 1 ? h("label.mki-sort", { title: SORTS[v.sort][1] }, "Sort ", (() => {
      const select = h("select", { "aria-label": "Sort the ideas", onchange: (e) => { v.sort = e.target.value; store(v, "sort", v.sort); paintList(v); } },
        Object.entries(SORTS).map(([k, [label, tip]]) => h("option", { value: k, title: tip }, label)));
      select.value = v.sort;
      return select;
    })()) : null,
    live.length > 1 ? (() => {
      const left = pendingIds(v, live).length;
      const label = v.rescoringAll ? `Re-scoring ${v.rescoringAll.i} of ${v.rescoringAll.n}… (keep this page open)`
        : left ? `Continue re-scoring (${left} left)` : `Re-score all ${live.length} with Claude`;
      return h("button.btn.mki-all", { type: "button", disabled: !!v.rescoringAll || v.busy.size > 0 && [...v.busy.values()].some((b) => !b.error),
        title: "Asks Claude again, one idea after another, with today's market data. If the page is closed midway, this button continues with the ones left.",
        onclick: () => rescoreAll(v) }, label);
    })() : null);
  if (!all.length) { v.list.replaceChildren(head, h("p.mki-muted", "Your scored ideas show up here, best score first.")); return; }
  const ranked = sortIdeas(shown, v.sort);
  v.list.replaceChildren(head, ...ranked.map((idea) => card(v, idea)));
  if (v.flash) {
    const el = v.list.querySelector(`[data-idea="${v.flash}"]`);
    v.flash = null;
    el?.classList.add("mki-new");
    if (!v.flashQuiet) el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    v.flashQuiet = false;
  }
}

const band = (s) => (s == null ? ["", "not scored"] : s >= 65 ? ["good", "promising"] : s >= 45 ? ["ok", "mixed"] : ["weak", "weak"]);
const shortDay = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function card(v, idea) {
  const { h } = v.ctx;
  const a = idea.analysis;
  const busy = v.busy.get(idea.id);
  const [cls, word] = band(a?.score);
  const points = idea.points || [];
  const last = points[points.length - 1];

  const scoreBox = h("div.mki-score",
    h("div.mki-big", a?.score ?? "–"),
    h("div.mki-score-t", h("span", h("i.mki-dot", { class: `mki-${cls}` }), ` ${word}`), h("small", a ? `Claude's score, ${shortDay(a.day)}` : "Not scored yet")));
  const marketBox = h("div.mki-market",
    h("div.mki-market-t", h("b", last ? `Market score ${last.score}` : "Market score –"), last && points.length > 1 ? delta(h, points) : null),
    points.length ? sparkline(v.ctx, points) : null,
    h("small.mki-muted", points.length > 1 ? `${points.length} days. From each day's Steam data for its tags, no Claude; 50 = an average tag.` : "Builds up one point a day from the Steam data for its tags, no Claude; 50 = an average tag."));

  const body = [];
  if (a) {
    const stats = new Map((v.files.trends?.tags || []).map((r) => [r.tag, r]));
    body.push(h("div.mki-tags", a.tags.map((t) => {
      const r = stats.get(t.id);
      return h("span.mki-chip", { title: `${t.why || ""}${r ? `\n${pct(r.hitRate)} of its games hit · typical ${r.medianReviews} reviews · ${r.releases} releases in 90 days` : "\nToo few recent games to rate"}` },
        t.name, r ? h("small", ` ${pct(r.hitRate)} hit`) : null);
    })));
    body.push(h("p.mki-muted.mki-tagnote", "Tag numbers show where buyers are and how crowded it is. They go with doing well; they don't cause it (hits collect more player tags, and good games do well anyway)."));
    if (a.hook) body.push(h("p.mki-hook", h("b", "The hook: "), a.hook));
    if (a.has?.length) body.push(h("p.mki-has", h("b", "Already has: "), a.has.join(" · ")));
    body.push(h("p.mki-verdict", a.verdict));
    body.push(h("div.mki-subs", (a.subscores || []).map((s) => {
      const meta = SUBSCORES.find(([k]) => k === s.key) || [s.key, s.key, ""];
      return h("div.mki-sub", { title: meta[2] },
        h("span.mki-sub-l", meta[1]),
        h("span.mki-sub-bar", { role: "img", "aria-label": `${meta[1]} ${s.score} of 100` }, h("span", { style: `width:${s.score ?? 0}%` })),
        h("b.mki-sub-n", s.score ?? "–"),
        h("span.mki-sub-r", s.reason));
    })));
    const t = a.timing || {};
    body.push(h("div.mki-timing", h("span.mki-pill", { class: `mki-t-${t.advice}` }, TIMING[t.advice] || t.advice), h("span", t.detail), t.watch ? h("span.mki-watch", h("b", "Watch: "), t.watch) : null));
    const tryIt = (text) => h("button.btn.mki-try", { type: "button", onclick: () => fill(v, text) }, "Score this instead");
    if (a.pivots?.length) body.push(h("div.mki-block", h("h4", "Pivots: change this idea"), h("ul", a.pivots.map((p) => h("li", h("b", p.change), " ", h("span", p.why), tryIt(`${idea.text}\n\nPivot: ${p.change}`))))));
    if (a.alternatives?.length) body.push(h("div.mki-block", h("h4", "Other ideas the data likes"), h("ul", a.alternatives.map((x) => h("li", h("b", x.idea), " ", h("span", x.why), tryIt(x.idea))))));
    if (a.risks?.length) body.push(h("div.mki-block", h("h4", "Risks"), h("ul.mki-risks", a.risks.map((r) => h("li", r)))));
    if ((idea.analyses || []).length > 1) body.push(h("p.mki-muted.mki-history", "Claude's scores so far: ", idea.analyses.map((x) => `${x.score ?? "–"} (${shortDay(x.day)})`).join(" → ")));
  }

  const editing = v.editing.has(idea.id);
  const notes = editing ? notesForm(v, idea) : idea.notes ? h("p.mki-notes", h("b", "Notes: "), ...linkify(h, idea.notes)) : null;
  const actions = h("div.mki-row",
    h("button.btn", { type: "button", disabled: !!busy, onclick: () => rescore(v, idea) }, a ? "Re-score with Claude" : "Score with Claude"),
    v.ctx.openTags && idea.tags?.length ? h("button.btn", { type: "button", title: "Opens Tag my game with this idea's tags: which of them go with doing well among the games most like it, and which to add",
      onclick: () => v.ctx.openTags({ tags: idea.tags, about: idea.text }) }, "Check its tags in Tag my game") : null,
    h("button.btn", { type: "button", disabled: editing, onclick: () => { v.editing.add(idea.id); v.focusNotes = idea.id; paintList(v); } }, idea.notes ? "Edit notes" : "Add notes"),
    h("button.btn", { type: "button", onclick: () => act(v, idea, () => v.api.update(idea.id, { archived: !idea.archived })) }, idea.archived ? "Unarchive" : "Archive"),
    h("button.btn.mki-danger", { type: "button", onclick: () => remove(v, idea) }, "Delete"));

  // Folded by default: one line with the score, the title, the timing and the tags; a click opens it.
  const open = v.open.has(idea.id);
  const toggle = () => { if (v.open.has(idea.id)) v.open.delete(idea.id); else v.open.add(idea.id); store(v, "open", JSON.stringify([...v.open])); paintList(v); };
  const summary = h("button.mki-summary", { type: "button", "aria-expanded": String(open), onclick: toggle },
    h("span.mki-s-score", { class: `mki-${cls}` }, a?.score ?? "–"),
    h("span.mki-s-main",
      h("b.mki-s-title", ideaTitle(idea.text)),
      h("span.mki-s-sub", [a?.timing?.advice ? { now: "Make now", soon: "Soon", wait: "Wait" }[a.timing.advice] || a.timing.advice : null, last ? `market ${last.score}` : null,
        ...(a?.tags || []).slice(0, 3).map((t) => t.name)].filter(Boolean).join(" · "))),
    busy?.started ? h("span.mki-s-busy", "scoring…") : null,
    h("span.mki-s-chev", { "aria-hidden": "true" }, open ? "▾" : "▸"));
  const headRow = h("div.mki-headrow", summary, mine(v, idea));
  const cls2 = [idea.archived ? "mki-archived" : "", idea.pinned ? "mki-pinned" : ""].filter(Boolean).join(" ") || null;
  if (!open) return h("article.mki-card.mki-folded", { "data-idea": idea.id, class: cls2 }, headRow,
    busy?.error ? h("p.mki-error", { role: "alert" }, busy.error) : null);
  return h("article.mki-card", { "data-idea": idea.id, class: cls2 },
    headRow,
    h("div.mki-top", scoreBox, marketBox),
    h("p.mki-idea", idea.text),
    idea.archived ? h("p.mki-muted", "Archived: no new market points.") : null,
    ...body, notes,
    busy?.started ? progress(h, busy.started) : null,
    busy?.error ? h("p.mki-error", { role: "alert" }, busy.error) : null,
    actions,
    h("p.mki-muted.mki-meta", `Added ${new Date(idea.created * 1000).toLocaleDateString()}${a ? ` · ${a.model}` : ""}`));
}

// The owner's own ranking, beside the summary: a pin and 1-5 stars (a click on the current star clears it).
function mine(v, idea) {
  const { h } = v.ctx;
  const set = (changes) => {
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, idea[k]]));
    Object.assign(idea, changes); // shown at once; the server's answer replaces it, a failure undoes it
    paintList(v);
    act(v, idea, () => v.api.update(idea.id, changes).catch((e) => { Object.assign(idea, before); throw e; }));
  };
  const stars = idea.stars || 0;
  return h("div.mki-mine",
    h("button.mki-pin", { type: "button", "aria-pressed": String(!!idea.pinned), title: idea.pinned ? "Unpin" : "Pin to the top of your order",
      onclick: () => set({ pinned: !idea.pinned }) }, h("span", { "aria-hidden": "true" }, "📌"), h("span.mki-sr", idea.pinned ? "Pinned" : "Pin")),
    h("span.mki-stars", { role: "group", "aria-label": `Your rating: ${stars ? `${stars} of 5` : "not rated"}` },
      [1, 2, 3, 4, 5].map((n) => h("button.mki-star", { type: "button", class: n <= stars ? "mki-on" : null, "aria-pressed": String(n === stars),
        title: n === stars ? "Clear your rating" : `${n} star${n > 1 ? "s" : ""}: ${n === 3 ? "keeps Claude's score" : `${n > 3 ? "+" : "−"}${Math.abs(n - 3) * STAR_STEP} in your order`}`,
        onclick: () => set({ stars: n === stars ? 0 : n }) }, n <= stars ? "★" : "☆"))));
}

// Text with its Steam store links clickable (the similar games "Make 5 top ideas" puts in the notes).
function linkify(h, text) {
  return text.split(/(https:\/\/store\.steampowered\.com\/app\/\d+\/?)/).map((part, i) =>
    i % 2 ? h("a", { href: part, target: "_blank", rel: "noopener noreferrer" }, part.replace(/^https:\/\//, "")) : part);
}

// "Working title: (crab fishing)" → "crab fishing"; otherwise the first line, cut short.
function ideaTitle(text) {
  const m = /^\s*working title\s*:\s*(.+)$/im.exec(text || "");
  const t = (m ? m[1] : (text || "").split("\n")[0]).replace(/^\((.*)\)$/, "$1").trim();
  return t.length > 70 ? t.slice(0, 67) + "…" : t || "Untitled idea";
}

function delta(h, points) {
  const d = points[points.length - 1].score - points[0].score;
  return h("small.mki-delta", d === 0 ? " flat" : ` ${d > 0 ? "+" : "−"}${Math.abs(d)} since ${shortDay(points[0].day)}`);
}

function fill(v, text) {
  v.box.value = text.slice(0, 2000);
  store(v, "draft", v.box.value);
  paintComposer(v);
  v.box.scrollIntoView?.({ block: "center", behavior: "smooth" });
  v.box.focus();
}

async function act(v, idea, call) {
  try {
    const updated = await call();
    if (updated) v.ideas = v.ideas.map((i) => (i.id === idea.id ? updated : i));
    v.busy.delete(idea.id);
  } catch (e) {
    if (e.signedOut) return;
    v.busy.set(idea.id, { error: errorText(e) });
  }
  paintList(v);
}

async function rescore(v, idea) {
  v.busy.set(idea.id, { started: Date.now() });
  paintList(v);
  const timer = setInterval(() => tick(v.list), 1000);
  try {
    const updated = await v.api.rescore(idea.id);
    v.ideas = v.ideas.map((i) => (i.id === idea.id ? updated : i));
    v.busy.delete(idea.id);
  } catch (e) {
    if (e.signedOut) v.busy.delete(idea.id);
    else v.busy.set(idea.id, { error: `Not re-scored: ${errorText(e)}` });
  } finally {
    clearInterval(timer);
  }
  paintList(v);
}

// Every live idea, one after another (the server runs at most two Claude calls at once anyway).
// The ideas a re-score-all run still has to do (kept in the browser, so a reload can continue it).
function pendingIds(v, live) {
  let ids = [];
  try { ids = JSON.parse(load(v, "pending") || "[]"); } catch {}
  return live.filter((i) => ids.includes(i.id));
}
const savePending = (v, ideas) => store(v, "pending", JSON.stringify(ideas.map((i) => i.id)));
// Leaving or reloading the page stops the run (it goes one idea at a time from this page).
const stayWarning = (e) => { e.preventDefault(); e.returnValue = ""; };

async function rescoreAll(v) {
  const live = (v.ideas || []).filter((i) => !i.archived);
  const left = pendingIds(v, live);
  const queue = left.length ? left : live;
  savePending(v, queue);
  globalThis.addEventListener?.("beforeunload", stayWarning);
  v.rescoringAll = { i: 0, n: queue.length };
  for (const idea of queue) {
    v.rescoringAll.i++;
    await rescore(v, idea);
    if (!v.busy.get(idea.id)?.error) savePending(v, queue.slice(v.rescoringAll.i));
    if (!v.ideas?.some((i) => i.id === idea.id) || v.busy.get(idea.id)?.error && /sign/i.test(v.busy.get(idea.id).error)) break;
  }
  v.rescoringAll = null;
  globalThis.removeEventListener?.("beforeunload", stayWarning);
  paintList(v);
}

async function remove(v, idea) {
  const short = idea.text.length > 60 ? idea.text.slice(0, 57) + "…" : idea.text;
  if (!globalThis.confirm?.(`Delete "${short}" and its whole score history? This can't be undone.`)) return;
  try {
    await v.api.remove(idea.id);
    v.ideas = v.ideas.filter((i) => i.id !== idea.id);
  } catch (e) {
    if (!e.signedOut) v.busy.set(idea.id, { error: `Not deleted: ${errorText(e)}` });
  }
  paintList(v);
}

function notesForm(v, idea) {
  const { h } = v.ctx;
  // What's typed survives a repaint of the list (another idea's re-score finishing, say).
  const area = h("textarea.mki-text.mki-notes-in", { rows: 3, maxlength: 5000, "aria-label": "Notes", oninput: () => v.noteDrafts.set(idea.id, area.value) });
  area.value = v.noteDrafts.get(idea.id) ?? idea.notes ?? "";
  const close = () => { v.editing.delete(idea.id); v.noteDrafts.delete(idea.id); paintList(v); };
  if (v.focusNotes === idea.id) { v.focusNotes = null; setTimeout(() => area.focus(), 0); }
  return h("div.mki-notes-form", area, h("div.mki-row",
    h("button.btn.primary", { type: "button", onclick: async () => { v.editing.delete(idea.id); v.noteDrafts.delete(idea.id); await act(v, idea, () => v.api.update(idea.id, { notes: area.value })); } }, "Save notes"),
    h("button.btn", { type: "button", onclick: close }, "Cancel")));
}

// The daily market score over time: one line, a dot per day, a hover tooltip, the 50 line labeled.
function sparkline(ctx, points) {
  const { h, svgEl } = ctx;
  const W = 220, H = 56, padL = 22, padR = 6, padT = 6, padB = 14;
  const scores = points.map((p) => p.score);
  const lo = Math.max(0, Math.min(40, ...scores) - 5), hi = Math.min(100, Math.max(60, ...scores) + 5);
  const x = (i) => padL + (points.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (points.length - 1));
  const y = (s) => padT + ((hi - s) * (H - padT - padB)) / (hi - lo);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mki-spark", role: "img", "aria-label": `Market score per day, from ${scores[0]} to ${scores[scores.length - 1]}` });
  svg.append(svgEl("line", { x1: padL, x2: W - padR, y1: y(50), y2: y(50), class: "mki-spark-mid" }));
  const mid = svgEl("text", { x: padL - 3, y: y(50) + 3, class: "mki-spark-ax", "text-anchor": "end" }); mid.textContent = "50"; svg.append(mid);
  for (const [i, anchor] of [[0, "start"], [points.length - 1, "end"]]) {
    if (points.length === 1 && i) continue;
    const t = svgEl("text", { x: x(i), y: H - 2, class: "mki-spark-ax", "text-anchor": points.length === 1 ? "middle" : anchor }); t.textContent = shortDay(points[i].day); svg.append(t);
  }
  if (points.length > 1) svg.append(svgEl("polyline", { points: points.map((p, i) => `${x(i)},${y(p.score)}`).join(" "), class: "mki-spark-line" }));
  const dot = svgEl("circle", { r: 3.5, cx: x(points.length - 1), cy: y(scores[scores.length - 1]), class: "mki-spark-dot" });
  svg.append(dot);
  const tip = h("div.mki-tip", { hidden: true });
  const wrap = h("div.mki-spark-wrap", svg, tip);
  const show = (i) => {
    const p = points[i];
    dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(p.score));
    const tags = (p.tags || []).map((t) => `${t.name} ${Math.round(t.score)}`).join(", ");
    tip.replaceChildren(h("b", `${shortDay(p.day)}: ${p.score}`), tags ? h("div", `Tags: ${tags}`) : null,
      p.pair ? h("div", `Best pair: ${(p.pair.names || p.pair.tags).join(" + ")}, ${pct(p.pair.hitRate)} hit (${p.pair.games} games)`) : null);
    tip.hidden = false;
    tip.style.left = `${(100 * x(i)) / W}%`;
  };
  const near = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    points.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    return best;
  };
  svg.addEventListener("pointermove", (e) => show(near(e)));
  svg.addEventListener("pointerleave", () => { tip.hidden = true; dot.setAttribute("cx", x(points.length - 1)); dot.setAttribute("cy", y(scores[scores.length - 1])); });
  return wrap;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
.mkv-ideas { margin-top: 28px; min-width: 0; color: var(--fb-ink); }
.mkv-ideas .mki-title { font-size: 1.15rem; margin: 0 0 4px; color: var(--fb-title); }
.mkv-ideas .mki-sub { margin: 0 0 10px; color: var(--fb-ink-2); font-size: 0.9rem; max-width: 80ch; }
.mkv-ideas .mki-test { margin: 0 0 12px; padding: 8px 12px; border: 1px dashed var(--fb-warning); border-radius: 10px; background: var(--fb-card-2); color: var(--fb-ink-2); font-size: 0.86rem; }
.mkv-ideas .mki-test b { color: var(--fb-ink); }
.mkv-ideas .mki-composer { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px; margin-bottom: 18px; }
.mkv-ideas .mki-labelrow { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; justify-content: space-between; }
.mkv-ideas .mki-tpl { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.mkv-ideas .mki-tip { margin: 2px 0 6px; color: var(--fb-muted); font-size: 0.8125rem; }
.mkv-ideas .mki-label { display: block; font-weight: 650; font-size: 0.9rem; margin-bottom: 6px; color: var(--fb-ink); }
.mkv-ideas .mki-text { display: block; box-sizing: border-box; width: 100%; font: inherit; font-size: 0.95rem; line-height: 1.45; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px; resize: vertical; }
.mkv-ideas .mki-text:focus { outline: 2px solid var(--fb-accent); outline-offset: 0; border-color: transparent; }
.mkv-ideas .mki-text:disabled { opacity: 0.7; }
.mkv-ideas .mki-actions, .mkv-ideas .mki-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.mkv-ideas .mki-hint, .mkv-ideas .mki-muted { color: var(--fb-muted); font-size: 0.82rem; }
.mkv-ideas .mki-progress { margin-top: 10px; }
.mkv-ideas .mki-bar { height: 6px; border-radius: 3px; background: var(--fb-line); overflow: hidden; }
.mkv-ideas .mki-bar span { display: block; height: 100%; background: var(--fb-accent); border-radius: 3px; transition: width 0.9s linear; }
.mkv-ideas .mki-progress-t { display: block; margin-top: 4px; font-size: 0.84rem; color: var(--fb-ink-2); }
.mkv-ideas .mki-error { color: var(--fb-negative); font-size: 0.88rem; margin: 8px 0 0; }
.mkv-ideas .mki-warn { color: var(--fb-ink-2); font-size: 0.85rem; margin: 8px 0 0; border-left: 3px solid var(--fb-warning); padding-left: 8px; }
.mkv-ideas .mki-folded { padding-top: 0; padding-bottom: 0; }
.mkv-ideas .mki-summary { display: flex; width: 100%; align-items: center; gap: 12px; padding: 10px 2px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mkv-ideas .mki-summary:hover .mki-s-title { text-decoration: underline; }
.mkv-ideas .mki-s-score { flex: 0 0 auto; min-width: 2.4em; font-size: 1.35rem; font-weight: 700; text-align: center; }
.mkv-ideas .mki-s-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.mkv-ideas .mki-s-title { color: var(--fb-title); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mkv-ideas .mki-s-sub { color: var(--fb-muted); font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mkv-ideas .mki-s-score.mki-good { color: var(--fb-good-text); }
.mkv-ideas .mki-s-score.mki-weak { color: var(--fb-negative); }
.mkv-ideas .mki-s-busy { color: var(--fb-muted); font-size: 0.8125rem; }
.mkv-ideas .mki-s-chev { color: var(--fb-muted); }
.mkv-ideas .mki-listhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin-bottom: 8px; }
.mkv-ideas .mki-listhead h3 { margin: 0; font-size: 1rem; color: var(--fb-title); }
.mkv-ideas .mki-all { margin-left: auto; }
.mkv-ideas .mki-link { appearance: none; border: 0; background: none; padding: 0; font: inherit; font-size: 0.85rem; color: var(--fb-link); cursor: pointer; text-decoration: underline; }
.mkv-ideas .mki-card { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 14px; margin-bottom: 14px; min-width: 0; }
.mkv-ideas .mki-card.mki-new { outline: 2px solid var(--fb-accent); }
.mkv-ideas .mki-card.mki-archived { opacity: 0.75; }
.mkv-ideas .mki-top { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-start; }
.mkv-ideas .mki-score { display: flex; align-items: center; gap: 10px; }
.mkv-ideas .mki-big { font-size: 2.6rem; font-weight: 750; line-height: 1; color: var(--fb-title); font-variant-numeric: tabular-nums; min-width: 2ch; }
.mkv-ideas .mki-score-t { display: flex; flex-direction: column; font-size: 0.9rem; color: var(--fb-ink); }
.mkv-ideas .mki-score-t small { color: var(--fb-muted); font-size: 0.78rem; }
.mkv-ideas .mki-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--fb-muted); }
.mkv-ideas .mki-dot.mki-good { background: var(--fb-positive); }
.mkv-ideas .mki-dot.mki-ok { background: var(--fb-warning); }
.mkv-ideas .mki-dot.mki-weak { background: var(--fb-negative); }
.mkv-ideas .mki-market { flex: 1 1 220px; min-width: 0; max-width: 340px; }
.mkv-ideas .mki-market-t { font-size: 0.88rem; }
.mkv-ideas .mki-delta { color: var(--fb-ink-2); }
.mkv-ideas .mki-market small.mki-muted { display: block; font-size: 0.76rem; }
.mkv-ideas .mki-spark-wrap { position: relative; width: 100%; max-width: 280px; }
.mkv-ideas .mki-spark { display: block; width: 100%; height: auto; overflow: visible; touch-action: none; }
.mkv-ideas .mki-spark-line { fill: none; stroke: var(--fb-accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.mkv-ideas .mki-spark-dot { fill: var(--fb-accent); stroke: var(--fb-card); stroke-width: 2; }
.mkv-ideas .mki-spark-mid { stroke: var(--fb-line); stroke-dasharray: 3 3; }
.mkv-ideas .mki-spark-ax { fill: var(--fb-muted); font-size: 9px; }
.mkv-ideas .mki-tip { position: absolute; bottom: 100%; transform: translateX(-50%); z-index: 2; background: var(--fb-card); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 8px; font-size: 0.78rem; width: max-content; max-width: 240px; box-shadow: 0 4px 14px rgba(0,0,0,0.15); pointer-events: none; }
.mkv-ideas .mki-idea { font-size: 1rem; font-weight: 600; margin: 12px 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fb-ink); }
.mkv-ideas .mki-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.mkv-ideas .mki-chip { border: 1px solid var(--fb-line); background: var(--fb-card-2); border-radius: 999px; padding: 2px 10px; font-size: 0.82rem; color: var(--fb-ink); cursor: help; }
.mkv-ideas .mki-chip small { color: var(--fb-muted); }
.mkv-ideas .mki-headrow { display: flex; align-items: center; gap: 8px; }
.mkv-ideas .mki-headrow .mki-summary { flex: 1; min-width: 0; }
.mkv-ideas .mki-mine { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; }
.mkv-ideas .mki-pin, .mkv-ideas .mki-star { appearance: none; border: 0; background: none; padding: 4px 3px; font: inherit; cursor: pointer; line-height: 1; border-radius: 6px; }
.mkv-ideas .mki-pin { filter: grayscale(1); opacity: 0.35; font-size: 1rem; }
.mkv-ideas .mki-pin[aria-pressed="true"] { filter: none; opacity: 1; }
.mkv-ideas .mki-pin:hover { opacity: 0.8; }
.mkv-ideas .mki-star { color: var(--fb-muted); font-size: 1.05rem; }
.mkv-ideas .mki-star.mki-on { color: var(--fb-warning); }
.mkv-ideas .mki-stars:hover .mki-star { color: var(--fb-warning); }
.mkv-ideas .mki-stars .mki-star:hover ~ .mki-star { color: var(--fb-muted); }
.mkv-ideas .mki-pin:focus-visible, .mkv-ideas .mki-star:focus-visible { outline: 2px solid var(--fb-accent); }
.mkv-ideas .mki-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.mkv-ideas .mki-card.mki-pinned { border-color: var(--fb-accent); }
.mkv-ideas .mki-sort { font-size: 0.85rem; color: var(--fb-ink-2); }
.mkv-ideas .mki-sort select { font: inherit; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 6px; padding: 2px 6px; }
.mkv-ideas .mki-tagnote { margin: 0 0 6px; font-size: 0.78rem; }
.mkv-ideas .mki-hook, .mkv-ideas .mki-has { margin: 6px 0; font-size: 0.9rem; color: var(--fb-ink-2); max-width: 80ch; }
.mkv-ideas .mki-hook b, .mkv-ideas .mki-has b { color: var(--fb-ink); }
.mkv-ideas .mki-verdict { margin: 8px 0; line-height: 1.5; color: var(--fb-ink); max-width: 80ch; }
.mkv-ideas .mki-subs { display: grid; grid-template-columns: max-content minmax(60px, 140px) 2.5ch minmax(0, 1fr); gap: 6px 10px; align-items: center; margin: 10px 0; font-size: 0.85rem; }
.mkv-ideas .mki-sub { display: contents; }
.mkv-ideas .mki-sub-l { color: var(--fb-ink-2); font-weight: 600; cursor: help; }
.mkv-ideas .mki-sub-bar { height: 8px; background: var(--fb-line); border-radius: 4px; overflow: hidden; }
.mkv-ideas .mki-sub-bar span { display: block; height: 100%; background: var(--fb-accent); border-radius: 4px; }
.mkv-ideas .mki-sub-n { text-align: right; font-variant-numeric: tabular-nums; color: var(--fb-ink); }
.mkv-ideas .mki-sub-r { color: var(--fb-ink-2); min-width: 0; overflow-wrap: anywhere; }
.mkv-ideas .mki-timing { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; margin: 10px 0; font-size: 0.88rem; color: var(--fb-ink-2); }
.mkv-ideas .mki-pill { border-radius: 999px; padding: 2px 10px; font-weight: 650; font-size: 0.82rem; border: 1px solid var(--fb-line); color: var(--fb-ink); background: var(--fb-card-2); }
.mkv-ideas .mki-pill.mki-t-now { border-color: var(--fb-positive); }
.mkv-ideas .mki-pill.mki-t-soon { border-color: var(--fb-warning); }
.mkv-ideas .mki-pill.mki-t-wait { border-color: var(--fb-negative); }
.mkv-ideas .mki-watch b { color: var(--fb-ink); }
.mkv-ideas .mki-block h4 { margin: 12px 0 4px; font-size: 0.88rem; color: var(--fb-title); }
.mkv-ideas .mki-block ul { margin: 0; padding-left: 18px; }
.mkv-ideas .mki-block li { margin: 4px 0; font-size: 0.88rem; line-height: 1.45; color: var(--fb-ink-2); overflow-wrap: anywhere; }
.mkv-ideas .mki-block li b { color: var(--fb-ink); }
.mkv-ideas .mki-try { margin-left: 8px; padding: 1px 8px; font-size: 0.78rem; }
.mkv-ideas .mki-notes { font-size: 0.88rem; color: var(--fb-ink-2); white-space: pre-wrap; margin: 8px 0; }
.mkv-ideas .mki-notes b { color: var(--fb-ink); }
.mkv-ideas .mki-notes-form { margin: 8px 0; }
.mkv-ideas .mki-gen { margin: 0 0 12px; padding: 0 0 12px; border-bottom: 1px solid var(--fb-line); }
.mkv-ideas .mki-gen-t { font-size: 0.88rem; color: var(--fb-ink-2); }
.mkv-ideas .mki-gen-t b { color: var(--fb-ink); }
.mkv-ideas .mki-gen-dir { flex: 1 1 240px; min-width: 0; font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; }
.mkv-ideas .mki-gen-dir:focus { outline: 2px solid var(--fb-accent); border-color: transparent; }
.mkv-ideas .mki-made-box { background: var(--fb-card); border: 1px solid var(--fb-accent); border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; }
.mkv-ideas .mki-made-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
.mkv-ideas .mki-made-head h3 { margin: 0; font-size: 1rem; color: var(--fb-title); }
.mkv-ideas .mki-made-head .mki-link { margin-left: auto; }
.mkv-ideas .mki-made-list { list-style: none; margin: 8px 0 0; padding: 0; }
.mkv-ideas .mki-made { padding: 8px 0; border-top: 1px solid var(--fb-line); }
.mkv-ideas .mki-made:first-child { border-top: 0; }
.mkv-ideas .mki-made.mki-made-out { opacity: 0.55; }
.mkv-ideas .mki-made-top { display: flex; align-items: center; gap: 12px; }
.mkv-ideas .mki-made-top b { color: var(--fb-title); }
.mkv-ideas .mki-made-why, .mkv-ideas .mki-similar { margin: 4px 0 0; font-size: 0.86rem; color: var(--fb-ink-2); overflow-wrap: anywhere; }
.mkv-ideas .mki-similar b { color: var(--fb-ink); }
.mkv-ideas .mki-similar a, .mkv-ideas .mki-notes a { color: var(--fb-link); }
.mkv-ideas .mki-danger { color: var(--fb-negative); }
.mkv-ideas .mki-meta { margin: 8px 0 0; font-size: 0.76rem; }
.mkv-ideas .mki-history { margin: 8px 0 0; }
@media (max-width: 560px) {
  .mkv-ideas .mki-subs { grid-template-columns: max-content minmax(0, 1fr) 2.5ch; }
  .mkv-ideas .mki-sub-r { grid-column: 1 / -1; margin: -2px 0 4px; }
  .mkv-ideas .mki-market { max-width: none; }
  .mkv-ideas .mki-big { font-size: 2.2rem; }
}
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("mk-ideas-style")) return;
  const el = document.createElement("style");
  el.id = "mk-ideas-style";
  el.textContent = CSS;
  document.head.append(el);
}

export const _test = { sortIdeas, myRank, splitIdeas, joinIdeas, submitAll, scoreAll, generate, cannedDrafts, linkify, marketScore, mapTags, cannedAnalysis, fakeApi, tagScore, marketOf, words };
