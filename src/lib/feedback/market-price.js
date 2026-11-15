// The Market page's "Price my game": pick one of our games (or any game, or tags for one not on Steam
// yet) and see what games like it, made with about as much effort, sell for.
//
// The trap this avoids: across Steam, pricier games become hits far more often, but mostly because
// bigger, more polished games charge more. So the comparison holds effort fixed as well as it can with
// what's known before launch (EFFORT): how many languages, a demo, and a Steam Deck rating.
//
// How it works, all in the browser on the market files (server/steamdata/market.py):
//   1. Look-alikes: the same search as "Tag my game" (market-tags.js lookalikes()), then only those
//      within one effort step of the game (two when that leaves too few), the most alike LOOK_K.
//   2. What they charge: the typical (median) full price, the most common exact prices, and what the
//      hits among them charge.
//   3. Per price band among them: the hit chance by estimated earnings (earn index 90+) and by reviews
//      (hit index 90+), pulled toward their own rate by PRIOR games, and how much pricier bands still
//      beat cheaper ones, next to the same gap with effort not matched, so it's plain how much of it
//      was effort. What's left is partly quality no number here sees: a hint, not proof.
//   4. For our own games, what buyers really paid per copy (Steamworks sales, ctx.ownSalesDetail).
//
// Contract: priceView(ctx, files, redraw) returns one element (.mkv-price), kept and handed back on
// later calls so typing survives the page's redraws. files = { overview, trends, games, upcoming, godot }.

import { GAMES } from "@/data/games.js";
import { unpackPool, ownGames, searchGames, lookalikes, tagKinds, oneIn } from "./market-tags.js";

const PREFIX = "mkv-price-";
const DAY = 86400;
const MIN_AGE = 14;      // days out before a game's indexes say anything
const HIT = 90;          // index 90+: top 10% of its launch fortnight
const PRIOR = 12;        // band rates pulled toward the group's own by this many games
const MIN_BAND = 8;      // a band needs this many paid games to be judged
const MIN_PAID = 40;     // effort matching widens from ±1 to ±2 steps below this many paid games
const LOOK_K = 250;      // look-alikes kept after effort matching
const POOL_K = 2000;     // look-alikes searched before it
const MAX_TAGS = 20;
const TOP = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Full price in cents, upper bound exclusive: $9.99 is in "$5–9.99".
export const BANDS = [
  { lo: 1, hi: 500, label: "Under $5" },
  { lo: 500, hi: 1000, label: "$5–9.99" },
  { lo: 1000, hi: 1500, label: "$10–14.99" },
  { lo: 1500, hi: 2000, label: "$15–19.99" },
  { lo: 2000, hi: 3000, label: "$20–29.99" },
  { lo: 3000, hi: Infinity, label: "$30 and up" },
];
export const bandOf = (cents) => cents > 0 ? BANDS.findIndex((b) => cents >= b.lo && cents < b.hi) : -1;

