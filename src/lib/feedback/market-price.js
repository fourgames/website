// The Market page's "Price my game": pick one of our games (or any game, or tags for one not on Steam
// yet) and see what the games most like it sell for, and which prices went with doing well.
//
// How it works, all in the browser on the market files (server/steamdata/market.py):
//   1. Look-alikes: the same search as "Tag my game" (market-tags.js lookalikes()): released games from
//      the last three years sharing the most of the game's tags, each weighted by how alike it is.
//   2. Paid look-alikes out 2+ weeks, split into price bands by today's full price. For each band:
//      the hit chance by estimated earnings (earn index 90+: top 10% of paid games out the same
//      fortnight) and by reviews (hit index 90+: players reached, with no revenue estimate in it),
//      both pulled toward the look-alikes' own rate by PRIOR games so a few lucky ones can't win.
//   3. The best band (by earnings, with at least MIN_BAND games), the most common exact prices, and
//      for our own games what buyers really paid per copy (Steamworks sales, ctx.ownSalesDetail).
// It shows which prices go together with doing well among similar games, not that a price causes it.
//
// Contract: priceView(ctx, files, redraw) returns one element (.mkv-price), kept and handed back on
// later calls so typing survives the page's redraws. files = { overview, trends, games, upcoming, godot }.

import { GAMES } from "@/data/games.js";
import { unpackPool, ownGames, searchGames, lookalikes, tagKinds, oneIn } from "./market-tags.js";

const PREFIX = "mkv-price-";
const DAY = 86400;
const MIN_AGE = 14;      // days out before a game's indexes say anything
const HIT = 90;          // index 90+: top 10% of its launch fortnight
const PRIOR = 12;        // band rates pulled toward the look-alikes' own by this many games
const MIN_BAND = 8;      // a band needs this many paid look-alikes to be judged
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

// Similarity-weighted hit rates of a group, pulled toward `base` by PRIOR games.
function rates(gs, baseEarn, baseRev) {
  let w = 0, eh = 0, rw = 0, rh = 0;
  for (const g of gs) {
    w += g.sim; eh += g.sim * (g.earn >= HIT ? 1 : 0);
    if (g.hit != null) { rw += g.sim; rh += g.sim * (g.hit >= HIT ? 1 : 0); }
  }
  return { w, earnRate: (eh + PRIOR * baseEarn) / (w + PRIOR), revRate: (rh + PRIOR * baseRev) / (rw + PRIOR) };
}

// The whole report for a list of tag ids.
export function priceReport({ tags, pool, today, tagNames, exclude = null }) {
  const kinds = tagKinds(tagNames);
  const looks = lookalikes(tags, pool, { today, exclude, skip: kinds.meta });
  const dated = looks.filter((g) => today - g.day >= MIN_AGE && g.price != null);
  const free = dated.filter((g) => g.price === 0);
  const rated = dated.filter((g) => g.price > 0 && g.earn != null);
  let W = 0, EH = 0, RW = 0, RH = 0;
  for (const g of rated) {
    W += g.sim; EH += g.sim * (g.earn >= HIT ? 1 : 0);
    if (g.hit != null) { RW += g.sim; RH += g.sim * (g.hit >= HIT ? 1 : 0); }
  }
  const baseEarn = W ? EH / W : 0.1, baseRev = RW ? RH / RW : 0.1;
  const bands = BANDS.map((b, i) => {
    const gs = rated.filter((g) => bandOf(g.price) === i);
    const r = rates(gs, baseEarn, baseRev);
    return { ...b, i, n: gs.length, share: W ? r.w / W : 0, earnRate: r.earnRate, revRate: r.revRate,
      medEarn: median(gs.map((g) => g.earn)), medRev: median(gs.filter((g) => g.rev != null).map((g) => g.rev)),
      sure: gs.length >= MIN_BAND, points: pricePoints(gs) };
  });
  const sure = bands.filter((b) => b.sure);
  const top = (key) => sure.length ? sure.reduce((a, b) => b[key] > a[key] ? b : a) : null;
  const best = top("earnRate"), bestRev = top("revRate");
  // A band within 10% of the best is said as a close second, so the pick doesn't look sharper than it is.
  const close = best ? sure.filter((b) => b !== best && b.earnRate >= best.earnRate * 0.9) : [];
  return {
    looks, rated, free, baseEarn, baseRev, bands, best, bestRev, close,
    points: pricePoints(rated),
    hitPrice: median(rated.filter((g) => g.earn >= HIT).map((g) => g.price)),
    allPrice: median(rated.map((g) => g.price)),
    hitCount: rated.filter((g) => g.earn >= HIT).length,
    thin: rated.length < 40,
  };
}

