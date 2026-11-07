// The dashboard's Creators page: every YouTube creator the server found making videos of Steam games
// (server/creators), with their emails and where each came from, how active they are, what kind of
// channel they are, and, for one of our games, who fits it best.
//
// The data is one file, server/creators/export.py's creators.json.gz, read through the game-data
// server's admin API (signed in as the owner only; it holds creators' emails). Everything else is
// worked out here in the browser:
//   - Active: from the channel's newest upload of any kind (lu; the collector reads it every 14 days),
//     or, until that's read, its newest video of a game we searched (lv).
//   - Type (the server's cat): indie variety = 4+ games, mostly small ones (median under 5,000 reviews);
//     variety = 4+ games; one game = one game in 3+ videos; a few games = the rest.
//   - Genres (p): the Steam tags of the games they covered, weighted by videos, generic tags left out.
//   - Fit for a game: how much their genres overlap the game's tags (its first tags count most), times
//     how active they are and a size factor (1k-300k subscribers is the sweet spot for a small studio:
//     big enough to sell, small enough to answer), a little more for indie-variety channels. Anyone
//     who already made a video of that game goes first.
//
// Contract (like market-merged.js): creatorsTop(ctx) fills the header, creatorsView(ctx) returns one
// root that redraws itself. ctx = the dashboard's helpers (h, chips, adminGet, copy, fmtNum, plural...).

const DAY = 86400;
const PAGE = 100;
const SIZES = [["all", "Any size"], ["s0", "Under 1k"], ["s1", "1k–10k"], ["s2", "10k–100k"], ["s3", "100k–1M"], ["s4", "1M+"]];
const SIZE_RANGE = { s0: [0, 1e3], s1: [1e3, 1e4], s2: [1e4, 1e5], s3: [1e5, 1e6], s4: [1e6, Infinity] };
const TYPES = { "indie-variety": "Indie variety", variety: "Variety", "one-game": "One game", "few-games": "A few games" };
const TYPE_HELP = {
  "indie-variety": "Plays lots of different games, mostly small ones",
  variety: "Plays lots of different games, often big ones",
  "one-game": "Mostly one game",
  "few-games": "Only a few of the games we searched so far",
};
const SOURCES = { youtube: "on their YouTube channel (on our list)", description: "in their channel description", links: "on a page they link to (Linktree, website)", revealed: "behind YouTube's View email button" };
const LANGS = { en: "English", ru: "Russian", de: "German", fr: "French", pt: "Portuguese", es: "Spanish", ja: "Japanese", tr: "Turkish", it: "Italian", pl: "Polish", ko: "Korean", zh: "Chinese", nl: "Dutch", sv: "Swedish", uk: "Ukrainian", ar: "Arabic", id: "Indonesian", vi: "Vietnamese", th: "Thai", cs: "Czech", hu: "Hungarian", fi: "Finnish", da: "Danish", no: "Norwegian", ro: "Romanian", el: "Greek", he: "Hebrew", hi: "Hindi" };

import { huntStrip, HUNT_CSS } from "./creators-hunt.js";
import { launchView } from "./launch.js";
import { eventsView } from "./events.js";
import { newsBadge } from "./news.js";

let C = null;
const st = { view: "creators", pf: { q: "", kind: "all", lang: "all", country: "all", reach: "all", email: "any" }, pshown: PAGE, data: null, error: null, loading: false, root: null, f: { q: "", email: "any", active: "all", size: "all", type: "all", lang: "all", genre: "all", game: "all", sort: "best" }, shown: PAGE, open: new Set() };

const now = () => Math.floor(Date.now() / 1000);
const num = (n) => (n == null ? "–" : C.fmtNum(n));
const subs = (n) => n == null ? "hidden" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);
const ago = (t) => { if (!t) return "–"; const d = Math.floor((now() - t) / DAY); return d < 1 ? "today" : d < 60 ? `${d} d ago` : d < 730 ? `${Math.round(d / 30)} mo ago` : `${Math.round(d / 365)} y ago`; };

// Newest upload (or newest video we found, until that's read) and what it says.
export function lastActive(c) { return c.lu || c.lv || null; }
export function activity(c, today = now()) {
  const t = lastActive(c);
  if (!t) return "unknown";
  const d = (today - t) / DAY;
  return d <= 30 ? "active" : d <= 90 ? "quiet" : "inactive";
}
export function sizeFactor(s) {
  if (s == null) return 0.5;
  return s < 500 ? 0.4 : s < 1000 ? 0.65 : s <= 300000 ? 1 : s <= 1e6 ? 0.75 : 0.5;
}
const ACTIVE_FACTOR = { active: 1, quiet: 0.6, inactive: 0.15, unknown: 0.5 };

// A game's tags as weights: its first (non-generic) tags count most.
export function gameWeights(game, meta) {
  const w = new Map();
  (game?.t || []).filter((t) => !meta.has(t)).forEach((t, i) => w.set(t, Math.max(0.2, 1 - i / 8)));
  return w;
}
// How well a creator fits a game: { score, base, genre, played }. Higher is better; anyone who already
// made a video of the game is above everyone else (base stays under 2).
export function fit(c, appid, weights, today = now()) {
  const played = c.g.some((g) => g[0] === appid);
  let genre = 0;
  for (const [t, pw] of c.p) genre += pw * (weights.get(t) || 0);
  const base = Math.pow(Math.min(1, genre), 0.8) * ACTIVE_FACTOR[activity(c, today)] * sizeFactor(c.s) * (c.cat === "indie-variety" ? 1.15 : 1);
  return { score: base + (played ? 2 : 0), base, genre, played };
}

export function filterCreators(list, f, data, today = now()) {
  const q = f.q.trim().toLowerCase();
  const genre = f.genre === "all" ? null : Number(f.genre);
  return list.filter((c) => {
    if (q && !`${c.t || ""} ${c.h || ""} ${c.e.map((e) => e[0]).join(" ")} ${c.g.map((g) => data.games[g[0]]?.n || "").join(" ")}`.toLowerCase().includes(q)) return false;
    if (f.email === "yes" && !c.e.length) return false;
    if (f.email === "no" && c.e.length) return false;
    if (f.email === "hidden" && (c.e.length || c.b !== 1)) return false;
    if (f.active !== "all" && activity(c, today) !== f.active) return false;
    if (f.size !== "all") { const [lo, hi] = SIZE_RANGE[f.size]; if (c.s == null || c.s < lo || c.s >= hi) return false; }
    if (f.type !== "all" && c.cat !== f.type) return false;
    if (f.lang !== "all" && (c.l || "?") !== f.lang) return false;
    if (genre != null && !c.p.slice(0, 4).some(([t]) => t === genre)) return false;
    return true;
  });
}

async function load() {
  if (st.loading) return;
  st.loading = true;
  st.error = null;
  try {
    const res = C.dataOverride
      ? await fetch(`${C.dataOverride}/creators.json`, { cache: "no-store" })
      : await C.adminGet("creators");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    st.data = await res.json();
    st.data.metaSet = new Set(st.data.meta || []);
    st.data.streamers ||= [];
    for (const c of [...st.data.creators, ...st.data.streamers]) { c.e ||= []; c.g ||= []; c.p ||= []; c.k ||= {}; }
  } catch (e) {
    if (e.signedOut) return;
    st.error = /not_built|404/.test(e.message) ? "The creator list isn't built yet: the server writes it after its next hourly run." : `Couldn't load the creator list: ${e.message}`;
  } finally {
    st.loading = false;
  }
  creatorsTop(C);
  draw();
}