// Effort, 0..5, from what a developer decides before launch: languages (1 / 2–5 / 6–11 / 12+ → 0..3),
// a demo (+1), Steam Deck playable or verified (+1). Checked on last year's releases: holding this
// fixed shrinks "the priciest band hits 16× as often as the cheapest" to about 2×.
export const langTier = (n) => n >= 12 ? 3 : n >= 6 ? 2 : n >= 2 ? 1 : 0;
export const effortOf = (e) => langTier(e?.langs || 0) + (e?.demo ? 1 : 0) + (e?.deck ? 1 : 0);
export const EFFORT_NAMES = ["very low", "low", "lowish", "middling", "high", "very high"];
// "High effort" for the Steam-wide table: 6+ languages, a demo and Steam Deck OK.
export const isHighEffort = (e) => (e?.langs || 0) >= 6 && !!e?.demo && !!e?.deck;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM)
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const pct = (x) => x == null || !Number.isFinite(x) ? "–" : `${Math.round(x * 100)}%`;
export const money = (c) => c == null ? "–" : c === 0 ? "Free" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const usd = (n) => n == null ? "–" : n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const times = (x) => x == null || !Number.isFinite(x) ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
export const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const monthYear = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}`; };
const effortWords = (e) => [`${num(e.langs || 0)} language${e.langs === 1 ? "" : "s"}`, e.demo ? "a demo" : "no demo", e.deck ? "Steam Deck OK" : "no Deck rating"].join(", ");

// Per price band: similarity-weighted hit rates pulled toward the group's own by PRIOR games.
function bandStats(rated) {
  let W = 0, EH = 0, RW = 0, RH = 0;
  for (const g of rated) {
    W += g.sim; EH += g.sim * (g.earn >= HIT ? 1 : 0);
    if (g.hit != null) { RW += g.sim; RH += g.sim * (g.hit >= HIT ? 1 : 0); }
  }
  const baseEarn = W ? EH / W : 0.1, baseRev = RW ? RH / RW : 0.1;
  const bands = BANDS.map((b, i) => {
    const gs = rated.filter((g) => bandOf(g.price) === i);
    let w = 0, eh = 0, rw = 0, rh = 0;
    for (const g of gs) {
      w += g.sim; eh += g.sim * (g.earn >= HIT ? 1 : 0);
      if (g.hit != null) { rw += g.sim; rh += g.sim * (g.hit >= HIT ? 1 : 0); }
    }
    return { ...b, i, n: gs.length, share: W ? w / W : 0, earnRate: (eh + PRIOR * baseEarn) / (w + PRIOR), revRate: (rh + PRIOR * baseRev) / (rw + PRIOR),
      medRev: median(gs.filter((g) => g.rev != null).map((g) => g.rev)), sure: gs.length >= MIN_BAND, points: pricePoints(gs) };
  });
  // How much the priciest judged band beats the cheapest, by earnings: the "pricier did better" gap.
  const sure = bands.filter((b) => b.sure);
  const gap = sure.length >= 2 && sure[0].earnRate > 0 ? { lo: sure[0], hi: sure.at(-1), x: sure.at(-1).earnRate / sure[0].earnRate } : null;
  return { baseEarn, baseRev, bands, gap };
}

// The whole report: tags plus the game's effort ({ langs, demo, deck }).
export function priceReport({ tags, effort, pool, today, tagNames, exclude = null }) {
  const kinds = tagKinds(tagNames);
  const all = lookalikes(tags, pool, { today, exclude, skip: kinds.meta, k: POOL_K });
  const paidOf = (gs) => gs.filter((g) => today - g.day >= MIN_AGE && g.price > 0 && g.earn != null);
  const mine = effortOf(effort);
  let width = 1;
  let looks = all.filter((g) => Math.abs(effortOf(g) - mine) <= width).slice(0, LOOK_K);
  if (paidOf(looks).length < MIN_PAID) { width = 2; looks = all.filter((g) => Math.abs(effortOf(g) - mine) <= width).slice(0, LOOK_K); }
  const rated = paidOf(looks);
  const free = looks.filter((g) => today - g.day >= MIN_AGE && g.price === 0);
  const s = bandStats(rated);
  // The same look-alikes with effort not matched, for the gap it hides.
  const rawGap = bandStats(paidOf(all.slice(0, LOOK_K))).gap;
  return {
    looks, rated, free, mine, width, ...s, rawGap,
    points: pricePoints(rated),
    typical: median(rated.map((g) => g.price)),
    hitPrice: median(rated.filter((g) => g.earn >= HIT).map((g) => g.price)),
    hitCount: rated.filter((g) => g.earn >= HIT).length,
    thin: rated.length < MIN_PAID,
  };
}

// The exact prices games use, most common first: { price, n, rate (raw hit rate by earnings) }.
function pricePoints(gs) {
  const by = new Map();
  for (const g of gs) { const p = by.get(g.price) || { price: g.price, n: 0, hits: 0 }; p.n++; if (g.earn >= HIT) p.hits++; by.set(g.price, p); }
  return [...by.values()].sort((a, b) => b.n - a.n || a.price - b.price).map((p) => ({ ...p, rate: p.hits / p.n }));
}

// For "How is Steam doing?": per release month the typical full price of new paid games and of the
// hits among them (by reviews, so no revenue estimate is in it), and per price band how the games out
// 2 weeks to a year did, all of them and the high-effort ones (isHighEffort). list: market-merged.js's
// unpackGames() rows (price, day, hit, earn, rev, langs, demo, deck).
export function priceTrends(list, today, { months = 36, minGames = 30, minHits = 10 } = {}) {
  const t = new Date(today * DAY * 1000);
  const end = t.getUTCFullYear() * 12 + t.getUTCMonth();
  const start = end - months + 1;
  const slots = Array.from({ length: months }, () => ({ prices: [], hitPrices: [] }));
  for (const g of list) {
    if (g.day == null || g.day > today || !g.price) continue;
    const d = new Date(g.day * DAY * 1000), m = d.getUTCFullYear() * 12 + d.getUTCMonth() - start;
    if (m < 0 || m >= months) continue;
    slots[m].prices.push(g.price);
    if (g.hit != null && g.hit >= HIT && today - g.day >= MIN_AGE) slots[m].hitPrices.push(g.price);
  }
  const labels = slots.map((_, i) => { const m = start + i; return `${MONTHS[m % 12]} '${String(Math.floor(m / 12)).slice(2)}`; });

  const year = list.filter((g) => g.day != null && today - g.day >= MIN_AGE && today - g.day <= 365);
  const paid = year.filter((g) => g.price > 0);
  const freeGames = year.filter((g) => !g.price);
  const rate = (gs, f) => { const r = gs.filter((g) => f(g) != null); return r.length ? r.filter((g) => f(g) >= HIT).length / r.length : null; };
  const bands = BANDS.map((b, i) => {
    const gs = paid.filter((g) => bandOf(g.price) === i), hi = gs.filter(isHighEffort);
    return { ...b, i, n: gs.length, share: paid.length ? gs.length / paid.length : 0, revRate: rate(gs, (g) => g.hit), earnRate: rate(gs, (g) => g.earn),
      hiN: hi.length, hiRevRate: rate(hi, (g) => g.hit), medRev: median(gs.filter((g) => g.rev != null).map((g) => g.rev)) };
  });
  return {
    labels, all: slots.map((s) => s.prices.length >= minGames ? median(s.prices) : null), hits: slots.map((s) => s.hitPrices.length >= minHits ? median(s.hitPrices) : null),
    nAll: slots.map((s) => s.prices.length), nHits: slots.map((s) => s.hitPrices.length),
    bands, paid: paid.length, free: freeGames.length, freeShare: year.length ? freeGames.length / year.length : null,
    freeRevRate: rate(freeGames, (g) => g.hit),
    medPaid: median(paid.map((g) => g.price)),
    medHit: median(paid.filter((g) => g.hit >= HIT).map((g) => g.price)),
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

let kept = null;

export function priceView(ctx, files, redraw) {
  injectCss();
  if (kept && kept.files.games === files.games && kept.files.upcoming === files.upcoming) {
    kept.ctx = ctx; kept.files = files; kept.redraw = redraw;
    paint(kept);
    return kept.root;
  }
  const { h } = ctx;
  const v = kept = { ctx, files, redraw, pool: unpackPool(files), tags: [], game: null, custom: false, results: [], tryCents: null, effort: { langs: 1, demo: false, deck: false } };
  // Ours: the site's list, our studio name, and every game with Steamworks sales (not all are on the site).
  v.own = ownGames(v.pool, { ids: [...GAMES.map((x) => x.appId), ...Object.keys(ctx.ownSalesDetail || {}).map(Number)] });
  v.root = h("section.mkv-price", { "aria-label": "Price my game" });
  v.search = h("input.mkp-input", { type: "search", placeholder: "Find any game by name or app id", "aria-label": "Find a game", oninput: () => { v.results = searchGames(v.pool, v.search.value); paintPicker(v); } });
  v.add = h("input.mkp-input", { type: "text", list: "mkp-taglist", placeholder: "Add a tag…", "aria-label": "Add a tag", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(v, v.add.value); } }, onchange: () => addTag(v, v.add.value) });
  v.price = h("input.mkp-input.mkp-small", { type: "number", min: "0", step: "0.01", inputmode: "decimal", "aria-label": "Price to test, in US dollars",
    oninput: () => { const d = parseFloat(v.price.value); v.tryCents = Number.isFinite(d) && d >= 0 ? Math.round(d * 100) : null; save(v, `try:${key(v)}`, v.price.value); paintReport(v); } });
  const setEffort = () => {
    const n = parseInt(v.langs.value, 10);
    v.effort = { langs: Number.isFinite(n) && n > 0 ? n : 1, demo: v.demo.checked, deck: v.deck.checked };
    save(v, `effort:${key(v)}`, v.effort);
    paintEditor(v); paintReport(v);
  };
  v.langs = h("input.mkp-input.mkp-tiny", { type: "number", min: "1", max: "40", step: "1", inputmode: "numeric", "aria-label": "Languages", oninput: setEffort });
  v.demo = h("input", { type: "checkbox", onchange: setEffort });
  v.deck = h("input", { type: "checkbox", onchange: setEffort });
  v.picker = h("div.mkp-picker");
  v.editor = h("div.mkp-editor");
  v.report = h("div.mkp-report");
  const names = Object.values(files.overview?.tags || {}).sort();
  v.root.append(
    h("div.mkp-head", h("h2.mkp-title", "Price my game"),
      h("p.mkp-sub", "What games like yours sell for, compared only with games made with about as much effort (languages, a demo, Steam Deck), since bigger games charge more and sell more. Pick one of your games, or type the tags of one that isn't out yet.")),
    v.picker, v.editor, v.report,
    h("datalist", { id: "mkp-taglist" }, ...names.map((n) => h("option", { value: n }))));
  restore(v);
  paint(v);
  return v.root;
}

