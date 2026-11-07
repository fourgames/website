// The Creators page's Launch tab: a short list per game of the few things that sell a launch
// (creators, streamers, press, trailer channels, the Steam posts), so none is forgotten. The next
// step is shown on its own with how to do it; the rest is one compact list.
//
// The steps are listed here (STEPS); the server keeps only each game's launch date and the ticks
// (server/creators/launch.py, GET/POST /admin/launch). Steps with `auto` tick themselves from the
// Outreach tab: a campaign for the game to that audience that was approved (or has sent mail).

const DAY = 86400000;
export const STEPS = [
  { key: "press-kit", when: -42, title: "Press kit page up", how: "press.fourgames.se/<game>: trailer, screenshots, logo. Every email links to it." },
  { key: "date-post", when: -28, title: "Release date post", how: "/steam-post (release date), and say it on Discord." },
  { key: "creators", when: -21, title: "YouTubers emailed", how: "Outreach → New campaign → YouTubers. Ticks itself once you approve it.", auto: "creators" },
  { key: "streamers", when: -21, title: "Streamers emailed", how: "Outreach → New campaign → Streamers. Ticks itself once you approve it.", auto: "streamers" },
  { key: "press-release", when: -7, title: "Press emailed", how: "Outreach → New campaign → Press: the news and the date in one sentence. Ticks itself once you approve it.", auto: "press" },
  { key: "trailer-channels", when: -7, title: "Trailer offered to trailer channels", how: "The trailer channels on the Press tab: they're free to upload it, with the Steam link." },
  { key: "out-now", when: 0, title: "Out Now post and Discord", how: "/steam-ship, then /steam-post (Out Now) and a Discord announcement." },
  { key: "thank", when: 7, title: "Thank the creators who made videos", how: "Reply to each and share their video on Discord. It makes them want to cover your next game." },
];
const whenText = (w) => w === 0 ? "launch day" : w < 0 ? (w <= -14 ? `${-w / 7} weeks before` : "1 week before") : "week after";

let C = null;
const ls = { data: null, outreach: null, error: null, loading: false, game: null, busy: false, msg: null };

async function load(redraw) {
  if (ls.loading) return;
  ls.loading = true;
  try {
    const [launch, outreach] = await Promise.all([C.adminGet("launch"), C.adminGet("outreach").catch(() => null)]);
    ls.data = await launch.json();
    ls.outreach = outreach ? await outreach.json() : null;
    ls.error = null;
  } catch (e) {
    if (!e.signedOut) ls.error = `Couldn't load the launch checklist: ${e.message}`;
  } finally {
    ls.loading = false;
  }
  redraw();
}

async function save(body, redraw) {
  ls.busy = true; ls.msg = null;
  try {
    ls.data = await (await C.adminSend("launch", "POST", body, 30000)).json();
  } catch (e) {
    if (!e.signedOut) ls.msg = e.message;
  } finally {
    ls.busy = false;
    redraw();
  }
}

// Campaigns for this game to this audience that were approved or have sent mail.
export function autoDone(campaigns, appid, audience) {
  const hits = (campaigns || []).filter(({ campaign: c, counts: n }) => c.appid === appid && c.audience === audience
    && (c.status === "approved" || c.status === "done" || (n.sent || 0) + (n.replied || 0) + (n.opted_out || 0) + (n.bounced || 0) > 0));
  return hits.length ? Math.min(...hits.map(({ campaign: c }) => c.approved_at || c.created_at)) : null;
}

// Each step's state for a game: { done (time or null), auto (true if from a campaign) }.
export function stepStates(game, campaigns, appid) {
  const out = {};
  for (const s of STEPS) {
    const manual = game?.done?.[s.key] || null;
    const auto = s.auto ? autoDone(campaigns, appid, s.auto) : null;
    out[s.key] = { done: manual || auto, auto: !manual && !!auto };
  }
  return out;
}

const dayOf = (date, offset) => { const [y, m, d] = date.split("-").map(Number); return new Date(y, m - 1, d + offset); };
const fmtDay = (t) => t.toLocaleDateString(undefined, { day: "numeric", month: "short" });

