// "Videos that moved sales": for each YouTube video of one of our games, the game's sales, wishlist
// adds and (when read) store visits from youtube.com in the 3 days after it went up, next to what the
// days before say those 3 days would have had anyway. It only says what happened around the same
// time, never that a video caused it: anything else in those days (another video, a sale, an update,
// the launch) is listed next to it.
//
// "What they would have had anyway" (expected): the 14 days before, each day divided by its weekday's
// usual share (a game sells more at weekends), averaged without the highest and lowest quarter (so an
// earlier video's spike doesn't lift it); when the second week is lower than the first (a launch curve
// falling), the fall is carried on into the 3 days. An extra counts as real only when it's more than
// normal day-to-day swings explain: at least 2 × √expected (counts like sales swing about √n a day).
//
// Wishlists are turned into sales with the game's own rate (wishlist purchases and gifts ÷ adds, from
// Steam's wishlist report), once there are enough to tell; before that they're shown, not converted.
//
// Data, all already on the game page: the videos are the Media tab's (feedback/media.py, `at` is
// when the video went up, `viewsByDay` its views at the end of each GMT day while it's refreshed),
// sales are Steam's days in Pacific time (feedback/sales.py), wishlists Steam's days in GMT
// (feedback/wishlists.py), store traffic Steamworks' Traffic Breakdown per day (feedback/traffic.js),
// so each is lined up with the video's day in its own time zone.
//
// Contract: videoImpact(input) works out the rows (plain data, tested in video-impact.test.mjs);
// videoImpactCard(ctx, rows) draws them, ctx = the dashboard's helpers { h, fmtNum, usd, fmtDate }.

export const AFTER = 3;
export const BEFORE = 14;
const WEEKDAY_HISTORY = 56; // days used to learn the weekday pattern
const MIN_WEEKDAY_DAYS = 28;
const NOISE = 2; // an extra is real above NOISE × √expected
// Another video counts as "around the same time" when it had at least this many views, or a quarter
// of this one's: a 9-view video next to a 190k-view one doesn't change the picture.
const MIN_OTHER_VIEWS = 500;
// The game's wishlist → purchase rate is used once it rests on at least this many.
const MIN_CONVERSION_ADDS = 200, MIN_CONVERSION_BUYS = 10;