// The exact prices games use, most common first: { price, n, earnRate (raw) }.
function pricePoints(gs) {
  const by = new Map();
  for (const g of gs) { const p = by.get(g.price) || { price: g.price, n: 0, hits: 0 }; p.n++; if (g.earn >= HIT) p.hits++; by.set(g.price, p); }
  return [...by.values()].sort((a, b) => b.n - a.n || a.price - b.price).map((p) => ({ ...p, rate: p.hits / p.n }));
}

// For "How is Steam doing?": per release month the typical full price of new paid games and of the
// hits among them (by reviews, so no revenue estimate is in it), and per price band how the games out
// 2 weeks to a year did. list: market-merged.js's unpackGames() rows (price, day, hit, earn, rev).
export function priceTrends(list, today, { months = 36, minGames = 30, minHits = 10 } = {}) {
  const t = new Date(today * DAY * 1000);
  const end = t.getUTCFullYear() * 12 + t.getUTCMonth();
  const start = end - months + 1;
  const slots = Array.from({ length: months }, () => ({ prices: [], hitPrices: [], free: 0, all: 0 }));
  for (const g of list) {
    if (g.day == null || g.day > today) continue;
    const d = new Date(g.day * DAY * 1000), m = d.getUTCFullYear() * 12 + d.getUTCMonth() - start;
    if (m < 0 || m >= months) continue;
    const s = slots[m];
    s.all++;
    if (!g.price) { s.free++; continue; }
    s.prices.push(g.price);
    if (g.hit != null && g.hit >= HIT && today - g.day >= MIN_AGE) s.hitPrices.push(g.price);
  }
  const labels = slots.map((_, i) => { const m = start + i; return `${MONTHS[m % 12]} '${String(Math.floor(m / 12)).slice(2)}`; });
  const all = slots.map((s) => s.prices.length >= minGames ? median(s.prices) : null);
  const hits = slots.map((s) => s.hitPrices.length >= minHits ? median(s.hitPrices) : null);

  // The last year's games, old enough to judge.
  const year = list.filter((g) => g.day != null && today - g.day >= MIN_AGE && today - g.day <= 365);
  const paid = year.filter((g) => g.price > 0);
  const freeGames = year.filter((g) => !g.price);
  const rate = (gs, f) => { const r = gs.filter((g) => f(g) != null); return r.length ? r.filter((g) => f(g) >= HIT).length / r.length : null; };
  const bands = BANDS.map((b, i) => {
    const gs = paid.filter((g) => bandOf(g.price) === i);
    return { ...b, i, n: gs.length, share: paid.length ? gs.length / paid.length : 0, revRate: rate(gs, (g) => g.hit), earnRate: rate(gs, (g) => g.earn),
      medRev: median(gs.filter((g) => g.rev != null).map((g) => g.rev)) };
  });
  return {
    labels, all, hits, nAll: slots.map((s) => s.prices.length), nHits: slots.map((s) => s.hitPrices.length),
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
  const v = kept = { ctx, files, redraw, pool: unpackPool(files), tags: [], game: null, custom: false, results: [], tryCents: null };
  // Ours: the site's list, our studio name, and every game with Steamworks sales (not all are on the site).
  v.own = ownGames(v.pool, { ids: [...GAMES.map((x) => x.appId), ...Object.keys(ctx.ownSalesDetail || {}).map(Number)] });
  v.root = h("section.mkv-price", { "aria-label": "Price my game" });
  v.search = h("input.mkp-input", { type: "search", placeholder: "Find any game by name or app id", "aria-label": "Find a game", oninput: () => { v.results = searchGames(v.pool, v.search.value); paintPicker(v); } });
  v.add = h("input.mkp-input", { type: "text", list: "mkp-taglist", placeholder: "Add a tag…", "aria-label": "Add a tag", onkeydown: (e) => { if (e.key === "Enter") { e.preventDefault(); addTag(v, v.add.value); } }, onchange: () => addTag(v, v.add.value) });
  v.price = h("input.mkp-input.mkp-price", { type: "number", min: "0", step: "0.01", inputmode: "decimal", "aria-label": "Price to test, in US dollars",
    oninput: () => { const d = parseFloat(v.price.value); v.tryCents = Number.isFinite(d) && d >= 0 ? Math.round(d * 100) : null; save(v, `try:${key(v)}`, v.price.value); paintReport(v); } });
  v.picker = h("div.mkp-picker");
  v.editor = h("div.mkp-editor");
  v.report = h("div.mkp-report");
  const names = Object.values(files.overview?.tags || {}).sort();
  v.root.append(
    h("div.mkp-head", h("h2.mkp-title", "Price my game"),
      h("p.mkp-sub", "What the games most like yours sell for on Steam, and which prices went with doing well among them. Pick one of your games, or type the tags of one that isn't out yet.")),
    v.picker, v.editor, v.report,
    h("datalist", { id: "mkp-taglist" }, ...names.map((n) => h("option", { value: n }))));
  restore(v);
  paint(v);
  return v.root;
}

const save = (v, k, val) => { try { v.ctx.store?.set(PREFIX + k, typeof val === "string" ? val : JSON.stringify(val)); } catch {} };
const load = (v, k) => { try { return v.ctx.store?.get(PREFIX + k) ?? null; } catch { return null; } };
const drop = (v, k) => { try { v.ctx.store?.del?.(PREFIX + k); } catch {} };
const key = (v) => v.game ? String(v.game.appid) : "custom";
const today = (v) => v.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);

