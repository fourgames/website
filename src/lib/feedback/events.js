// The Creators page's Events & awards tab: festivals, showcases, Steam fests and awards a game can
// enter, sorted by the next deadline, and a shelf per game of what it got into, was nominated for or won
// (with the line to put under a laurel on the store page).
//
// The researched list is events-list.js (dates marked est. are last year's month, not announced yet).
// The server keeps only each game's status and note per event and the events added here by hand
// (server/creators/events.py, GET/POST /admin/events). Game "Studio" (appid 0) is for studio awards.

import { EVENTS, AVOID, BADGES, oddsOf, regionOf } from "./events-list.js";
import { laurelSvg, saveLaurelPng } from "./laurel.js";

const DAY = 86400000;
const ODDS = [["any", "Any"], ["open", "Open"], ["curated", "Curated"], ["selective", "Selective"]];
const ODDS_TIP = { open: "Sign up (or pay) and you're in, if the game fits", curated: "They pick, but take lots of games", selective: "Few get in" };
const KINDS = [["all", "All"], ["steam", "Steam"], ["festival", "Festivals"], ["showcase", "Showcases"], ["award", "Awards"]];
const WHERE = [["any", "Any"], ["se", "Swedish only"], ["nordic", "Nordic only"], ["in-se", "Held in Sweden"]];
const WHERE_TIP = { se: "Only Swedish games or studios", nordic: "Only Nordic games or studios", "in-se": "Held in Sweden, open to anyone" };
const KIND_NAME ={ steam: "Steam", festival: "Festival", showcase: "Showcase", award: "Award" };
const STATUSES = [["", "Not yet"], ["planned", "Planning to"], ["applied", "Applied"], ["in", "Got in / took part"],
  ["nominated", "Nominated"], ["won", "Won"], ["rejected", "Not picked"], ["skipped", "Skip"]];
const SHELF = { won: ["🏆", "Winner"], nominated: ["🏅", "Nominee"], in: ["🎖️", "Official Selection"] };

let C = null;
const es = { data: null, error: null, loading: false, game: null, kind: "all", odds: "any", badgeFirst: true, show: "open", free: false, where: "any", busy: false, msg: null, adding: false };

async function load(redraw) {
  if (es.loading) return;
  es.loading = true;
  try {
    es.data = await (await C.adminGet("events")).json();
    es.error = null;
  } catch (e) {
    if (!e.signedOut) es.error = `Couldn't load events: ${e.message}`;
  } finally {
    es.loading = false;
  }
  redraw();
}

async function save(body, redraw) {
  es.busy = true; es.msg = null;
  try {
    es.data = await (await C.adminSend("events", "POST", body, 30000)).json();
    return true;
  } catch (e) {
    if (!e.signedOut) es.msg = e.message;
    return false;
  } finally {
    es.busy = false;
    redraw();
  }
}

// "2027-02-03" or "2027-02" → a Date (a month alone counts as its last day, so it isn't past too early).
export function dateOf(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return d ? new Date(y, m - 1, d) : new Date(y, m, 0);
}
const fmt = (s) => {
  const t = dateOf(s);
  if (!t) return "";
  return s.length > 7 ? t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : t.toLocaleDateString(undefined, { month: "short", year: "numeric" });
};

// Open: the deadline (or, without one, the event) hasn't passed, or nobody knows when it is.
export function isOpen(e, today) {
  const t = dateOf(e.deadline) || dateOf(e.when);
  return !t || t.getTime() >= today.getTime();
}
// Next deadline first; events with only an event date by that; undated last.
export function sortKey(e) {
  const t = dateOf(e.deadline) || dateOf(e.when);
  return t ? t.getTime() : 9e15;
}
// The line under a laurel: "Official Selection · Tiny Teams 2027".
export function laurelText(e, status) {
  const { top, name, year } = laurelParts(e, status);
  return `${top} · ${year && !name.includes(year) ? `${name} ${year}` : name}`;
}
// What the laurel says: Winner / Nominee once marked so, otherwise Official Selection.
export function laurelParts(e, status) {
  const year = (e.when || e.deadline || "").slice(0, 4);
  const name = e.name.replace(/\s*\([^)]*\)/g, "").replace(/\s+20\d\d$/, "").trim() || e.name;
  return { top: (SHELF[status] || SHELF.in)[1], name, year };
}