const save = (v, k, val) => { try { v.ctx.store?.set(PREFIX + k, typeof val === "string" ? val : JSON.stringify(val)); } catch {} };
const load = (v, k) => { try { return v.ctx.store?.get(PREFIX + k) ?? null; } catch { return null; } };
const loadJson = (v, k) => { try { const s = load(v, k); return s ? JSON.parse(s) : null; } catch { return null; } };
const drop = (v, k) => { try { v.ctx.store?.del?.(PREFIX + k); } catch {} };
const key = (v) => v.game ? String(v.game.appid) : "custom";
const today = (v) => v.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const gameEffort = (g) => g ? { langs: g.langs || 1, demo: !!g.demo, deck: !!g.deck } : { langs: 1, demo: false, deck: false };
const sameEffort = (a, b) => a.langs === b.langs && a.demo === b.demo && a.deck === b.deck;

function restore(v) {
  const saved = load(v, "game");
  const g = v.pool.get(Number(saved)) || (saved === "custom" ? null : v.own.find((x) => x.released) || v.own[0]) || null;
  choose(v, g, { quiet: true });
}

function choose(v, g, { quiet = false } = {}) {
  v.game = g;
  v.custom = !g;
  save(v, "game", g ? String(g.appid) : "custom");
  const edited = loadJson(v, `tags:${key(v)}`);
  v.tags = Array.isArray(edited) ? edited.filter((t) => Number.isInteger(t)).slice(0, MAX_TAGS) : g ? [...g.tags] : [];
  const tried = load(v, `try:${key(v)}`);
  v.price.value = tried ?? (g?.price > 0 ? (g.price / 100).toFixed(2) : "");
  const d = parseFloat(v.price.value);
  v.tryCents = Number.isFinite(d) && d >= 0 ? Math.round(d * 100) : null;
  const e = loadJson(v, `effort:${key(v)}`);
  v.effort = e && typeof e === "object" ? { langs: Number(e.langs) || 1, demo: !!e.demo, deck: !!e.deck } : gameEffort(g);
  v.langs.value = String(v.effort.langs); v.demo.checked = v.effort.demo; v.deck.checked = v.effort.deck;
  v.results = []; v.search.value = "";
  if (!quiet) paint(v);
}

