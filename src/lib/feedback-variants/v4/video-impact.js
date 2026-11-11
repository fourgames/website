// "Videos that moved sales": for each YouTube video of one of our games, the game's sales and
// wishlist adds in the 3 days after it went up next to the 7 days before, so you can see which kind
// of creators to email first. It only says what happened around the same time, never that a video
// caused it: anything else in those days (another video, a sale, an update, the launch) is listed
// next to it.
//
// Data, all already on the game page: the videos are the Media tab's (feedback/media.py, `at` is
// when the video went up), sales are Steam's days in Pacific time (feedback/sales.py) and wishlists
// Steam's days in GMT (feedback/wishlists.py), so each is lined up with the video's day in its own
// time zone.
//
// Contract: videoImpact(input) works out the rows (plain data, tested in video-impact.test.mjs);
// videoImpactCard(ctx, rows) draws them, ctx = the dashboard's helpers { h, fmtNum, usd, fmtDate }.

export const AFTER = 3;
export const BEFORE = 7;
// Another video counts as "around the same time" when it had at least this many views, or a quarter
// of this one's: a 9-view video next to a 190k-view one doesn't change the picture.
const MIN_OTHER_VIEWS = 500;

const DAY_MS = 86400000;
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export const pacificDay = (t) => pacific.format(new Date(t * 1000));
export const gmtDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));

// One number over the window before and after a day. `known`: the days that can be counted
// (from..to, inclusive); days in that span missing from `days` count as 0.
function windows(days, day, key, known) {
  const ok = (d) => d >= known.from && d <= known.to;
  const sum = (list) => list.reduce((a, d) => a + (days[d]?.[key] || 0), 0);
  const before = range(addDays(day, -BEFORE), BEFORE).filter(ok);
  const after = range(day, AFTER).filter(ok);
  if (!after.length || !before.length) return { before: before.length ? sum(before) / before.length : null, beforeDays: before.length, after: sum(after), afterDays: after.length, extra: null };
  const perDay = sum(before) / before.length;
  return { before: perDay, beforeDays: before.length, after: sum(after), afterDays: after.length, extra: sum(after) - perDay * after.length };
}

/**
 * input: {
 *   videos: media items ({ id, source: "youtube", at, title, url, author, authorUrl, views, subscribers, lang, own }),
 *   sales: { "YYYY-MM-DD" (Pacific): { units, gross, discount } } for this game,
 *   wishlists: { "YYYY-MM-DD" (GMT): { adds } } for this game,
 *   events: [{ time, name, launch?, milestone? }] (updates, the launch, the 10th review),
 *   now: unix seconds, salesLast: the newest day in the sales file (any game; defaults to this game's),
 * }
 * Returns one row per video, the biggest extra sales first.
 */
export function videoImpact({ videos = [], sales = {}, wishlists = {}, events = [], now, salesLast }) {
  const yt = videos.filter((v) => v.source === "youtube" && v.at && !v.live);
  const saleDays = Object.keys(sales).sort();
  const firstSale = saleDays.find((d) => sales[d].units > 0);
  // Launch day: the first day anything sold (a launch post can come a day or two later), else the
  // launch post's or the store's release day.
  const launch = events.find((e) => e.launch)?.time;
  const launchDay = firstSale || (launch ? pacificDay(launch) : null);
  const todayPacific = pacificDay(now), todayGmt = gmtDay(now);
  const lastSales = [salesLast || saleDays.at(-1), addDays(todayPacific, -1)].filter(Boolean).sort()[0];
  const wishDays = Object.keys(wishlists).sort();
  const lastWish = [wishDays.at(-1), addDays(todayGmt, -1)].filter(Boolean).sort()[0];

  const rows = yt.map((v) => {
    const sDay = pacificDay(v.at), wDay = gmtDay(v.at);
    const salesKnown = launchDay && lastSales ? { from: launchDay, to: lastSales } : { from: "9", to: "0" };
    const wishKnown = wishDays.length ? { from: wishDays[0], to: lastWish } : { from: "9", to: "0" };
    const units = windows(sales, sDay, "units", salesKnown);
    const gross = windows(sales, sDay, "gross", salesKnown);
    const adds = windows(wishlists, wDay, "adds", wishKnown);
    const flags = [];
    // Other videos in the same days (their 3 days overlap this one's), or big ones in the week
    // before (they lift the "before" days, so this one's jump looks smaller).
    const bar = Math.max(MIN_OTHER_VIEWS, (v.views || 0) / 4);
    for (const o of yt) {
      if (o === v || (o.views || 0) < bar) continue;
      const gap = daysBetween(sDay, pacificDay(o.at));
      if (Math.abs(gap) < AFTER) flags.push({ kind: "video", text: `Another video went up in the same days: ${o.author || "?"} (${o.views.toLocaleString("en-US")} views)` });
      else if (gap < 0 && gap >= -BEFORE && (o.views || 0) > (v.views || 0)) flags.push({ kind: "video", text: `A bigger video came out ${-gap} days before (${o.author || "?"}), so the days before were already busy` });
    }
    if (launchDay && sDay < launchDay) flags.push({ kind: "launch", text: "Before launch: no sales yet, only wishlists count" });
    else if (launchDay && daysBetween(launchDay, sDay) <= BEFORE) flags.push({ kind: "launch", text: daysBetween(launchDay, sDay) === 0 ? "Launch day: nothing to compare with" : "Launch week: the days before are launch days" });
    // Updates from the day before to the end of the 3 days: one line, a note only (some games get
    // one most days). The 10th review counts like a launch: Steam shows the game more from then.
    const near = events.filter((e) => !e.launch && e.time >= v.at - 86400 && e.time <= v.at + AFTER * 86400);
    for (const e of near.filter((e) => e.milestone)) flags.push({ kind: "event", text: `${e.name} reached around then (Steam shows the game more)` });
    const updates = near.filter((e) => !e.milestone).map((e) => e.name);
    if (updates.length) flags.push({ kind: "update", text: `${updates.length === 1 ? "An update" : `${updates.length} updates`} came out around then (${updates.slice(0, 3).join(", ")}${updates.length > 3 ? "…" : ""})` });
    const off = (list) => Math.max(0, ...list.map((d) => sales[d]?.discount || 0));
    const offBefore = off(range(addDays(sDay, -BEFORE), BEFORE)), offAfter = off(range(sDay, AFTER));
    if (offAfter !== offBefore) flags.push({ kind: "sale", text: offAfter ? `On sale in the days after (${offAfter}% off)` : `A sale ended just before (${offBefore}% off)` });
    if (units.afterDays && units.afterDays < AFTER) flags.push({ kind: "new", text: `Only ${units.afterDays} of ${AFTER} days so far` });
    else if (!units.afterDays && !adds.afterDays) flags.push({ kind: "new", text: "Too new: no full day of data yet" });
    return { video: v, day: sDay, units, gross, adds, flags, clean: !flags.some((f) => f.kind !== "new" && f.kind !== "update") };
  });
  return rows.sort(byImpact);
}

