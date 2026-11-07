// The Creators page's email hunt strip: how far through the hidden emails behind YouTube's "View
// email address" button we are (the yt-email-unlock skill, a captcha each), and the streak of days
// with a reveal, so keeping at it is visible.
//
// From creators.json (export.py): a creator's hidden email was looked at when it has ra (that time),
// found when one of its emails came from "revealed". Days are the viewer's local days.


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

  const { current, best, today: doneToday } = s.streak;

  return h("div.hn",
    h("div.hn-top",
      h("div.hn-prog",
        h("div", h("b.hn-big", num(s.looked)), h("span.cr-muted", ` of ${num(total)} hidden emails cleared · ${num(s.found)} found · ${num(s.left)} left`)),
        h("div.hn-bar", h("div.hn-fill", { style: `width:${(s.looked / total) * 100}%` }))),
      h("div.hn-streak", h("b.hn-big", { class: current ? "is-hot" : null }, current ? `🔥 ${current}` : "0"),
        h("div", h("div.cr-muted", `${current === 1 ? "day" : "days"} in a row · best ${best}`),
          current && !doneToday ? h("div.hn-keep", "Do a round today to keep it") : null)),
      s.left ? h("button.btn", { type: "button", title: "Paste it into Claude Code to start a round of 10", onclick: (e) => C.copy(command, e.currentTarget) }, `Copy ${command}`) : null));
}

export const HUNT_CSS = `
.crv .hn { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 14px; margin: 0 0 12px; }
.crv .hn-top { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 20px; }
.crv .hn-prog { flex: 1 1 200px; min-width: 0; }
.crv .hn-streak { display: flex; align-items: center; gap: 8px; }
.crv .hn .btn { white-space: nowrap; }
.crv .hn-big { font-size: 1.4rem; font-weight: 800; color: var(--fb-title); font-variant-numeric: tabular-nums; }
.crv .hn-big.is-hot { color: var(--fb-warning); }
.crv .hn-bar { height: 10px; border-radius: 999px; background: var(--fb-card-2); border: 1px solid var(--fb-line); overflow: hidden; margin-top: 6px; }
.crv .hn-fill { height: 100%; background: var(--fb-good-text); border-radius: 999px; }
.crv .hn-keep { font-size: 0.78rem; font-weight: 600; color: var(--fb-warning); }
`;