function setTags(v, tags) {
  v.tags = tags.slice(0, MAX_TAGS);
  const same = v.game && v.tags.length === v.game.tags.length && v.tags.every((t, i) => t === v.game.tags[i]);
  if (same) drop(v, `tags:${key(v)}`); else save(v, `tags:${key(v)}`, v.tags);
  paint(v);
}

function addTag(v, text) {
  const id = tagKinds(v.files.overview?.tags).byName.get(String(text).trim().toLowerCase());
  v.add.value = "";
  if (id == null || v.tags.includes(id) || v.tags.length >= MAX_TAGS) { paintEditor(v); return; }
  setTags(v, [...v.tags, id]);
  v.add.focus();
}

function paint(v) { paintPicker(v); paintEditor(v); paintReport(v); }

function paintPicker(v) {
  const { h } = v.ctx;
  const chip = (g) => h("button.mkp-game", { type: "button", "aria-pressed": String(v.game?.appid === g.appid), onclick: () => choose(v, g) },
    h("b", g.name), h("small", g.released ? `${money(g.price)} · ${num(g.reviews)} reviews` : "coming soon"));
  v.picker.replaceChildren(
    h("div.mkp-row",
      h("span.mkp-label", "Your games"),
      ...(v.own.length ? v.own.map(chip) : [h("span.mkp-muted", "None found in the market data.")]),
      h("button.mkp-game", { type: "button", "aria-pressed": String(v.custom), onclick: () => choose(v, null) }, h("b", "A game not on Steam yet"), h("small", "type its tags"))),
    h("div.mkp-row", h("span.mkp-label", "Or any game"), h("div.mkp-searchwrap", v.search,
      v.results.length ? h("div.mkp-results", ...v.results.map((g) => h("button.mkp-result", { type: "button", onclick: () => choose(v, g) }, g.name, h("small", ` ${g.released ? `${money(g.price)}, ${num(g.reviews)} reviews, ${monthYear(g.day)}` : "coming soon"}`)))) : null)));
}

