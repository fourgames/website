// The Market page's gap finder: niches (single tags or pairs of a game's strongest tags) with a hit
// chance and an earn chance side by side, both pulled toward their average so a lucky handful of
// games can't look like a gap. A table only, ranked by one metric or by several at once (a Combined
// column: the average of each picked metric's percentile among the rows shown).
//
// Contract: gapView(ctx, files, opts, redraw) returns one element (.mkv-gaps). files = { overview,
// trends, games }; opts = { small } (the tab's "small-team niches only" switch). Every input updates
// the table live as you type (debounced), without rebuilding the inputs, so focus and the cursor stay.
// The root element is kept and handed back on later calls, so a redraw of the page doesn't lose focus.

import { glossary } from "./market-merged.js";

const PREFIX = "mkv-merged-gaps-";
const INDIE = 492;
const PRIOR = 30;          // shrinkage: as if each niche also had 30 games at the base rate
const MIN_PAIR = 15;       // a niche needs this many games to be listed at all
const MIN_SINGLE = 20;
// Market files from before the revenue estimate (no "rev" column): the old rough guess, so the page
// still works until the server rebuilds them.
const OLD_SALES_PER_REVIEW = 30, OLD_NET_SHARE = 0.5;
const DEBOUNCE = 250;
const PAGE = 30;
// Same lists as market-merged.js (not exported there): big-build tags left out by "small-team only".
const HUGE = ["Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Realistic", "Photorealistic"];
const BIG = ["Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Co-op", "Third-Person Shooter", "Souls-like", "Sandbox", "Story Rich", "3D", "First-Person"];
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
const META = ["Indie", "Free to Play", "Early Access", "Replay Value", "Great Soundtrack", "Masterpiece", "Addictive", "Classic", "Beautiful", "Singleplayer", "Casual"];

// The metrics a row can be ranked by. good: 1 = higher is better, -1 = lower is better.
const METRICS = [
  { key: "hit", label: "Hit chance", good: 1 },
  { key: "earn", label: "Earn chance", good: 1 },
  { key: "gap", label: "Gap score", good: 1 },
  { key: "bonus", label: "vs its tags", good: 1, pairsOnly: true },
  { key: "typical", label: "Typical game", good: 1 },
  { key: "recent", label: "Fewest rivals", good: -1 },
  { key: "n", label: "Most games", good: 1 },
];
const METRIC = Object.fromEntries(METRICS.map((m) => [m.key, m]));
const SORT_KEYS = ["name", "combined", "hit", "earn", "bonus", "n", "typical", "recent", "gap"];

export const GAP_FILTERS = { minHit: null, minEarn: null, minGames: 40, maxCrowd: null, minGap: null };
const NO_FILTERS = { minHit: null, minEarn: null, minGames: null, maxCrowd: null, minGap: null };

