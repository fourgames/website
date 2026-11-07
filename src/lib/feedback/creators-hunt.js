// The Creators page's Email hunt: the hidden emails behind YouTube's "View email address" button
// (the yt-email-unlock skill, a captcha each) as a game, so the 900-odd still waiting feel like a run
// to keep going rather than a chore.
//
// Everything comes from creators.json (export.py): a creator's hidden email was looked at when it has
// ra (that time), found when one of its emails came from "revealed". Days are the viewer's local days.
//   - XP: 10 per email found, +10 when they made a video of our games, +5 at 1k-300k subscribers (the
//     sweet spot), +5 when they uploaded in the last 30 days. A button that showed nothing: 2.
//   - Level n needs 25·n·(n−1) XP. Streak: days in a row with a reveal, alive until a day is missed.
//   - Daily goal: one skill round (10 tabs). Bounties: the next targets, in the skill's own order.

const DAY = 86400;
export const GOAL = 10;
const TITLES = ["Rookie", "Scout", "Tracker", "Hunter", "Headhunter", "Inbox Ranger", "Mail Raider", "Legend"];

const isFound = (c) => c.e.some((e) => e[1] === "revealed");
const sweet = (c) => c.s != null && c.s >= 1000 && c.s <= 300000;
const recent = (c, now) => { const t = c.lu || c.lv; return !!t && now - t <= 30 * DAY; };

