// The Market page's "Tag my game": pick one of our games (or any game, or a list of tags for one not
// on Steam yet) and see, from the real Steam data, which of its tags help, which hold it back and which
// tags games like it use that it doesn't. Then, optionally, Claude reads the store page and says which
// of those really describe the game, so no tag is added just because it sells.
//
// How it works, all in the browser on the market files (server/steamdata/market.py):
//   1. Look-alikes: released games from the last three years (out 2 weeks or more) that share the most
//      of the game's tags, weighted by position (a tag in the first five counts double), with the
//      generic tags (Indie, Singleplayer...) left out so they don't make everything look alike.
//   2. For every tag among the look-alikes: how many have it ("fit"), and how the look-alikes with it
//      did against those without it: the hit chance and the typical (median) rank. Both use an index
//      that compares a game only with the games out the same fortnight, so a 3-year-old game and a
//      2-week-old one are judged fairly: the earn index (estimated revenue among paid games, market.py;
//      free games left out) when the files have it, else the hit index (reviews). A hit = 90+. Rates
//      are pulled toward the look-alikes' own rate by PRIOR games, so a handful of lucky games can't win.
//   3. Verdicts for the game's own tags, tags worth adding, and a suggested top five.
// It shows which tags go together with doing well among similar games, not that a tag causes it.
//
// Contract: tagsView(ctx, files, redraw) returns one element (.mkv-tags), kept and handed back on
// later calls, so typing and focus survive the page's redraws. files = { overview, trends, games,
// upcoming, godot }. Claude: ctx.adminSend("tagcheck", "POST", body), see server/gamedata/tagcheck.py;
// with ctx.dataOverride set there is no server and a canned local answer stands in. openWith({tags, about})
// opens it on a list of tags (market-merged.js's ctx.openTags, for "My game ideas").

import { SITE } from "@/data/site.js";
import { GAMES } from "@/data/games.js";