// ---------------------------------------------------------------------------
// Pure helpers (no DOM): exported under _test for the smoke test
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const fmtK = (n) => n == null || !Number.isFinite(n) ? "–" : Math.abs(n) < 1000 ? String(Math.round(n)) : Math.abs(n) < 1e6 ? `${+(n / 1000).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const pct = (x, d = 0) => x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null || !Number.isFinite(x) ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const usd = (n) => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const confidence = (n) => n >= 100 ? "solid" : n >= 40 ? "likely" : "thin data";
const spread = (p, n) => 1.64 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / (n + PRIOR));
const sureLabel = (p, n) => `${confidence(n)} · ±${Math.max(1, Math.round(spread(p, n) * 100))} pts`;

function tagSets(tagNames) {
  const byName = new Map(Object.entries(tagNames || {}).map(([id, n]) => [n.trim().toLowerCase(), Number(id)]));
  const ids = (list) => new Set(list.map((n) => byName.get(n.toLowerCase())).filter((x) => x != null));
  return { big: ids([...HUGE, ...BIG]), adult: ids(ADULT), meta: ids(META), byName };
}

// --- The revenue estimate (worked out on the server, market.py: est_revenue) ---
// rev: a paid game's estimated lifetime net revenue in dollars: reviews × sales per review (by price
// band and release year) × its realized price (discounts in) × what's left after Steam's cut, VAT and
// refunds, divided by the share of lifetime sales a game of its age has made. earn: that as a
// percentile among the paid games out the same fortnight (the "hit" of the niche numbers). Free games
// have neither. Old files without the column fall back on reviews × 30 × list price × 0.5.
export const hasRevenue = (file) => !!file?.columns?.includes("rev");
export function unpackGames(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  const top = file.topTags || 5;
  const byRev = col.rev != null;
  const FREE = file.flags?.free ?? 32;
  return file.rows.map((r) => {
    const tags = r[col.tags] || [];
    const price = r[col.price] || 0, reviews = r[col.reviews] || 0, free = !!((r[col.flags] || 0) & FREE);
    const rev = byRev ? r[col.rev] ?? null : !free && price > 0 ? reviews * OLD_SALES_PER_REVIEW * (price / 100) * OLD_NET_SHARE : null;
    return {
      appid: r[col.appid], name: r[col.name], day: r[col.day], price, reviews, free,
      top: tags.slice(0, top), hit: r[col.hit], earn: byRev ? r[col.earn] ?? null : null, rev,
    };
  });
}

// Lifetime share of sales by age (the server's curve in games.json revenueModel), for calibration.
export function lifetimeShare(model, age) {
  const pts = model?.lifetimeShare || [[7, 0.12], [30, 0.25], [90, 0.36], [180, 0.46], [365, 0.6], [730, 0.76], [1460, 0.9], [2920, 1]];
  if (age <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [d0, v0] = pts[i - 1], [d1, v1] = pts[i];
    if (age <= d1) return v0 + ((Math.log(age) - Math.log(d0)) / (Math.log(d1) - Math.log(d0))) * (v1 - v0);
  }
  return 1;
}

// The hook for our own Steamworks sales: own = { appid: net dollars so far }. Each of our games'
// real net against the estimate so far (rev × lifetime share at its age); their geometric mean,
// pulled toward ×1 as if 2 more games matched the estimate exactly, and kept within ×0.25..×4.
// Returns { factor, n } (factor 1, n 0 when there's nothing to calibrate with). The page passes
// ctx.ownSales when the dashboard has it; until then the estimate stands uncalibrated.
export function calibration(own, list, today, model = null) {
  if (!own || !list) return { factor: 1, n: 0 };
  let sum = 0, n = 0;
  for (const g of list) {
    const net = own[g.appid];
    if (!(net > 0) || !(g.rev > 0) || today - g.day < 30) continue;
    const est = g.rev * lifetimeShare(model, today - g.day);
    if (est > 0) { sum += Math.log(net / est); n++; }
  }
  return { factor: n ? clamp(Math.exp(sum / (n + 2)), 0.25, 4) : 1, n };
}

// The assumption in one short line, for under the table.
export function revenueLine(model, cal = { factor: 1, n: 0 }) {
  if (!model) return `Revenue (old server files): reviews × ${OLD_SALES_PER_REVIEW} sales per review × list price × ${OLD_NET_SHARE}. A rough guide, not sales data.`;
  const years = model.salesPerReviewByYear.map(([, v]) => v), facs = model.salesPerReviewByPrice.map(([, f]) => f);
  const lo = Math.round(Math.min(...years) * Math.min(...facs)), hi = Math.round(Math.max(...years) * Math.max(...facs));
  return `Revenue = reviews × ${lo}–${hi} sales per review (cheaper and older games more) × the price people really paid (sales included) × ${model.netShare} (Steam's cut, VAT, refunds), scaled up to a whole lifetime by the game's age. `
    + (cal.n ? `Matched to our own sales (${cal.n} game${cal.n > 1 ? "s" : ""}): ×${cal.factor.toFixed(2)}.` : "Not yet checked against our own sales.");
}

// Niches with two chances: hit = a paid game in the top 10% of its release fortnight by estimated
// revenue (games out 2 weeks to 6 months; free games left out); earn = estimated lifetime revenue of
// about `target` dollars (paid games out 2 months to 2 years). Both shrunk toward the average.
// Files without revenue fall back on the review hit index. `calib` scales the estimate (calibration()).
export function gapFinder(list, tagNames, { today, target = 50000, pairs = true, small = true, must = null, calib = 1 } = {}) {
  const s = tagSets(tagNames);
  const byRev = list.some((g) => g.earn != null);
  const perf = byRev ? (g) => g.earn : (g) => g.hit;
  const okH = (g) => perf(g) != null && g.day >= today - 180 && g.day <= today - 14;
  const okE = (g) => g.rev != null && g.day >= today - 730 && g.day <= today - 60;
  const wonE = (g) => g.rev * calib >= target;
  const keysOf = (g) => {
    const own = g.top.filter((t) => t !== INDIE && !s.meta.has(t) && t !== must);
    if (!pairs) return own.map(String);
    const out = [];
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) out.push(own[i] < own[j] ? `${own[i]}+${own[j]}` : `${own[j]}+${own[i]}`);
    return out;
  };
  const skip = (g) => g.top.some((t) => s.adult.has(t)) || (small && g.top.some((t) => s.big.has(t))) || (must != null && !g.top.includes(must));
  const niches = new Map(), recent = new Map();
  let nH = 0, wH = 0, nE = 0, wE = 0;
  for (const g of list) {
    if (skip(g)) continue;
    const isRecent = g.day > today - 90;
    const inH = okH(g), inE = okE(g);
    if (!inH && !inE && !isRecent) continue;
    const keys = keysOf(g);
    if (isRecent) for (const k of keys) recent.set(k, (recent.get(k) || 0) + 1);
    if (!inH && !inE) continue;
    const hitW = inH && perf(g) >= 90, earnW = inE && wonE(g);
    if (inH) { nH++; if (hitW) wH++; }
    if (inE) { nE++; if (earnW) wE++; }
    for (const k of keys) {
      let e = niches.get(k);
      if (!e) niches.set(k, e = { k, n: 0, nH: 0, wH: 0, nE: 0, wE: 0, revs: [], best: null });
      e.n++;
      if (inH) { e.nH++; if (hitW) e.wH++; }
      if (inE) { e.nE++; if (earnW) e.wE++; }
      if (g.rev != null) e.revs.push(g.rev * calib);
      if (g.rev != null && (!e.best || g.rev > e.best.rev)) e.best = g;
    }
  }
  const baseHit = nH ? wH / nH : 0, baseEarn = nE ? wE / nE : 0;
  const min = pairs ? MIN_PAIR : MIN_SINGLE;
  const rows = [...niches.values()].filter((e) => e.n >= min && baseHit > 0 && baseEarn > 0).map((e) => {
    const hit = (e.wH + PRIOR * baseHit) / (e.nH + PRIOR), earn = (e.wE + PRIOR * baseEarn) / (e.nE + PRIOR);
    const r = recent.get(e.k) || 0;
    const nMin = Math.min(e.nH, e.nE);
    return {
      k: e.k, name: e.k.split("+").map((id) => (tagNames[id] || `Tag ${id}`).trim()).join(" + "), n: e.n,
      nH: e.nH, wH: e.wH, nE: e.nE, wE: e.wE, hit, earn, hitLift: hit / baseHit, earnLift: earn / baseEarn, lift: (hit / baseHit + earn / baseEarn) / 2,
      conf: confidence(nMin), sure: sureLabel(hit, nMin), typical: median(e.revs),
      best: e.best ? { appid: e.best.appid, name: e.best.name, reviews: e.best.reviews, rev: e.best.rev * calib } : null,
      recent: r,
    };
  }).sort((x, y) => y.lift - x.lift);
  return { baseHit, baseEarn, poolHit: nH, poolEarn: nE, rows, byRev };
}

// gap: the two chances against their averages (averaged), divided by log10(10 + releases in the last
// 90 days); bonus: the pair against the better of its two tags alone on the same lift (pairs only).
export function withGapScores(res, singles) {
  const single = new Map((singles?.rows || []).map((r) => [r.k, r.lift]));
  return res.rows.map((r) => {
    const parts = r.k.includes("+") ? r.k.split("+").map((k) => single.get(k) ?? 1) : null;
    return { ...r, gap: r.lift / Math.log10(10 + r.recent), bonus: parts ? r.lift / Math.max(...parts) : null };
  });
}

export function filterGaps(rows, f) {
  return rows.filter((r) => (f.minHit == null || r.hit * 100 >= f.minHit) && (f.minEarn == null || r.earn * 100 >= f.minEarn)
    && (f.minGames == null || r.n >= f.minGames) && (f.maxCrowd == null || r.recent <= f.maxCrowd) && (f.minGap == null || r.gap >= f.minGap));
}

export function searchRows(rows, q) {
  const s = String(q || "").trim().toLowerCase();
  return s ? rows.filter((r) => r.name.toLowerCase().includes(s)) : rows;
}

// Percentile (0..1, ties share the middle) of each value among `values`; null counts as the middle.
export function percentiler(values) {
  const s = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const below = (v, strict) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (strict ? s[m] < v : s[m] <= v) lo = m + 1; else hi = m; } return lo; };
  return (v) => {
    if (v == null || !Number.isFinite(v) || s.length < 2) return 0.5;
    const lo = below(v, true), le = below(v, false);
    return (lo + (le - lo - 1) / 2) / (s.length - 1);
  };
}

// The metrics actually usable for this table (vs its tags exists for pairs only).
export const usableRank = (rank, pairs) => rank.filter((k) => METRIC[k] && (pairs || !METRIC[k].pairsOnly));

// Adds `combined` (0..100): the average of each ranked metric's percentile among `rows`, flipped for
// metrics where lower is better (Fewest rivals).
export function combinedScores(rows, keys) {
  if (!keys.length) return rows.map((r) => ({ ...r, combined: null }));
  const ps = keys.map((k) => ({ k, good: METRIC[k].good, p: percentiler(rows.map((r) => r[k])) }));
  return rows.map((r) => ({ ...r, combined: 100 * ps.reduce((s, { k, good, p }) => s + (good > 0 ? p(r[k]) : 1 - p(r[k])), 0) / ps.length }));
}

// The order: a header click wins; else Combined when 2+ metrics are picked; else that one metric.
export function sortRows(rows, keys, sort) {
  let key, dir;
  if (sort && SORT_KEYS.includes(sort.key) && (sort.key !== "combined" || keys.length > 1)) ({ key, dir } = sort);
  else if (keys.length > 1) { key = "combined"; dir = -1; }
  else { key = keys[0] || "gap"; dir = -(METRIC[key]?.good ?? 1); }
  const val = key === "name" ? (r) => r.name : (r) => r[key] ?? (dir < 0 ? -Infinity : Infinity);
  const out = [...rows].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir || b.gap - a.gap; });
  return { rows: out, key, dir };
}

// The whole pipeline for given settings, the heavy part cached by its inputs.
const unpacked = new WeakMap(), results = new WeakMap();
export function computeGaps(files, { target, small, mustId, pairs, own = null }) {
  const g = files.games;
  if (!unpacked.has(g)) unpacked.set(g, unpackGames(g));
  if (!results.has(g)) results.set(g, new Map());
  const cache = results.get(g), list = unpacked.get(g), names = files.overview?.tags || {};
  const today = files.overview?.today ?? Math.floor(Date.now() / 86400000);
  const cal = calibration(own, list, today, g.revenueModel);
  const calib = cal.factor;
  const run = (p) => {
    const k = `${today}:${target}:${small}:${mustId}:${p}:${calib}`;
    if (!cache.has(k)) {
      cache.set(k, gapFinder(list, names, { today, target, small, must: mustId, pairs: p, calib }));
      if (cache.size > 16) cache.delete(cache.keys().next().value);
    }
    return cache.get(k);
  };
  const res = run(pairs);
  const sk = `${today}:${target}:${small}:${mustId}:${pairs}:${calib}:scored`;
  if (!cache.has(sk)) cache.set(sk, withGapScores(res, pairs ? run(false) : null));
  return { res, scored: cache.get(sk), cal };
}

// The best tag pairs that contain `tag` (by gap score), for "find an angle" hints elsewhere on the
// page. Only pairs with `minGames`+ games, so a lucky handful can't be the suggestion. Pairs that do
// better than either of their tags alone (bonus ×`minBonus`+) come first, so the angle is a real
// improvement when one exists. Uses the owner's earn target once the gap finder restored it.
export function topPairsWith(files, tag, { small = true, target = S.target, limit = 1, minGames = GAP_FILTERS.minGames, minBonus = 1.05 } = {}) {
  if (!files?.games || tag == null) return [];
  const { scored } = computeGaps(files, { target, small, mustId: null, pairs: true, own: files.own || null });
  const id = String(tag);
  const better = (r) => (r.bonus ?? 0) >= minBonus;
  // A pair clearly worse than its tags alone (under ×0.95) is no angle at all.
  return scored.filter((r) => r.n >= minGames && (r.bonus ?? 1) >= 0.95 && r.k.split("+").includes(id))
    .sort((a, b) => better(b) - better(a) || b.gap - a.gap).slice(0, limit)
    .map((r) => ({ ...r, better: better(r), other: r.k.split("+").filter((k) => k !== id).map((k) => (files.overview?.tags?.[k] || `Tag ${k}`).trim()).join(" + ") }));
}

// The rows for a view: filters, search, Combined, order.
export function viewRows(scored, { filters, q, rank, sort, pairs }) {
  const keys = usableRank(rank, pairs);
  const shown = searchRows(filterGaps(scored, filters), q);
  return { ...sortRows(combinedScores(shown, keys), keys, sort), keys };
}

// ---------------------------------------------------------------------------
// State (module level, saved in ctx.store)
// ---------------------------------------------------------------------------

let C, R, FILES, OPTS = { small: true }, ROOT = null, ROOT_H = null, restored = false;
const S = { target: 50000, pairs: true, must: "", q: "", filters: { ...GAP_FILTERS }, rank: ["gap"], sort: null, shown: PAGE };
const save = (k, v) => { try { C.store.set(PREFIX + k, typeof v === "string" ? v : JSON.stringify(v)); } catch {} };
const load = (k) => { try { const v = C.store.get(PREFIX + k); return v == null ? null : v; } catch { return null; } };
function restore() {
  if (restored) return;
  restored = true;
  // Fall back on the merged page's older keys, so the owner's target and filters carry over.
  const old = (k) => { try { return C.store.get(`mkv-merged-${k}`); } catch { return null; } };
  const target = Number(load("target") ?? old("target")); if (target >= 100) S.target = target;
  // "pairs2": tag pairs became the default; a "single tags" choice stored before that is ignored.
  const pairs = load("pairs2"); if (pairs === "true" || pairs === "false") S.pairs = pairs === "true";
  const must = load("must"); if (typeof must === "string") S.must = must;
  try { const f = JSON.parse(load("filters") ?? old("gapF") ?? "null"); if (f && typeof f === "object") for (const k of Object.keys(GAP_FILTERS)) S.filters[k] = Number.isFinite(f[k]) ? f[k] : null; } catch {}
  try { const r = JSON.parse(load("rank") || "null"); if (Array.isArray(r)) { const ok = r.filter((k) => METRIC[k]); if (ok.length) S.rank = ok; } } catch {}
  try { const s = JSON.parse(load("sort") || "null"); if (s && SORT_KEYS.includes(s.key) && (s.dir === 1 || s.dir === -1)) S.sort = s; } catch {}
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const names = () => FILES?.overview?.tags || {};
const mustId = () => S.must.trim() ? tagSets(names()).byName.get(S.must.trim().toLowerCase()) ?? null : null;
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;

export function gapView(ctx, files, opts = {}, redraw) {
  C = ctx; R = redraw || (() => {}); FILES = files; OPTS = { small: !!opts.small };
  injectStyle();
  restore();
  if (!files?.games || !files?.overview) return ctx.h("div.mkv-gaps", ctx.h("p.mkg-note", "Loading three years of releases (a few MB, once)…"));
  // Keep focus and the cursor if the page redraws while someone types here.
  const doc = typeof document !== "undefined" ? document : null;
  const act = doc?.activeElement, keep = ROOT && act && ROOT.contains?.(act) ? { el: act, pos: act.selectionStart } : null;
  if (!ROOT || ROOT_H !== ctx.h) build();
  update();
  if (keep && typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => { keep.el.focus(); try { keep.el.setSelectionRange(keep.pos, keep.pos); } catch {} });
  return ROOT;
}

// Parts updated in place (never rebuilt while typing).
let U = {};
function debounced(fn) { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), DEBOUNCE); }; }

function build() {
  const h = C.h;
  ROOT_H = C.h;
  const later = debounced(() => { S.shown = PAGE; update(); });
  const numIn = (k, label, unit, tip, step = 1) => h("label.mkg-field", { title: tip }, h("span", label),
    h("input.mkg-in.mkg-in-s", { type: "number", min: 0, step, value: S.filters[k] ?? "", placeholder: "any", "aria-label": label,
      oninput: (e) => { const t = e.target.value.trim(), v = t === "" ? null : Number(t); S.filters[k] = Number.isFinite(v) ? v : null; save("filters", S.filters); U.clear.hidden = !anyFilter(); later(); } }),
    unit ? h("span.mkg-dim", unit) : null);
  U.filterIns = [];
  const filterRow = h("div.mkg-row.mkg-filters", h("span.mkg-row-t", "Only show"),
    numIn("minHit", "Hit ≥", "%", "Keep niches whose hit chance is at least this many percent."),
    numIn("minEarn", "Earn ≥", "%", "Keep niches whose earn chance is at least this many percent."),
    numIn("minGames", "Games ≥", null, "Keep niches with at least this many games behind them."),
    numIn("maxCrowd", "Crowding ≤", null, "Keep niches with at most this many games released in the last 90 days."),
    numIn("minGap", "Gap score ≥", null, "Keep niches with at least this gap score.", 0.1),
    U.clear = h("button.mkg-btn", { type: "button", onclick: () => {
      S.filters = { ...NO_FILTERS }; save("filters", S.filters);
      for (const el of filterRow.querySelectorAll ? filterRow.querySelectorAll("input") : []) el.value = "";
      U.clear.hidden = true; S.shown = PAGE; update();
    } }, "Clear"));
  U.clear.hidden = !anyFilter();

  U.pairBtns = [[true, "Tag pairs"], [false, "Single tags"]].map(([v, label]) => h("button", { type: "button", "aria-pressed": String(S.pairs === v),
    onclick: () => { if (S.pairs === v) return; S.pairs = v; save("pairs2", String(v)); S.shown = PAGE; if (S.sort?.key === "bonus") S.sort = null; update(); } }, label));
  U.chips = METRICS.map((m) => h("button.mkg-chip", { type: "button", "aria-pressed": String(S.rank.includes(m.key)), "data-k": m.key,
    title: m.good < 0 ? `${m.label}: fewer new games in the last 90 days ranks higher.` : `${m.label}: higher ranks higher.`,
    onclick: () => {
      const on = S.rank.includes(m.key);
      if (on && S.rank.length === 1) return; // keep at least one
      S.rank = on ? S.rank.filter((k) => k !== m.key) : [...S.rank, m.key];
      S.sort = null; save("rank", S.rank); save("sort", "null"); S.shown = PAGE; update();
    } }, h("span.mkg-check", { "aria-hidden": "true" }), m.label));

  U.targetIn = h("input.mkg-in.mkg-in-m", { type: "number", min: 100, step: 5000, value: S.target, "aria-label": "Earn target in dollars",
    oninput: (e) => { const v = Number(e.target.value); if (v >= 100) { S.target = v; save("target", String(v)); later(); } } });
  U.mustIn = h("input.mkg-in", { list: "mkg-tags", value: S.must, placeholder: "Must include a tag…", "aria-label": "Must include a tag",
    oninput: (e) => { S.must = e.target.value; save("must", S.must); later(); } });
  U.qIn = h("input.mkg-in", { type: "search", value: S.q, placeholder: "Search niches", "aria-label": "Search niches",
    oninput: (e) => { S.q = e.target.value; later(); } });
  const datalist = h("datalist", { id: "mkg-tags" }, ...[...new Set(Object.values(names()).map((n) => n.trim()))].sort().map((n) => h("option", { value: n })));

  U.legend = h("div.mkg-legend");
  U.counts = h("p.mkg-counts", { role: "status" });
  U.mustNote = h("span.mkg-dim");
  U.table = h("div.mkg-tablebox");
  ROOT = h("section.mkv-gaps",
    h("h2.mkg-title", "Tag pairs: the gap finder"),
    h("p.mkg-sub", `Combinations of a game's strongest tags. A pair needs ${MIN_PAIR}+ games to show (a single tag ${MIN_SINGLE}+), and every chance is pulled toward the average as if the niche also had ${PRIOR} ordinary games, so "dwarves + fishing" with 3 lucky games isn't called a gap.`),
    U.legend,
    h("div.mkg-row",
      h("label.mkg-field", h("span", "Earn target $"), U.targetIn),
      h("div.mkg-seg", { role: "group", "aria-label": "Niche size" }, ...U.pairBtns),
      h("label.mkg-field", U.mustIn, U.mustNote), datalist,
      U.qIn),
    h("div.mkg-row.mkg-rank", h("span.mkg-row-t", { title: "Pick one to sort by it; pick several to rank by all of them at once (the Combined column)." }, "Rank by"), ...U.chips),
    filterRow,
    U.counts,
    U.table);
}

const anyFilter = () => Object.values(S.filters).some((v) => v != null);

function legend(res, cal) {
  const h = C.h;
  const line = (b, ...t) => h("p", h("b", b), " ", ...t);
  return [
    line("Hit chance:", res.byRev
      ? `the share of the niche's paid games (out 2 weeks to 6 months) that earned more than 90% of the paid games out the same fortnight. Free games are left out. Average ${pct(res.baseHit, 1)}.`
      : `the share of the niche's games (out 2 weeks to 6 months) that ended up in the top 10% by reviews of their release fortnight. Average ${pct(res.baseHit, 1)}.`),
    line("Earn chance:", `the share of its paid games (out 2 months to 2 years) that will earn your ${usd(S.target)} over their lifetime, by the estimate below. Average ${pct(res.baseEarn, 1)}. The target changes only this column (and the gap score and "vs its tags", which use it).`),
    line("Typical game:", "what a typical (median) paid game in the niche earns over its lifetime, by the same estimate."),
    h("p.mkg-dim", revenueLine(FILES.games?.revenueModel, cal)),
    line("Gap score:", `(hit chance ÷ average hit chance + earn chance ÷ average earn chance) ÷ 2, divided by log10(10 + games released in it in the last 90 days). High = does well on both and few are being made.`),
    line("Small-team only:", OPTS.small
      ? `on (switch at the top of the tab): games with big-build tags (MMO, open world, multiplayer, 3D, story rich…) are left out here.`
      : `off (switch at the top of the tab): every game counts, big-build tags included.`),
  ];
}