export function xpFor(c, now) {
  if (c.ra && !isFound(c)) return 2;
  return 10 + (c.own ? 10 : 0) + (sweet(c) ? 5 : 0) + (recent(c, now) ? 5 : 0);
}
export const levelXp = (n) => 25 * n * (n - 1);
export function level(xp) {
  let n = 1;
  while (xp >= levelXp(n + 1)) n++;
  return { n, title: TITLES[n - 1] || `Legend ${n - TITLES.length + 1}`, from: levelXp(n), to: levelXp(n + 1) };
}
export function dayKey(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const shift = (key, days) => { const [y, m, d] = key.split("-").map(Number); return dayKey(new Date(y, m - 1, d + days, 12).getTime() / 1000); };

// Streaks over days with at least one reveal: { current, best, today } (current stays alive through
// today until it ends without one).
export function streaks(days, now) {
  const today = dayKey(now);
  const keys = [...days.keys()].sort();
  let best = 0, run = 0, prev = null;
  for (const k of keys) { run = prev && shift(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run); prev = k; }
  let current = 0;
  for (let k = days.has(today) ? today : shift(today, -1); days.has(k); k = shift(k, -1)) current++;
  return { current, best, today: days.has(today) };
}

// Same order as server/creators/reveal.py: ours, sweet spot, active, more games, more subscribers.
export function bounties(all, now) {
  const key = (c) => [c.own ? 1 : 0, sweet(c) ? 1 : 0, recent(c, now) ? 1 : 0, c.g.length, c.s || 0];
  return all.filter((c) => c.b === 1 && !c.e.length && !c.ra)
    .map((c) => [key(c), c]).sort((a, b) => { for (let i = 0; i < 5; i++) if (a[0][i] !== b[0][i]) return b[0][i] - a[0][i]; return 0; })
    .map(([, c]) => c);
}

export function huntStats(all, now) {
  const looked = all.filter((c) => c.ra);
  const found = looked.filter(isFound);
  const days = new Map();
  for (const c of looked) {
    const k = dayKey(c.ra);
    const d = days.get(k) || { looked: 0, found: 0, xp: 0 };
    d.looked++; d.xp += xpFor(c, now); if (isFound(c)) d.found++;
    days.set(k, d);
  }
  const xp = looked.reduce((s, c) => s + xpFor(c, now), 0);
  const left = bounties(all, now);
  const ours = all.filter((c) => c.own && c.b === 1 && (c.ra || !c.e.length));
  return { looked, found, days, xp, left, ours, oursDone: ours.filter((c) => c.ra).length, streak: streaks(days, now),
    bestDay: Math.max(0, ...[...days.values()].map((d) => d.looked)) };
}

export function badges(s) {
  const n = s.found.length;
  return [
    ["First blood", "Find your first hidden email", n >= 1],
    ["Full round", `${GOAL} looked at in one day`, s.bestDay >= GOAL],
    ["Double round", `${GOAL * 2} in one day`, s.bestDay >= GOAL * 2],
    ["Ten", "10 emails found", n >= 10],
    ["Fifty", "50 emails found", n >= 50],
    ["Century", "100 emails found", n >= 100],
    ["Quarter grand", "250 emails found", n >= 250],
    ["Five hundred", "500 emails found", n >= 500],
    ["On a roll", "3-day streak", s.streak.best >= 3],
    ["Week warrior", "7-day streak", s.streak.best >= 7],
    ["Unstoppable", "30-day streak", s.streak.best >= 30],
    ["Our people", "Every creator who covered our games looked at", s.ours.length > 0 && s.oursDone === s.ours.length],
    ["Clean sweep", "No hidden emails left", s.left.length === 0 && s.looked.length > 0],
  ];
}

const SEEN = "cr-hunt-seen";
const read = () => { try { return JSON.parse(localStorage.getItem(SEEN) || "null"); } catch { return null; } };
const write = (v) => { try { localStorage.setItem(SEEN, JSON.stringify(v)); } catch { /* private window */ } };

export function huntView(d, C) {
  const { h } = C;
  const now = Math.floor(Date.now() / 1000);
  const s = huntStats(d.creators, now);
  const lv = level(s.xp);
  const today = s.days.get(dayKey(now)) || { looked: 0, found: 0, xp: 0 };
  const earned = badges(s);
  const num = (n) => C.fmtNum(n);
  const pct = (a, b) => `${Math.max(0, Math.min(100, b ? (a / b) * 100 : 0))}%`;
  const bar = (a, b, cls = "") => h(`div.hn-bar${cls}`, h("div.hn-fill", { style: `width:${pct(a, b)}` }));

  // What changed since this browser last opened the hunt.
  const seen = read();
  const got = earned.filter((b) => b[2]).map((b) => b[0]);
  const news = seen ? [
    s.xp > seen.xp ? `+${num(s.xp - seen.xp)} XP` : null,
    lv.n > seen.level ? `level up: ${lv.title}` : null,
    ...got.filter((b) => !(seen.badges || []).includes(b)).map((b) => `badge: ${b}`),
  ].filter(Boolean) : [];
  write({ xp: s.xp, level: lv.n, badges: got });

  const total = s.looked.length + s.left.length;
  const command = `/yt-email-unlock ${GOAL}`;
  const hero = h("div.hn-hero",
    h("div.hn-level", h("div.hn-lvnum", lv.n), h("div",
      h("div.hn-title", lv.title), h("div.cr-muted", `${num(s.xp)} XP · ${num(lv.to - s.xp)} to level ${lv.n + 1}`),
      bar(s.xp - lv.from, lv.to - lv.from))),
    h("div.hn-stat", h("div.hn-big", { class: s.streak.current ? "is-hot" : null }, `${s.streak.current}`), h("div.hn-lab", s.streak.current === 1 ? "day streak" : "days streak"),
      h("div.cr-muted", s.streak.current && !s.streak.today ? "Do a round today to keep it" : `Best ${s.streak.best}`)),
    h("div.hn-stat", h("div.hn-big", `${today.looked}/${GOAL}`), h("div.hn-lab", "today's round"),
      bar(today.looked, GOAL, today.looked >= GOAL ? ".is-done" : ""),
      h("div.cr-muted", today.looked >= GOAL ? `Done · ${today.found} found, +${today.xp} XP` : `${GOAL - today.looked} to go`)),
    h("div.hn-stat", h("div.hn-big", num(s.found.length)), h("div.hn-lab", "emails found"),
      h("div.cr-muted", `${s.looked.length ? Math.round((s.found.length / s.looked.length) * 100) : 0}% hit rate`)));

  const go = h("div.hn-go",
    h("div", h("b", s.left.length ? `${num(s.left.length)} hidden emails waiting` : "Nothing left to unlock"),
      h("div.cr-muted", `${num(s.looked.length)} of ${num(total)} cleared`), bar(s.looked.length, total, ".is-pool")),
    s.left.length ? h("button.btn.hn-cta", { type: "button", title: "Paste it into Claude Code to start a round", onclick: (e) => C.copy(command, e.currentTarget) }, `Copy ${command}`) : null);

  // Last 14 days.
  const last = Array.from({ length: 14 }, (_, i) => dayKey(now - (13 - i) * DAY));
  const peak = Math.max(GOAL, ...last.map((k) => s.days.get(k)?.looked || 0));
  const chart = h("div.hn-chart", ...last.map((k) => {
    const v = s.days.get(k) || { looked: 0, found: 0 };
    return h("div.hn-col", { title: `${k}: ${v.found} found of ${v.looked} looked at` },
      h("div.hn-area", h("div.hn-stack", { style: `height:${pct(v.looked, peak)}` }, h("div.hn-found", { style: `height:${pct(v.found, v.looked)}` }))),
      h("div.hn-day", k.slice(8)));
  }), h("div.hn-goal", { style: `bottom:${18 + Math.round((GOAL / peak) * 120)}px`, title: `Goal: ${GOAL} a day` }));

  const board = s.left.slice(0, GOAL);
  const bounty = h("div.hn-panel",
    h("div.hn-h", "Next round's bounties"),
    board.length ? h("ol.hn-bounties", ...board.map((c) => h("li",
      h("span.hn-xp", `${xpFor(c, now)} XP`),
      h("a", { href: `https://www.youtube.com/${c.h || `channel/${c.id}`}/about`, target: "_blank", rel: "noopener" }, c.t || c.id),
      c.own ? h("span.cr-badge", { title: "Made a video of one of our games" }, "ours") : null,
      h("span.cr-muted", ` ${c.s == null ? "" : `${C.fmtNum(c.s)} subs`}`)))) : h("p.cr-muted", "All clear."),
    h("p.cr-muted", "The skill opens these in your Chrome; you click View email address and the captcha in each."));

  const badgeGrid = h("div.hn-panel",
    h("div.hn-h", `Badges ${got.length}/${earned.length}`),
    h("div.hn-badges", ...earned.map(([name, how, ok]) => h("div.hn-badge", { class: ok ? "is-got" : null, title: how }, h("b", name), h("span", how)))));

  const rules = h("details.about", h("summary", "How points work"),
    h("p", "Each email you unlock is 10 XP, plus 10 if they made a video of one of our games, 5 if they have 1k–300k subscribers and 5 if they uploaded in the last 30 days. A button that showed nothing still counts as looked at: 2 XP."),
    h("p", `The daily goal is one round of the skill (${GOAL} tabs). The streak counts days in a row with at least one reveal. The numbers come from the server's creator list, so a round shows up here after the server's next hourly export.`));

  return h("div.hn",
    news.length ? h("p.cr-note.hn-news", h("b", "Since last time: "), news.join(" · ")) : null,
    hero, go, h("div.hn-grid", h("div.hn-panel", h("div.hn-h", "Last 14 days"), chart, h("div.cr-muted", "Bar: looked at · green: email found · line: daily goal")), bounty),
    badgeGrid, rules);
}

export const HUNT_CSS = `
.crv .hn-news { border-left-color: var(--fb-accent); margin: 0 0 12px; }
.crv .hn-hero { display: grid; grid-template-columns: minmax(240px, 2fr) repeat(3, minmax(130px, 1fr)); gap: 10px; margin: 0 0 10px; }
.crv .hn-hero > div, .crv .hn-panel, .crv .hn-go { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px 14px; }
.crv .hn-level { display: flex; gap: 14px; align-items: center; }
.crv .hn-level > div:last-child { flex: 1; min-width: 0; }
.crv .hn-lvnum { flex: none; width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; font-size: 1.6rem; font-weight: 800; color: var(--fb-title); border: 3px solid var(--fb-accent); }
.crv .hn-title { font-size: 1.15rem; font-weight: 750; color: var(--fb-title); }
.crv .hn-big { font-size: 1.6rem; font-weight: 800; color: var(--fb-title); font-variant-numeric: tabular-nums; }
.crv .hn-big.is-hot { color: var(--fb-warning); }
.crv .hn-big.is-hot::after { content: " 🔥"; font-size: 1.2rem; }
.crv .hn-lab { font-weight: 600; font-size: 0.88rem; }
.crv .hn-bar { height: 8px; border-radius: 999px; background: var(--fb-card-2); border: 1px solid var(--fb-line); overflow: hidden; margin: 6px 0 4px; }
.crv .hn-fill { height: 100%; background: var(--fb-accent); border-radius: 999px; transition: width .4s; }
.crv .hn-bar.is-done .hn-fill, .crv .hn-bar.is-pool .hn-fill { background: var(--fb-good-text); }
.crv .hn-go { display: flex; flex-wrap: wrap; gap: 10px 20px; align-items: center; justify-content: space-between; margin: 0 0 10px; }
.crv .hn-go > div { flex: 1 1 260px; }
.crv .hn-cta { font-weight: 700; }
.crv .hn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; margin: 0 0 10px; }
.crv .hn-h { font-weight: 700; color: var(--fb-title); margin: 0 0 8px; }
.crv .hn-chart { position: relative; display: flex; gap: 4px; margin-bottom: 6px; }
.crv .hn-col { flex: 1; min-width: 0; }
.crv .hn-area { height: 120px; display: flex; flex-direction: column; justify-content: flex-end; }
.crv .hn-stack { background: var(--fb-accent); opacity: .85; border-radius: 4px 4px 0 0; display: flex; flex-direction: column; justify-content: flex-end; }
.crv .hn-found { background: var(--fb-good-text); border-radius: 4px 4px 0 0; }
.crv .hn-day { text-align: center; font-size: 0.68rem; color: var(--fb-muted); height: 18px; line-height: 18px; }
.crv .hn-goal { position: absolute; left: 0; right: 0; border-top: 2px dashed var(--fb-warning); pointer-events: none; }
.crv .hn-bounties { margin: 0; padding-left: 1.4em; font-size: 0.88rem; }
.crv .hn-bounties li { margin: 4px 0; }
.crv .hn-bounties a { color: var(--fb-link); font-weight: 600; }
.crv .hn-xp { display: inline-block; min-width: 3.6em; margin-right: 8px; padding: 0 6px; border-radius: 6px; font-size: 0.72rem; font-weight: 700; text-align: center; background: var(--fb-card-2); border: 1px solid var(--fb-accent); }
.crv .hn-badges { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.crv .hn-badge { border: 1px dashed var(--fb-line); border-radius: 10px; padding: 8px 10px; opacity: .5; font-size: 0.82rem; display: flex; flex-direction: column; gap: 2px; }
.crv .hn-badge span { color: var(--fb-muted); font-size: 0.74rem; }
.crv .hn-badge.is-got { opacity: 1; border: 1px solid var(--fb-good-text); background: var(--fb-card-2); }
.crv .hn-badge.is-got b::before { content: "★ "; color: var(--fb-warning); }
@media (max-width: 760px) { .crv .hn-hero { grid-template-columns: 1fr 1fr; } .crv .hn-level { grid-column: 1 / -1; } }
`;