export function eventsView(ctx, d, redraw) {
  C = ctx;
  injectCss();
  const { h } = C;
  const wrap = h("div.ev");
  if (C.dataOverride) { wrap.append(h("p.empty", "Events need the server (not available with ?data=).")); return wrap; }
  if (!es.data && !es.loading && !es.error) load(redraw);
  if (!es.data) { wrap.append(h("p.empty", es.error || "Loading…")); return wrap; }

  const own = Object.entries(d.games).filter(([, g]) => g.own).map(([id, g]) => [Number(id), g.n]).sort((a, b) => a[1].localeCompare(b[1]));
  const games = [[0, "Studio"], ...own];
  if (es.game == null || !games.some(([a]) => a === es.game)) es.game = own[0]?.[0] ?? 0;
  const appid = es.game;
  const gameName = games.find(([a]) => a === appid)[1];
  const entries = es.data.entries || {};
  const all = [...EVENTS, ...(es.data.custom || [])];
  const mine = (e) => entries[e.key]?.[String(appid)] || null;
  const today = new Date(); today.setHours(0, 0, 0, 0);

  wrap.append(h("p.cr-muted.ev-intro", "Festivals, showcases, Steam fests and awards you can enter, next deadline first. Mark what you applied to; what gets in goes on the game's shelf. Dates marked est. are last year's, not announced yet: check the link."));
  wrap.append(h("div.cr-row", h("span.cr-label", "For"),
    C.chips(games.map(([id, n]) => [String(id), n]), String(appid), (v) => { es.game = Number(v); redraw(); }, "Game")));

  // The shelf: what this game got into, best first.
  const rank = { won: 0, nominated: 1, in: 2 };
  const shelf = all.map((e) => [e, mine(e)]).filter(([, m]) => m && rank[m.status] != null)
    .sort((a, b) => rank[a[1].status] - rank[b[1].status] || (b[1].at || 0) - (a[1].at || 0));
  const waiting = all.filter((e) => mine(e)?.status === "applied").length;
  wrap.append(h("div.ev-shelf",
    h("div.ev-shelf-h", h("span.ev-shelf-t", `${gameName}'s shelf`),
      h("span.cr-muted", [shelf.length ? `${shelf.length} on it` : null, waiting ? `${waiting} waiting to hear back` : null].filter(Boolean).join(" · "))),
    shelf.length
      ? h("div.ev-laurels", ...shelf.map(([e, m]) => {
          const text = laurelText(e, m.status);
          return h("button.ev-laurel", { type: "button", title: "Copy the laurel text", onclick: () => C.copy(text) },
            laurel(e, m.status, "ev-laurel-c"), h("span", h("span.ev-laurel-k", SHELF[m.status][1]), h("span.ev-laurel-n", e.name)));
        }))
      : h("p.cr-muted", "Nothing yet. Pick a free one below and mark it Applied.")));
  if (es.msg) wrap.append(h("p.cr-alert", es.msg));

  // Filters.
  const freeBox = h("input", { type: "checkbox", checked: es.free || undefined });
  const badgeBox = h("input", { type: "checkbox", checked: es.badgeFirst || undefined });
  badgeBox.addEventListener("change", () => { es.badgeFirst = badgeBox.checked; redraw(); });
  freeBox.addEventListener("change", () => { es.free = freeBox.checked; redraw(); });
  wrap.append(h("div.cr-row",
    C.chips(KINDS, es.kind, (v) => { es.kind = v; redraw(); }, "Kind"),
    C.chips([["open", "Open"], ["mine", "Marked"], ["all", "All"]], es.show, (v) => { es.show = v; redraw(); }, "Show"),
    h("label.cr-select", freeBox, h("span", "Free only")),
    h("label.cr-select", { title: "Events that hand out their own badge art, before the ones you'd make a laurel for yourself" }, badgeBox, h("span", "Own badge first"))));
  wrap.append(h("div.cr-row", h("span.cr-label", "How hard"),
    C.chips(ODDS, es.odds, (v) => { es.odds = v; redraw(); }, "How hard to get in"),
    es.odds !== "any" ? h("span.cr-muted", ODDS_TIP[es.odds]) : null));
  wrap.append(h("div.cr-row", h("span.cr-label", "Where"),
    C.chips(WHERE, es.where, (v) => { es.where = v; redraw(); }, "Where"),
    es.where !== "any" ? h("span.cr-muted", WHERE_TIP[es.where]) : null));

  const list = all.filter((e) => (es.kind === "all" || e.kind === es.kind)
    && (!es.free || /^free/i.test(e.cost || ""))
    && (es.where === "any" || regionOf(e) === es.where)
    && (es.odds === "any" || oddsOf(e) === es.odds)
    && (es.show === "all" || (es.show === "mine" ? !!mine(e) : isOpen(e, today) && mine(e)?.status !== "skipped")))
    .sort((a, b) => (es.badgeFirst ? !BADGES[a.key] - !BADGES[b.key] : 0) || sortKey(a) - sortKey(b) || a.name.localeCompare(b.name));

  wrap.append(list.length ? h("div.ev-list", ...list.map((e) => row(e, mine(e), appid, today, redraw)))
    : h("p.empty", es.show === "mine" ? `Nothing marked for ${gameName} yet.` : "Nothing matches."));
  wrap.append(addForm(redraw));
  wrap.append(h("p.cr-muted.ev-avoid", AVOID));
  return wrap;
}