function paintEditor(v) {
  const { h } = v.ctx;
  const names = v.files.overview?.tags || {};
  const chips = v.tags.map((t, i) => h("span.mkp-chip", { class: i < TOP ? "is-top" : null }, names[t] ?? `Tag ${t}`,
    h("button.mkp-x", { type: "button", title: "Remove", "aria-label": `Remove ${names[t]}`, onclick: () => setTags(v, v.tags.filter((x) => x !== t)) }, "×")));
  const changed = v.game && (v.tags.length !== v.game.tags.length || v.tags.some((t, i) => t !== v.game.tags[i]));
  const effortChanged = v.game && !sameEffort(v.effort, gameEffort(v.game));
  v.editor.replaceChildren(
    h("div.mkp-box",
      h("div.mkp-boxhead", h("b", v.game ? `${v.game.name}: tags` : "Your game's tags, most important first"),
        v.game ? h("a.mkp-link", { href: `https://store.steampowered.com/app/${v.game.appid}/`, target: "_blank", rel: "noopener" }, "Store page ↗") : null,
        changed ? h("button.mkp-linkbtn", { type: "button", onclick: () => setTags(v, [...v.game.tags]) }, "Back to Steam's tags") : null),
      h("div.mkp-chips", ...chips, v.tags.length < MAX_TAGS ? v.add : null),
      h("div.mkp-effort",
        h("span.mkp-flabel", "Effort:"),
        h("label", v.langs, " languages"),
        h("label", v.demo, " a demo"),
        h("label", v.deck, " Steam Deck playable or verified"),
        h("span.mkp-muted.mkp-inline", `(${EFFORT_NAMES[effortOf(v.effort)]})`),
        effortChanged ? h("button.mkp-linkbtn", { type: "button", onclick: () => { drop(v, `effort:${key(v)}`); choose(v, v.game); } }, "Back to the store page's") : null),
      h("div.mkp-effort",
        h("span.mkp-flabel", "Price to test: $"), v.price,
        v.game?.price > 0 && v.tryCents !== v.game.price ? h("button.mkp-linkbtn", { type: "button", onclick: () => { drop(v, `try:${key(v)}`); choose(v, v.game); } }, `Back to ${money(v.game.price)}`) : null)));
}