const PREFIX = "mkv-tags-";
const DAY = 86400;
const INDIE = 492;
const TOP = 5;              // the first five tags are what a game "is" (market.py's TOP_TAGS)
const MAX_TAGS = 20;        // Steam lets a developer apply 20 tags
const LOOK_K = 250;         // look-alikes kept, most similar first
const LOOK_MIN_SIM = 0.2;   // and at least this similar (0..1)
const MIN_SHARED = 2;       // sharing this many of the game's real (not generic) tags
const MIN_AGE = 14;         // days out before a game's hit index says anything
const HIT = 90;             // hit index 90+: top 10% of its launch fortnight
const PRIOR = 12;           // rates pulled toward the look-alikes' own by this many games
const MIN_WITH = 8;         // a tag needs this many look-alikes with it to be judged
const MIN_FIT = 0.12;       // ... and this share of them, to be suggested
const GOOD = 1.12, BAD = 0.88;
const CORE = 0.8;           // a tag this share of the look-alikes has defines them
const MAX_ABOUT = 6000;
const META = ["Indie", "Free to Play", "Early Access", "Replay Value", "Great Soundtrack", "Masterpiece", "Addictive", "Classic", "Beautiful", "Singleplayer", "Casual"];
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const pct = (x) => x == null || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
const posWeight = (i) => i < TOP ? 1 : 0.5;
export function oneIn(p) {
  if (p == null) return "–";
  if (p >= 0.5) return "1 in 2+";
  if (p <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / p))}`;
}

// Tag ids by kind, from overview.tags ({ id: name }).
export function tagKinds(tagNames) {
  const byName = new Map(Object.entries(tagNames || {}).map(([id, n]) => [String(n).trim().toLowerCase(), Number(id)]));
  const ids = (list) => new Set(list.map((n) => byName.get(n.toLowerCase())).filter((x) => x != null));
  const meta = ids(META); meta.add(INDIE);
  return { meta, adult: ids(ADULT), byName };
}

// Every game the files know, one shape: released ones from games.json, coming soon from upcoming.json,
// and the Godot set (older released Godot games are only there).
export function unpackPool(files) {
  const out = new Map();
  const g = files.games;
  if (g) {
    const c = Object.fromEntries(g.columns.map((x, i) => [x, i]));
    for (const r of g.rows) out.set(r[c.appid], { appid: r[c.appid], name: r[c.name], day: r[c.day], reviews: r[c.reviews] || 0, pos: r[c.pos], tags: r[c.tags] || [], hit: r[c.hit], earn: c.earn != null ? r[c.earn] ?? null : null, released: true, devs: [], pubs: [] });
  }
  const u = files.upcoming;
  if (u) {
    const c = Object.fromEntries(u.columns.map((x, i) => [x, i]));
    for (const r of u.rows) if (!out.has(r[c.appid])) out.set(r[c.appid], { appid: r[c.appid], name: r[c.name], day: r[c.day], reviews: 0, pos: null, tags: r[c.tags] || [], hit: null, released: false, devs: r[c.devs] || [], pubs: r[c.pubs] || [] });
  }
  for (const r of files.godot?.games || []) {
    const have = out.get(r.appid);
    if (have) { have.devs = r.developers || have.devs; have.pubs = r.publishers || have.pubs; continue; }
    out.set(r.appid, { appid: r.appid, name: r.name, day: r.day, reviews: r.reviews || 0, pos: r.pos, tags: r.tags || [], hit: r.hit, earn: r.earn ?? null, released: !r.comingSoon, devs: r.developers || [], pubs: r.publishers || [] });
  }
  return out;
}

// Our games: the site's list (src/data/games.js) and anything our studio name develops or publishes.
export function ownGames(pool, { names = [SITE.steam?.publisher, SITE.steam?.developer], ids = GAMES.map((x) => x.appId) } = {}) {
  const who = new Set(names.filter(Boolean).map((n) => n.toLowerCase()));
  const want = new Set(ids);
  const out = [];
  for (const g of pool.values()) {
    if (want.has(g.appid) || [...g.devs, ...g.pubs].some((n) => who.has(String(n).toLowerCase()))) out.push(g);
  }
  // Released ones first (most reviews first), then the ones still to come.
  return out.sort((a, b) => (b.released - a.released) || b.reviews - a.reviews || (a.day ?? 1e9) - (b.day ?? 1e9));
}

export function searchGames(pool, q, limit = 8) {
  const s = q.trim().toLowerCase();
  if (s.length < 2) return [];
  const id = /^\d+$/.test(s) ? Number(s) : null;
  const hits = [];
  for (const g of pool.values()) {
    if (g.appid === id) { hits.unshift({ g, rank: -1 }); continue; }
    const n = String(g.name || "").toLowerCase(), at = n.indexOf(s);
    if (at >= 0) hits.push({ g, rank: (at === 0 ? 0 : 1) * 1e7 - g.reviews });
  }
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map((x) => x.g);
}

// The released games most like these tags, most similar first (each with .sim, 0..1, and .shared).
export function lookalikes(tags, pool, { today, exclude = null, skip = new Set(), k = LOOK_K } = {}) {
  const core = tags.filter((t) => !skip.has(t));
  if (!core.length) return [];
  const wT = new Map(core.map((t) => [t, posWeight(tags.indexOf(t))]));
  let normT = 0; for (const w of wT.values()) normT += w * w;
  const need = Math.min(MIN_SHARED, core.length);
  const out = [];
  for (const g of pool.values()) {
    if (!g.released || g.appid === exclude || g.day == null || g.day > today) continue;
    let dot = 0, shared = 0, normG = 0;
    for (let i = 0; i < g.tags.length; i++) {
      const t = g.tags[i];
      if (skip.has(t)) continue;
      const w = posWeight(i); normG += w * w;
      const a = wT.get(t);
      if (a) { dot += a * w; shared++; }
    }
    if (shared < need || !normG) continue;
    const sim = dot / Math.sqrt(normT * normG);
    if (sim >= LOOK_MIN_SIM) out.push({ ...g, sim, shared });
  }
  return out.sort((a, b) => b.sim - a.sim || b.reviews - a.reviews).slice(0, k);
}

// How the look-alikes with a tag did against those without it (g.rank: the age-matched index).
function tagStats(t, looks, rated, base, baseMedian) {
  let all = 0, fitW = 0, topW = 0, n = 0;
  for (const g of looks) {
    all += g.sim;
    const i = g.tags.indexOf(t);
    if (i >= 0) { fitW += g.sim; n++; if (i < TOP) topW += g.sim; }
  }
  let wW = 0, hW = 0, nW = 0, wO = 0, hO = 0, nO = 0;
  const revW = [], revO = [];
  for (const g of rated) {
    const hit = g.rank >= HIT ? 1 : 0;
    if (g.tags.includes(t)) { wW += g.sim; hW += g.sim * hit; nW++; revW.push(g.rank); }
    else { wO += g.sim; hO += g.sim * hit; nO++; revO.push(g.rank); }
  }
  const rateWith = (hW + PRIOR * base) / (wW + PRIOR), rateWithout = (hO + PRIOR * base) / (wO + PRIOR);
  const medWith = median(revW), medWithout = median(revO);
  const lift = rateWithout > 0 ? rateWith / rateWithout : null;
  // The typical rank among same-age games, with as many pretend games at the look-alikes' median as PRIOR on each side.
  const revLift = medWith != null && medWithout != null ? (1 + (medWith * nW + PRIOR * baseMedian) / (nW + PRIOR)) / (1 + (medWithout * nO + PRIOR * baseMedian) / (nO + PRIOR)) : null;
  const parts = [lift, revLift].filter((x) => x != null && Number.isFinite(x));
  const effect = parts.length ? Math.exp(parts.reduce((s, x) => s + Math.log(Math.max(x, 0.05)), 0) / parts.length) : null;
  return { tag: t, fit: all ? fitW / all : 0, topFit: all ? topW / all : 0, n, nWith: nW, nWithout: nO, rateWith, rateWithout, lift, medWith, medWithout, revLift, effect, sure: nW >= MIN_WITH && nO >= MIN_WITH };
}

// The whole report for a list of tag ids (strongest first).
export function tagReport({ tags, pool, trends, tagNames, today, exclude = null, game = null }) {
  const kinds = tagKinds(tagNames);
  const name = (t) => tagNames?.[t] ?? `Tag ${t}`;
  const looks = lookalikes(tags, pool, { today, exclude, skip: kinds.meta });
  // Earnings when the files have them (paid games only), else reviews; either way against games of the same age.
  const byRev = [...pool.values()].some((g) => g.earn != null);
  const rankOf = (g) => byRev ? g.earn : g.hit;
  const rated = looks.filter((g) => rankOf(g) != null && today - g.day >= MIN_AGE).map((g) => ({ ...g, rank: rankOf(g) }));
  let W = 0, H = 0; for (const g of rated) { W += g.sim; H += g.sim * (g.rank >= HIT ? 1 : 0); }
  const baseRate = W ? H / W : trends?.baseHitRate || 0.1;
  const baseMedian = median(rated.map((g) => g.rank)) ?? 0;
  const stat = (t) => tagStats(t, looks, rated, baseRate, baseMedian);
  const global = new Map((trends?.tags || []).map((r) => [r.tag, r]));
  const steamBase = trends?.baseHitRate || null;

  const current = tags.map((t, i) => {
    const s = stat(t), gl = global.get(t);
    const v = verdict(t, i, s, kinds, gl, steamBase);
    return { ...s, name: name(t), pos: i, meta: kinds.meta.has(t), adult: kinds.adult.has(t), global: gl || null, ...v };
  });

  const have = new Set(tags);
  const seen = new Set();
  for (const g of looks) for (const t of g.tags) if (!have.has(t) && !kinds.adult.has(t) && !kinds.meta.has(t)) seen.add(t);
  const adds = [];
  for (const t of seen) {
    const s = stat(t);
    if (s.fit < MIN_FIT || s.nWith < MIN_WITH || s.effect == null) continue;
    const gl = global.get(t);
    let kind = null, why;
    if (s.effect >= GOOD) { kind = "add"; why = `${lead(s)}: ${hitWords(s)}${revWords(s)}.`; }
    else if (s.fit >= 0.3 && s.effect >= BAD) { kind = "expected"; why = `${pct(s.fit)} of games like yours have it, and it doesn't hurt them. Add it if it's true, so Steam shows you next to them.`; }
    if (!kind) continue;
    if (gl?.hitLift != null && gl.hitLift < 0.7) why += ` Crowded on Steam as a whole (${num(gl.releases)} new games in 90 days).`;
    adds.push({ ...s, name: name(t), kind, why, global: gl || null });
  }
  adds.sort((a, b) => (a.kind === "add" ? 0 : 1) - (b.kind === "add" ? 0 : 1) || b.effect * (0.5 + b.fit) - a.effect * (0.5 + a.fit));

  // Suggested top five: tags that are core to games like this one (in their first five) and do well
  // with them. The game's own tags get a nudge, since they're known to describe it.
  const pick = [
    ...current.filter((c) => !c.meta && !c.adult && c.fit >= 0.1 && c.effect != null).map((c) => ({ tag: c.tag, name: c.name, own: true, score: c.effect * (0.6 + c.topFit) * 1.15 })),
    ...adds.filter((a) => a.kind === "add" && a.topFit >= 0.15).map((a) => ({ tag: a.tag, name: a.name, own: false, score: a.effect * (0.6 + a.topFit) })),
  ].sort((a, b) => b.score - a.score).slice(0, TOP);

  const own = game ? rankOf(game) : null;
  const you = game && game.released && own != null && today - game.day >= MIN_AGE
    ? { reviews: game.reviews, hit: own, typical: baseMedian, better: rated.filter((g) => g.rank < own).length / Math.max(1, rated.length) }
    : null;
  return { looks, rated, baseRate, median: baseMedian, steamBase, current, adds, top: pick, you, byRev, thin: rated.length < 40 };
}

// "did better", or which way it split when hits and the typical rank disagree.
function lead(s) {
  const h = s.lift ?? 1, r = s.revLift ?? 1;
  const better = s.effect >= 1;
  if ((h >= 1.05 && r <= 0.95) || (h <= 0.95 && r >= 1.05)) return `Games like yours with it did ${better ? "better" : "worse"} overall, though not on both counts`;
  return `Games like yours with it did ${better ? "better" : "worse"}`;
}
function hitWords(s) { return `${oneIn(s.rateWith)} became hits, against ${oneIn(s.rateWithout)} without it`; }
function revWords(s) { return s.medWith != null && s.medWithout != null ? `; a typical one beat ${num(s.medWith)}% of the games out the same fortnight, against ${num(s.medWithout)}%` : ""; }

function verdict(t, i, s, kinds, gl, steamBase) {
  const top = i < TOP;
  if (kinds.adult.has(t)) return { kind: "keep", say: "Keep if true", why: "A content tag: Steam needs it if it applies, whatever it does to sales." };
  if (kinds.meta.has(t)) return top
    ? { kind: "down", say: "Move down", why: "Generic: it says how the game is sold or felt, not what it is, and nearly every game has it. In your first five it takes the place of a tag that tells Steam who to show the game to." }
    : { kind: "keep", say: "Fine here", why: "Generic, but harmless this far down." };
  const crowded = gl?.hitLift != null && gl.hitLift < 0.7 ? ` On Steam as a whole it's crowded: ${num(gl.releases)} new games in 90 days and ${oneIn(gl.hitRate)} hits${steamBase ? ` (Steam: ${oneIn(steamBase)})` : ""}.` : "";
  // A tag nearly every look-alike has is what makes them alike: there's nothing to compare it with.
  if (s.fit >= CORE) return { kind: top ? "keep" : "up", say: top ? "Core" : "Move up", why: `${pct(s.fit)} of games like yours have it: it's what makes them alike, so the numbers can't judge it.${top ? " Keep it high." : " Something this central belongs in your first five."}${crowded}` };
  if (s.fit < 0.1) return { kind: "odd", say: "Check it", why: `Rare in games like yours (${pct(s.fit)} have it). If it's the game's hook, keep it; if it isn't central, it may show the game to the wrong players.${crowded}` };
  if (!s.sure) return { kind: "keep", say: "Keep", why: `Too few look-alikes ${s.nWithout < MIN_WITH ? "without" : "with"} it to tell whether it helps.${crowded}` };
  if (s.effect >= GOOD) return top
    ? { kind: "good", say: "Strong", why: `${lead(s)}: ${hitWords(s)}${revWords(s)}.${crowded}` }
    : { kind: "up", say: "Move up", why: `${lead(s)} (${hitWords(s)}${revWords(s)}): worth a place in your first five.${crowded}` };
  if (s.effect <= BAD) return top
    ? { kind: "down", say: "Move down", why: `${lead(s)}: ${hitWords(s)}${revWords(s)}. Keep it if it's true, but lower.${crowded}` }
    : { kind: "weak", say: "Weak", why: `${lead(s)} (${hitWords(s)}${revWords(s)}). If a tag below fits better, swap it.${crowded}` };
  return { kind: "keep", say: "Keep", why: `About even: ${hitWords(s)}${revWords(s)}.${crowded}` };
}