function row(e, m, appid, today, redraw) {
  const { h } = C;
  const status = m?.status || "";
  const sel = h("select", { "aria-label": `Status for ${e.name}`, disabled: es.busy || undefined },
    ...STATUSES.map(([v, t]) => h("option", { value: v, selected: v === status || undefined }, t)));
  sel.addEventListener("change", () => save({ event: e.key, appid, status: sel.value }, redraw));
  const note = h("input.cr-input.ev-note", { value: m?.note || "", placeholder: "Note (login, what you sent…)", "aria-label": `Note for ${e.name}`, disabled: (!status || es.busy) || undefined });
  note.addEventListener("change", () => save({ event: e.key, appid, status, note: note.value }, redraw));

  const dl = dateOf(e.deadline);
  const days = dl ? Math.round((dl - today) / DAY) : null;
  const soon = days != null && days >= 0 && days <= 21;
  const deadline = e.deadline
    ? h("span", { class: `ev-date${soon ? " is-soon" : ""}` }, `Deadline ${fmt(e.deadline)}${e.deadline_est ? " (est.)" : ""}`,
        days != null && days >= 0 ? ` · ${days === 0 ? "today" : `in ${C.plural(days, "day")}`}` : days != null ? " · passed" : "")
    : h("span.ev-date", e.kind === "steam" ? "Opt in from Steamworks" : "No fixed deadline");
  const when = e.when ? h("span.ev-date", `Event ${fmt(e.when)}${e.when_est ? " (est.)" : ""}`) : null;

  return h("div", { class: `ev-item${status ? ` is-${status}` : ""}` },
    h("div.ev-top", laurel(e, status, "ev-crest", true),
      h("div.ev-name", e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener" }, e.name) : e.name,
        h("span.ev-tag", KIND_NAME[e.kind] || e.kind), e.cost ? h("span", { class: `ev-tag${/^free/i.test(e.cost) ? " is-free" : ""}` }, e.cost) : null,
        oddsOf(e) ? h("span", { class: `ev-tag is-${oddsOf(e)}`, title: ODDS_TIP[oddsOf(e)] }, ODDS.find(([v]) => v === oddsOf(e))[1]) : null,
        regionOf(e) ? h("span.ev-tag", { title: WHERE_TIP[regionOf(e)] }, WHERE.find(([v]) => v === regionOf(e))[1]) : null,
        e.custom ? h("span.ev-tag", "Yours") : null),
      sel),
    h("div.ev-dates", deadline, when),
    e.needs || e.prize ? h("div.ev-meta", e.needs ? h("span", h("b", "Needs "), e.needs) : null, e.prize ? h("span", h("b", "You get "), e.prize) : null) : null,
    e.note ? h("div.ev-why", e.note) : null,
    h("div.ev-foot", note,
      e.custom ? h("button.btn", { type: "button", disabled: es.busy || undefined, onclick: () => { if (confirm(`Remove ${e.name} from the list?`)) save({ remove: e.key }, redraw); } }, "Remove") : null));
}