export function launchView(ctx, d, redraw) {
  C = ctx;
  injectCss();
  const { h } = C;
  const wrap = h("div.lc");
  if (C.dataOverride) { wrap.append(h("p.empty", "The launch list needs the server (not available with ?data=).")); return wrap; }
  if (!ls.data && !ls.loading && !ls.error) load(redraw);
  if (!ls.data) { wrap.append(h("p.empty", ls.error || "Loading…")); return wrap; }

  const saved = ls.data.games || {};
  const campaigns = ls.outreach?.campaigns || [];
  const own = Object.entries(d.games).filter(([, g]) => g.own).map(([id, g]) => [Number(id), g.n]);
  for (const id of Object.keys(saved)) if (!own.some(([a]) => a === Number(id))) own.push([Number(id), `App ${id}`]);
  if (!own.length) { wrap.append(h("p.empty", "None of our games is in the Steam data yet.")); return wrap; }
  // Nearest upcoming launch first, then games with a date, then the rest by name.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rank = ([id]) => { const dt = saved[id]?.date; if (!dt) return 3e15; const t = dayOf(dt, 0).getTime(); return t >= today.getTime() - 7 * DAY ? t : 2e15 - t; };
  own.sort((a, b) => rank(a) - rank(b) || a[1].localeCompare(b[1]));
  if (!ls.game || !own.some(([a]) => a === ls.game)) ls.game = own[0][0];

  wrap.append(h("div.cr-row", h("span.cr-label", "Game"),
    C.chips(own.map(([id, n]) => [String(id), n]), String(ls.game), (v) => { ls.game = Number(v); redraw(); }, "Game")));

  const appid = ls.game;
  const game = saved[appid] || { date: null, done: {} };
  const states = stepStates(game, campaigns, appid);
  const doneN = STEPS.filter((s) => states[s.key].done).length;
  const tick = (s, done) => save({ appid, item: s.key, done }, redraw);

  const date = h("input.cr-input.lc-date", { type: "date", value: game.date || "", "aria-label": "Launch date", disabled: ls.busy || undefined });
  date.addEventListener("change", () => save({ appid, date: date.value || null }, redraw));
  const days = game.date ? Math.round((dayOf(game.date, 0) - today) / DAY) : null;
  wrap.append(h("div.cr-row.lc-top", h("label.cr-select", h("span", "Launch"), date),
    h("span.cr-muted", days == null ? "" : days > 0 ? `in ${C.plural(days, "day")}` : days === 0 ? "today" : `${C.plural(-days, "day")} ago`),
    h("span.lc-count", `${doneN}/${STEPS.length} done`)));
  if (ls.msg) wrap.append(h("p.cr-alert", ls.msg));

  const next = STEPS.find((s) => !states[s.key].done);
  const due = (s) => game.date ? fmtDay(dayOf(game.date, s.when)) : whenText(s.when);
  wrap.append(next
    ? h("div.lc-next", h("div.cr-muted", `Next · ${due(next)}`), h("div.lc-next-t", next.title), h("div.lc-how", next.how),
        next.auto ? null : h("button.btn.primary", { type: "button", disabled: ls.busy || undefined, onclick: () => tick(next, true) }, "Done"))
    : h("div.lc-next", h("div.lc-next-t", "All done for this launch 🎉")));

  wrap.append(h("div.lc-list", ...STEPS.map((s) => {
    const st = states[s.key];
    const box = h("input", { type: "checkbox", checked: !!st.done || undefined, disabled: ls.busy || st.auto || undefined, "aria-label": s.title });
    box.addEventListener("change", () => tick(s, box.checked));
    return h("label", { class: `lc-step${st.done ? " is-done" : ""}${s === next ? " is-next" : ""}`, title: s.how }, box,
      h("span.lc-title", s.title), h("span.cr-muted.lc-when", st.auto ? "from Outreach" : due(s)));
  })));
  return wrap;
}

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const css = `
.lc { max-width: 640px; }
.lc .lc-top { margin-bottom: 12px; }
.lc .lc-date { flex: 0 0 auto; max-width: 11em; }
.lc .lc-count { margin-left: auto; font-weight: 600; color: var(--fb-ink-2); }
.lc .lc-next { background: var(--fb-card); border: 1px solid var(--fb-accent); border-radius: 12px; padding: 14px 16px; margin: 0 0 12px; }
.lc .lc-next-t { font-size: 1.15rem; font-weight: 700; color: var(--fb-title); margin: 2px 0 4px; }
.lc .lc-next .btn { margin-top: 10px; }
.lc .lc-how { color: var(--fb-ink-2); overflow-wrap: anywhere; }
.lc .lc-list { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 2px 14px; }
.lc .lc-step { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--fb-line); cursor: pointer; }
.lc .lc-step:last-child { border-bottom: 0; }
.lc .lc-step input { width: 16px; height: 16px; flex: none; margin: 0; accent-color: var(--fb-positive); }
.lc .lc-title { flex: 1; min-width: 0; }
.lc .lc-step.is-next .lc-title { font-weight: 700; }
.lc .lc-step.is-done .lc-title { color: var(--fb-muted); text-decoration: line-through; }
.lc .lc-when { white-space: nowrap; }
`;
  document.head.append(C.h("style", css));
}