// A canned Claude answer for test mode (?data=): fits everything named in the text, "maybe" otherwise.
export function fakeCheck(body) {
  const text = `${body.name || ""} ${body.about || ""}`.toLowerCase();
  const one = (t) => text.includes(t.toLowerCase()) ? { tag: t, fits: "yes", why: "Test mode: the description names it." } : { tag: t, fits: "maybe", why: "Test mode: not named in the description." };
  return { summary: "Test mode: not Claude. Tags named in the description count as fitting.", current: body.tags.map(one), candidates: body.candidates.map(one), source: body.about ? "given" : "store", model: "test" };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

let kept = null;
let asked = null;

// Another view's way in (market-merged.js's ctx.openTags, used by "My game ideas"): the next draw shows
// these tag ids and this description as "A game not on Steam yet", replacing any edited custom tags.
export function openWith({ tags = [], about = "" } = {}) {
  asked = { tags: Array.isArray(tags) ? tags.filter((t) => Number.isInteger(t)) : [], about: String(about || "").slice(0, MAX_ABOUT) };
}

function takeAsked(v) {
  if (!asked) return;
  const { tags, about } = asked;
  asked = null;
  const names = v.files.overview?.tags || {};
  choose(v, null, { quiet: true });
  v.tags = [...new Set(tags)].filter((t) => t in names).slice(0, MAX_TAGS);
  save(v, "tags:custom", v.tags);
  v.about.value = about;
  save(v, "about:custom", about);
  v.claude = null;
  try { v.ctx.store?.del?.(PREFIX + "claude:custom"); } catch {}
  requestAnimationFrame(() => v.root.scrollIntoView?.({ behavior: "smooth", block: "start" }));
}

export function tagsView(ctx, files, redraw) {
  injectCss();
  if (kept && kept.files.games === files.games && kept.files.upcoming === files.upcoming) {
    kept.ctx = ctx; kept.files = files; kept.redraw = redraw;
    takeAsked(kept);
    paint(kept);
    return kept.root;
  }
  const { h } = ctx;
  const v = kept = { ctx, files, redraw, pool: unpackPool(files), tags: [], game: null, custom: false, claude: null, checking: false, checkError: null, results: [] };
  v.own = ownGames(v.pool);
  v.root = h("section.mkv-tags", { "aria-label": "Tag my game" });
  v.search = h("input.mkt-input", { type: "search", placeholder: "Find any game by name or app id", "aria-label": "Find a game", oninput: () => { v.results = searchGames(v.pool, v.search.value); paintPicker(v); } });
  v.add = h("input.mkt-input", { type: "text", list: "mkt-taglist", placeholder: "Add a tag…", "aria-label": "Add a tag", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(v, v.add.value); } }, onchange: () => addTag(v, v.add.value) });
  v.about = h("textarea.mkt-about", { rows: 4, maxlength: MAX_ABOUT, placeholder: "What the game is, in your words or pasted from the store page. Leave empty to have the server read the game's store page.", "aria-label": "About the game", oninput: () => save(v, `about:${key(v)}`, v.about.value) });
  v.picker = h("div.mkt-picker");
  v.editor = h("div.mkt-editor");
  v.report = h("div.mkt-report");
  const names = Object.values(files.overview?.tags || {}).sort();
  v.root.append(
    h("div.mkt-head", h("h2.mkt-title", "Tag my game"),
      h("p.mkt-sub", "Your game's tags against the games most like it on Steam: which of your tags go with doing well, which hold it back, and which tags similar games use that yours doesn't. Change the tags below to try ideas; nothing is sent to Steam.")),
    v.picker, v.editor, v.report,
    h("datalist", { id: "mkt-taglist" }, ...names.map((n) => h("option", { value: n }))));
  restore(v);
  takeAsked(v);
  paint(v);
  return v.root;
}