function paintReport(v) {
  const { h } = v.ctx;
  if (!v.tags.length) { v.report.replaceChildren(h("p.mkp-note", "Add a few tags to see what games like it sell for.")); return; }
  const r = priceReport({ tags: v.tags, effort: v.effort, pool: v.pool, today: today(v), tagNames: v.files.overview?.tags || {}, exclude: v.game?.appid ?? null });
  if (r.rated.length < 15) { v.report.replaceChildren(h("p.mkp-note", `Only ${r.rated.length} paid games are like this mix of tags and effort: too few to judge by. Try fewer or broader tags.`)); return; }
  const name = v.game?.name || "your game";
  const tb = v.tryCents > 0 ? r.bands[bandOf(v.tryCents)] : null;
  const common = r.points.slice(0, 3);

  const lines = [];
  lines.push(`Compared with the ${num(r.rated.length)} paid games most like ${name} (out at least 2 weeks) that were made with about as much effort: ${effortWords(v.effort)}, give or take ${r.width === 1 ? "one step" : "two steps (one left too few games)"}.${r.free.length ? ` ${num(r.free.length)} more are free.` : ""}`);
  lines.push(h("span", h("b", `They typically charge ${money(r.typical)}.`),
    common.length ? ` The most common prices: ${common.map((p) => `${money(p.price)} (${num(p.n)} games)`).join(", ")}.` : "",
    r.hitPrice != null ? ` The ${num(r.hitCount)} that became hits typically charge ${money(r.hitPrice)}.` : ""));
  if (v.tryCents === 0) lines.push(`Free: earnings aren't estimated for free games, so this page can't weigh free against paid.`);
  else if (v.tryCents > 0) {
    const below = r.rated.filter((g) => g.price < v.tryCents).length / r.rated.length, above = r.rated.filter((g) => g.price > v.tryCents).length / r.rated.length;
    lines.push(`At ${money(v.tryCents)} you'd be ${above >= below ? `cheaper than ${pct(above)}` : `pricier than ${pct(below)}`} of them${tb?.sure ? `; ${oneIn(tb.earnRate)} of those in ${tb.label} became hits by earnings` : ""}.`);
  }
  if (r.gap) {
    const said = r.rawGap && r.rawGap.x > r.gap.x * 1.2 ? ` With effort not matched it was ${times(r.rawGap.x)}, so most of that gap was bigger games charging more.` : "";
    lines.push(`Among them, ${r.gap.hi.label} games still became hits ${times(r.gap.x)} as often as ${r.gap.lo.label} ones.${said} What's left is likely part quality that no number here can see, so read it as "don't underprice a game that matches these", not "a higher price sells more".`);
  }
  if (r.thin) lines.push(`Fewer than ${MIN_PAID} paid games to compare with: read this as a hint, not a verdict.`);

  const maxE = Math.max(...r.bands.map((b) => b.earnRate), 0.01), maxR = Math.max(...r.bands.map((b) => b.revRate), 0.01);
  const bar = (x, max, text) => h("td.mkp-num", h("div.mkp-barcell", h("span.mkp-bar", h("i", { style: `width:${Math.min(1, x / max) * 100}%` })), h("span", text)));
  const bandRows = r.bands.map((b) => h("tr", { class: [b === tb ? "is-you" : null, b.sure ? null : "is-thin"].filter(Boolean).join(" ") || null },
    h("td", h("b", b.label), b === tb ? h("span.mkp-pill.is-you", "your price") : null),
    h("td.mkp-num", { title: `${pct(b.share)} of them, by how alike they are` }, num(b.n)),
    bar(b.earnRate, maxE, b.sure ? oneIn(b.earnRate) : "–"),
    bar(b.revRate, maxR, b.sure ? oneIn(b.revRate) : "–"),
    h("td.mkp-num", b.sure ? usd(b.medRev) : "–"),
    h("td.mkp-dim", b.points.slice(0, 3).map((p) => `${money(p.price)} (${p.n})`).join(", ") || "–")));
  const head = (...cols) => h("thead", h("tr", ...cols.map(([l, tip, n]) => h(n ? "th.mkp-num" : "th", { title: tip || null }, l))));
  const bandTable = h("div.mkp-scroll", h("table.mkp-table",
    head(["Full price"], ["Games", "Paid games like yours, of similar effort, at this price", 1],
      ["Hits by earnings", "How many became hits: top 10% of paid games out the same fortnight by estimated revenue. Pulled toward the group's average when a band has few games.", 1],
      ["Hits by reviews", "Top 10% of the games out the same week by reviews: players reached, no revenue estimate in it. Cheap games get fewer reviews per copy, so this undercounts them.", 1],
      ["Typical lifetime revenue", "Median estimated lifetime net revenue (after Steam's cut, VAT and refunds)", 1],
      ["Common prices"]),
    h("tbody", ...bandRows)));

  const pointRows = r.points.slice(0, 10).map((p) => h("tr", { class: p.price === v.tryCents ? "is-you" : null },
    h("td", h("b", money(p.price))), h("td.mkp-num", num(p.n)), h("td.mkp-num", p.n >= MIN_BAND ? oneIn(p.rate) : "–")));
  const pointTable = h("div.mkp-scroll", h("table.mkp-table.mkp-narrow", head(["Price"], ["Games", null, 1], ["Hits by earnings", "Not pulled toward the average: needs 8+ games to show", 1]), h("tbody", ...pointRows)));

  const lookRows = r.rated.slice(0, 25).map((g) => h("tr",
    h("td", h("a.mkp-link", { href: `https://store.steampowered.com/app/${g.appid}/`, target: "_blank", rel: "noopener" }, g.name)),
    h("td.mkp-num", money(g.price)), h("td.mkp-num", pct(g.sim)), h("td.mkp-num", num(g.langs)), h("td", [g.demo ? "demo" : null, g.deck ? "Deck" : null].filter(Boolean).join(", ") || "–"),
    h("td.mkp-num", num(g.reviews)), h("td.mkp-num", g.earn ?? "–"), h("td.mkp-num", monthYear(g.day))));
  const looks = h("details.mkp-fold", h("summary", `The ${Math.min(25, r.rated.length)} paid games most like it`),
    h("div.mkp-scroll", h("table.mkp-table", head(["Game"], ["Price", "Today's full price", 1], ["Alike", null, 1], ["Languages", null, 1], ["Has"], ["Reviews", null, 1], ["Earn index", "Estimated revenue as a percentile among paid games out the same fortnight (90+ = hit)", 1], ["Out", null, 1]), h("tbody", ...lookRows))));

  const history = v.files.overview?.historyFrom;
  const model = v.files.games?.revenueModel;
  const facs = model?.salesPerReviewByPrice?.map(([, f]) => f) || [];
  v.report.replaceChildren(
    h("div.mkp-summary", ...lines.map((l) => h("p", l))),
    ownBox(v),
    h("h3.mkp-h", "By price, among games like yours of similar effort"), bandTable,
    h("p.mkp-muted", "Bands with fewer than 8 games show no rates. Rates are weighted by how alike each game is to yours."),
    h("h3.mkp-h", "The exact prices they use"), pointTable,
    looks,
    h("p.mkp-muted.mkp-caveat",
      "Effort here is only what's on the store page: languages, a demo, a Steam Deck rating. How good a game is, players decide, and part of that they judge against the price, so no store number can hold quality fully fixed. ",
      facs.length ? `The earnings columns assume cheaper games sell more copies per review (×${Math.max(...facs)} under $5 down to ×${Math.min(...facs)} at $40+, from public estimates). ` : "",
      `What a price change really does shows best when the same game changes price: the server has kept every game's daily price, discount and reviews${history != null ? ` since ${dayDate(history)}` : ""}, and the sales ahead will show how much a discount lifts games like yours.`));
}