export function creatorsTop(ctx) {
  C = ctx;
  const set = (id, ...kids) => { const el = document.getElementById(id); if (el) el.replaceChildren(...kids); };
  const cap = document.getElementById("fb-capsule"); if (cap) cap.hidden = true;
  set("fb-title", "Creators");
  const d = st.data;
  set("fb-updated", d ? `${C.plural(d.creators.length, "YouTube creator")} and ${C.plural((d.streamers || []).length, "Twitch streamer")} who covered the ${num(d.searched)} Steam games searched so far · updated ${C.fmtDateTime(d.generated)}` : "YouTube creators who make videos of Steam games, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) set(id);
}

export function creatorsView(ctx) {
  C = ctx;
  injectCss();
  st.root ??= C.h("div.crv");
  if (!st.data && !st.loading && !st.error) load();
  draw();
  return st.root;
}

function draw() {
  const { h } = C;
  const root = st.root;
  if (!root) return;
  if (!st.data) {
    root.replaceChildren(h("p.empty", st.error || "Loading the creator list…"));
    return;
  }
  const d = st.data;
  const switcher = h("div.cr-row.cr-switch", C.chips([["creators", `YouTube creators (${num(d.creators.length)})`], ["twitch", `Twitch streamers (${num(d.streamers.length)})`], ["press", `Press & trailers (${num((d.press || []).length)})`], ["outreach", "Outreach"], ["launch", "Launch checklist"], ["events", "Events & awards"]],
    st.view, (v) => { st.view = v; draw(); }, "Show"), newsBadge(C));
  if (st.view === "press") {
    root.replaceChildren(switcher, pressView(d));
    return;
  }
  if (st.view === "outreach") {
    root.replaceChildren(switcher, outreachView(d));
    return;
  }
  if (st.view === "events") {
    root.replaceChildren(switcher, eventsView(C, d, draw));
    return;
  }
  if (st.view === "launch") {
    root.replaceChildren(switcher, launchView(C, d, draw));
    return;
  }
  const today = now();
  // Twitch streamers come in the same shape as YouTube creators (export.py), so one view shows both.
  const tw = st.view === "twitch";
  const all = tw ? d.streamers : d.creators;
  const who = tw ? "streamer" : "creator";
  const ownGames = Object.entries(d.games).filter(([, g]) => g.own).map(([id, g]) => [Number(id), g]).sort((a, b) => a[1].n.localeCompare(b[1].n));
  const gameId = st.f.game === "all" ? null : Number(st.f.game);
  const weights = gameId ? gameWeights(d.games[gameId], d.metaSet) : null;

  // Summary cards.
  const withEmail = all.filter((c) => c.e.length);
  const bySource = (s) => all.filter((c) => c.e.some((e) => e[1] === s)).length;
  const card = (label, value, sub, onclick) => h(onclick ? "button.cr-card.is-link" : "div.cr-card", onclick ? { type: "button", onclick } : null,
    h("div.cr-card-v", value), h("div.cr-card-l", label), sub ? h("div.cr-card-s", sub) : null);
  const setF = (patch) => { Object.assign(st.f, patch); st.shown = PAGE; draw(); };
  const cards = h("div.cr-cards",
    card(tw ? "Streamers" : "Creators", num(all.length), `${num(all.filter((c) => c.own).length)} ${tw ? "streamed" : "made a video of"} our games`),
    card("With an email", num(withEmail.length), tw ? `${num(bySource("description"))} description · ${num(bySource("youtube"))} from their YouTube` : `${num(bySource("description"))} description · ${num(bySource("links"))} links · ${num(bySource("revealed"))} revealed`, () => setF({ email: "yes" })),
    tw ? card("Also on YouTube", num(all.filter((c) => c.yt).length), "their YouTube channel is on our list")
      : card("Hidden email only", num(all.filter((c) => !c.e.length && c.b === 1).length), "behind YouTube's captcha button", () => setF({ email: "hidden" })),
    card("Active", num(all.filter((c) => activity(c, today) === "active").length), tw ? "streamed a searched game in 30 days" : "uploaded in the last 30 days", () => setF({ active: "active" })));

  // Best for one of our games.
  const gamePick = h("div.cr-row", h("span.cr-label", "Best for"),
    C.chips([["all", "No game (everyone)"], ...ownGames.map(([id, g]) => [String(id), g.n])], st.f.game, (v) => setF({ game: v, sort: v === "all" ? (st.f.sort === "fit" ? "best" : st.f.sort) : "fit" }), "Best creators for a game"));

  // Filters.
  const langs = Object.entries(all.reduce((m, c) => { const l = c.l || "?"; m[l] = (m[l] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const genres = Object.entries(all.reduce((m, c) => { for (const [t] of c.p.slice(0, 3)) m[t] = (m[t] || 0) + 1; return m; }, {}))
    .filter(([t]) => d.tags[t]).sort((a, b) => b[1] - a[1]).slice(0, 60);
  const select = (label, value, options, key) => h("label.cr-select", h("span", label),
    h("select", { onchange: (e) => setF({ [key]: e.currentTarget.value }) }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
  const search = h("input.cr-input", { type: "search", placeholder: "Search name, email or game", value: st.f.q, "aria-label": "Search creators" });
  search.addEventListener("input", () => { st.f.q = search.value; st.shown = PAGE; drawList(); });
  const filters = h("div.cr-filters",
    h("div.cr-row", search,
      select("Email", st.f.email, [["any", "Any"], ["yes", "Has an email"], ["no", "No email yet"], ["hidden", "Hidden email only"]], "email"),
      select("Active", st.f.active, [["all", "Any"], ["active", "Active (30 days)"], ["quiet", "Quiet (30–90 days)"], ["inactive", "Inactive (90+ days)"], ["unknown", "Not known yet"]], "active"),
      select("Language", st.f.lang, [["all", "Any"], ...langs.map(([l, n]) => [l, `${LANGS[l] || (l === "?" ? "Not set" : l.toUpperCase())} (${n})`])], "lang"),
      select("Genre", st.f.genre, [["all", "Any"], ...genres.map(([t, n]) => [t, `${d.tags[t]} (${n})`])], "genre"),
      select("Sort", st.f.sort, [...(gameId ? [["fit", "Best fit for the game"]] : []), ["best", "Best overall"], ["subs", "Most subscribers"], ["active", "Newest upload"], ["games", "Most games"], ["new", "Newest found"]], "sort")),
    h("div.cr-row", C.chips(SIZES, st.f.size, (v) => setF({ size: v }), "Size"),
      C.chips([["all", "Any type"], ...Object.entries(TYPES)], st.f.type, (v) => setF({ type: v }), "Type")));

  const list = h("div.cr-list");
  function drawList() {
    let rows = filterCreators(all, st.f, d, today);
    const scored = new Map();
    if (gameId) for (const c of rows) scored.set(c.id, fit(c, gameId, weights, today));
    const overall = (c) => ACTIVE_FACTOR[activity(c, today)] * sizeFactor(c.s) * (c.e.length ? 1.3 : 1) * (1 + Math.min(c.g.length, 10) / 10) * (c.own ? 2 : 1);
    const key = {
      fit: (c) => scored.get(c.id)?.score || 0,
      best: overall,
      subs: (c) => c.s || 0,
      active: (c) => lastActive(c) || 0,
      games: (c) => c.g.length,
      new: (c) => c.first || 0,
    }[st.f.sort] || overall;
    rows = rows.map((c) => [key(c), c]).sort((a, b) => b[0] - a[0]).map(([, c]) => c);
    const top = gameId ? Math.max(...rows.map((c) => scored.get(c.id).base), 0.0001) : 1;
    const shown = rows.slice(0, st.shown);
    const emails = rows.filter((c) => c.e.length);
    const head = h("div.cr-listhead",
      h("span", `${C.plural(rows.length, who)}${rows.length !== all.length ? ` of ${num(all.length)}` : ""}, ${num(emails.length)} with an email`),
      h("button.btn", { type: "button", disabled: !emails.length, title: "One email per creator, the first found, one per line", onclick: (e) => C.copy(emails.map((c) => c.e[0][0]).join("\n"), e.currentTarget) }, `Copy ${C.plural(emails.length, "email")}`));
    const table = h("table.cr-table",
      h("thead", h("tr", ...(gameId ? [h("th.cr-num", "Fit")] : []), h("th", "Channel"), h("th.cr-num", tw ? "Followers" : "Subs"), h("th", "Lang"), h("th", tw ? "Last stream" : "Last upload"),
        h("th", "Games"), h("th", "Type"), h("th", "Genres"), h("th", "Email"))),
      h("tbody", ...shown.flatMap((c) => row(c, gameId ? scored.get(c.id) : null, top, today))));
    const more = rows.length > st.shown ? h("button.btn.cr-more", { type: "button", onclick: () => { st.shown += PAGE; drawList(); } }, `Show ${Math.min(PAGE, rows.length - st.shown)} more`) : null;
    list.replaceChildren(head, rows.length ? h("div.cr-scroll", table) : h("p.empty", `No ${who}s match these filters.`), more);
  }

  function row(c, f, top, today) {
    const open = st.open.has(c.id);
    const toggle = () => { open ? st.open.delete(c.id) : st.open.add(c.id); drawList(); };
    const act = activity(c, today);
    const games = c.g.map((g) => d.games[g[0]]?.n || `App ${g[0]}`);
    const url = c.pl === "tw" ? `https://www.twitch.tv/${c.h}` : c.h ? `https://www.youtube.com/${c.h}` : `https://www.youtube.com/channel/${c.id}`;
    const email = c.e.length
      ? h("span.cr-email", h("a", { href: `mailto:${c.e[0][0]}`, title: `Found ${SOURCES[c.e[0][1]] || c.e[0][1]}` }, c.e[0][0]),
          c.e.length > 1 ? h("span.cr-muted", ` +${c.e.length - 1}`) : null,
          h("button.cr-copy", { type: "button", title: "Copy", onclick: (e) => { e.stopPropagation(); C.copy(c.e[0][0], e.currentTarget); } }, "Copy"))
      : c.b === 1 ? h("span.cr-muted", { title: "Has a business email behind YouTube's View email address button (needs a captcha)" }, "hidden")
      : h("span.cr-muted", "–");
    const main = h("tr.cr-main", { class: open ? "is-open" : null, onclick: toggle },
      ...(f ? [h("td.cr-num", h("span.cr-fit", { title: f.played ? "Already made a video of this game" : `Genre overlap ${Math.round(f.genre * 100)}%` }, f.played ? "played" : Math.round(f.base / top * 100)))] : []),
      h("td.cr-chan", h("a", { href: url, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() }, c.t || c.id),
        c.own ? h("span.cr-badge", { title: tw ? "Streamed one of our games" : "Made a video of one of our games" }, "ours") : null,
        c.pk ? h("span.cr-badge", { title: "Twitch partner or affiliate" }, c.pk) : null,
        c.h ? h("div.cr-muted", c.h) : null),
      h("td.cr-num", subs(c.s)),
      h("td", { title: LANGS[c.l] || "" }, (c.l || "–").toUpperCase(), c.c ? h("span.cr-muted", ` ${c.c}`) : null),
      h("td", h("span.cr-act", { class: `is-${act}`, title: tw ? "Newest broadcast of a game we searched" : c.lu ? "Newest upload of any kind" : c.lv ? "Newest video of a game we searched (the newest upload isn't read yet)" : "" }, ago(lastActive(c)))),
      h("td.cr-gamescol", { title: games.join(", ") }, h("b", c.g.length), " ", h("span.cr-muted", games.slice(0, 2).join(", "))),
      h("td", h("span.cr-type", { title: TYPE_HELP[c.cat] }, TYPES[c.cat] || c.cat)),
      h("td.cr-genres", c.p.slice(0, 3).map(([t]) => d.tags[t]).filter(Boolean).join(", ")),
      h("td", email));
    if (!open) return [main];
    const cols = (f ? 1 : 0) + 8;
    const links = Object.entries(c.k).map(([k, v]) => {
      const href = { youtube: `https://www.youtube.com/${v}`, twitch: `https://twitch.tv/${v}`, x: `https://x.com/${v}`, instagram: `https://instagram.com/${v}`, tiktok: `https://tiktok.com/@${v}`, discord: `https://discord.gg/${v}` }[k];
      return href ? h("a", { href, target: "_blank", rel: "noopener" }, k === "x" ? "X" : k[0].toUpperCase() + k.slice(1)) : null;
    }).filter(Boolean);
    const detail = h("tr.cr-detail", h("td", { colspan: cols },
      h("div.cr-detailgrid",
        h("div", h("div.cr-dh", "Emails"), c.e.length ? h("ul", ...c.e.map(([e, s]) => h("li", h("a", { href: `mailto:${e}` }, e), h("span.cr-muted", ` ${SOURCES[s] || s}`)))) : h("p.cr-muted", c.b === 1 ? "None public. There's one behind YouTube's View email address button (the creator-emails skill, with a captcha)." : c.b === 0 ? "None found, and no hidden one on YouTube." : "None found yet.")),
        h("div", h("div.cr-dh", "Channel"), tw
          ? h("p", `${subs(c.s)} followers · ${C.plural(c.n || 0, "broadcast")} of searched games`, h("br"),
            `Newest broadcast: ${ago(c.lu)} · ${C.plural(c.v30 || 0, "broadcast")} in 30 days`)
          : h("p", `${subs(c.s)} subscribers · ${num(c.n)} videos`, h("br"),
          `Newest upload: ${c.lu ? ago(c.lu) : "not read yet"} · ${C.plural(c.v30 || 0, "video")} of searched games in 30 days`),
          links.length ? h("p", "Also on ", ...links.flatMap((a, i) => [i ? " · " : null, a])) : null),
        h("div", h("div.cr-dh", `Games (${c.g.length})`), h("ul.cr-games", ...c.g.slice(0, 12).map(([id, n, last, views]) =>
          h("li", h("a", { href: `https://store.steampowered.com/app/${id}/`, target: "_blank", rel: "noopener" }, d.games[id]?.n || `App ${id}`), d.games[id]?.own ? h("span.cr-badge", "ours") : null,
            h("span.cr-muted", ` ${C.plural(n, tw ? "broadcast" : "video")}, ${num(views)} views, ${ago(last)}`))), c.g.length > 12 ? h("li.cr-muted", `and ${c.g.length - 12} more`) : null)),
        h("div", h("div.cr-dh", "Genres"), h("p", c.p.map(([t, w]) => `${d.tags[t] || t} ${Math.round(w * 100)}%`).join(" · ") || "–")))));
    return [main, detail];
  }

  // Collecting: YouTube's daily units, so a still number reads as "limit reached", not "broken".
  const q = d.quota;
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const resetAt = q ? clock(q.reset) : "";
  const collecting = tw ? h("p.cr-note.cr-quota.is-ok", "Twitch is read every hour: each game's past broadcasts this month and who's live in it now (ours every week, other games every 30 days). Twitch keeps broadcasts for 7 to 60 days, so the list grows with each pass.")
    : q ? h(q.exhausted ? "p.cr-note.cr-quota" : "p.cr-note.cr-quota.is-ok",
    q.exhausted
      ? `Collecting paused: today's YouTube limit is used (${num(q.spent)} of ${num(q.limit)} units). New creators again after ${resetAt}.`
      : `Collecting: ${num(q.spent)} of ${num(q.limit)} YouTube units used today, spread over the day (resets at ${resetAt}).`,
    d.generated ? ` Last run ${clock(d.generated)}.` : "") : null;

  drawList();
  root.replaceChildren(switcher, tw ? null : huntStrip(d, C), cards, collecting, gamePick, filters, list,
    h("details.about", h("summary", "How this works"),
      h("p", "The server searches YouTube every hour for videos of Steam games (ours every week, then games with 30 to 50,000 reviews, those like ours first) and keeps the channels that made them. Emails come from the channel description, from pages they link to (Linktree, their website; the server follows those), or from YouTube's hidden View email button, which needs a captcha (the creator-emails skill)."),
      h("p", "Last upload is the channel's newest upload of any kind, read every 14 days. Type comes from the games they covered: indie variety plays 4+ different, mostly small games; one game is mostly one title. Genres are the Steam tags of those games."),
      h("p", "Best for a game ranks creators by how much their genres overlap the game's tags (its first tags count most), how active they are, and size: 1k–300k subscribers is the sweet spot for a small studio. Anyone who already made a video of the game is first. Contact status (emailed, replied, made a video) comes with sending: for 60 days after an email, the server looks at the creator's new uploads every 3 days for videos of the game.")));
}

// Press, aggregators and trailer channels (server/creators/press.py), worldwide.
const KINDS = { press: "Press", aggregator: "Aggregator", "trailer-channel": "Trailer channel" };
const COUNTRY_NAMES = { INT: "International", US: "USA", GB: "UK", CA: "Canada", AU: "Australia", JP: "Japan", KR: "Korea", CN: "China", TW: "Taiwan", HK: "Hong Kong", DE: "Germany", AT: "Austria", CH: "Switzerland", FR: "France", BE: "Belgium", ES: "Spain", IT: "Italy", PL: "Poland", NL: "Netherlands", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", CZ: "Czechia", PT: "Portugal", BR: "Brazil", MX: "Mexico", AR: "Argentina", CL: "Chile", CO: "Colombia", RU: "Russia", UA: "Ukraine", TR: "Turkey", SA: "Saudi Arabia", AE: "UAE", EG: "Egypt", TH: "Thailand", VN: "Vietnam", ID: "Indonesia", PH: "Philippines", MY: "Malaysia", SG: "Singapore", IN: "India" };
export function filterPress(list, f) {
  const q = f.q.trim().toLowerCase();
  return list.filter((p) => {
    if (q && !`${p.name} ${p.url} ${p.email || ""} ${p.notes || ""} ${p.focus || ""}`.toLowerCase().includes(q)) return false;
    if (f.kind !== "all" && p.kind !== f.kind) return false;
    if (f.lang !== "all" && (p.language || "?") !== f.lang) return false;
    if (f.country !== "all" && (p.country || "?") !== f.country) return false;
    if (f.reach !== "all" && p.reach !== f.reach) return false;
    if (f.email === "yes" && !p.email) return false;
    if (f.email === "form" && p.email) return false;
    return true;
  });
}

function pressView(d) {
  const { h } = C;
  const all = d.press || [];
  const wrap = h("div");
  if (!all.length) {
    wrap.append(h("p.empty", "No press list yet: it's imported on the server with python -m creators.press import."));
    return wrap;
  }
  const setP = (patch) => { Object.assign(st.pf, patch); st.pshown = PAGE; draw(); };
  const count = (fn) => all.filter(fn).length;
  const card = (label, value, sub, onclick) => h(onclick ? "button.cr-card.is-link" : "div.cr-card", onclick ? { type: "button", onclick } : null,
    h("div.cr-card-v", value), h("div.cr-card-l", label), sub ? h("div.cr-card-s", sub) : null);
  const countries = new Set(all.map((p) => p.country).filter(Boolean));
  const langs = Object.entries(all.reduce((m, p) => { const l = p.language || "?"; m[l] = (m[l] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const byCountry = Object.entries(all.reduce((m, p) => { const c = p.country || "?"; m[c] = (m[c] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const cards = h("div.cr-cards",
    card("Outlets", num(all.length), `${num(countries.size)} countries, ${num(langs.length)} languages`),
    card("Press", num(count((p) => p.kind === "press")), `${num(count((p) => p.kind === "press" && p.focus === "indie"))} indie-focused`, () => setP({ kind: "press" })),
    card("Trailer channels", num(count((p) => p.kind === "trailer-channel")), "post trailers and showcases", () => setP({ kind: "trailer-channel" })),
    card("With an email", num(count((p) => p.email)), `${num(count((p) => !p.email))} by contact form only`, () => setP({ email: "yes" })));
  const select = (label, value, options, k) => h("label.cr-select", h("span", label),
    h("select", { onchange: (e) => setP({ [k]: e.currentTarget.value }) }, ...options.map(([v, text]) => h("option", { value: v, selected: v === value }, text))));
  const search = h("input.cr-input", { type: "search", placeholder: "Search outlet, email or notes", value: st.pf.q, "aria-label": "Search outlets" });
  search.addEventListener("input", () => { st.pf.q = search.value; st.pshown = PAGE; drawList(); });
  const filters = h("div.cr-filters",
    h("div.cr-row", search,
      select("Country", st.pf.country, [["all", "Any"], ...byCountry.map(([c, n]) => [c, `${COUNTRY_NAMES[c] || c} (${n})`])], "country"),
      select("Language", st.pf.lang, [["all", "Any"], ...langs.map(([l, n]) => [l, `${LANGS[l] || l.toUpperCase()} (${n})`])], "lang"),
      select("Contact", st.pf.email, [["any", "Any"], ["yes", "Has an email"], ["form", "Form only"]], "email")),
    h("div.cr-row", C.chips([["all", "Any kind"], ...Object.entries(KINDS)], st.pf.kind, (v) => setP({ kind: v }), "Kind"),
      C.chips([["all", "Any reach"], ["big", "Big"], ["mid", "Mid"], ["small", "Small"]], st.pf.reach, (v) => setP({ reach: v }), "Reach")));
  const list = h("div.cr-list");
  const REACH_ORDER = { big: 0, mid: 1, small: 2 };
  function drawList() {
    const rows = filterPress(all, st.pf).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "press" ? -1 : b.kind === "press" ? 1 : a.kind.localeCompare(b.kind))
      || (REACH_ORDER[a.reach] ?? 3) - (REACH_ORDER[b.reach] ?? 3) || a.name.localeCompare(b.name));
    const emails = [...new Set(rows.map((p) => p.email).filter(Boolean))];
    const head = h("div.cr-listhead", h("span", `${C.plural(rows.length, "outlet")}${rows.length !== all.length ? ` of ${num(all.length)}` : ""}, ${num(emails.length)} with an email`),
      h("button.btn", { type: "button", disabled: !emails.length, onclick: (e) => C.copy(emails.join("\n"), e.currentTarget) }, `Copy ${C.plural(emails.length, "email")}`));
    const table = h("table.cr-table", h("thead", h("tr", h("th", "Outlet"), h("th", "Kind"), h("th", "Where"), h("th", "Reach"), h("th", "Focus"), h("th", "Contact"), h("th", "Notes"))),
      h("tbody", ...rows.slice(0, st.pshown).map((p) => h("tr",
        h("td.cr-chan", h("a", { href: p.url, target: "_blank", rel: "noopener" }, p.name), h("div.cr-muted", p.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))),
        h("td", h("span.cr-type", KINDS[p.kind] || p.kind)),
        h("td", { title: COUNTRY_NAMES[p.country] || "" }, p.country || "–", h("span.cr-muted", ` ${(p.language || "").toUpperCase()}`)),
        h("td", p.reach || "–"),
        h("td", p.focus || "–"),
        h("td", p.email
          ? h("span.cr-email", h("a", { href: `mailto:${p.email}` }, p.email), h("button.cr-copy", { type: "button", onclick: (e) => C.copy(p.email, e.currentTarget) }, "Copy"),
              p.contact_url ? h("div", h("a.cr-muted", { href: p.contact_url, target: "_blank", rel: "noopener" }, "form ↗")) : null)
          : p.contact_url ? h("a", { href: p.contact_url, target: "_blank", rel: "noopener" }, "Contact form ↗") : "–"),
        h("td.cr-genres", p.notes || "", p.source ? h("div", h("a.cr-muted", { href: p.source, target: "_blank", rel: "noopener", title: "Where the contact was found" }, "source ↗")) : null)))));
    const more = rows.length > st.pshown ? h("button.btn.cr-more", { type: "button", onclick: () => { st.pshown += PAGE; drawList(); } }, `Show ${Math.min(PAGE, rows.length - st.pshown)} more`) : null;
    list.replaceChildren(head, rows.length ? h("div.cr-scroll", table) : h("p.empty", "No outlets match these filters."), more);
  }
  drawList();
  wrap.append(cards, filters, list, h("details.about", h("summary", "How this works"),
    h("p", "Games press, aggregators (sites and newsletters that repost trailers and press releases) and YouTube trailer channels, worldwide, for launch announcements. Each contact was taken from the outlet's own contact or about page (source); none are guessed. Kept on the server, not in the public repository."),
    h("p", "Send one short, personal email per outlet in its language where you can, with the press release, trailer link and a key or Steam page; no mass mail. Many big sites prefer their tips address; trailer channels usually want an unlisted video link. Steam Curator Connect (in Steamworks) reaches curators separately.")));
  return wrap;
}

// Outreach: drafts, approvals and status of the emails (server/creators/outreach.py and send.py,
// through the game-data server's /admin/outreach routes). Nothing is sent before a batch is approved.
const TEMPLATES = {
  // Short, one thing to do (play it: the key is right there), plain text by default. {key} is a Steam
  // key from the key bot's pool, put in when the email is sent.
  creators: {
    subject: "Steam key for {game}",
    body: "Hi {name},\n\nI'm Danny, a 23-year-old solo developer from Sweden with no marketing budget. I made {game}: [what you do in it, in one simple sentence]. You played {their_game}, so I think you might like it.\n\nSteam: {steam}\nPress kit: {press}\n\nFree key: {key}\n\nThanks,\nDanny\nFour Games",
  },
  streamers: {
    subject: "Steam key for {game}",
    body: "Hi {name},\n\nI'm Danny, a 23-year-old solo developer from Sweden with no marketing budget. I made {game}: [what you do in it, in one simple sentence]. You've played {their_game}, so I think it could be fun on stream.\n\nSteam: {steam}\nPress kit: {press}\n\nFree key: {key}\n\nThanks,\nDanny\nFour Games",
  },
  press: {
    subject: "{game}: [the news, in a few words]",
    body: "Hi {name} team,\n\n[The news in one simple sentence, with the date.]\n\nI'm Danny, a 23-year-old solo developer from Sweden with no marketing budget. I made {game}: [what you do in it, in one simple sentence].\n\nSteam: {steam}\nPress kit (screenshots, trailer, logo): {press}\n\nFor a key, join https://discord.fourgames.se and type /request type:press.\n\nThanks,\nDanny\nFour Games",
  },
};
const MSG_STATUS = { queued: "Waiting", sent: "Sent", replied: "Replied", opted_out: "Said no", bounced: "Bounced", failed: "Failed", skipped: "Skipped" };
const CAMPAIGN_STATUS = { draft: "Draft: not approved", approved: "Sending", paused: "Paused", done: "Done" };
const ot = { data: null, error: null, loading: false, open: null, openData: null, form: null, busy: false, msg: null, shownMsg: null };
const slug = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

async function loadOutreach() {
  if (ot.loading) return;
  ot.loading = true;
  try {
    ot.data = await (await C.adminGet("outreach")).json();
    ot.error = null;
    if (ot.open) ot.openData = await (await C.adminGet(`outreach/${ot.open}`)).json();
  } catch (e) {
    if (!e.signedOut) ot.error = `Couldn't load outreach: ${e.message}`;
  } finally {
    ot.loading = false;
  }
  draw();
}
async function outreachSend(path, body, ok) {
  ot.busy = true; ot.msg = null; draw();
  try {
    const res = await C.adminSend(path, "POST", body, 60000);
    const out = await res.json();
    ok?.(out);
  } catch (e) {
    if (!e.signedOut) ot.msg = e.message;
  } finally {
    ot.busy = false;
    await loadOutreach();
  }
}

function outreachView(d) {
  const { h } = C;
  const wrap = h("div");
  if (C.dataOverride) { wrap.append(h("p.empty", "Outreach needs the server (not available with ?data=).")); return wrap; }
  if (!ot.data && !ot.loading && !ot.error) loadOutreach();
  if (!ot.data) { wrap.append(h("p.empty", ot.error || "Loading outreach…")); return wrap; }
  const o = ot.data;
  const contacted = new Set(o.contacted || []);
  const err = o.state?.last_error;
  const lastRun = o.state?.last_run ? Number(o.state.last_run) : null;
  const card = (label, value, sub) => h("div.cr-card", h("div.cr-card-v", value), h("div.cr-card-l", label), sub ? h("div.cr-card-s", sub) : null);
  const sum = (k) => o.campaigns.reduce((a, c) => a + (c.counts[k] || 0), 0);
  const add = (...els) => wrap.append(...els.filter(Boolean));
  add(
    err ? h("p.cr-alert", err) : null,
    !lastRun ? h("p.cr-note", "The sender hasn't run yet: it needs the mailbox login in /etc/fourgames/outreach.env and creators-send.timer on the server (server/creators/README.md, Outreach). Drafts can be made already.") : null,
    h("div.cr-cards",
      card("Sent", num(sum("sent") + sum("replied") + sum("opted_out") + sum("bounced")), `${num(o.sent_24h)} in the last 24 hours`),
      card("Waiting", num(sum("queued")), "approved or draft, not sent yet"),
      card("Replied", num(sum("replied")), `${num(sum("opted_out"))} said no`),
      card("Made a video", num(o.campaigns.reduce((a, c) => a + (c.videos?.creators || 0), 0)),
        `${num(o.campaigns.reduce((a, c) => a + (c.videos?.views || 0), 0))} views so far`),
      card("Never email again", num(o.suppressed), "opted out or bounced")),
    ot.msg ? h("p.cr-alert", ot.msg) : null);
  add(healthBox(o));
  if (ot.open && ot.openData) { add(campaignView(d)); return wrap; }
  add(h("div.cr-listhead", h("b", "Campaigns"), h("button.btn.primary", { type: "button", onclick: () => { ot.form = ot.form ? null : newForm(d); draw(); } }, ot.form ? "Close" : "New campaign")));
  if (ot.form) wrap.append(formView(d, contacted));
  wrap.append(o.campaigns.length ? h("div.cr-scroll", h("table.cr-table", h("thead", h("tr", h("th", "Campaign"), h("th", "Status"), h("th.cr-num", "Waiting"), h("th.cr-num", "Sent"), h("th.cr-num", "Replied"), h("th.cr-num", "Made a video"), h("th.cr-num", "No / bounced"), h("th", ""))),
    h("tbody", ...o.campaigns.map(({ campaign: c, counts: n, videos: v }) => h("tr.cr-main", { onclick: () => { ot.open = c.id; ot.openData = null; loadOutreach(); } },
      h("td.cr-chan", h("b", c.game), h("div.cr-muted", `${c.audience === "press" ? "Press" : c.audience === "streamers" ? "Streamers" : "YouTubers"} · from ${c.from_name} · ${C.fmtDate(c.created_at)}`)),
      h("td", h("span.cr-type", { title: c.paused_reason || "" }, c.paused_reason ? "Paused by the safety brake" : CAMPAIGN_STATUS[c.status] || c.status)),
      h("td.cr-num", num(n.queued || 0)), h("td.cr-num", num((n.sent || 0) + (n.replied || 0) + (n.opted_out || 0) + (n.bounced || 0))),
      h("td.cr-num", num(n.replied || 0)), h("td.cr-num", { title: v?.views ? `${num(v.views)} views` : "" }, num(v?.creators || 0)),
      h("td.cr-num", `${num(n.opted_out || 0)} / ${num(n.bounced || 0)}`),
      h("td", h("span.cr-muted", "Open ›")))))))
    : h("p.empty", "No campaigns yet."));
  wrap.append(h("details.about", h("summary", "How this works"),
    h("p", "Make a draft: a game, who to email (the best creators for it, or the press list with the Press tab's filters), and a short message. Each person gets their own copy with their name filled in. People who said no, bounced or were emailed in the last 90 days are left out, and every email ends with how to say no."),
    h("p", "Read the previews, then Approve. The server sends slowly on weekdays during the day, at most DAILY_MAX a day in all, through your Strato mailbox, and reads the inbox: replies show here, and anyone who answers \"no\" is never emailed again."),
    h("p", "To send from the game's address (e.g. pomovalley@fourgames.se), add it in Strato as an alias of your mailbox first, so replies land in your inbox.")));
  return wrap;
}

// Mail health: what Gmail, Outlook, Yahoo... reported about mail from fourgames.se (DMARC aggregate
// reports, read by the server), and the safety brake's limits.
function healthBox(o) {
  const { h } = C;
  const dm = o.dmarc || { by: [], ever: 0, failed_from: {} };
  const b = o.brake || {};
  const pct = (x) => `${Math.round(x * 100)}%`;
  const fails = Object.entries(dm.failed_from || {});
  const bad = dm.by.some((r) => r.passed < r.messages);
  return h("details.cr-filters.cr-health", { open: bad || undefined },
    h("summary", h("b", "Mail health "), h("span.cr-muted", !dm.ever ? "· waiting for the first DMARC reports"
      : bad ? "· some mail failed checks: look inside" : `· all mail passed in the last ${dm.days} days`)),
    !dm.ever
      ? h("p.cr-muted", "Once the DMARC record at Strato points to dmarc@fourgames.se, Gmail, Outlook, Yahoo and others report every day how many emails from fourgames.se they got and whether they passed. The server reads those reports and files them into a DMARC folder, so they never fill your inbox.")
      : h("table.cr-table", h("thead", h("tr", h("th", "Reported by"), h("th.cr-num", "Emails"), h("th.cr-num", "Passed"), h("th", "Latest"))),
          h("tbody", ...dm.by.map((r) => h("tr", h("td", r.org), h("td.cr-num", num(r.messages)),
            h("td.cr-num", h("span", { class: r.passed < r.messages ? "cr-bad" : "cr-good" }, r.messages ? pct(r.passed / r.messages) : "–")),
            h("td.cr-muted", r.last ? C.fmtDate(r.last) : "–"))))),
    fails.length ? h("p.cr-alert", `Mail that failed came from: ${fails.map(([ip, n]) => `${ip} (${n})`).join(", ")}. If that isn't Strato, someone may be sending as fourgames.se (p=reject blocks it); if it is, the signing broke.`) : null,
    h("p.cr-muted", `Safety brake: a campaign pauses itself once ${b.min_sent || 10}+ emails are sent and more than ${pct(b.bounces || 0.05)} bounce or more than ${pct(b.nos || 0.08)} say no. Gmail's own view: postmaster.google.com.`));
}

function newForm(d) {
  const own = Object.entries(d.games).filter(([, g]) => g.own).map(([id, g]) => [Number(id), g.n]);
  const [appid, game] = own[0] || [null, ""];
  return { appid, game, audience: "creators", n: 30, activeOnly: true, gif: false, from_name: `Danny from ${game}`, from_email: `${slug(game)}@fourgames.se`, daily_limit: 20, ...TEMPLATES.creators };
}

function recipientsFor(d, f, contacted) {
  if (f.audience === "press") {
    return filterPress(d.press || [], st.pf).filter((p) => p.email && !contacted.has(p.email.toLowerCase()))
      .map((p) => ({ id: pressKey(p.url), label: p.name, email: p.email, lang: (p.language || "en").slice(0, 2) }));
  }
  const weights = gameWeights(d.games[f.appid], d.metaSet);
  const today = now();
  // Streamers: Twitch streamers, and YouTube creators with a Twitch channel; one email each.
  const pool = f.audience === "streamers" ? [...d.streamers, ...d.creators.filter((c) => c.k.twitch)] : d.creators;
  const seen = new Set();
  return pool.filter((c) => c.e.length && !contacted.has(c.e[0][0]) && (!f.activeOnly || activity(c, today) !== "inactive"))
    .map((c) => [fit(c, f.appid, weights, today).score, c]).sort((a, b) => b[0] - a[0])
    .filter(([, c]) => !seen.has(c.e[0][0]) && seen.add(c.e[0][0])).slice(0, f.n)
    .map(([, c]) => ({ id: c.id, label: c.t, email: c.e[0][0], lang: (c.l || "en").slice(0, 2) }));
}
export function pressKey(url) {
  const u = new URL(url);
  return u.host.toLowerCase().replace(/^www\./, "") + u.pathname.replace(/\/+$/, "").toLowerCase();
}

function formView(d, contacted) {
  const { h } = C;
  const f = ot.form;
  const own = Object.entries(d.games).filter(([, g]) => g.own).map(([id, g]) => [String(id), g.n]);
  const set = (patch, redraw = true) => { Object.assign(f, patch); if (redraw) draw(); };
  const input = (label, key, attrs = {}) => { const el = h("input.cr-input", { value: f[key], ...attrs }); el.addEventListener("input", () => set({ [key]: attrs.type === "number" ? Number(el.value) : el.value }, false)); if (key === "n") el.addEventListener("change", () => draw()); return h("label.cr-field", h("span", label), el); };
  const area = (label, key, rows) => { const el = h("textarea.cr-area", { rows }, f[key]); el.addEventListener("input", () => { const stale = !!f.translations; set({ [key]: el.value, translations: null }, false); if (stale) draw(); }); return h("label.cr-field", h("span", label), el); };
  const people = recipientsFor(d, f, contacted);
  const leftover = /\[[^\]]{3,}\]/.test(f.subject + f.body);
  const create = () => {
    if (leftover) { ot.msg = "Fill in the [bracketed] parts of the subject and message first."; draw(); return; }
    outreachSend("outreach", { appid: f.appid, game: f.game, audience: f.audience, from_name: f.from_name, from_email: f.from_email,
      subject: f.subject, body: f.body, daily_limit: f.daily_limit, gif: f.gif, recipients: people.map((p) => p.id),
      translations: f.translations || undefined },
      (out) => { ot.form = null; ot.open = out.id; });
  };
  return h("div.cr-filters.cr-form",
    h("div.cr-row", h("span.cr-label", "Game"), C.chips(own, String(f.appid), (v) => { const g = d.games[v]?.n || ""; set({ appid: Number(v), game: g, from_name: `Danny from ${g}`, from_email: `${slug(g)}@fourgames.se` }); }, "Game")),
    h("div.cr-row", h("span.cr-label", "Who"), C.chips([["creators", "YouTubers"], ["streamers", "Streamers"], ["press", "Press list"]], f.audience, (v) => set({ audience: v, translations: null, ...TEMPLATES[v] }), "Audience"),
      f.audience !== "press" ? input("How many", "n", { type: "number", min: 1, max: 500, style: "max-width:6em" }) : null,
      f.audience !== "press" ? h("label.cr-select", h("input", { type: "checkbox", checked: f.activeOnly, onchange: (e) => set({ activeOnly: e.currentTarget.checked }) }), h("span", "Skip inactive channels")) : null),
    h("p.cr-muted", f.audience === "press"
      ? `${C.plural(people.length, "outlet")} with an email from the Press tab's current filters (country, language, kind, reach), not emailed before. Change the filters there to change who's in.`
      : f.audience === "streamers"
        ? `The ${C.plural(people.length, "streamer")} who fit ${f.game} best (Twitch streamers, and YouTubers with a Twitch channel), with an email, not emailed before.`
        : `The ${C.plural(people.length, "creator")} who fit ${f.game} best, with an email, not emailed before. Change "How many" to pick more or fewer.`),
    h("div.cr-row", input("From name", "from_name"), input("From address", "from_email", { type: "email" }), input("Per day", "daily_limit", { type: "number", min: 1, max: 200, style: "max-width:6em" })),
    h("p.cr-muted", "The from address must be your Strato mailbox or one of its aliases (add a game address as an alias in Strato's mail settings first)."),
    h("label.cr-select", h("input", { type: "checkbox", checked: f.gif, onchange: (e) => set({ gif: e.currentTarget.checked }, false) }),
      h("span", "Add the game's GIF (makes it an HTML email; plain text has the lowest spam risk)")),
    input("Subject", "subject"),
    area("Message", "body", 14),
    translateView(f, people, leftover),
    h("p.cr-muted", "{name} = the channel or outlet, {game}, {steam} = the store link, {press} = the game's press page, {their_game} = a game the creator made a video of, {key} = a Steam key from the key bot (taken when the email is sent; the game needs its Steam app id in the bot and enough keys to approve). Replace the [bracketed] parts. Keep it short and simple (creators skim, and many read English as a second language), and true. The game's GIF goes in after the second paragraph, and an opt-out line at the end."),
    h("div.cr-row", h("button.btn.primary", { type: "button", disabled: ot.busy || !people.length, onclick: create }, ot.busy ? "Saving…" : `Save draft for ${people.length === 1 ? "1 person" : `${num(people.length)} people`}`),
      h("span.cr-muted", "Nothing is sent until you approve the draft.")),
    people.length ? h("details", h("summary.cr-muted", `Who's in (${people.length})`), h("p.cr-muted", people.slice(0, 200).map((p) => p.label).join(", "))) : null);
}

// Each recipient gets the email in their language (their channel's or outlet's), translated by Claude
// from the English in the same short, plain style; the owner reads and can edit each one. Languages
// without a translation get the English.
const LANG_LABEL = { de: "German", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", pl: "Polish", ru: "Russian", uk: "Ukrainian", tr: "Turkish", ja: "Japanese", ko: "Korean", zh: "Chinese", nl: "Dutch", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish", cs: "Czech", hu: "Hungarian", ro: "Romanian", id: "Indonesian", vi: "Vietnamese", th: "Thai", ar: "Arabic", hi: "Hindi", el: "Greek", he: "Hebrew" };
function translateView(f, people, leftover) {
  const { h } = C;
  const counts = {};
  for (const p of people) if (p.lang && p.lang !== "en" && LANG_LABEL[p.lang]) counts[p.lang] = (counts[p.lang] || 0) + 1;
  const langs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!langs.length) return h("p.cr-muted", "Everyone here gets the English email (no other languages among them).");
  const english = people.length - langs.reduce((a, [, n]) => a + n, 0);
  const go = async (e) => {
    if (leftover) { ot.msg = "Fill in the [bracketed] parts first, then localize."; draw(); return; }
    e.currentTarget.disabled = true; e.currentTarget.textContent = "Localizing…";
    try {
      const out = await (await C.adminSend("outreach/translate", "POST", { subject: f.subject, body: f.body, languages: langs.map(([l]) => l), appid: f.appid }, 200000)).json();
      f.translations = out.translations;
      ot.msg = out.skipped?.length ? `Left in English (the translation changed a link or placeholder): ${out.skipped.map((l) => LANG_LABEL[l] || l).join(", ")}.` : null;
    } catch (err) { if (!err.signedOut) ot.msg = `Localizing failed: ${err.message}`; }
    draw();
  };
  const t = f.translations;
  return h("div.cr-translate",
    h("div.cr-row", h("span.cr-label", "Languages"),
      h("span.cr-muted", `${langs.map(([l, n]) => `${LANG_LABEL[l]} ${n}`).join(" · ")}${english ? ` · English ${english}` : ""}`),
      h("button.btn", { type: "button", onclick: go }, t ? "Localize again" : `Localize for ${C.plural(langs.length, "language")}`)),
    t ? h("div", ...Object.entries(t).map(([l, tr]) => {
      const sub = h("input.cr-input", { value: tr.subject }); sub.addEventListener("input", () => { tr.subject = sub.value; });
      const bod = h("textarea.cr-area", { rows: 9 }, tr.body); bod.addEventListener("input", () => { tr.body = bod.value; });
      const opt = h("input.cr-input", { value: tr.opt_out }); opt.addEventListener("input", () => { tr.opt_out = opt.value; });
      const game = h("input.cr-input", { value: tr.game || "" }); game.addEventListener("input", () => { tr.game = game.value; });
      return h("details.cr-lang", h("summary", `${LANG_LABEL[l] || l} (${counts[l] || 0})${tr.game ? ` · ${tr.game}` : ""}`),
        h("label.cr-field", h("span", "Game name in this language (fills {game}; from your Steam page)"), game),
        h("label.cr-field", h("span", "Subject"), sub), h("label.cr-field", h("span", "Message"), bod), h("label.cr-field", h("span", "Opt-out line"), opt));
    }), h("p.cr-muted", "Each uses your game\'s Steam name in that language and says the game is in their language when it is (Steam opens in their language by itself). Open one to read or fix it. Changing the English clears these; localize again after.")) : h("p.cr-muted", "Optional: without localizing, everyone gets the English."));
}

function campaignView(d) {
  const { h } = C;
  const { campaign: c, counts: n, messages: msgs, videos: made } = ot.openData;
  const action = (label, status, primary) => h(primary ? "button.btn.primary" : "button.btn", { type: "button", disabled: ot.busy,
    onclick: () => outreachSend(`outreach/${c.id}/status`, { status }, status === "deleted" ? () => { ot.open = null; ot.openData = null; } : null) }, label);
  const preview = msgs.find((m) => m.id === ot.shownMsg) || msgs[0];
  return h("div",
    h("div.cr-listhead", h("button.btn", { type: "button", onclick: () => { ot.open = null; ot.openData = null; draw(); } }, "‹ All campaigns"),
      h("span", c.status === "draft" ? action("Approve and start sending", "approved", true) : null, " ",
        c.status === "paused" ? action("Resume", "approved", true) : null, c.status === "approved" ? action("Pause", "paused") : null, " ",
        c.status === "draft" ? action("Delete draft", "deleted") : null)),
    c.paused_reason ? h("p.cr-alert", h("b", "Paused by the safety brake: "), c.paused_reason, " Fix the list or the message before resuming; resuming counts afresh.") : null,
    h("h3.cr-h", `${c.game} · ${c.audience} · ${CAMPAIGN_STATUS[c.status] || c.status}`),
    h("p.cr-muted", `From ${c.from_name} <${c.from_email}> · up to ${c.daily_limit} a day · ${Object.entries(n).map(([k, v]) => `${MSG_STATUS[k] || k} ${v}`).join(" · ")}`),
    made?.creators ? h("p.cr-note", h("b", `${C.plural(made.creators, "creator")} made a video`), ` after the email: ${C.plural(made.videos, "video")}, ${num(made.views)} views so far.`) : null,
    preview ? h("div.cr-preview", h("div.cr-muted", `To ${preview.name || ""} <${preview.email}> · from ${c.from_name}`), h("div", h("b", preview.subject)),
      preview.html ? h("iframe.cr-frame", { title: "Email preview", sandbox: "", srcdoc: preview.html }) : h("pre.cr-body", preview.body),
      preview.html ? h("details", h("summary.cr-muted", "Plain-text version (sent inside the same email)"), h("pre.cr-body", preview.body)) : null) : null,
    h("div.cr-scroll", h("table.cr-table", h("thead", h("tr", h("th", "To"), h("th", "Subject"), h("th", "Status"), h("th", "When"), h("th", ""))),
      h("tbody", ...msgs.map((m) => h("tr.cr-main", { class: m.id === preview?.id ? "is-open" : null, onclick: () => { ot.shownMsg = m.id; draw(); } },
        h("td.cr-chan", h("b", m.name || m.email), h("div.cr-muted", `${m.email}${m.language && m.language !== "en" ? ` · ${LANG_LABEL[m.language] || m.language}` : ""}`)),
        h("td.cr-genres", m.subject),
        h("td", h("span.cr-type", { title: m.error || "" }, MSG_STATUS[m.status] || m.status),
          ...(m.videos || []).map((v) => h("div", h("a.cr-made", { href: `https://www.youtube.com/watch?v=${v.id}`, target: "_blank", rel: "noopener", title: v.title || "", onclick: (e) => e.stopPropagation() },
            `🎬 Made a video · ${num(v.views || 0)} views · ${C.fmtDate(v.published)}`)))),
        h("td.cr-muted", m.replied_at ? `replied ${C.fmtDate(m.replied_at)}` : m.sent_at ? C.fmtDateTime(m.sent_at) : "–"),
        h("td", m.status === "queued" ? h("button.cr-copy", { type: "button", onclick: (e) => { e.stopPropagation(); outreachSend(`outreach/messages/${m.id}/skip`, undefined); } }, "Leave out") : null)))))));
}

const CSS = `
.crv { min-width: 0; color: var(--fb-ink); }
.crv .cr-switch { margin-bottom: 14px; }
.crv .cr-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin: 0 0 16px; }
.crv .cr-card { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 14px; text-align: left; font: inherit; color: var(--fb-ink); }
.crv .cr-card.is-link { cursor: pointer; }
.crv .cr-made { display: inline-block; margin-top: 4px; font-size: 0.8rem; font-weight: 650; color: var(--fb-good, #1a7f37); text-decoration: none; }
.crv .cr-made:hover { text-decoration: underline; }
.crv .cr-card.is-link:hover { background: var(--fb-hover); }
.crv .cr-card-v { font-size: 1.5rem; font-weight: 700; color: var(--fb-title); font-variant-numeric: tabular-nums; }
.crv .cr-card-l { font-weight: 600; font-size: 0.9rem; }
.crv .cr-card-s { color: var(--fb-muted); font-size: 0.78rem; margin-top: 2px; }
.crv .cr-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 10px; }
.crv .cr-label { font-weight: 650; font-size: 0.88rem; }
.crv .cr-filters { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px 12px 2px; margin: 0 0 12px; }
.crv .cr-input { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; flex: 1 1 220px; max-width: 320px; min-width: 0; }
.crv .cr-select { display: inline-flex; align-items: center; gap: 6px; font-size: 0.85rem; color: var(--fb-ink-2); }
.crv .cr-select select { font: inherit; font-size: 0.85rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 5px 8px; max-width: 14em; }
.crv .cr-listhead { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 0.9rem; color: var(--fb-ink-2); }
.crv .cr-scroll { overflow-x: auto; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; }
.crv .cr-table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.crv .cr-table th { text-align: left; font-weight: 600; color: var(--fb-ink-2); font-size: 0.78rem; padding: 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; }
.crv .cr-table td { padding: 7px 8px; border-bottom: 1px solid var(--fb-line); vertical-align: top; }
.crv .cr-main { cursor: pointer; }
.crv .cr-main:hover, .crv .cr-main.is-open { background: var(--fb-hover); }
.crv .cr-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.crv .cr-chan a { font-weight: 600; color: var(--fb-ink); text-decoration: none; }
.crv .cr-chan a:hover { text-decoration: underline; }
.crv .cr-chan { min-width: 12em; max-width: 20em; }
.crv .cr-muted { color: var(--fb-muted); font-size: 0.8rem; }
.crv .cr-gamescol { max-width: 16em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crv .cr-genres { color: var(--fb-ink-2); min-width: 10em; }
.crv .cr-badge { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 0.7rem; font-weight: 700; color: var(--fb-good-text); border: 1px solid var(--fb-positive); vertical-align: 1px; }
.crv .cr-type { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; white-space: nowrap; background: var(--fb-card-2); border: 1px solid var(--fb-line); color: var(--fb-ink-2); }
.crv .cr-act { white-space: nowrap; font-weight: 600; }
.crv .cr-act.is-active { color: var(--fb-good-text); }
.crv .cr-act.is-quiet { color: var(--fb-warning); }
.crv .cr-act.is-inactive, .crv .cr-act.is-unknown { color: var(--fb-muted); font-weight: 400; }
.crv .cr-fit { display: inline-block; min-width: 2.2em; padding: 1px 6px; border-radius: 6px; background: var(--fb-card-2); border: 1px solid var(--fb-accent); font-weight: 700; text-align: center; }
.crv .cr-email { white-space: nowrap; }
.crv .cr-email a { color: var(--fb-link); }
.crv .cr-copy { margin-left: 6px; border: 1px solid var(--fb-line); background: var(--fb-card-2); color: var(--fb-ink-2); border-radius: 6px; font: inherit; font-size: 0.72rem; padding: 0 6px; cursor: pointer; }
.crv .cr-copy:hover { background: var(--fb-hover); }
.crv .cr-detail td { background: var(--fb-card-2); }
.crv .cr-detailgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px 20px; padding: 4px 2px 8px; }
.crv .cr-detailgrid p, .crv .cr-detailgrid ul { margin: 4px 0; padding-left: 0; list-style: none; font-size: 0.84rem; }
.crv .cr-detailgrid li { margin: 2px 0; }
.crv .cr-detailgrid a { color: var(--fb-link); }
.crv .cr-dh { font-weight: 650; font-size: 0.8rem; color: var(--fb-ink-2); margin-top: 4px; }
.crv .cr-more { margin: 12px auto 0; display: block; }
.crv details.about { margin-top: 18px; }
.crv .cr-health summary { cursor: pointer; padding: 2px 0 10px; }
.crv .cr-health .cr-table { margin-bottom: 8px; }
.crv .cr-good { color: var(--fb-good-text); font-weight: 600; }
.crv .cr-bad { color: var(--fb-negative); font-weight: 600; }
.crv .cr-alert { background: var(--fb-card); border: 1px solid var(--fb-negative); border-left-width: 3px; border-radius: 8px; padding: 8px 12px; color: var(--fb-ink); }
.crv .cr-note { background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-warning); border-radius: 8px; padding: 8px 12px; color: var(--fb-ink-2); font-size: 0.88rem; }
.crv .cr-quota { color: var(--fb-ink); font-size: 0.95rem; margin: 10px 0; }
.crv .cr-quota.is-ok { border-left-color: var(--fb-positive); }
.crv .cr-form { padding-bottom: 12px; }
.crv .cr-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.82rem; color: var(--fb-ink-2); margin: 0 0 10px; flex: 1 1 220px; }
.crv .cr-field .cr-input { max-width: none; flex: none; }
.crv .cr-area { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 8px 10px; resize: vertical; }
.crv .cr-translate { border-top: 1px solid var(--fb-line); padding-top: 10px; margin: 6px 0 10px; }
.crv .cr-lang { margin: 6px 0; }
.crv .cr-lang > summary { cursor: pointer; font-weight: 600; font-size: 0.88rem; }
.crv .cr-h { margin: 12px 0 2px; color: var(--fb-title); font-size: 1.05rem; }
.crv .cr-preview { background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-accent); border-radius: 8px; padding: 10px 14px; margin: 10px 0 14px; }
.crv .cr-frame { display: block; width: 100%; height: 560px; border: 1px solid var(--fb-line); border-radius: 8px; margin-top: 10px; background: #fff; }
.crv .cr-body { white-space: pre-wrap; font: inherit; font-size: 0.88rem; margin: 8px 0 0; color: var(--fb-ink); }
@media (max-width: 640px) {
  .crv .cr-input { max-width: none; flex-basis: 100%; }
}
`;

function injectCss() {
  if (typeof document === "undefined" || document.getElementById("cr-style")) return;
  const el = document.createElement("style");
  el.id = "cr-style";
  el.textContent = CSS + HUNT_CSS;
  document.head.append(el);
}