const save = (v, k, val) => { try { v.ctx.store?.set(PREFIX + k, typeof val === "string" ? val : JSON.stringify(val)); } catch {} };
const load = (v, k) => { try { return v.ctx.store?.get(PREFIX + k) ?? null; } catch { return null; } };
const loadJson = (v, k) => { try { const s = load(v, k); return s ? JSON.parse(s) : null; } catch { return null; } };
const key = (v) => v.game ? String(v.game.appid) : "custom";
const today = (v) => v.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);

function restore(v) {
  const id = Number(load(v, "game"));
  const g = v.pool.get(id) || (load(v, "game") === "custom" ? null : v.own[0]) || null;
  choose(v, g, { quiet: true });
}

function choose(v, g, { quiet = false } = {}) {
  v.game = g;
  v.custom = !g;
  save(v, "game", g ? String(g.appid) : "custom");
  const edited = loadJson(v, `tags:${key(v)}`);
  v.tags = Array.isArray(edited) ? edited.filter((t) => Number.isInteger(t)).slice(0, MAX_TAGS) : g ? [...g.tags] : [];
  v.about.value = load(v, `about:${key(v)}`) || "";
  v.claude = loadJson(v, `claude:${key(v)}`);
  v.checkError = null;
  v.results = []; v.search.value = "";
  if (!quiet) paint(v);
}