function restore(v) {
  const saved = load(v, "game");
  const g = v.pool.get(Number(saved)) || (saved === "custom" ? null : v.own.find((x) => x.released) || v.own[0]) || null;
  choose(v, g, { quiet: true });
}

function choose(v, g, { quiet = false } = {}) {
  v.game = g;
  v.custom = !g;
  save(v, "game", g ? String(g.appid) : "custom");
  let edited = null; try { edited = JSON.parse(load(v, `tags:${key(v)}`) || "null"); } catch {}
  v.tags = Array.isArray(edited) ? edited.filter((t) => Number.isInteger(t)).slice(0, MAX_TAGS) : g ? [...g.tags] : [];
  const tried = load(v, `try:${key(v)}`);
  v.price.value = tried ?? (g?.price > 0 ? (g.price / 100).toFixed(2) : "");
  const d = parseFloat(v.price.value);
  v.tryCents = Number.isFinite(d) && d >= 0 ? Math.round(d * 100) : null;
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
  v.editor.replaceChildren(
    h("div.mkp-box",
      h("div.mkp-boxhead", h("b", v.game ? `${v.game.name}: tags` : "Your game's tags, most important first"),
        v.game ? h("a.mkp-link", { href: `https://store.steampowered.com/app/${v.game.appid}/`, target: "_blank", rel: "noopener" }, "Store page ↗") : null,
        changed ? h("button.mkp-linkbtn", { type: "button", onclick: () => setTags(v, [...v.game.tags]) }, "Back to Steam's tags") : null),
      h("div.mkp-chips", ...chips, v.tags.length < MAX_TAGS ? v.add : null),
      h("label.mkp-pricerow", h("span", "Price to test: $"), v.price,
        v.game?.price > 0 && v.tryCents !== v.game.price ? h("button.mkp-linkbtn", { type: "button", onclick: () => { drop(v, `try:${key(v)}`); choose(v, v.game); } }, `Back to ${money(v.game.price)}`) : null)));
}