// The laurel the game would put on its store page for this event, on Steam's dark blue: the event's own
// badge art when it hands one out (BADGES), otherwise one drawn the way most developers make theirs.
// In the list it's a button: the official one opens full size, a drawn one saves as a transparent PNG.
function laurel(e, status, cls, saveable) {
  const { h } = C;
  const badge = BADGES[e.key];
  if (badge) {
    const img = h("img", { src: `/images/badges/${badge}`, alt: `${e.name} badge`, loading: "lazy" });
    return saveable
      ? h("a", { class: `${cls} is-official`, href: `/images/badges/${badge}`, target: "_blank", rel: "noopener", title: "The event's own badge: open it full size" }, img)
      : h("span", { class: `${cls} is-official` }, img);
  }
  const svg = laurelSvg(laurelParts(e, status));
  const box = saveable
    ? h("button", { class: cls, type: "button", title: "Drawn here, the way most developers make theirs: save it as a PNG",
        onclick: () => saveLaurelPng(svg, `laurel-${e.key}.png`) })
    : h("span", { class: cls, "aria-hidden": "true" });
  box.innerHTML = svg;
  return box;
}

function addForm(redraw) {
  const { h } = C;
  if (!es.adding) return h("button.btn.ev-add", { type: "button", onclick: () => { es.adding = true; redraw(); } }, "+ Add an event");
  const f = { name: h("input.cr-input", { placeholder: "Name", required: true }), url: h("input.cr-input", { placeholder: "https://…", type: "url" }),
    cost: h("input.cr-input", { placeholder: "Free, $25…" }), deadline: h("input.cr-input", { type: "date" }), when: h("input.cr-input", { type: "date" }),
    note: h("input.cr-input", { placeholder: "Why it's worth it" }),
    kind: h("select", ...KINDS.slice(1).map(([v, t]) => h("option", { value: v }, t.replace(/s$/, "")))) };
  const field = (label, el) => h("label.cr-field", h("span", label), el);
  const form = h("form.ev-form",
    field("Name", f.name), field("Kind", f.kind), field("Link", f.url), field("Cost", f.cost),
    field("Deadline", f.deadline), field("Event date", f.when), field("Note", f.note),
    h("div.cr-row", h("button.btn.primary", { type: "submit", disabled: es.busy || undefined }, "Add"),
      h("button.btn", { type: "button", onclick: () => { es.adding = false; redraw(); } }, "Cancel")));
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const add = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
    if (await save({ add }, redraw)) es.adding = false;
    redraw();
  });
  return form;
}