function setTags(v, tags) {
  v.tags = tags.slice(0, MAX_TAGS);
  const same = v.game && v.tags.length === v.game.tags.length && v.tags.every((t, i) => t === v.game.tags[i]);
  if (same) { try { v.ctx.store?.del?.(PREFIX + `tags:${key(v)}`); } catch {} }
  else save(v, `tags:${key(v)}`, v.tags);
  paint(v);
}

function addTag(v, text) {
  const kinds = tagKinds(v.files.overview?.tags);
  const id = kinds.byName.get(String(text).trim().toLowerCase());
  v.add.value = "";
  if (id == null || v.tags.includes(id) || v.tags.length >= MAX_TAGS) { paintEditor(v); return; }
  setTags(v, [...v.tags, id]);
  v.add.focus();
}

function paint(v) {
  paintPicker(v);
  paintEditor(v);
  paintReport(v);
}

function paintPicker(v) {
  const { h } = v.ctx;
  const chip = (g) => h("button.mkt-game", { type: "button", "aria-pressed": String(v.game?.appid === g.appid), onclick: () => choose(v, g) },
    h("b", g.name), h("small", g.released ? `${num(g.reviews)} reviews` : "coming soon"));
  v.picker.replaceChildren(
    h("div.mkt-row",
      h("span.mkt-label", "Your games"),
      ...(v.own.length ? v.own.map(chip) : [h("span.mkt-muted", "None found in the market data.")]),
      h("button.mkt-game", { type: "button", "aria-pressed": String(v.custom), onclick: () => choose(v, null) }, h("b", "A game not on Steam yet"), h("small", "type its tags"))),
    h("div.mkt-row", h("span.mkt-label", "Or any game"), h("div.mkt-searchwrap", v.search,
      v.results.length ? h("div.mkt-results", ...v.results.map((g) => h("button.mkt-result", { type: "button", onclick: () => choose(v, g) }, g.name, h("small", ` ${g.released ? `${num(g.reviews)} reviews, ${dayDate(g.day)}` : "coming soon"}`)))) : null)));
}

function paintEditor(v) {
  const { h } = v.ctx;
  const names = v.files.overview?.tags || {};
  const kinds = tagKinds(names);
  const move = (i, d) => { const t = [...v.tags]; [t[i], t[i + d]] = [t[i + d], t[i]]; setTags(v, t); };
  const chips = v.tags.map((t, i) => h("span.mkt-chip", { class: [i < TOP ? "is-top" : null, kinds.meta.has(t) ? "is-meta" : null].filter(Boolean).join(" ") || null },
    h("span.mkt-n", String(i + 1)), names[t] ?? `Tag ${t}`,
    i > 0 ? h("button.mkt-x", { type: "button", title: "Move up", "aria-label": `Move ${names[t]} up`, onclick: () => move(i, -1) }, "↑") : null,
    h("button.mkt-x", { type: "button", title: "Remove", "aria-label": `Remove ${names[t]}`, onclick: () => setTags(v, v.tags.filter((x) => x !== t)) }, "×")));
  const changed = v.game && (v.tags.length !== v.game.tags.length || v.tags.some((t, i) => t !== v.game.tags[i]));
  v.editor.replaceChildren(
    h("div.mkt-tagbox",
      h("div.mkt-taghead", h("b", v.game ? `${v.game.name}: tags, strongest first` : "Your game's tags, most important first"),
        v.game ? h("a.mkt-link", { href: `https://store.steampowered.com/app/${v.game.appid}/`, target: "_blank", rel: "noopener" }, "Store page ↗") : null,
        changed ? h("button.mkt-linkbtn", { type: "button", onclick: () => setTags(v, [...v.game.tags]) }, "Back to Steam's tags") : null),
      h("div.mkt-chips", ...chips, v.tags.length < MAX_TAGS ? v.add : null),
      h("p.mkt-muted", `The first ${TOP} (blue) are what Steam mostly goes by. `,
        v.game ? `The market data keeps a game's first 10 tags, as Steam orders them by players' votes; your Steamworks tag editor has all ${MAX_TAGS}: add the rest here to have them checked too.` : `Steam lets you pick ${MAX_TAGS}.`)));
}