function update() {
  if (!ROOT || !FILES?.games) return;
  const h = C.h, id = mustId();
  const { res, scored, cal } = computeGaps(FILES, { target: S.target, small: OPTS.small, mustId: id, pairs: S.pairs, own: C.ownSales || null });
  const keys = usableRank(S.rank, S.pairs);
  const v = viewRows(scored, { filters: S.filters, q: S.q, rank: S.rank, sort: S.sort, pairs: S.pairs });
  // Controls, updated in place.
  U.pairBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(S.pairs === (i === 0))));
  for (const b of U.chips) {
    const k = b.getAttribute("data-k"), on = S.rank.includes(k), off = METRIC[k].pairsOnly && !S.pairs;
    b.setAttribute("aria-pressed", String(on && !off));
    if (off) b.setAttribute("disabled", ""); else b.removeAttribute("disabled");
  }
  U.mustNote.textContent = S.must.trim() && id == null ? " no such tag" : "";
  U.legend.replaceChildren(...legend(res, cal));
  const rankText = keys.length > 1 ? `Ranked by Combined: ${keys.map((k) => METRIC[k].label).join(" + ")}.` : `Ranked by ${METRIC[keys[0]]?.label || "gap score"}.`;
  U.counts.textContent = `${num(v.rows.length)} of ${num(scored.length)} niches shown${id != null ? ` (games with ${names()[id].trim()})` : ""}. ${v.key === "combined" || !S.sort ? rankText : "Sorted by the column you clicked; pick a chip to rank again."}`;
  U.table.replaceChildren(...(v.rows.length ? table(v, keys) : [h("p.mkg-note", scored.length ? "No niche passes these filters: loosen one." : "Not enough games for these settings: take a tag away, switch to single tags or lower the target.")]));
}

