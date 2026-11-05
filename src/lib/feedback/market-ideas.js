// The Market page's "My game ideas": the owner types a game idea, the server asks Claude to score it
// against the real Steam market data, and keeps it. Each idea shows Claude's score and a sparkline of
// its daily market score (worked out by the server from that day's market files, no Claude), the Steam
// tags it maps to, the sub-scores with their reasons, the verdict, pivots, alternatives and timing.
//
// Contract: ideasView(ctx, files, redraw) returns one element (.mkv-ideas), kept and handed back on
// later calls (so a page redraw keeps the typed text and the open forms). files = { overview, trends,
// games, growth }. The server: ctx.adminGet("ideas") and ctx.adminSend("ideas…", method, body), see
// server/gamedata/ideas.py. With ctx.dataOverride set there is no server: a local fake keeps the ideas
// in memory and answers with a canned analysis built from the real files (tags found by keyword).

const PREFIX = "mkv-ideas-";
const MAX_IDEA = 2000; // the server's limit for one idea
const MAX_BOX = 20000; // several ideas pasted at once

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
      const idea = { id: next++, text: text.trim(), notes, archived: false, tags: [], created: now, updated: now, analysis: null, analyses: [], points: [] };
      analyse(idea);
      ideas.push(idea);
      return copy(idea);
    },
    async rescore(id) { await wait(); const idea = find(id); analyse(idea); return copy(idea); },
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
    submitting: null, submitError: null, busy: new Map(), editing: new Set(), noteDrafts: new Map(), focusNotes: null, showArchived: false, flash: null };
  kept = v;
  const { h } = ctx;
  v.root = h("section.mkv-ideas", { "aria-label": "My game ideas" });
  v.box = h("textarea.mki-text", { rows: 5, maxlength: MAX_BOX, placeholder: "Describe the game: what you do, the hook, the look, the scope. E.g. \"A cozy organizing game in a dwarf mine: sort ore carts against a timer, 2 hours of content, made in 3 months.\"\nSeveral ideas? Paste them as a numbered list (1. … 2. …) or with a blank line between them.",
    "aria-label": "Your game idea", oninput: () => { store(v, "draft", v.box.value); paintComposer(v); } });
  v.box.value = load(v, "draft") || "";
  v.box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { if (splitIdeas(v.box.value).length) submitAll(v); else submit(v); } });
  v.composer = h("div.mki-composer");
  v.list = h("div.mki-list");
  v.root.append(
    h("div.mki-head",
      h("h2.mki-title", "My game ideas"),
      h("p.mki-sub", "Type a game idea and Claude scores it against today's Steam data: which tags it is, how many games in them become hits, how crowded they are and whether they're growing. It suggests pivots and other ideas. Ideas are kept and get a fresh market score every day, because timing matters: the same idea can flop early and hit a year later."),
      v.mode === "test" ? h("p.mki-test", h("b", "Test mode: not saved, not Claude."), " Ideas live in this tab only, the analysis is canned from the real market files (tags found by keyword), the earlier days of the sparkline are made up. Put \"fail\" in an idea to try the error (in a list of ideas, it stops there and keeps the unsent ones in the box).") : null),
    v.composer, v.list);
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
    v.error = e.status === 404 ? "The game-data server doesn't have the ideas yet (deploy server/gamedata/ideas.py and restart gamedata)." : `Couldn't load the ideas: ${e.message}`;
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
    if (!e.signedOut) v.submitError = errorText(e);
  } finally {
    clearInterval(timer);
    v.submitting = null;
  }
  paintComposer(v);
  paintList(v);
}

// Several ideas, one after another (each takes the server 30-60 s). The box always holds exactly the
// ideas not yet scored, so a failure (or closing the page) loses nothing.
async function submitAll(v) {
  const list = splitIdeas(v.box.value);
  if (list.length < 2 || v.submitting || list.some((x) => x.length > MAX_IDEA)) return;
  const n = list.length, left = [...list];
  v.submitError = null;
  let done = 0;
  try {
    while (left.length) {
      v.submitting = { started: Date.now(), i: done + 1, n };
      paintComposer(v);
      const timer = setInterval(() => tick(v.status), 1000);
      try {
        const idea = await v.api.create(left[0]);
        v.ideas = [idea, ...(v.ideas || []).filter((i) => i.id !== idea.id)];
        v.flash = idea.id;
        left.shift();
        done++;
        v.box.value = joinIdeas(left);
        store(v, "draft", v.box.value);
        paintList(v);
      } finally {
        clearInterval(timer);
      }
    }
  } catch (e) {
    if (!e.signedOut) v.submitError = `Idea ${done + 1} of ${n} not scored: ${errorText(e).replace(/([^.!?])$/, "$1.")} ${done ? `${done} scored; the` : "The"} ${left.length === 1 ? "unsent idea is" : `${left.length} unsent ideas are`} still in the box.`;
  } finally {
    v.submitting = null;
  }
  paintComposer(v);
  paintList(v);
}

const STAGES = [[0, "Sending the idea and today's market data…"], [4, "Claude is mapping it to Steam tags…"], [15, "Claude is weighing demand, competition and hit odds…"], [35, "Writing pivots, alternatives and timing…"], [70, "Taking longer than usual, still waiting…"]];
const stage = (s) => STAGES.filter(([at]) => s >= at).pop()[1];