function paintReport(v) {
  const { h } = v.ctx;
  const names = v.files.overview?.tags || {};
  if (!v.tags.length) { v.report.replaceChildren(h("p.mkt-note", "Add a few tags to see how they do.")); return; }
  const r = tagReport({ tags: v.tags, pool: v.pool, trends: v.files.trends, tagNames: names, today: today(v), exclude: v.game?.appid ?? null, game: v.game });
  v.last = r;
  if (r.rated.length < 10) { v.report.replaceChildren(h("p.mkt-note", `Only ${r.rated.length} released games are like this mix of tags: too few to judge by. Try fewer or broader tags.`)); return; }
  const claude = v.claude && v.claude.tags === v.tags.join(",") ? v.claude.result : null;
  const fits = new Map([...(claude?.current || []), ...(claude?.candidates || [])].map((x) => [x.tag.toLowerCase(), x]));
  const fitPill = (n) => { const f = fits.get(n.toLowerCase()); return f ? h("span.mkt-fit", { class: `is-${f.fits}`, title: f.why }, f.fits === "yes" ? "✓ fits" : f.fits === "no" ? "✗ doesn't fit" : "? maybe") : null; };
  const pillOf = (kind, say) => h("span.mkt-v", { class: `is-${kind}` }, say);
  const rateCell = (s) => h("td.mkt-num", { title: s.sure ? `Hit = top 10% of the games out the same fortnight. ${num(s.nWith)} look-alikes with it, ${num(s.nWithout)} without.` : "Too few games on one side to judge" }, `${oneIn(s.rateWith)} / ${oneIn(s.rateWithout)}`);
  const revCell = (s) => h("td.mkt-num", s.medWith == null ? "–" : `${num(s.medWith)} / ${num(s.medWithout)}`);
  const what = r.byRev ? "earned more than (estimated revenue, paid games)" : "got more reviews than";

  const lines = [];
  lines.push(`Compared with the ${num(r.looks.length)} released games most like this one (${num(r.rated.length)} out long enough to judge${r.byRev ? ", paid games only" : ""}). Among them ${oneIn(r.baseRate)} became hits${r.steamBase ? ` (all of Steam: ${oneIn(r.steamBase)})` : ""}, and a typical one ${what} ${num(r.median)}% of the games out the same fortnight. Each game is only compared with games of its own age.`);
  if (r.you) lines.push(`${v.game.name} ${what} ${r.you.hit}% of the games out the same fortnight: better than ${pct(r.you.better)} of these look-alikes.`);
  const moves = r.current.filter((c) => ["down", "up", "odd", "weak"].includes(c.kind));
  const goodAdds = r.adds.filter((a) => a.kind === "add");
  if (moves.length || goodAdds.length) lines.push(`${moves.length ? `${moves.length} of your tags could move or go` : "Your tags look sound"}${goodAdds.length ? `, and ${goodAdds.length} tag${goodAdds.length === 1 ? "" : "s"} that games like yours use went with doing better: add the ones that are true.` : "."}`);
  else lines.push("Your tags look sound: nothing stands out to change.");
  if (r.thin) lines.push("Fewer than 40 look-alikes to judge by: read this as a hint, not a verdict.");

  const top = h("div.mkt-top", h("b", "Suggested first five: "),
    ...r.top.map((x, i) => h("span.mkt-chip", { class: x.own ? "is-top" : "is-new", title: x.own ? "Already one of your tags" : "Not one of your tags yet: only if it's true" }, h("span.mkt-n", String(i + 1)), x.name, x.own ? null : h("small", " new"))),
    h("p.mkt-muted", "Ordered by how core each tag is to games like yours and how they do with it. Put true tags first; a tag that brings the wrong players costs more in refunds and reviews than it gains."));

  // Each tag is two rows: the numbers, then the reason across the whole table (so nothing scrolls away).
  const whyRow = (span, x) => h("tr.mkt-whyrow", h("td", { colspan: String(span) }, x.why,
    fits.get(x.name.toLowerCase())?.why ? h("span.mkt-claude", ` Claude: ${fits.get(x.name.toLowerCase()).why}`) : null));
  const curRows = r.current.flatMap((c) => [h("tr.mkt-main", { class: `is-${c.kind}` },
    h("td.mkt-num", String(c.pos + 1)), h("td", h("b", c.name), " ", fitPill(c.name)), h("td.mkt-num", pct(c.fit)), rateCell(c), revCell(c),
    h("td", pillOf(c.kind, c.say))), whyRow(6, c)]);
  const head = (...cols) => h("thead", h("tr", ...cols.map(([l, tip, n]) => h(n ? "th.mkt-num" : "th", { title: tip || null }, l))));
  const COLS = [["Tag"], ["Have it", "Share of the games like yours that have this tag", 1], ["Hits with / without", `How many games like yours became hits (top 10% of the games out the same fortnight, by ${r.byRev ? "estimated revenue" : "reviews"}), with the tag and without it`, 1], ["Typical rank with / without", `A typical game's rank against the games out the same fortnight (0–100, by ${r.byRev ? "estimated revenue" : "reviews"}), with the tag and without it`, 1]];
  const curTable = h("div.mkt-scroll", h("table.mkt-table", head(["#", null, 1], COLS[0], COLS[1], COLS[2], COLS[3], ["Verdict"]), h("tbody", ...curRows)));

  const addRows = r.adds.slice(0, 15).flatMap((a) => [h("tr.mkt-main", { class: `is-${a.kind}` },
    h("td", h("b", a.name), " ", fitPill(a.name)), h("td.mkt-num", pct(a.fit)), rateCell(a), revCell(a),
    h("td", pillOf(a.kind === "add" ? "good" : "keep", a.kind === "add" ? "Worth adding" : "Common"), " ",
      v.tags.length < MAX_TAGS ? h("button.mkt-linkbtn", { type: "button", onclick: () => setTags(v, [...v.tags, a.tag]) }, "Try it") : null)), whyRow(5, a)]);
  const addTable = addRows.length
    ? h("div.mkt-scroll", h("table.mkt-table", head(COLS[0], COLS[1], COLS[2], COLS[3], ["Verdict"]), h("tbody", ...addRows)))
    : h("p.mkt-note", "No tag that games like yours use stands out as one to add.");

  const lookRows = r.looks.slice(0, 20).map((g) => h("tr",
    h("td", h("a.mkt-link", { href: `https://store.steampowered.com/app/${g.appid}/`, target: "_blank", rel: "noopener" }, g.name)),
    h("td.mkt-num", pct(g.sim)), h("td.mkt-num", num(g.reviews)), h("td.mkt-num", g.hit ?? "–"), h("td.mkt-num", dayDate(g.day)),
    h("td.mkt-why", g.tags.slice(0, 6).map((t) => names[t] ?? t).join(", "))));
  const looks = h("details.mkt-fold", h("summary", `The ${Math.min(20, r.looks.length)} games most like it`),
    h("div.mkt-scroll", h("table.mkt-table", head(["Game"], ["Alike", "How much of its tag list matches, first five counted double", 1], ["Reviews", null, 1], ["Hit index", "Reviews as a percentile among games out the same fortnight (90+ = hit)", 1], ["Out", null, 1], ["First tags"]), h("tbody", ...lookRows))));

  v.report.replaceChildren(
    h("div.mkt-summary", ...lines.map((l) => h("p", l))),
    top,
    h("h3.mkt-h", "Your tags"), curTable,
    h("h3.mkt-h", "Tags to consider"), h("p.mkt-muted", "Tags that games like yours use and yours doesn't. \"Worth adding\": the ones with it did better. \"Common\": many have it; it helps Steam place you next to them. Only add a tag that's true of the game."), addTable,
    claudeBox(v, r, claude),
    looks,
    h("p.mkt-muted.mkt-caveat", "This shows which tags go together with doing well among similar games, not that a tag makes a game do well: the games that did well may just be better. Steam orders a game's tags by players' votes, led by the tags you apply in Steamworks."));
}

