// The Creators page's email hunt strip: how far through the hidden emails behind YouTube's "View
// email address" button we are (the yt-email-unlock skill, a captcha each), and the streak of days
// with a reveal, so keeping at it is visible.
//
// From creators.json (export.py): a creator's hidden email was looked at when it has ra (that time),
// found when one of its emails came from "revealed". Days are the viewer's local days.
// reveal_limit {hit, ready}: YouTube's daily reveal limit was last hit then, so the strip counts down
// to ready instead of offering a round.


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

// "3h 05m" / "12m" until t.
export function untilText(t, now) {
  const m = Math.max(0, Math.ceil((t - now) / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

const clock = (t, opts) => new Date(t * 1000).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...opts });

// The countdown to when YouTube should allow reveals again; it ticks while it's on the page.
function limitNote(h, limit) {
  const today = dayKey(limit.ready) === dayKey(Date.now() / 1000);
  const left = h("b.hn-big.hn-wait");
  const el = h("div.hn-limit", h("span.hn-icon", "⏳"), left,
    h("div", h("div", "until YouTube lets you reveal emails again"),
      h("div.cr-muted", `Daily limit hit ${clock(limit.hit, { weekday: "short" })} · next round ${today ? "today " + clock(limit.ready) : clock(limit.ready, { weekday: "long" })}`)));
  let seen = false;
  const tick = () => {
    if (el.isConnected) seen = true; else if (seen) return clearInterval(timer);
    const now = Date.now() / 1000;
    if (now < limit.ready) left.textContent = untilText(limit.ready, now);
    else { clearInterval(timer); el.replaceChildren(h("span.hn-icon", "✅"), h("b", "The limit should be over: you can do a round again.")); }
  };
  const timer = setInterval(tick, 15000);
  tick();
  return el;
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
  const limit = d.reveal_limit && d.reveal_limit.ready > now ? d.reveal_limit : null;

  return h("div.hn",
    h("div.hn-top",
      h("div.hn-prog",
        h("div", h("b.hn-big", num(s.looked)), h("span.cr-muted", ` of ${num(total)} hidden emails cleared · ${num(s.found)} found · ${num(s.left)} left`)),
        h("div.hn-bar", h("div.hn-fill", { style: `width:${(s.looked / total) * 100}%` }))),
      h("div.hn-streak", h("b.hn-big", { class: current ? "is-hot" : null }, current ? `🔥 ${current}` : "0"),
        h("div", h("div.cr-muted", `${current === 1 ? "day" : "days"} in a row · best ${best}`),
          current && !doneToday && !limit ? h("div.hn-keep", "Do a round today to keep it") : null)),
      s.left && !limit ? h("button.btn", { type: "button", title: "Paste it into Claude Code to start a round of 10", onclick: (e) => C.copy(command, e.currentTarget) }, `Copy ${command}`) : null),
    limit ? limitNote(h, limit) : null);
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
.crv .hn-limit { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--fb-line); }
.crv .hn-icon { font-size: 1.3rem; }
.crv .hn-wait { color: var(--fb-warning); min-width: 5.5ch; }
`;