// A progress bar that eases toward 95% (the real call has no progress to report) and names a stage.
// tick() repaints every .mki-progress inside a root in place, so nothing else is redrawn.
function progress(h, started, expected = 45, prefix = "") {
  const bar = h("span");
  const label = h("span.mki-progress-t");
  const el = h("div.mki-progress", { role: "status", "data-started": started }, h("div.mki-bar", bar), label);
  el._update = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    bar.style.width = `${(Math.min(0.95, 1 - Math.exp(-s / expected)) * 100).toFixed(1)}%`;
    label.textContent = `${prefix}${stage(s)} ${s} s (usually 30-60 s)`;
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
    v.composer.append(h("label.mki-label", { for: "mki-text" }, "Your idea (or several)"), v.box, h("div.mki-actions", v.allButton, v.button, v.hint), v.status);
  }
  const busy = !!v.submitting;
  const n = v.box.value.trim().length, many = splitIdeas(v.box.value), tooLong = many.filter((x) => x.length > MAX_IDEA).length;
  v.box.disabled = busy;
  v.allButton.style.display = many.length ? "" : "none";
  v.allButton.disabled = busy || !!tooLong;
  v.allButton.textContent = busy && v.submitting.n ? `Scoring ${v.submitting.i} of ${v.submitting.n}…` : `Score all ${many.length} ideas`;
  // With several ideas found, "as one" stays there (a long idea with paragraphs), as the second choice.
  v.button.className = many.length ? "btn" : "btn primary";
  v.button.disabled = busy || !n || n > MAX_IDEA;
  v.button.textContent = busy && !v.submitting.n ? "Scoring…" : many.length ? "Score it as one idea" : "Score this idea";
  v.hint.textContent = many.length
    ? `${many.length} ideas found (a list, or blank lines between them)${tooLong ? ` · ${tooLong} ${tooLong === 1 ? "is" : "are"} over ${MAX_IDEA} characters: shorten ${tooLong === 1 ? "it" : "them"}` : ""} · Ctrl+Enter scores all`
    : `${n}/${MAX_IDEA}${n > MAX_IDEA ? " · too long for one idea" : ""} · Ctrl+Enter to score`;
  const notice = v.claude === false && v.mode !== "test" ? h("p.mki-warn", "The server has no ANTHROPIC_API_KEY yet: scoring will fail until it's set in /etc/fourgames/gamedata.env (then restart gamedata).") : null;
  v.status.replaceChildren(
    ...[busy ? progress(h, v.submitting.started, 45, v.submitting.n ? `${v.submitting.i} of ${v.submitting.n}: ` : "") : null,
      v.submitError ? h("p.mki-error", { role: "alert" }, /^Idea \d+ of/.test(v.submitError) ? v.submitError : `Not scored: ${v.submitError} Your text is still in the box.`) : null,
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
    archived ? h("button.mki-link", { type: "button", onclick: () => { v.showArchived = !v.showArchived; paintList(v); } }, v.showArchived ? "Hide archived" : `Show ${archived} archived`) : null);
  if (!all.length) { v.list.replaceChildren(head, h("p.mki-muted", "Your scored ideas show up here, newest first.")); return; }
  v.list.replaceChildren(head, ...shown.map((idea) => card(v, idea)));
  if (v.flash) {
    const el = v.list.querySelector(`[data-idea="${v.flash}"]`);
    v.flash = null;
    el?.classList.add("mki-new");
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
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
  const notes = editing ? notesForm(v, idea) : idea.notes ? h("p.mki-notes", h("b", "Notes: "), idea.notes) : null;
  const actions = h("div.mki-row",
    h("button.btn", { type: "button", disabled: !!busy, onclick: () => rescore(v, idea) }, a ? "Re-score with Claude" : "Score with Claude"),
    h("button.btn", { type: "button", disabled: editing, onclick: () => { v.editing.add(idea.id); v.focusNotes = idea.id; paintList(v); } }, idea.notes ? "Edit notes" : "Add notes"),
    h("button.btn", { type: "button", onclick: () => act(v, idea, () => v.api.update(idea.id, { archived: !idea.archived })) }, idea.archived ? "Unarchive" : "Archive"),
    h("button.btn.mki-danger", { type: "button", onclick: () => remove(v, idea) }, "Delete"));

  return h("article.mki-card", { "data-idea": idea.id, class: idea.archived ? "mki-archived" : null },
    h("div.mki-top", scoreBox, marketBox),
    h("p.mki-idea", idea.text),
    idea.archived ? h("p.mki-muted", "Archived: no new market points.") : null,
    ...body, notes,
    busy?.started ? progress(h, busy.started) : null,
    busy?.error ? h("p.mki-error", { role: "alert" }, busy.error) : null,
    actions,
    h("p.mki-muted.mki-meta", `Added ${new Date(idea.created * 1000).toLocaleDateString()}${a ? ` · ${a.model}` : ""}`));
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
.mkv-ideas .mki-listhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin-bottom: 8px; }
.mkv-ideas .mki-listhead h3 { margin: 0; font-size: 1rem; color: var(--fb-title); }
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

export const _test = { splitIdeas, joinIdeas, submitAll, marketScore, mapTags, cannedAnalysis, fakeApi, tagScore, marketOf, words };