function claudeBox(v, r, claude) {
  const { h } = v.ctx;
  const stale = v.claude && v.claude.tags !== v.tags.join(",");
  const busy = v.checking;
  return h("div.mkt-claudebox",
    h("h3.mkt-h", "Ask Claude which tags really fit"),
    h("p.mkt-muted", "The numbers can't tell whether a tag is true of your game. Claude reads the game's description and marks each of your tags and each suggestion: fits, maybe, or doesn't fit. About a cent a check."),
    v.about,
    h("div.mkt-row",
      h("button.mkt-btn", { type: "button", disabled: busy || (!v.game && !v.about.value.trim()) ? true : null, onclick: () => check(v, r) }, busy ? "Claude is reading…" : claude ? "Ask again" : "Check with Claude"),
      !v.game && !v.about.value.trim() ? h("span.mkt-muted", "Describe the game first: it has no store page to read.") : null,
      stale ? h("span.mkt-muted", "The tags changed since the last check: ask again to mark the new ones.") : null),
    v.checkError ? h("p.mkt-error", v.checkError) : null,
    claude ? h("div.mkt-claudeans", h("p", h("b", "Claude: "), claude.summary),
      claude.source === "store" ? h("p.mkt-muted", "From the store page's description.") : null) : null);
}

async function check(v, r) {
  const names = v.files.overview?.tags || {};
  const body = {
    name: v.game?.name || "Unnamed game",
    tags: v.tags.map((t) => names[t] ?? `Tag ${t}`),
    candidates: r.adds.slice(0, 15).map((a) => a.name),
  };
  if (v.game) body.appid = v.game.appid;
  const about = v.about.value.trim();
  if (about) body.about = about;
  v.checking = true; v.checkError = null; paintReport(v);
  try {
    const result = v.ctx.dataOverride
      ? await new Promise((ok) => setTimeout(() => ok(fakeCheck(body)), 600))
      : await (await v.ctx.adminSend("tagcheck", "POST", body)).json();
    v.claude = { tags: v.tags.join(","), at: Math.floor(Date.now() / 1000), result };
    save(v, `claude:${key(v)}`, v.claude);
  } catch (e) {
    if (!e.signedOut) v.checkError = [404, 405].includes(e.status) || /HTTP 40[45]\b/.test(e.message || "")
      ? "The game-data server isn't running the tag check yet: it needs a restart with the new code (server/gamedata/tagcheck.py)."
      : e.name === "TimeoutError" ? "Claude didn't answer in time; try again." : `The check failed: ${e.reason || e.message || e}`;
  } finally {
    v.checking = false;
    paintReport(v);
  }
}