// Our own game's real sales from Steamworks (ctx.ownSalesDetail: { appid: { units, returnedUnits, gross, net } }).
function ownBox(v) {
  const { h } = v.ctx;
  const s = v.game && v.ctx.ownSalesDetail?.[v.game.appid];
  if (!s || !(s.units > 0)) return null;
  const kept = s.units - (s.returnedUnits || 0);
  const perCopy = kept > 0 ? (s.net / kept) * 100 : null;  // cents, after VAT and refunds, before Steam's cut
  const list = v.game.price;
  return h("div.mkp-own",
    h("b", `${v.game.name}'s real sales so far (Steamworks)`),
    h("p", `${num(s.units)} copies sold, ${num(s.returnedUnits || 0)} refunded (${pct((s.returnedUnits || 0) / s.units)}). `,
      perCopy != null ? `Buyers paid ${money(Math.round(perCopy))} a kept copy on average after VAT and refunds${list > 0 ? `, ${pct(perCopy / list)} of the ${money(list)} list price (launch discounts, sales and cheaper regional prices)` : ""}; you keep 70% of that: ${money(Math.round(perCopy * 0.7))}.` : ""));
}

const CSS = `
.mkv-price { min-width: 0; color: var(--fb-ink); }
.mkv-price .mkp-title { font-size: 1.15rem; margin: 0 0 4px; color: var(--fb-title); }
.mkv-price .mkp-sub { margin: 0 0 12px; color: var(--fb-ink-2); font-size: 0.9rem; max-width: 80ch; }
.mkv-price .mkp-h { font-size: 1rem; margin: 22px 0 6px; color: var(--fb-title); }
.mkv-price .mkp-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 10px; }
.mkv-price .mkp-label { font-weight: 650; font-size: 0.88rem; min-width: 7.5em; }
.mkv-price .mkp-muted { color: var(--fb-muted); font-size: 0.82rem; margin: 6px 0 0; }
.mkv-price .mkp-inline { margin: 0; }
.mkv-price .mkp-note { color: var(--fb-ink-2); font-size: 0.9rem; }
.mkv-price .mkp-dim { color: var(--fb-muted); }
.mkv-price .mkp-game { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; font-size: 0.88rem; cursor: pointer; text-align: left; }
.mkv-price .mkp-game small { color: var(--fb-muted); font-size: 0.75rem; }
.mkv-price .mkp-game:hover { background: var(--fb-hover); }
.mkv-price .mkp-game[aria-pressed="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-price .mkp-input { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; min-width: 0; }
.mkv-price .mkp-small { width: 7em; }
.mkv-price .mkp-tiny { width: 4.5em; padding: 4px 8px; }
.mkv-price .mkp-searchwrap { position: relative; flex: 1 1 260px; max-width: 420px; }
.mkv-price .mkp-searchwrap .mkp-input { width: 100%; box-sizing: border-box; }
.mkv-price .mkp-results { position: absolute; z-index: 5; left: 0; right: 0; top: calc(100% + 4px); background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; box-shadow: var(--fb-shadow); overflow: hidden; }
.mkv-price .mkp-result { display: block; width: 100%; text-align: left; padding: 7px 10px; border: 0; background: none; color: var(--fb-ink); font: inherit; font-size: 0.88rem; cursor: pointer; }
.mkv-price .mkp-result:hover, .mkv-price .mkp-result:focus { background: var(--fb-hover); }
.mkv-price .mkp-result small { color: var(--fb-muted); }
.mkv-price .mkp-box { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px; margin: 4px 0 16px; }
.mkv-price .mkp-boxhead { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; margin-bottom: 8px; }
.mkv-price .mkp-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mkv-price .mkp-chips .mkp-input { width: 11em; padding: 4px 8px; }
.mkv-price .mkp-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 999px; border: 1px solid var(--fb-line); background: var(--fb-card-2); font-size: 0.86rem; white-space: nowrap; }
.mkv-price .mkp-chip.is-top { border-color: var(--fb-accent); }
.mkv-price .mkp-x { border: 0; background: none; color: var(--fb-muted); font: inherit; font-size: 0.85rem; padding: 0 4px; cursor: pointer; border-radius: 50%; }
.mkv-price .mkp-x:hover { color: var(--fb-ink); background: var(--fb-hover); }
.mkv-price .mkp-effort { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 12px; font-size: 0.9rem; }
.mkv-price .mkp-effort label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.mkv-price .mkp-flabel { font-weight: 600; }
.mkv-price .mkp-link { color: var(--fb-link); font-size: 0.85rem; }
.mkv-price .mkp-table .mkp-link { font-size: inherit; }
.mkv-price .mkp-linkbtn { appearance: none; border: 0; background: none; padding: 0; font: inherit; font-size: 0.85rem; font-weight: 400; color: var(--fb-link); cursor: pointer; text-decoration: underline; white-space: nowrap; }
.mkv-price .mkp-summary { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 14px; }
.mkv-price .mkp-summary p { margin: 4px 0; max-width: 90ch; }
.mkv-price .mkp-own { margin-top: 10px; background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-positive); border-radius: 8px; padding: 8px 12px; }
.mkv-price .mkp-own p { margin: 4px 0 0; max-width: 90ch; }
.mkv-price .mkp-scroll { overflow-x: auto; }
.mkv-price .mkp-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.mkv-price .mkp-narrow { width: auto; min-width: 280px; }
.mkv-price .mkp-table th { text-align: left; font-weight: 600; color: var(--fb-ink-2); font-size: 0.78rem; padding: 6px 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; }
.mkv-price .mkp-table td { padding: 7px 8px; border-bottom: 1px solid var(--fb-line); vertical-align: middle; }
.mkv-price .mkp-table tr.is-you td:first-child { box-shadow: inset 3px 0 0 var(--fb-accent); }
.mkv-price .mkp-table tr.is-thin td { color: var(--fb-muted); }
.mkv-price .mkp-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mkv-price .mkp-barcell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mkv-price .mkp-bar { display: inline-block; width: 70px; height: 8px; border-radius: 4px; background: var(--fb-line); overflow: hidden; }
.mkv-price .mkp-bar i { display: block; height: 100%; background: var(--sw-1); border-radius: 4px; }
.mkv-price .mkp-pill { display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; border: 1px solid var(--fb-line); white-space: nowrap; }
.mkv-price .mkp-pill.is-you { color: var(--fb-accent); border-color: var(--fb-accent); }
.mkv-price .mkp-fold { margin-top: 18px; }
.mkv-price .mkp-fold > summary { cursor: pointer; font-weight: 600; color: var(--fb-ink); }
.mkv-price .mkp-caveat { margin-top: 18px; max-width: 90ch; }
@media (max-width: 640px) {
  .mkv-price .mkp-label { min-width: 0; flex-basis: 100%; }
}
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("mk-price-style")) return;
  const el = document.createElement("style");
  el.id = "mk-price-style";
  el.textContent = CSS;
  document.head.append(el);
}