let cssDone = false;
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const css = `
.ev { max-width: 820px; }
.ev .ev-intro { margin: 0 0 12px; font-size: 0.85rem; }
.ev .ev-shelf { background: var(--fb-card); border: 1px solid var(--fb-accent); border-radius: 12px; padding: 12px 16px; margin: 0 0 14px; }
.ev .ev-shelf-h { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin-bottom: 8px; }
.ev .ev-shelf-t { font-size: 1.1rem; font-weight: 700; color: var(--fb-title); }
.ev .ev-shelf p { margin: 0; }
.ev .ev-laurels { display: flex; flex-wrap: wrap; gap: 8px; }
.ev .ev-laurel { display: inline-flex; gap: 8px; align-items: center; font: inherit; text-align: left; cursor: pointer; background: var(--fb-card-2); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 10px; padding: 6px 12px 6px 8px; max-width: 100%; }
.ev .ev-laurel:hover { border-color: var(--fb-accent); }
.ev .ev-laurel-i { font-size: 1.4rem; line-height: 1; }
.ev .ev-laurel-k { display: block; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--fb-muted); }
.ev .ev-laurel-n { display: block; font-weight: 600; overflow-wrap: anywhere; }
.ev .ev-list { display: flex; flex-direction: column; gap: 8px; }
.ev .ev-item { background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-line); border-radius: 10px; padding: 10px 14px; }
.ev .ev-item.is-applied, .ev .ev-item.is-planned { border-left-color: var(--fb-accent); }
.ev .ev-item.is-in, .ev .ev-item.is-nominated, .ev .ev-item.is-won { border-left-color: var(--fb-positive); }
.ev .ev-item.is-rejected, .ev .ev-item.is-skipped { opacity: 0.65; }
.ev .ev-top { display: flex; gap: 10px; align-items: flex-start; justify-content: space-between; }
.ev .ev-crest { flex: none; width: 150px; aspect-ratio: 280 / 180; padding: 0; border: 0; border-radius: 8px; background: #1b2838; cursor: pointer; }
.ev .ev-crest:hover { outline: 2px solid var(--fb-accent); }
.ev .ev-crest svg, .ev .ev-laurel-c svg { width: 100%; height: 100%; display: block; }
.ev .ev-crest.is-official, .ev .ev-laurel-c.is-official { display: block; padding: 4px; box-sizing: border-box; }
.ev .ev-crest img, .ev .ev-laurel-c img { width: 100%; height: 100%; object-fit: contain; display: block; }
.ev .ev-top .ev-name { flex: 1; }
.ev .ev-laurel-c { flex: none; width: 84px; aspect-ratio: 280 / 180; border-radius: 6px; background: #1b2838; }
.ev .ev-top select { font: inherit; font-size: 0.85rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 4px 6px; flex: none; }
.ev .ev-name { font-weight: 700; color: var(--fb-title); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; min-width: 0; overflow-wrap: anywhere; }
.ev .ev-name a { color: var(--fb-title); text-decoration: none; }
.ev .ev-name a:hover { text-decoration: underline; }
.ev .ev-tag { font-size: 0.72rem; font-weight: 600; color: var(--fb-ink-2); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 999px; padding: 1px 8px; }
.ev .ev-tag.is-free { color: var(--fb-positive); border-color: var(--fb-positive); }
.ev .ev-tag.is-open { color: var(--fb-positive); }
.ev .ev-tag.is-curated { color: var(--fb-accent); }
.ev .ev-tag.is-selective { color: var(--fb-negative); }
.ev .ev-dates { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 4px; font-size: 0.85rem; color: var(--fb-ink-2); }
.ev .ev-date.is-soon { color: var(--fb-negative); font-weight: 600; }
.ev .ev-meta { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 4px; font-size: 0.85rem; color: var(--fb-ink-2); }
.ev .ev-meta b { color: var(--fb-muted); font-weight: 600; }
.ev .ev-why { margin-top: 4px; font-size: 0.85rem; color: var(--fb-muted); }
.ev .ev-foot { display: flex; gap: 8px; margin-top: 8px; }
.ev .ev-note { max-width: none; font-size: 0.8rem; padding: 4px 8px; }
.ev .ev-add { margin-top: 12px; }
.ev .ev-avoid { margin-top: 14px; }
.ev .ev-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px 12px; margin-top: 12px; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 12px 14px; }
.ev .ev-form select { font: inherit; font-size: 0.9rem; color: var(--fb-ink); background: var(--fb-card-2); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 8px; }
.ev .ev-form .cr-row { grid-column: 1 / -1; margin: 0; }
@media (max-width: 560px) { .ev .ev-top { flex-wrap: wrap; } .ev .ev-top select { flex-basis: 100%; } }
`;
  document.head.append(C.h("style", css));
}