// The biggest extra sales first (wishlists when there are no sales to compare), then views.
const score = (r) => r.units.extra ?? (r.adds.extra != null ? r.adds.extra / 10 : -Infinity);
export const byImpact = (a, b) => score(b) - score(a) || (b.video.views || 0) - (a.video.views || 0);

// Channel sizes, for the "which kind of creators" summary.
export const SIZES = [[1e6, "1M+ subscribers"], [1e5, "100k–1M"], [1e4, "10k–100k"], [1e3, "1k–10k"], [0, "Under 1k"]];
export const sizeOf = (subs) => (SIZES.find(([min]) => (subs || 0) >= min) || SIZES.at(-1))[1];

// Per channel size: videos, and the extra units and wishlist adds next to them, counting only
// videos with nothing else going on in their days (when there are any), so a launch or a sale
// isn't credited to a channel size.
export function bySize(rows) {
  const out = new Map(SIZES.map(([, label]) => [label, { label, videos: 0, counted: 0, units: 0, adds: 0 }]));
  for (const r of rows) {
    if (r.video.own) continue;
    const s = out.get(sizeOf(r.video.subscribers));
    s.videos++;
    if (!r.clean || r.units.extra == null) continue;
    s.counted++;
    s.units += r.units.extra;
    s.adds += r.adds.extra || 0;
  }
  return [...out.values()].filter((s) => s.videos);
}

let languageNames;
export function languageName(code) {
  if (!code) return null;
  const base = code.split("-")[0].toLowerCase();
  try {
    languageNames ??= new Intl.DisplayNames(["en"], { type: "language" });
    return languageNames.of(base) || base.toUpperCase();
  } catch {
    return base.toUpperCase();
  }
}

const SHOWN = 8;