const DAY_MS = 86400000;
const pacific = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
export const pacificDay = (t) => pacific.format(new Date(t * 1000));
export const gmtDay = (t) => new Date(t * 1000).toISOString().slice(0, 10);
export const addDays = (day, n) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY_MS);
const range = (from, n) => Array.from({ length: n }, (_, i) => addDays(from, i));
const weekday = (day) => new Date(day + "T00:00:00Z").getUTCDay();
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
// The mean of the middle half: steady like a median, but not stuck at 0 for a game selling 0–2 a day.
export function middleMean(list) {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b), cut = Math.floor(s.length / 4);
  return mean(s.slice(cut, s.length - cut));
}
export const median = (list) => {
  if (!list.length) return null;
  const s = list.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Each weekday's usual level as a multiple of the average (1 = an average day), from up to 8 weeks
// before `day`; all 1 with under 4 weeks of days. Pulled toward 1 a little (one average day added to
// each weekday) so one odd Saturday doesn't make a pattern.
export function weekdayFactors(days, key, day, ok) {
  const list = range(addDays(day, -WEEKDAY_HISTORY), WEEKDAY_HISTORY).filter(ok);
  const flat = [1, 1, 1, 1, 1, 1, 1];
  if (list.length < MIN_WEEKDAY_DAYS) return flat;
  const avg = mean(list.map((d) => days[d]?.[key] || 0));
  if (avg <= 0) return flat;
  return flat.map((_, w) => {
    const these = list.filter((d) => weekday(d) === w).map((d) => days[d]?.[key] || 0);
    const f = (these.reduce((a, b) => a + b, 0) + avg) / (these.length + 1) / avg;
    return Math.min(2, Math.max(0.5, f));
  });
}

// What the days from `day` would have had without the video (see the top), and the extra on top.
// `ok(d)`: the days that can be counted; days in that span missing from `days` count as 0.
export function windows(days, key, day, ok) {
  const value = (d) => days[d]?.[key] || 0;
  const before = range(addDays(day, -BEFORE), BEFORE).filter(ok);
  const after = range(day, AFTER).filter(ok);
  const actual = after.reduce((a, d) => a + value(d), 0);
  const base = { after: actual, afterDays: after.length, beforeDays: before.length, before: null, expected: null, extra: null, real: false, falling: null };
  if (before.length < 5) return base;
  const f = weekdayFactors(days, key, day, ok);
  const level = (list) => middleMean(list.map((d) => value(d) / f[weekday(d)]));
  const early = before.filter((d) => d < addDays(day, -7)), late = before.filter((d) => d >= addDays(day, -7));
  let at = () => level(before);
  if (early.length >= 4 && late.length >= 4) {
    const e = level(early), l = level(late);
    if (e > 0 && l < e) {
      // Falling: carry on the week-on-week fall, from the middle of the last week (4 days before the video).
      const perDay = Math.max(0.25, l / e) ** (1 / 7);
      at = (i) => l * perDay ** (i + 4);
      base.falling = 1 - Math.max(0.25, l / e);
    }
  }
  base.before = level(before);
  if (!after.length) return base;
  const expected = after.reduce((a, d) => a + at(daysBetween(day, d)) * f[weekday(d)], 0);
  base.expected = expected;
  base.extra = actual - expected;
  base.real = base.extra > 0 && base.extra >= NOISE * Math.sqrt(Math.max(expected, 1));
  return base;
}

// The game's own wishlist → purchase rate (purchases and gifts of wishlisted copies ÷ adds), or null
// while there are too few to tell (before launch, all of them).
export function conversion(wishlists = {}) {
  let adds = 0, buys = 0;
  for (const d of Object.values(wishlists)) {
    adds += d.adds || 0;
    buys += (d.purchases || 0) + (d.gifts || 0);
  }
  return adds >= MIN_CONVERSION_ADDS && buys >= MIN_CONVERSION_BUYS ? buys / adds : null;
}

// Views a video gained per GMT day, from its end-of-day views (media.py `viewsByDay`): the views up
// to the first reading are spread over the days since it went up. {day: views}, or null.
export function viewGains(video) {
  const snaps = Object.entries(video.viewsByDay || {}).sort(([a], [b]) => a.localeCompare(b));
  if (!snaps.length) return null;
  const gains = {};
  let [prevDay, prevViews] = [addDays(gmtDay(video.at), -1), 0];
  for (const [day, views] of snaps) {
    const gap = Math.max(1, daysBetween(prevDay, day));
    for (let i = 1; i <= gap; i++) gains[addDays(prevDay, i)] = Math.max(0, views - prevViews) / gap;
    [prevDay, prevViews] = [day, views];
  }
  return gains;
}

// The day the video took off: its biggest day of views, when that's after its first two days (a
// video found by the algorithm a week later). null when it took off right away or there's no history.
export function tookOff(video) {
  const gains = viewGains(video);
  if (!gains) return null;
  const [day, views] = Object.entries(gains).reduce((a, b) => (b[1] > a[1] ? b : a));
  return daysBetween(gmtDay(video.at), day) >= 2 && views >= MIN_OTHER_VIEWS ? { day, views: Math.round(views) } : null;
}

// Store visits from YouTube on one day of Steamworks' Traffic Breakdown (traffic.js): the youtube.com
// rows (www., m.), else the biggest row naming YouTube, in the "Visits" column. null when not read.
export function youtubeVisits(entry) {
  if (!entry || entry.missing || !entry.cols?.length) return null;
  const col = entry.cols.findIndex((c) => /visits/i.test(c) && !/owner/i.test(c));
  if (col < 1) return null;
  const at = (r) => r[col] || 0;
  const exact = entry.rows.filter((r) => /^(https?:\/\/)?((www|m)\.)?youtube\.com\/?$/i.test(r[0]));
  if (exact.length) return exact.reduce((a, r) => a + at(r), 0);
  const loose = entry.rows.filter((r) => /youtube|youtu\.be/i.test(r[0]));
  return loose.length ? Math.max(...loose.map(at)) : 0;
}

/**
 * input: {
 *   videos: media items ({ id, source: "youtube", at, title, url, author, authorUrl, views, viewsByDay, subscribers, lang, own }),
 *   sales: { "YYYY-MM-DD" (Pacific): { units, gross, discount } } for this game,
 *   wishlists: { "YYYY-MM-DD" (GMT): { adds, purchases, gifts } } for this game,
 *   traffic: { "YYYY-MM-DD": { cols, rows } } Steamworks' Traffic Breakdown for this game (optional),
 *   events: [{ time, name, launch?, milestone? }] (updates, the launch, the 10th review),
 *   now: unix seconds, salesLast: the newest day in the sales file (any game; defaults to this game's),
 * }
 * Returns one row per video, the biggest extra first (sales plus wishlists turned into sales).
 */
export function videoImpact({ videos = [], sales = {}, wishlists = {}, traffic = {}, events = [], now, salesLast }) {
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
  const rate = conversion(wishlists);
  // YouTube visits per day, only the days the traffic page was read.
  const ytDays = {};
  for (const [d, entry] of Object.entries(traffic || {})) {
    const n = youtubeVisits(entry);
    if (n != null) ytDays[d] = { visits: n };
  }
  const salesOk = (d) => !!launchDay && !!lastSales && d >= launchDay && d <= lastSales;
  const wishOk = (d) => wishDays.length > 0 && d >= wishDays[0] && d <= lastWish;
  const trafficOk = (d) => d in ytDays && d < todayPacific;

  const rows = yt.map((v) => {
    const off = tookOff(v);
    // Lined up with the day it took off when that was later than its first days.
    const sDay = off ? off.day : pacificDay(v.at), wDay = off ? off.day : gmtDay(v.at);
    const units = windows(sales, "units", sDay, salesOk);
    const gross = windows(sales, "gross", sDay, salesOk);
    const adds = windows(wishlists, "adds", wDay, wishOk);
    const visits = Object.keys(ytDays).length ? windows(ytDays, "visits", sDay, trafficOk) : null;
    const gains = viewGains(v);
    const viewsAfter = gains ? Math.round(range(wDay, AFTER).reduce((a, d) => a + (gains[d] || 0), 0)) : null;
    const flags = [];
    if (off) flags.push({ kind: "took", text: `Took off later: ${off.views.toLocaleString("en-US")} views on ${off.day}, so the 3 days start then` });
    // Other videos in the same days (their 3 days overlap this one's), or big ones in the 2 weeks
    // before (they lift the "before" days, so this one's jump looks smaller).
    const bar = Math.max(MIN_OTHER_VIEWS, (v.views || 0) / 4);
    for (const o of yt) {
      if (o === v || (o.views || 0) < bar) continue;
      const gap = daysBetween(sDay, pacificDay(o.at));
      if (Math.abs(gap) < AFTER) flags.push({ kind: "video", text: `Another video went up in the same days: ${o.author || "?"} (${o.views.toLocaleString("en-US")} views)` });
      else if (gap < 0 && gap >= -BEFORE && (o.views || 0) > (v.views || 0)) flags.push({ kind: "video", text: `A bigger video came out ${-gap} days before (${o.author || "?"}), so the days before were already busy` });
    }
    if (launchDay && sDay < launchDay) flags.push({ kind: "launch", text: "Before launch: no sales yet, only wishlists count" });
    else if (launchDay && daysBetween(launchDay, sDay) <= 7) flags.push({ kind: "launch", text: daysBetween(launchDay, sDay) === 0 ? "Launch day: nothing to compare with" : "Launch week: the days before are launch days" });
    // Updates from the day before to the end of the 3 days: one line, a note only (some games get
    // one most days). The 10th review counts like a launch: Steam shows the game more from then.
    const start = Date.parse(sDay + "T00:00:00Z") / 1000;
    const near = events.filter((e) => !e.launch && e.time >= Math.min(v.at, start) - 86400 && e.time <= Math.max(v.at, start) + AFTER * 86400);
    for (const e of near.filter((e) => e.milestone)) flags.push({ kind: "event", text: `${e.name} reached around then (Steam shows the game more)` });
    const updates = near.filter((e) => !e.milestone).map((e) => e.name);
    if (updates.length) flags.push({ kind: "update", text: `${updates.length === 1 ? "An update" : `${updates.length} updates`} came out around then (${updates.slice(0, 3).join(", ")}${updates.length > 3 ? "…" : ""})` });
    const discount = (list) => Math.max(0, ...list.map((d) => sales[d]?.discount || 0));
    const offBefore = discount(range(addDays(sDay, -BEFORE), BEFORE)), offAfter = discount(range(sDay, AFTER));
    if (offAfter !== offBefore) flags.push({ kind: "sale", text: offAfter ? `On sale in the days after (${offAfter}% off)` : `A sale ended in the 2 weeks before (${offBefore}% off)` });
    if (units.afterDays && units.afterDays < AFTER) flags.push({ kind: "new", text: `Only ${units.afterDays} of ${AFTER} days so far` });
    else if (!units.afterDays && !adds.afterDays) flags.push({ kind: "new", text: "Too new: no full day of data yet" });
    // Sold now plus wishlists turned into sales at the game's rate.
    const value = units.extra == null && (adds.extra == null || rate == null) ? null : (units.extra || 0) + (rate != null ? (adds.extra || 0) * rate : 0);
    const real = units.real || adds.real || !!visits?.real;
    return { video: v, day: sDay, tookOff: off, units, gross, adds, visits, viewsAfter, rate, value, real, flags,
      clean: !flags.some((f) => f.kind !== "new" && f.kind !== "update" && f.kind !== "took") };
  });
  return rows.sort(byImpact);
}

// The biggest extra first (sales plus converted wishlists; wishlists alone when they can't be
// converted yet), then views.
const score = (r) => r.value ?? -Infinity;
export const byImpact = (a, b) => score(b) - score(a) || (b.adds.extra ?? -Infinity) - (a.adds.extra ?? -Infinity) || (b.video.views || 0) - (a.video.views || 0);

// The video's own views, for the "which kind of video" summary: what a video reached, not how big its
// channel is (a big channel's flop and a small channel's hit are told apart).
export const TIERS = [[1e5, "100k+ views"], [1e4, "10k–100k views"], [1e3, "1k–10k views"], [0, "Under 1k views"]];
export const tierOf = (views) => (TIERS.find(([min]) => (views || 0) >= min) || TIERS.at(-1))[1];

// Per view tier: videos, how many could be counted (nothing else going on in their days), how many
// were a real jump, and the median extra units and wishlist adds per counted video. Our own channel
// is left out.
export function byViews(rows) {
  const out = new Map(TIERS.map(([, label]) => [label, { label, videos: 0, counted: 0, real: 0, units: [], adds: [] }]));
  for (const r of rows) {
    if (r.video.own) continue;
    const s = out.get(tierOf(r.video.views));
    s.videos++;
    if (!r.clean || (r.units.extra == null && r.adds.extra == null)) continue;
    s.counted++;
    if (r.real) s.real++;
    if (r.units.extra != null) s.units.push(r.units.extra);
    if (r.adds.extra != null) s.adds.push(r.adds.extra);
  }
  return [...out.values()].filter((s) => s.videos).map((s) => ({ ...s, units: median(s.units), adds: median(s.adds) }));
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
.fb .vi-noise { color: var(--fb-muted); }
.fb ul.vi-flags li.vi-took::before { content: "↗ "; color: var(--fb-muted); }
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
  const traffic = rows.some((r) => r.visits);
  const signed = (n, fmt = (x) => x.toLocaleString("en-US")) => n == null ? "–" : `${n >= 0.5 ? "+" : n <= -0.5 ? "−" : "±"}${fmt(Math.abs(Math.round(n)))}`;
  const usual = (w) => w.expected == null ? "" : `usual ${Math.round(w.expected * 10) / 10}`;
  // A real jump in color; one inside normal swings grey, with why.
  const num = (w, fmt) => w.extra == null ? h("b", "–")
    : w.real ? h("b.vi-up", signed(w.extra, fmt))
    : h("b.vi-noise", { title: `Within normal day-to-day swings (needs more than +${Math.ceil(2 * Math.sqrt(Math.max(w.expected, 1)))})` }, signed(w.extra, fmt));
  const cell = (w, word) => h("td.vi-num", num(w), h("div.meta", [`${w.after} ${word}`, usual(w), w.falling ? "falling" : null].filter(Boolean).join(" · ")));
  const row = (r) => {
    const v = r.video;
    const who = [v.own ? "your channel" : null, v.subscribers != null ? `${fmtNum(v.subscribers)} subscribers` : null, languageName(v.lang), v.views != null ? `${fmtNum(v.views)} views` : null,
      r.viewsAfter != null ? `${fmtNum(r.viewsAfter)} in the 3 days` : null].filter(Boolean).join(" · ");
    return h("tr",
      h("td.vi-video",
        r.game ? h("div.vi-game", r.game) : null,
        h("a", { href: v.url, target: "_blank", rel: "noopener" }, v.title || "(no title)"),
        h("div.meta", v.authorUrl ? h("a", { href: v.authorUrl, target: "_blank", rel: "noopener" }, v.author) : v.author, who ? ` · ${who}` : ""),
        r.flags.length ? h("ul.vi-flags", ...r.flags.map((f) => h(`li.vi-${f.kind}`, f.text))) : null),
      h("td.vi-date", fmtDate(v.at)),
      traffic ? (r.visits ? cell(r.visits, "visits") : h("td.vi-num", "–")) : null,
      h("td.vi-num", num(r.units), h("div.meta", [`${r.units.after} sold`, usual(r.units), r.units.falling ? "falling" : null].filter(Boolean).join(" · ")),
        r.gross.extra != null ? h("div.meta", `${signed(r.gross.extra, (x) => usd(x))} gross`) : null),
      cell(r.adds, "added"));
  };
  const head = h("tr", h("th", "Video"), h("th", "Went up"),
    traffic ? h("th", { title: "Store page visits from youtube.com (Steamworks' Traffic Breakdown), over the usual" }, "Visits from YouTube") : null,
    h("th", { title: `Units sold in the ${AFTER} days from the video's day, over what the ${BEFORE} days before say was usual` }, `Extra sold, ${AFTER} days`),
    h("th", `Extra wishlists, ${AFTER} days`));
  const table = h("table.data.vi-table", head, ...rows.slice(0, SHOWN).map(row));
  const more = rows.length > SHOWN ? h("button.btn.more", { type: "button", onclick: () => { table.append(...rows.slice(SHOWN).map(row)); more.remove(); } }, `Show ${rows.length - SHOWN} more`) : null;

  const tiers = byViews(rows);
  // Only a jump bigger than normal swings, with nothing else going on, makes the headline.
  const best = rows.find((r) => r.clean && !r.video.own && r.real && ((r.units.real && r.units.extra > 0) || (r.adds.real && r.adds.extra > 0) || r.visits?.real));
  const parts = best ? [best.visits?.real ? `${signed(best.visits.extra)} visits from YouTube` : null,
    best.units.extra != null ? `${signed(best.units.extra)} sold` : null, best.adds.extra != null ? `${signed(best.adds.extra)} wishlists` : null].filter(Boolean) : [];
  const lead = best
    ? `The clearest jump: ${best.video.author} (${best.video.views != null ? `${fmtNum(best.video.views)} views, ` : ""}${languageName(best.video.lang) || "language unknown"})${several ? ` for ${best.game}` : ""}, ${parts.join(", ")} over the usual in ${AFTER} days.`
    : "No video stands out yet: no jump bigger than normal swings with nothing else going on in the same days.";
  const rate = rows.find((r) => r.rate != null)?.rate;
  const tierTable = tiers.length > 1 ? h("table.data.vi-sizes", h("tr", h("th", "Video views"), h("th", "Videos"), h("th", "Real jumps"), h("th", "Extra sold (median)"), h("th", "Extra wishlists (median)")),
    ...tiers.map((s) => h("tr", h("td", s.label), h("td", s.videos), h("td", s.counted ? `${s.real} of ${s.counted}` : "–"), h("td", s.units != null ? signed(s.units) : "–"), h("td", s.adds != null ? signed(s.adds) : "–")))) : null;
  return h("div.chart-card.vi-card",
    h("h3", "Videos that moved sales"),
    h("div.sub", `Each YouTube video of the game (from the Media tab): sales and wishlists in the ${AFTER} days from the day it went up (or took off), over what the ${BEFORE} days before say was usual (weekdays and a falling launch curve taken into account). Green is more than normal swings; grey could be chance. This shows what happened around the same time, not what a video caused: anything else in those days is listed under it.`),
    h("p.vi-lead", lead),
    h("p.meta", rate != null ? `Wishlists count as sales at this game's own rate: ${Math.round(rate * 1000) / 10}% of wishlists became purchases.` : "Wishlists aren't turned into sales yet: too few wishlist purchases to know this game's rate."),
    traffic ? null : h("p.meta", "Visits from YouTube: not read yet. The task on your Mac reads Steamworks' Traffic Breakdown once Chrome is signed in to partner.steamgames.com; then it's the best evidence here."),
    table, more,
    tierTable ? [h("h4", "By video views"), h("p.meta", "Per video, the middle value (median), over videos with nothing else going on in their days (no other big video, sale, launch or 10th review; updates don't count). The others are only counted under Videos."), tierTable] : null);
}