function table(v, keys) {
  const h = C.h, rows = v.rows.slice(0, S.shown);
  const mx = (k) => Math.max(...v.rows.map((r) => r[k] ?? 0), 1e-9);
  const mxh = mx("hit"), mxe = mx("earn"), mxc = Math.log1p(mx("recent"));
  const combined = keys.length > 1;
  const cols = [
    { key: "name", label: S.pairs ? "Pair of tags" : "Tag", tip: "Tags among a game's 5 strongest (Indie, adult and how-it's-sold tags left out). Hover a row for what a tag means." },
    combined ? { key: "combined", label: "Combined", num: true, tip: `The average of each picked metric's percentile among the rows shown (0–100): ${keys.map((k) => METRIC[k].label).join(", ")}.` } : null,
    { key: "hit", label: "Hit chance", num: true, tip: "Share of its paid games in the top 10% of their release fortnight by estimated revenue, pulled toward the average." },
    { key: "earn", label: "Earn chance", num: true, tip: `Share of its paid games that reached ${usd(S.target)}, pulled toward the average.` },
    { key: "gap", label: "Gap score", num: true, tip: "Both chances against their averages, divided by crowding (log)." },
    S.pairs ? { key: "bonus", label: "vs its tags", num: true, tip: "The pair against the better of its two tags alone. Above ×1: the combination does better than either part." } : null,
    { key: "typical", label: "Typical game", num: true, tip: "Estimated lifetime revenue (after Steam's cut) of a typical paid game in it." },
    { key: "recent", label: "Crowding", num: true, tip: "Games released with it in the last 90 days." },
    { key: "n", label: "Games", num: true, tip: "Games behind the numbers. Fewer games = the chances lean more on the average." },
    { key: null, label: "How sure", tip: "By the smaller pool: solid 100+ games, likely 40+, thin data fewer. ± is a rough 90% range for the hit chance." },
    { key: null, label: "Biggest game" },
  ].filter(Boolean);
  const onSort = (k) => {
    S.sort = v.key === k ? { key: k, dir: -v.dir } : { key: k, dir: k === "name" || k === "recent" ? 1 : -1 };
    save("sort", S.sort); update();
  };
  const bar = (frac, text, color) => h("td.mkg-num", h("span.mkg-bc", h("span.mkg-bar", h("i", { style: `width:${(clamp(frac) * 100).toFixed(1)}%;background:${color}` })), h("span", text)));
  const body = rows.map((r) => {
    const gl = r.k.split("+").map((tid) => names()[tid]).filter((n) => n && glossary(n)).map((n) => `${n.trim()}: ${glossary(n)}`).join("\n");
    return h("tr", { title: gl || null },
      h("td.mkg-name", r.name, gl ? h("span.mkg-dim", " ⓘ") : null),
      combined ? bar(r.combined / 100, String(Math.round(r.combined)), "var(--sw-2)") : null,
      bar(r.hit / mxh, pct(r.hit), r.hitLift >= 1.5 ? "var(--sw-3)" : "var(--sw-1)"),
      bar(r.earn / mxe, pct(r.earn), r.earnLift >= 1.5 ? "var(--sw-3)" : "var(--sw-1)"),
      h("td.mkg-num", h("b", r.gap.toFixed(2))),
      S.pairs ? h("td.mkg-num", { class: r.bonus >= 1.1 ? "mkg-up" : r.bonus < 0.9 ? "mkg-down" : null }, times(r.bonus)) : null,
      h("td.mkg-num", r.typical == null ? "–" : usd(r.typical)),
      bar(Math.log1p(r.recent) / mxc, fmtK(r.recent), "var(--fb-muted)"),
      h("td.mkg-num", { title: `${num(r.wH)} of ${num(r.nH)} became hits; ${num(r.wE)} of ${num(r.nE)} paid games reached ${usd(S.target)}` }, num(r.n)),
      h("td", h("span.mkg-sure", { class: r.conf === "solid" ? "is-solid" : r.conf === "likely" ? "is-likely" : "is-thin" }, r.sure)),
      h("td.mkg-best", r.best ? h("a", { href: storeUrl(r.best.appid), target: "_blank", rel: "noopener", title: `${r.best.name}: ${num(r.best.reviews)} reviews, about ${usd(r.best.rev)} over its lifetime` }, r.best.name) : "–"));
  });
  const head = h("tr", ...cols.map((c) => h("th", { title: c.tip || null, class: c.num ? "mkg-num" : null, "aria-sort": c.key && c.key === v.key ? (v.dir > 0 ? "ascending" : "descending") : null },
    c.key ? h("button", { type: "button", onclick: () => onSort(c.key) }, c.label, c.key === v.key ? (v.dir > 0 ? " ↑" : " ↓") : "") : c.label)));
  const more = v.rows.length > S.shown ? h("button.mkg-btn.mkg-more", { type: "button", onclick: () => { S.shown += PAGE; update(); } }, `Show more (${num(v.rows.length - S.shown)} more)`) : null;
  return [h("div.mkg-scroll", h("table.mkg-table", h("thead", head), h("tbody", ...body))), more].filter(Boolean);
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
.mkv-gaps { margin-top: 28px; min-width: 0; }
.mkv-gaps .mkg-title { font-size: 1.15rem; margin: 0 0 4px; color: var(--fb-title); }
.mkv-gaps .mkg-sub { margin: 0 0 10px; color: var(--fb-ink-2); font-size: 0.9rem; max-width: 80ch; }
.mkv-gaps .mkg-legend { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; padding: 8px 12px; margin: 0 0 10px; font-size: 0.86rem; color: var(--fb-ink-2); }
.mkv-gaps .mkg-legend p { margin: 2px 0; }
.mkv-gaps .mkg-legend b { color: var(--fb-ink); }
.mkv-gaps .mkg-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 8px; }
.mkv-gaps .mkg-row-t { font-size: 0.82rem; font-weight: 650; color: var(--fb-ink-2); cursor: help; }
.mkv-gaps .mkg-filters { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 10px; padding: 6px 10px; }
.mkv-gaps .mkg-field { display: inline-flex; align-items: center; gap: 5px; font-size: 0.85rem; color: var(--fb-ink-2); }
.mkv-gaps .mkg-in { font: inherit; font-size: 0.88rem; color: var(--fb-ink); background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 8px; padding: 5px 8px; min-width: 0; max-width: 100%; }
.mkv-gaps .mkg-in:focus { outline: 2px solid var(--fb-accent); outline-offset: 0; border-color: transparent; }
.mkv-gaps .mkg-in-s { width: 64px; }
.mkv-gaps .mkg-in-m { width: 100px; }
.mkv-gaps .mkg-seg { display: inline-flex; border: 1px solid var(--fb-line); border-radius: 8px; overflow: hidden; }
.mkv-gaps .mkg-seg button { appearance: none; font: inherit; font-size: 0.85rem; border: 0; background: var(--fb-card); color: var(--fb-ink-2); padding: 5px 10px; cursor: pointer; }
.mkv-gaps .mkg-seg button + button { border-left: 1px solid var(--fb-line); }
.mkv-gaps .mkg-seg button[aria-pressed="true"] { background: var(--fb-accent); color: var(--fb-card); font-weight: 600; }
.mkv-gaps .mkg-chip { appearance: none; font: inherit; font-size: 0.83rem; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink-2); border-radius: 999px; padding: 3px 10px 3px 6px; cursor: pointer; }
.mkv-gaps .mkg-chip:hover { background: var(--fb-hover); }
.mkv-gaps .mkg-chip[aria-pressed="true"] { border-color: var(--fb-accent); color: var(--fb-ink); font-weight: 600; }
.mkv-gaps .mkg-chip[disabled] { opacity: .4; cursor: not-allowed; }
.mkv-gaps .mkg-check { width: 13px; height: 13px; border-radius: 50%; border: 1px solid var(--fb-line); display: inline-block; }
.mkv-gaps .mkg-chip[aria-pressed="true"] .mkg-check { background: var(--fb-accent); border-color: var(--fb-accent); }
.mkv-gaps .mkg-btn { appearance: none; font: inherit; font-size: 0.83rem; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-link); border-radius: 8px; padding: 4px 10px; cursor: pointer; }
.mkv-gaps .mkg-btn:hover { background: var(--fb-hover); }
.mkv-gaps .mkg-btn[hidden] { display: none; }
.mkv-gaps .mkg-more { margin-top: 8px; }
.mkv-gaps .mkg-counts { font-size: 0.82rem; color: var(--fb-muted); margin: 2px 0 4px; }
.mkv-gaps .mkg-note { color: var(--fb-muted); font-size: 0.9rem; }
.mkv-gaps .mkg-dim { color: var(--fb-muted); }
.mkv-gaps .mkg-scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; border: 1px solid var(--fb-line); border-radius: 10px; background: var(--fb-card); }
.mkv-gaps .mkg-table { border-collapse: collapse; width: 100%; font-size: 0.84rem; font-variant-numeric: tabular-nums; }
.mkv-gaps .mkg-table th { text-align: left; color: var(--fb-muted); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; position: sticky; top: 0; background: var(--fb-card); }
.mkv-gaps .mkg-table th[title] { cursor: help; }
.mkv-gaps .mkg-table th button { appearance: none; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.mkv-gaps .mkg-table th[aria-sort] { color: var(--fb-title); }
.mkv-gaps .mkg-table td { padding: 3px 8px; border-bottom: 1px solid var(--fb-line); color: var(--fb-ink); white-space: nowrap; }
.mkv-gaps .mkg-table tbody tr:last-child td { border-bottom: 0; }
.mkv-gaps .mkg-table tbody tr:hover td { background: var(--fb-hover); }
.mkv-gaps .mkg-table .mkg-num { text-align: right; }
.mkv-gaps .mkg-name { font-weight: 600; }
.mkv-gaps .mkg-bc { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
.mkv-gaps .mkg-bar { display: inline-block; width: 44px; height: 6px; border-radius: 3px; background: var(--fb-card-2); overflow: hidden; }
.mkv-gaps .mkg-bar i { display: block; height: 100%; border-radius: 3px; }
.mkv-gaps .mkg-up { color: var(--fb-good-text); }
.mkv-gaps .mkg-down { color: var(--fb-negative); }
.mkv-gaps .mkg-sure { font-size: 0.78rem; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--fb-line); color: var(--fb-ink-2); }
.mkv-gaps .mkg-sure.is-solid { border-color: var(--fb-positive); color: var(--fb-good-text); }
.mkv-gaps .mkg-sure.is-thin { border-color: var(--fb-warning); }
.mkv-gaps .mkg-best { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.mkv-gaps .mkg-best a { color: var(--fb-link); text-decoration: none; }
.mkv-gaps .mkg-best a:hover { text-decoration: underline; }
@media (max-width: 640px) {
  .mkv-gaps .mkg-row > .mkg-in, .mkv-gaps .mkg-row > .mkg-field:has(input[list]) { flex: 1 1 100%; }
  .mkv-gaps .mkg-field input[list] { flex: 1; }
}
`;

function injectStyle() {
  if (typeof document === "undefined" || document.getElementById("mk-gaps-style")) return;
  const el = document.createElement("style");
  el.id = "mk-gaps-style";
  el.textContent = CSS;
  document.head.append(el);
}

export const _test = { calibration, lifetimeShare, revenueLine, topPairsWith, unpackGames, gapFinder, withGapScores, filterGaps, searchRows, percentiler, combinedScores, sortRows, usableRank, computeGaps, viewRows, GAP_FILTERS, METRICS };
