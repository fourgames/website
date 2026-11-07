// The Creators page's email hunt strip: how far through the hidden emails behind YouTube's "View
// email address" button we are (the yt-email-unlock skill, a captcha each), the streak of days with a
// reveal, and a calendar of those days, so keeping at it is visible.
//
// From creators.json (export.py): a creator's hidden email was looked at when it has ra (that time),
// found when one of its emails came from "revealed". Days are the viewer's local days.

const DAY = 86400;
const WEEKS = 18;

export function dayKey(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const shift = (key, days) => { const [y, m, d] = key.split("-").map(Number); return dayKey(new Date(y, m - 1, d + days, 12).getTime() / 1000); };

// Streaks over days with at least one reveal: { current, best, today } (current stays alive through
// today until it ends without one).
export function streaks(days, now) {
  const today = dayKey(now);
  let best = 0, run = 0, prev = null;
  for (const k of [...days.keys()].sort()) { run = prev && shift(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  let current = 0;
  for (let k = days.has(today) ? today : shift(today, -1); days.has(k); k = shift(k, -1)) current++;
  return { current, best, today: days.has(today) };
}

export function huntStats(all, now) {
  const looked = all.filter((c) => c.ra);
  const found = looked.filter((c) => c.e.some((e) => e[1] === "revealed")).length;
  const left = all.filter((c) => c.b === 1 && !c.e.length && !c.ra).length;
  const days = new Map();
  for (const c of looked) days.set(dayKey(c.ra), (days.get(dayKey(c.ra)) || 0) + 1);
  return { looked: looked.length, found, left, days, streak: streaks(days, now) };
}

export function huntStrip(d, C) {
  const { h } = C;
  const now = Math.floor(Date.now() / 1000);
  const s = huntStats(d.creators, now);
  const total = s.looked + s.left;
  if (!total) return null;
  const num = (n) => C.fmtNum(n);
  const command = "/yt-email-unlock 10";

  // Calendar: WEEKS columns of Monday..Sunday, ending this week.
  const today = new Date(now * 1000);
  const start = now - ((today.getDay() + 6) % 7) * DAY - (WEEKS - 1) * 7 * DAY;
  const cells = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const t = start + i * DAY;
    const k = dayKey(t);
    const n = s.days.get(k) || 0;
    const future = t > now;
    cells.push(h("i", { class: future ? "is-future" : n >= 10 ? "l3" : n >= 5 ? "l2" : n ? "l1" : null, title: future ? "" : `${k}: ${n ? `${n} looked at` : "none"}` }));
  }
  const { current, best, today: doneToday } = s.streak;

  return h("div.hn",
    h("div.hn-top",
      h("div.hn-prog",
        h("div", h("b.hn-big", num(s.looked)), h("span.cr-muted", ` of ${num(total)} hidden emails cleared · ${num(s.found)} found · ${num(s.left)} left`)),
        h("div.hn-bar", h("div.hn-fill", { style: `width:${(s.looked / total) * 100}%` }))),
      h("div.hn-streak", h("b.hn-big", { class: current ? "is-hot" : null }, current ? `🔥 ${current}` : "0"),
        h("div.cr-muted", `${current === 1 ? "day" : "days"} in a row · best ${best}`),
        current && !doneToday ? h("div.hn-keep", "Do a round today to keep it") : null),
      s.left ? h("button.btn", { type: "button", title: "Paste it into Claude Code to start a round of 10", onclick: (e) => C.copy(command, e.currentTarget) }, `Copy ${command}`) : null),
    h("div.hn-heat", { "aria-label": `Hidden emails looked at per day, the last ${WEEKS} weeks` }, ...cells),
    h("div.cr-muted.hn-legend", `Last ${WEEKS} weeks · darker = more looked at that day (1, 5, 10+)`));
}

export const HUNT_CSS = `
.crv .hn { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px 14px; margin: 0 0 16px; }
.crv .hn-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; margin: 0 0 10px; }
.crv .hn-prog { flex: 1 1 280px; min-width: 0; }
.crv .hn-big { font-size: 1.4rem; font-weight: 800; color: var(--fb-title); font-variant-numeric: tabular-nums; }
.crv .hn-big.is-hot { color: var(--fb-warning); }
.crv .hn-bar { height: 10px; border-radius: 999px; background: var(--fb-card-2); border: 1px solid var(--fb-line); overflow: hidden; margin-top: 6px; }
.crv .hn-fill { height: 100%; background: var(--fb-good-text); border-radius: 999px; }
.crv .hn-keep { font-size: 0.78rem; font-weight: 600; color: var(--fb-warning); }
.crv .hn-heat { display: grid; grid-template-rows: repeat(7, 11px); grid-auto-flow: column; grid-auto-columns: 11px; gap: 3px; overflow-x: auto; padding-bottom: 2px; }
.crv .hn-heat i { border-radius: 2px; background: var(--fb-card-2); border: 1px solid var(--fb-line); }
.crv .hn-heat i.is-future { visibility: hidden; }
.crv .hn-heat i.l1 { background: color-mix(in srgb, var(--fb-good-text) 35%, var(--fb-card)); border-color: transparent; }
.crv .hn-heat i.l2 { background: color-mix(in srgb, var(--fb-good-text) 65%, var(--fb-card)); border-color: transparent; }
.crv .hn-heat i.l3 { background: var(--fb-good-text); border-color: transparent; }
.crv .hn-legend { margin-top: 4px; }
`;