function paintReport(v) {
  const { h } = v.ctx;
  if (!v.tags.length) { v.report.replaceChildren(h("p.mkp-note", "Add a few tags to see what games like it sell for.")); return; }
  const r = priceReport({ tags: v.tags, pool: v.pool, today: today(v), tagNames: v.files.overview?.tags || {}, exclude: v.game?.appid ?? null });
  if (r.rated.length < 15) { v.report.replaceChildren(h("p.mkp-note", `Only ${r.rated.length} paid games are like this mix of tags: too few to judge by. Try fewer or broader tags.`)); return; }
  const name = v.game?.name || "your game";
  const tb = v.tryCents > 0 ? r.bands[bandOf(v.tryCents)] : null;

  const lines = [];
  lines.push(`Compared with the ${num(r.looks.length)} released games most like ${name}: ${num(r.rated.length)} paid ones out at least 2 weeks${r.free.length ? `, and ${num(r.free.length)} free ones` : ""}. Across all prices ${oneIn(r.baseEarn)} became hits by estimated earnings.`);
  if (r.best) {
    const pt = r.best.points[0];
    lines.push(h("span", h("b", `Best price among them: ${r.best.label}. `),
      `${oneIn(r.best.earnRate)} of those games became hits by earnings${pt ? `; the most common price there is ${money(pt.price)} (${num(pt.n)} games)` : ""}.`,
      r.close.length ? ` ${r.close.map((b) => b.label).join(" and ")} did almost as well (${r.close.map((b) => oneIn(b.earnRate)).join(", ")}).` : ""));
    if (r.bestRev && r.bestRev.i === r.best.i) lines.push("It also wins by reviews (players reached), which doesn't use the revenue estimate, so the two agree.");
    else if (r.bestRev) lines.push(`By reviews alone (players reached, no revenue estimate in it) ${r.bestRev.label} does best: ${oneIn(r.bestRev.revRate)} became hits. A higher price earns more per player, so the two can differ: the earnings pick is the one about money.`);
  }
  if (v.tryCents === 0) lines.push(`Free: ${num(r.free.length)} of the look-alikes are free. Earnings aren't estimated for free games, so this page can't price that against paid.`);
  else if (tb) {
    let s = `At ${money(v.tryCents)} (${tb.label}): ${oneIn(tb.earnRate)} of ${num(tb.n)} games like it became hits by earnings${tb.sure ? "" : " (too few games to be sure)"}.`;
    if (r.best && tb.i !== r.best.i && tb.earnRate > 0) s += ` ${r.best.label} did ${times(r.best.earnRate / tb.earnRate)} as well.`;
    else if (r.best && tb.i === r.best.i) s += " That's the best band.";
    lines.push(s);
  }
  if (r.hitPrice != null) lines.push(`The ${num(r.hitCount)} hits among them typically sell at ${money(r.hitPrice)}; all of them at ${money(r.allPrice)}.`);
  if (r.thin) lines.push("Fewer than 40 paid look-alikes: read this as a hint, not a verdict.");

  const maxE = Math.max(...r.bands.map((b) => b.earnRate), 0.01), maxR = Math.max(...r.bands.map((b) => b.revRate), 0.01);
  const bar = (x, max, text) => h("td.mkp-num", h("div.mkp-barcell", h("span.mkp-bar", h("i", { style: `width:${Math.min(1, x / max) * 100}%` })), h("span", text)));
  const bandRows = r.bands.map((b) => h("tr", { class: [b === r.best ? "is-best" : null, b === tb ? "is-you" : null, b.sure ? null : "is-thin"].filter(Boolean).join(" ") || null },
    h("td", h("b", b.label), b === r.best ? h("span.mkp-pill.is-best", "best") : null, b === tb ? h("span.mkp-pill.is-you", "your price") : null),
    h("td.mkp-num", { title: `${pct(b.share)} of the paid look-alikes, by how alike they are` }, num(b.n)),
    bar(b.earnRate, maxE, b.sure ? oneIn(b.earnRate) : "–"),
    bar(b.revRate, maxR, b.sure ? oneIn(b.revRate) : "–"),
    h("td.mkp-num", b.sure && b.medEarn != null ? num(b.medEarn) : "–"),
    h("td.mkp-num", b.sure ? usd(b.medRev) : "–"),
    h("td.mkp-dim", b.points.slice(0, 3).map((p) => `${money(p.price)} (${p.n})`).join(", ") || "–")));
  const head = (...cols) => h("thead", h("tr", ...cols.map(([l, tip, n]) => h(n ? "th.mkp-num" : "th", { title: tip || null }, l))));
  const bandTable = h("div.mkp-scroll", h("table.mkp-table",
    head(["Full price"], ["Games", "Paid look-alikes at this price, out 2+ weeks", 1],
      ["Hits by earnings", "How many became hits: top 10% of paid games out the same fortnight by estimated revenue. Pulled toward the look-alikes' average when a band has few games.", 1],
      ["Hits by reviews", "How many became hits by reviews (players reached): top 10% of the games out the same week. No revenue estimate in it.", 1],
      ["Typical rank", "A typical game's earnings rank against the paid games out the same fortnight (0–100)", 1],
      ["Typical lifetime revenue", "Median estimated lifetime net revenue (after Steam's cut, VAT and refunds)", 1],
      ["Common prices"]),
    h("tbody", ...bandRows)));

  const pointRows = r.points.slice(0, 10).map((p) => h("tr", { class: p.price === v.tryCents ? "is-you" : null },
    h("td", h("b", money(p.price))), h("td.mkp-num", num(p.n)), h("td.mkp-num", p.n >= MIN_BAND ? `${oneIn(p.rate)}` : "–")));
  const pointTable = h("div.mkp-scroll", h("table.mkp-table.mkp-narrow", head(["Price"], ["Games", null, 1], ["Hits by earnings", "Not pulled toward the average: needs 8+ games to show", 1]), h("tbody", ...pointRows)));

  const lookRows = r.rated.slice(0, 25).map((g) => h("tr",
    h("td", h("a.mkp-link", { href: `https://store.steampowered.com/app/${g.appid}/`, target: "_blank", rel: "noopener" }, g.name)),
    h("td.mkp-num", money(g.price)), h("td.mkp-num", pct(g.sim)), h("td.mkp-num", num(g.reviews)),
    h("td.mkp-num", g.earn ?? "–"), h("td.mkp-num", usd(g.rev)), h("td.mkp-num", monthYear(g.day))));
  const looks = h("details.mkp-fold", h("summary", `The ${Math.min(25, r.rated.length)} paid games most like it`),
    h("div.mkp-scroll", h("table.mkp-table", head(["Game"], ["Price", "Today's full price", 1], ["Alike", null, 1], ["Reviews", null, 1], ["Earn index", "Estimated revenue as a percentile among paid games out the same fortnight (90+ = hit)", 1], ["Est. lifetime", null, 1], ["Out", null, 1]), h("tbody", ...lookRows))));

  const history = v.files.overview?.historyFrom;
  const model = v.files.games?.revenueModel;
  const facs = model?.salesPerReviewByPrice?.map(([, f]) => f) || [];
  v.report.replaceChildren(
    h("div.mkp-summary", ...lines.map((l) => h("p", l))),
    ownBox(v),
    h("h3.mkp-h", "By price"), bandTable,
    h("p.mkp-muted", "Bands with fewer than 8 games show no rates. Rates are weighted by how alike each game is to yours."),
    h("h3.mkp-h", "The exact prices they use"), pointTable,
    looks,
    h("p.mkp-muted.mkp-caveat",
      "This shows which prices go together with doing well among similar games, not that a price makes a game do well: bigger and more polished games charge more and also sell more. Comparing only games like yours takes out part of that, not all of it. ",
      facs.length ? `The earnings columns assume cheaper games sell more copies per review (×${Math.max(...facs)} under $5 down to ×${Math.min(...facs)} at $40+, from public estimates); the reviews column doesn't, so trust a band more when both agree. ` : "",
      `Prices are today's full prices${history != null ? `; the server has kept daily prices and discounts since ${dayDate(history)}, too short yet to say how soon or how deep games like yours go on sale` : ""}.`));
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
.mkv-price .mkp-note { color: var(--fb-ink-2); font-size: 0.9rem; }
.mkv-price .mkp-dim { color: var(--fb-muted); }
.mkv-price .mkp-game { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 12px; border-radius: 10px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; font-size: 0.88rem; cursor: pointer; text-align: left; }
.mkv-price .mkp-game small { color: var(--fb-muted); font-size: 0.75rem; }
.mkv-price .mkp-game:hover { background: var(--fb-hover); }
.mkv-price .mkp-game[aria-pressed="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-price .mkp-input { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; min-width: 0; }
.mkv-price .mkp-price { width: 7em; }
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
.mkv-price .mkp-pricerow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 12px; font-size: 0.9rem; font-weight: 600; }
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
.mkv-price .mkp-table tr.is-best td { background: color-mix(in srgb, var(--fb-positive) 9%, transparent); }
.mkv-price .mkp-table tr.is-you td:first-child { box-shadow: inset 3px 0 0 var(--fb-accent); }
.mkv-price .mkp-table tr.is-thin td { color: var(--fb-muted); }
.mkv-price .mkp-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.mkv-price .mkp-barcell { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.mkv-price .mkp-bar { display: inline-block; width: 70px; height: 8px; border-radius: 4px; background: var(--fb-line); overflow: hidden; }
.mkv-price .mkp-bar i { display: block; height: 100%; background: var(--sw-1); border-radius: 4px; }
.mkv-price .mkp-pill { display: inline-block; margin-left: 6px; padding: 0 7px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; border: 1px solid var(--fb-line); white-space: nowrap; }
.mkv-price .mkp-pill.is-best { color: var(--fb-good-text); border-color: var(--fb-positive); }
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