const CSS = `
.mkv-tags { min-width: 0; color: var(--fb-ink); }
.mkv-tags .mkt-title { font-size: 1.15rem; margin: 0 0 4px; color: var(--fb-title); }
.mkv-tags .mkt-sub { margin: 0 0 12px; color: var(--fb-ink-2); font-size: 0.9rem; max-width: 80ch; }
.mkv-tags .mkt-h { font-size: 1rem; margin: 22px 0 6px; color: var(--fb-title); }
.mkv-tags .mkt-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; }
.mkv-tags .mkt-label { font-weight: 650; font-size: 0.88rem; min-width: 7.5em; }
.mkv-tags .mkt-muted { color: var(--fb-muted); font-size: 0.82rem; margin: 6px 0 0; }
.mkv-tags .mkt-note { color: var(--fb-ink-2); font-size: 0.9rem; }
.mkv-tags .mkt-error { color: var(--fb-negative); font-size: 0.88rem; }
.mkv-tags .mkt-game { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; font-size: 0.88rem; cursor: pointer; text-align: left; }
.mkv-tags .mkt-game small { color: var(--fb-muted); font-size: 0.75rem; }
.mkv-tags .mkt-game:hover { background: var(--fb-hover); }
.mkv-tags .mkt-game[aria-pressed="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-tags .mkt-input { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; min-width: 0; }
.mkv-tags .mkt-searchwrap { position: relative; flex: 1 1 260px; max-width: 420px; }
.mkv-tags .mkt-searchwrap .mkt-input { width: 100%; box-sizing: border-box; }
.mkv-tags .mkt-results { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; box-shadow: var(--fb-shadow); overflow: hidden; }
.mkv-tags .mkt-result { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; background: none; color: var(--fb-ink); font: inherit; font-size: 0.88rem; cursor: pointer; }
.mkv-tags .mkt-result:hover, .mkv-tags .mkt-result:focus { background: var(--fb-hover); }
.mkv-tags .mkt-result small { color: var(--fb-muted); }
.mkv-tags .mkt-tagbox { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px; margin: 4px 0 16px; }
.mkv-tags .mkt-taghead { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin-bottom: 8px; }
.mkv-tags .mkt-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mkv-tags .mkt-chips .mkt-input { width: 11em; padding: 4px 8px; }
.mkv-tags .mkt-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 4px 3px 4px; border-radius: 999px; border: 1px solid var(--fb-line); background: var(--fb-card-2); font-size: 0.86rem; white-space: nowrap; }
.mkv-tags .mkt-chip.is-top { border-color: var(--fb-accent); }
.mkv-tags .mkt-chip.is-meta { color: var(--fb-muted); border-style: dashed; }
.mkv-tags .mkt-chip.is-new { border-color: var(--fb-positive); border-style: dashed; }
.mkv-tags .mkt-chip small { color: var(--fb-positive); font-size: 0.72rem; margin-right: 4px; }
.mkv-tags .mkt-n { display: inline-grid; place-items: center; min-width: 1.5em; height: 1.5em; border-radius: 50%; background: var(--fb-line); color: var(--fb-ink-2); font-size: 0.72rem; font-weight: 700; }
.mkv-tags .mkt-chip.is-top .mkt-n { background: var(--fb-accent); color: var(--fb-card); }
.mkv-tags .mkt-x { border: 0; background: none; color: var(--fb-muted); font: inherit; font-size: 0.85rem; padding: 0 4px; cursor: pointer; border-radius: 50%; }
.mkv-tags .mkt-x:hover { color: var(--fb-ink); background: var(--fb-hover); }
.mkv-tags .mkt-link { color: var(--fb-link); font-size: 0.85rem; }
.mkv-tags .mkt-linkbtn { appearance: none; border: 0; background: none; padding: 0; font: inherit; font-size: 0.85rem; color: var(--fb-link); cursor: pointer; text-decoration: underline; white-space: nowrap; }
.mkv-tags .mkt-btn { font: inherit; font-size: 0.9rem; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--fb-accent); background: var(--fb-accent); color: var(--fb-card); cursor: pointer; font-weight: 600; }
.mkv-tags .mkt-btn[disabled] { opacity: 0.55; cursor: default; }
.mkv-tags .mkt-summary { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 14px; }
.mkv-tags .mkt-summary p { margin: 4px 0; max-width: 90ch; }
.mkv-tags .mkt-top { margin: 14px 0 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mkv-tags .mkt-top .mkt-muted { flex-basis: 100%; }
.mkv-tags .mkt-scroll { overflow-x: auto; }
.mkv-tags .mkt-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.mkv-tags .mkt-table th { text-align: left; font-weight: 600; color: var(--fb-ink-2); font-size: 0.78rem; padding: 6px 8px; border-bottom: 1px solid var(--fb-line-strong, var(--fb-line)); white-space: nowrap; }
.mkv-tags .mkt-table td { padding: 7px 8px; border-bottom: 1px solid var(--fb-line); vertical-align: top; }
.mkv-tags .mkt-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mkv-tags .mkt-why { color: var(--fb-ink-2); min-width: 16em; }
.mkv-tags .mkt-table tr.mkt-main td { border-bottom: 0; padding-bottom: 2px; }
.mkv-tags .mkt-whyrow td { color: var(--fb-ink-2); font-size: 0.82rem; padding-top: 0; padding-bottom: 9px; }
.mkv-tags .mkt-claude { color: var(--fb-ink); }
.mkv-tags .mkt-v { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 650; white-space: nowrap; background: var(--fb-card-2); color: var(--fb-ink-2); border: 1px solid var(--fb-line); }
.mkv-tags .mkt-v.is-good, .mkv-tags .mkt-v.is-up { color: var(--fb-good-text); border-color: var(--fb-positive); }
.mkv-tags .mkt-v.is-down, .mkv-tags .mkt-v.is-weak { color: var(--fb-negative); border-color: var(--fb-negative); }
.mkv-tags .mkt-v.is-odd { color: var(--fb-ink); border-color: var(--fb-warning); }
.mkv-tags .mkt-fit { font-size: 0.72rem; font-weight: 650; white-space: nowrap; }
.mkv-tags .mkt-fit.is-yes { color: var(--fb-good-text); }
.mkv-tags .mkt-fit.is-no { color: var(--fb-negative); }
.mkv-tags .mkt-fit.is-maybe { color: var(--fb-muted); }
.mkv-tags .mkt-claudebox { margin-top: 8px; }
.mkv-tags .mkt-about { display: block; box-sizing: border-box; width: 100%; font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px; resize: vertical; margin: 8px 0; }
.mkv-tags .mkt-claudeans { background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-accent); border-radius: 8px; padding: 6px 12px; }
.mkv-tags .mkt-fold { margin-top: 18px; }
.mkv-tags .mkt-fold > summary { cursor: pointer; font-weight: 600; color: var(--fb-ink); }
.mkv-tags .mkt-caveat { margin-top: 18px; max-width: 90ch; }
@media (max-width: 640px) {
  .mkv-tags .mkt-label { min-width: 0; flex-basis: 100%; }
}
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("mk-tags-style")) return;
  const el = document.createElement("style");
  el.id = "mk-tags-style";
  el.textContent = CSS;
  document.head.append(el);
}