const CSS = `
.fb .vi-card { overflow-x: auto; }
.fb .vi-lead { margin: 8px 0 0; font-size: 0.88rem; }
.fb table.vi-table { width: 100%; font-size: 0.8rem; }
.fb table.vi-table th { font-weight: 600; color: var(--fb-ink-2); white-space: nowrap; }
.fb table.vi-table td { vertical-align: top; padding: 8px 12px 8px 0; border-top: 1px solid var(--fb-line, rgba(127,127,127,.2)); }
.fb .vi-video { min-width: 220px; max-width: 460px; }
.fb .vi-video > a { font-weight: 600; }
.fb .vi-game { font-size: 0.72rem; color: var(--fb-muted); text-transform: uppercase; letter-spacing: .03em; }
.fb .vi-date { white-space: nowrap; }
.fb .vi-num { white-space: nowrap; }
.fb .vi-num b { font-size: 0.95rem; }
.fb .vi-up { color: var(--fb-positive); }
.fb .vi-down { color: var(--fb-negative); }
.fb ul.vi-flags { margin: 4px 0 0; padding: 0; list-style: none; font-size: 0.74rem; }
.fb ul.vi-flags li { color: var(--fb-ink-2); }
.fb ul.vi-flags li::before { content: "⚠ "; color: var(--fb-warning); }
.fb ul.vi-flags li.vi-new::before { content: "⏳ "; }
.fb ul.vi-flags li.vi-update { color: var(--fb-muted); }
.fb ul.vi-flags li.vi-update::before { content: "· "; color: var(--fb-muted); }
.fb table.vi-sizes { font-size: 0.8rem; }
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("vi-style")) return;
  const el = document.createElement("style");
  el.id = "vi-style";
  el.textContent = CSS;
  document.head.append(el);
}

// The card on the Sales tab. `rows` may come from several games (each with a `game` name).
export function videoImpactCard({ h, fmtNum, usd, fmtDate }, rows) {
  if (!rows.length) return null;
  injectCss();
  const several = new Set(rows.map((r) => r.game)).size > 1;
  if (several) rows = [...rows].sort(byImpact);
  const signed = (n, fmt = (x) => x.toLocaleString("en-US")) => n == null ? "–" : `${n >= 0.5 ? "+" : n <= -0.5 ? "−" : "±"}${fmt(Math.abs(Math.round(n)))}`;
  const perDay = (w) => w.before == null ? "" : `${Math.round(w.before * 10) / 10}/day before`;
  const tone = (n) => n == null ? "" : n >= 1 ? "vi-up" : n <= -1 ? "vi-down" : "";
  const row = (r) => {
    const v = r.video;
    const who = [v.own ? "your channel" : null, v.subscribers != null ? `${fmtNum(v.subscribers)} subscribers` : null, languageName(v.lang), v.views != null ? `${fmtNum(v.views)} views` : null].filter(Boolean).join(" · ");
    return h("tr",
      h("td.vi-video",
        r.game ? h("div.vi-game", r.game) : null,
        h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.title || "(no title)"),
        h("div.meta", v.authorUrl ? h("a", { href: v.authorUrl, target: "_blank", rel: "noopener" }, v.author) : v.author, who ? ` · ${who}` : ""),
        r.flags.length ? h("ul.vi-flags", ...r.flags.map((f) => h(`li.vi-${f.kind}`, f.text))) : null),
      h("td.vi-date", fmtDate(v.at)),
      h("td.vi-num", h(`b.${tone(r.units.extra)}`, signed(r.units.extra)), h("div.meta", [`${r.units.after} sold`, perDay(r.units)].filter(Boolean).join(" · ")),
        r.gross.extra != null ? h("div.meta", `${signed(r.gross.extra, (x) => usd(x))} gross`) : null),
      h("td.vi-num", h(`b.${tone(r.adds.extra)}`, signed(r.adds.extra)), h("div.meta", [`${r.adds.after} added`, perDay(r.adds)].filter(Boolean).join(" · "))));
  };
  const head = h("tr", h("th", "Video"), h("th", "Went up"), h("th", { title: `Units sold in the ${AFTER} days from the video's day, minus what the ${BEFORE} days before would give` }, `Extra sold, ${AFTER} days`), h("th", `Extra wishlists, ${AFTER} days`));
  const table = h("table.data.vi-table", head, ...rows.slice(0, SHOWN).map(row));
  const more = rows.length > SHOWN ? h("button.btn.more", { type: "button", onclick: () => { table.append(...rows.slice(SHOWN).map(row)); more.remove(); } }, `Show ${rows.length - SHOWN} more`) : null;

  const sizes = bySize(rows);
  const best = rows.find((r) => r.clean && !r.video.own && (r.units.extra || 0) >= 1);
  const lead = best
    ? `The clearest jump: ${best.video.author} (${best.video.subscribers != null ? `${fmtNum(best.video.subscribers)} subscribers, ` : ""}${languageName(best.video.lang) || "language unknown"})${several ? ` for ${best.game}` : ""}, ${signed(best.units.extra)} sold and ${signed(best.adds.extra)} wishlists over the usual in ${AFTER} days.`
    : "No video stands out yet with nothing else going on in the same days.";
  const sizeTable = sizes.length > 1 ? h("table.data.vi-sizes", h("tr", h("th", "Channel size"), h("th", "Videos"), h("th", "Extra sold"), h("th", "Extra wishlists")),
    ...sizes.map((s) => h("tr", h("td", s.label), h("td", s.videos), h("td", s.counted ? signed(s.units) : "–"), h("td", s.counted ? signed(s.adds) : "–")))) : null;
  return h("div.chart-card.vi-card",
    h("h3", "Videos that moved sales"),
    h("div.sub", `Each YouTube video of the game (from the Media tab), with sales and wishlist adds in the ${AFTER} days from the day it went up, next to the ${BEFORE} days before. This shows what happened around the same time, not what a video caused: anything else in those days is listed under it.`),
    h("p.vi-lead", lead),
    table, more,
    sizeTable ? [h("h4", "By channel size"), h("p.meta", "Added up over videos with nothing else going on in their days (no other big video, sale, launch or 10th review; updates don't count, they come out most weeks); the others are only counted under Videos."), sizeTable] : null);
}
