// The Creators page's Launch tab: a checklist per game, from six weeks before release to the week
// after, so every launch gets the same marketing push (store page, press kit, creators, streamers,
// press, trailer channels, short videos, Discord, the fan list...).
//
// The steps are listed here (STEPS); the server keeps only each game's launch date and the ticks
// (server/creators/launch.py, GET/POST /admin/launch). Steps with `auto` tick themselves from the
// Outreach tab: a campaign for the game to that audience that was approved (or has sent mail).
// With a launch date set, each phase shows its day and turns amber once it's past with steps left.

const DAY = 86400000;
const PHASES = [
  { key: "w6", title: "6 weeks before", offset: -42 },
  { key: "w3", title: "2–4 weeks before", offset: -21 },
  { key: "w1", title: "Launch week", offset: -7 },
  { key: "d0", title: "Launch day", offset: 0 },
  { key: "a7", title: "First week after", offset: 7 },
];
export const STEPS = [
  { key: "store-page", phase: "w6", title: "Store page ready", how: "Capsule art, trailer, screenshots and a short description that says what you do in the game. Check the tags with Tag check on the game's page." },
  { key: "localize", phase: "w6", title: "Store page in 30 languages", how: "/steam-localize" },
  { key: "press-kit", phase: "w6", title: "Press kit page up", how: "press.fourgames.se/<game>: trailer, screenshots, logo, a few facts. The emails link to it." },
  { key: "date-post", phase: "w6", title: "Release date announced", how: "/steam-post (release date post), and on Discord." },
  { key: "alias", phase: "w6", title: "The game's email address", how: "A Strato alias like game@fourgames.se on danny@, so replies land in your inbox." },
  { key: "creator-keys", phase: "w6", title: "Creator keys in the keybot", how: "A stock of keys for /request type:creator, so creators get one right away." },
  { key: "creators", phase: "w3", title: "Matched YouTubers emailed", how: "Outreach → New campaign → YouTubers, best fit for the game. Ticks itself once a campaign is approved.", auto: "creators" },
  { key: "streamers", phase: "w3", title: "Streamers emailed", how: "Outreach → New campaign → Streamers. Ticks itself once a campaign is approved.", auto: "streamers" },
  { key: "trailer-channels", phase: "w3", title: "Trailer sent to trailer channels", how: "The trailer channels on the Press tab: they're free to upload it, with the Steam link in the description." },
  { key: "shorts-pre", phase: "w3", title: "Short videos posted", how: "15–30 s clips of the best moment on TikTok, YouTube Shorts and Reels, with the release date." },
  { key: "press-release", phase: "w1", title: "Press release to the press list", how: "Outreach → New campaign → Press, the news and the date in one sentence. Ticks itself once a campaign is approved.", auto: "press" },
  { key: "final-build", phase: "w1", title: "Release build checked", how: "Played through once from a clean install, Steam Deck too." },
  { key: "broadcast", phase: "w1", title: "Trailer stream on the store page", how: "/steam-broadcast" },
  { key: "release", phase: "d0", title: "Released on Steam", how: "/steam-ship" },
  { key: "out-now-post", phase: "d0", title: "Out Now post", how: "/steam-post (Out Now)" },
  { key: "discord", phase: "d0", title: "Discord told", how: "An announcement with the Steam link and how to get a creator key." },
  { key: "newsletter", phase: "d0", title: "Fan mailing list emailed", how: "Once the fan list exists." },
  { key: "shorts-launch", phase: "d0", title: "Launch short video", how: "\"Out now\" clip on TikTok, Shorts and Reels." },
  { key: "replies", phase: "a7", title: "Replies and key requests answered", how: "The Outreach tab's replies and the keybot's requests." },
  { key: "videos", phase: "a7", title: "Videos found and thanked", how: "The Announcements and Media pages; thank each creator and share their video on Discord." },
  { key: "reviews", phase: "a7", title: "Reviews and refund notes read", how: "The game's page and /steam-scrape for the refund notes." },
  { key: "first-patch", phase: "a7", title: "First patch out", how: "/steam-ship with the fixes players asked for." },
];

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
const fmtDay = (t) => t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function launchView(ctx, d, redraw) {
  C = ctx;
  injectCss();
  const { h } = C;
  const wrap = h("div.lc");
  if (C.dataOverride) { wrap.append(h("p.empty", "The launch checklist needs the server (not available with ?data=).")); return wrap; }
  if (!ls.data && !ls.loading && !ls.error) load(redraw);
  if (!ls.data) { wrap.append(h("p.empty", ls.error || "Loading the launch checklist…")); return wrap; }

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

  const count = (id) => { const s = stepStates(saved[id], campaigns, id); return STEPS.filter((x) => s[x.key].done).length; };
  wrap.append(h("div.cr-row", h("span.cr-label", "Game"),
    C.chips(own.map(([id, n]) => [String(id), `${n} · ${count(id)}/${STEPS.length}`]), String(ls.game), (v) => { ls.game = Number(v); redraw(); }, "Game")));

  const appid = ls.game;
  const game = saved[appid] || { date: null, done: {} };
  const states = stepStates(game, campaigns, appid);
  const doneN = STEPS.filter((s) => states[s.key].done).length;

  const date = h("input.cr-input.lc-date", { type: "date", value: game.date || "", "aria-label": "Launch date", disabled: ls.busy || undefined });
  date.addEventListener("change", () => save({ appid, date: date.value || null }, redraw));
  const launchDay = game.date ? dayOf(game.date, 0) : null;
  const days = launchDay ? Math.round((launchDay - today) / DAY) : null;
  wrap.append(h("div.cr-filters.lc-head",
    h("div.cr-row", h("label.cr-select", h("span", "Launch date"), date),
      h("span.cr-muted", days == null ? "Set it to see when each part is due." : days > 0 ? `${C.plural(days, "day")} to go` : days === 0 ? "Launch day is today" : `Launched ${C.plural(-days, "day")} ago`),
      h("span.lc-count", `${doneN} of ${STEPS.length} done`)),
    h("div.lc-bar", h("div.lc-fill", { style: `width:${Math.round(doneN / STEPS.length * 100)}%` }))));
  if (ls.msg) wrap.append(h("p.cr-alert", ls.msg));

  for (const p of PHASES) {
    const steps = STEPS.filter((s) => s.phase === p.key);
    const left = steps.filter((s) => !states[s.key].done).length;
    const due = game.date ? dayOf(game.date, p.offset) : null;
    const late = due && left && due < today;
    wrap.append(h("section.lc-phase",
      h("div.lc-phead", h("b", p.title), due ? h("span", { class: `cr-muted${late ? " lc-late" : ""}` }, `${fmtDay(due)}${late ? ` · ${left} left` : ""}`) : null,
        h("span.cr-muted.lc-pcount", `${steps.length - left}/${steps.length}`)),
      ...steps.map((s) => {
        const st = states[s.key];
        const box = h("input", { type: "checkbox", checked: !!st.done || undefined, disabled: ls.busy || st.auto || undefined, "aria-label": s.title });
        box.addEventListener("change", () => save({ appid, item: s.key, done: box.checked }, redraw));
        return h("label", { class: `lc-step${st.done ? " is-done" : ""}` }, box,
          h("span.lc-text", h("span.lc-title", s.title),
            st.done ? h("span.cr-muted", st.auto ? ` · from an Outreach campaign, ${C.fmtDate(st.done)}` : ` · ${C.fmtDate(st.done)}`) : null,
            h("span.lc-how", s.how)));
      })));
  }
  wrap.append(h("details.about", h("summary", "How this works"),
    h("p", "One checklist per game, from six weeks before release to the week after. Tick each step when it's done; the date is saved with it. The emailing steps tick themselves once an Outreach campaign for the game to that audience is approved."),
    h("p", "Set the launch date and each part shows the day it's due, amber when it's past with steps left. The game with the next launch comes first.")));
  return wrap;
}

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const css = `
.lc .lc-head { padding-bottom: 12px; }
.lc .lc-date { flex: 0 0 auto; max-width: 12em; }
.lc .lc-count { margin-left: auto; font-weight: 600; color: var(--fb-ink-2); font-size: 0.9rem; }
.lc .lc-bar { height: 8px; border-radius: 999px; background: var(--fb-card-2); border: 1px solid var(--fb-line); overflow: hidden; }
.lc .lc-fill { height: 100%; background: var(--fb-positive); transition: width .2s; }
.lc .lc-phase { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 8px 12px; margin: 0 0 10px; }
.lc .lc-phead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 4px 0 6px; border-bottom: 1px solid var(--fb-line); }
.lc .lc-pcount { margin-left: auto; }
.lc .lc-late { color: var(--fb-warning); font-weight: 600; }
.lc .lc-step { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--fb-line); cursor: pointer; }
.lc .lc-step:last-child { border-bottom: 0; }
.lc .lc-step input { margin-top: 3px; width: 16px; height: 16px; flex: none; accent-color: var(--fb-positive); }
.lc .lc-text { min-width: 0; }
.lc .lc-title { font-weight: 600; }
.lc .lc-step.is-done .lc-title { color: var(--fb-muted); text-decoration: line-through; }
.lc .lc-how { display: block; color: var(--fb-muted); font-size: 0.82rem; margin-top: 1px; overflow-wrap: anywhere; }
`;
  document.head.append(C.h("style", css));
}
