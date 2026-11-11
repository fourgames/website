// Redesign variant 1, "Inbox". One ranked stream of everything that needs the owner, a reading pane
// beside it, and done / snooze so it can reach zero. Plain DOM, no build step.
// Data: feedback/data (the private feedback-data checkout) when it is served next to this page,
// else the invented window.SAMPLE from sample.js. Same shape either way.
const DATA = "../../data";
const DAY = 86400, HOUR = 3600, now = Date.now() / 1000;

const $ = (tag, props = {}, ...kids) => {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(3)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
};
const get = async (p) => { try { const r = await fetch(`${DATA}/${p}`); return r.ok ? await r.json() : null; } catch { return null; } };
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const lastDays = (n, back = 0) => Array.from({ length: n }, (_, i) => iso(now - (n - 1 - i + back) * DAY));
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const plural = (n, w) => `${n} ${n === 1 ? w : w === "reply" ? "replies" : `${w}s`}`;
const fmt = (n) => n == null ? "–" : Math.abs(n) >= 10000 ? `${Math.round(n / 1000)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const money = (n) => n == null ? "–" : `$${Math.round(n).toLocaleString("en-US")}`;
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;
const ago = (t) => { const s = Math.max(0, now - t); return s < HOUR ? `${Math.max(1, Math.round(s / 60))} min` : s < DAY ? `${Math.round(s / HOUR)} h` : `${Math.round(s / DAY)} d`; };
const change = (a, b) => (!b ? "" : Math.abs((a - b) / b) < 0.05 ? "about the same" : `${a > b ? "up" : "down"} ${Math.round(Math.abs((a - b) / b) * 100)}%`);
const hueOf = (meta) => meta.hue ?? (meta.appId * 47) % 360;

// ---- importance ---------------------------------------------------------------------------------
// One score per row decides the order. Weights by what the thing is, not by when it arrived:
// a bug that came back or is urgent > refund notes > high bugs > unanswered negative reviews >
// new threads > videos > ideas > answered or positive posts. Replies are folded into their thread,
// YouTube comments into their video; neither gets a row. Anything scoring 45+ "needs you".
const NEEDS = 45;
const BUG = { urgent: 95, high: 80, medium: 55, low: 30 };
const POST_WEIGHT = { review: 4, topic: 4, video: 4, refund: 4, reply: 2, comment: 1 };
const KIND = { review: "Review", topic: "Thread", reply: "Reply", video: "Video", comment: "YouTube comment", refund: "Refund note" };
const fresh = (t) => (now - t < DAY ? 8 : now - t < 3 * DAY ? 4 : now - t > 14 * DAY ? -30 : 0);
const level = (score) => (score >= 80 ? 3 : score >= 55 ? 2 : score >= NEEDS ? 1 : 0);

let GAMES = [], ENTRIES = [], BY_ID = {}, IS_SAMPLE = false;

function derive(meta, g, data) {
  const id = String(meta.appId);
  const peakByDay = {};
  for (const [t, n] of g.players || []) { const d = iso(t); peakByDay[d] = Math.max(peakByDay[d] || 0, n); }
  const d30 = lastDays(30, 1), d7 = lastDays(7, 1), p7 = lastDays(7, 8); // whole days, ending yesterday
  const players = lastDays(30).map((d) => peakByDay[d] ?? 0);
  const rt = g.reviewTotals || {}, rKeys = Object.keys(rt).sort();
  const rAt = (d) => { const k = rKeys.filter((x) => x <= d).pop(); return k ? rt[k] : null; };
  const total = (r) => (r ? r.positive + r.negative : 0);
  const rNow = rAt(iso(now)), r7 = rAt(iso(now - 7 * DAY));
  const day = (d) => data.sales?.days?.[d]?.[id] || {};
  const wDays = data.wishlists?.apps?.[id]?.days || {};
  const wNet = (d) => { const x = wDays[d]; return x ? (x.adds || 0) - (x.deletes || 0) - (x.purchases || 0) - (x.gifts || 0) : 0; };
  const play = (data.steamworks?.apps?.[id]?.pages?.playtime || []).flatMap((t) => t.rows);
  const yesterday = iso(now - DAY);
  return {
    id, meta, g, hue: hueOf(meta), upcoming: meta.status === "upcoming",
    players, playersNow: (g.players || []).at(-1)?.[1] ?? null, peak7: Math.max(0, ...players.slice(-7)), peakPrev7: Math.max(0, ...players.slice(-14, -7)),
    pos: total(rNow) ? Math.round((rNow.positive / total(rNow)) * 100) : null, reviewsTotal: total(rNow), reviewsNew7: total(rNow) - total(r7),
    yesterday: day(yesterday), rev30: d30.map((d) => day(d).gross || 0), rev7: sum(d7.map((d) => day(d).gross)), revPrev7: sum(p7.map((d) => day(d).gross)), hasSales: d30.some((d) => day(d).gross),
    wish30: d30.map((d) => wDays[d]?.adds || 0), wish7: sum(d7.map(wNet)), wishPrev7: sum(p7.map(wNet)), wishYesterday: wNet(yesterday), hasWish: Object.keys(wDays).length > 0,
    median: play.find((r) => /^Median time played/.test(r[0]))?.[1],
    reach: play.filter((r) => /^\d+ (minutes?|hours?)/.test(r[0]) && /%$/.test(r[1] || "")).map((r) => ({ label: r[0].replace(/ hours?/, " h").replace(/ minutes?/, " min"), pct: parseFloat(r[1]) })),
  };
}

function build(data) {
  GAMES = data.index.games.map((m) => data.games[m.appId] && derive(m, data.games[m.appId], data)).filter(Boolean);
  ENTRIES = [];
  for (const x of GAMES) {
    const g = x.g, items = g.items || {};
    const add = (type, key, o) => ENTRIES.push({ id: `${x.id}:${type}:${key}`, type, game: x, ...o });
    const live = Object.values(items).filter((i) => !i.dev && !i.offTopic);
    const sumOf = (i) => i.triage?.summary || i.title || (i.text || "").slice(0, 160);
    const issuesOf = (ids) => Object.values(g.issues || {}).filter((s) => (s.items || []).some((id) => ids.includes(id)));

    for (const s of Object.values(g.issues || {})) {
      if (s.status === "likely_fixed") continue;
      const posts = (s.items || []).map((id) => items[id]).filter(Boolean);
      const back = s.status === "still_happening";
      const o = s.kind === "bug" ? { kind: "bug", why: back ? "Came back after a fix" : s.urgency ? `${s.urgency[0].toUpperCase()}${s.urgency.slice(1)} bug` : "Bug", score: (back ? 100 : BUG[s.urgency] ?? 45) + (now - s.lastSeen < DAY ? 4 : 0) }
        : s.kind === "suggestion" ? { kind: "idea", why: "Idea", score: 30 + Math.min(20, s.mentions || 0) }
        : { kind: "loved", why: "Loved", score: 12 + Math.min(10, Math.round((s.mentions || 0) / 2)) };
      add("issue", s.id, { ...o, title: s.title, sub: s.summary || "", at: s.lastSeen || s.firstSeen || now, issue: s, posts,
        facts: [plural(s.mentions || 0, "player"), s.negativeReviews ? plural(s.negativeReviews, "negative review") : null, s.refunds ? plural(s.refunds, "refund") : null].filter(Boolean).join(" · ") });
    }

    const replies = {}, comments = {}, notes = {};
    for (const i of live) {
      if (i.kind === "reply") { const t = items[i.topic] || items[i.topicId] || items[`t${i.topicId}`]; if (t) (replies[t.id] ||= []).push(i); }
      else if (i.kind === "comment" && i.media) (comments[i.media] ||= []).push(i);
      else if (i.kind === "video" && i.media) notes[i.media] = i;
    }
    for (const i of live) {
      if (now - i.created > 45 * DAY) continue;
      const base = { item: i, at: i.created, sub: i.kind === "topic" && i.triage?.summary ? i.triage.summary : (i.text || "").replace(/\s+/g, " ").slice(0, 200), linked: issuesOf([i.id]), draft: i.draft || "" };
      const who = i.author?.name;
      if (i.kind === "refund") add("post", i.id, { ...base, kind: "refund", why: "Refund note", title: i.refundReason ? `Refund: ${i.refundReason}` : "Refund note", score: 85 + fresh(i.created), facts: "Steamworks refund note" });
      else if (i.kind === "review") {
        const neg = i.votedUp === false, open = neg && !i.devResponse;
        add("post", i.id, { ...base, kind: neg ? "review" : "loved", reply: open, why: open ? (i.draft ? "Reply draft ready" : "Negative review, no answer") : neg ? "Negative review, answered" : "Positive review",
          title: sumOf(i), score: (open ? 75 + (i.draft ? 5 : 0) : neg ? 25 : 18) + fresh(i.created), facts: [who, i.playtime != null ? `${i.playtime} h played` : null].filter(Boolean).join(" · ") });
      } else if (i.kind === "topic") {
        const open = !i.devResponse, kids = (replies[i.id] || []).sort((a, b) => a.created - b.created);
        add("post", i.id, { ...base, kind: "thread", reply: open, kids, linked: issuesOf([i.id, ...kids.map((k) => k.id)]), why: open ? "New thread" : "Thread, answered", title: i.title || sumOf(i), score: (open ? 60 : 22) + fresh(i.created) + Math.min(6, kids.length * 2),
          facts: [who, kids.length ? `${plural(kids.length, "reply")} folded` : null].filter(Boolean).join(" · ") });
      } else if (i.kind === "reply" && !(items[i.topic] || items[i.topicId] || items[`t${i.topicId}`])) {
        add("post", i.id, { ...base, kind: "reply", why: "Reply", title: sumOf(i), score: 10 + fresh(i.created), facts: who || "" });
      }
    }
    // Videos, streams and articles. A video's row carries the notes on what the creator said and
    // its YouTube comments; the comments never get rows of their own.
    const media = Object.values(g.media?.items || {}).filter((m) => m.source !== "copy" && !m.own);
    for (const v of Object.values(notes)) if (!media.some((m) => m.id === v.media)) media.push({ id: v.media, source: "youtube", title: v.title, author: v.author?.name, url: v.url, at: v.created });
    for (const m of media) {
      if (now - m.at > 45 * DAY) continue;
      const kids = (comments[m.id] || []).sort((a, b) => b.created - a.created), note = notes[m.id];
      const src = m.source === "youtube" ? "Video" : m.source === "twitch" ? "Stream" : m.source === "reddit" ? "Reddit post" : "Article";
      const base = m.source === "youtube" ? 50 + Math.min(15, Math.round(Math.log10((m.views || 0) + 1) * 3)) : m.source === "twitch" ? 34 : 40;
      add("media", m.id, { kind: "media", media: m, note, kids, at: m.at, why: `New ${src.toLowerCase()}`, src, title: m.title || src, sub: note?.triage?.summary || "",
        linked: issuesOf([note?.id, ...kids.map((k) => k.id)].filter(Boolean)), score: base + fresh(m.at),
        facts: [m.author, m.views != null ? `${fmt(m.views)} views` : null, kids.length ? `${plural(kids.length, "comment")} folded` : null].filter(Boolean).join(" · ") });
    }
  }
  BY_ID = Object.fromEntries(ENTRIES.map((e) => [e.id, e]));
}

// ---- state --------------------------------------------------------------------------------------
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(`inbox-lab:${k}`)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`inbox-lab:${k}`, JSON.stringify(v)); } catch {} } };
const S = { scope: "all", filter: "inbox", sel: null, pane: null, q: "", marks: store.get("marks", {}) };
const FILTERS = [["inbox", "Inbox", "i"], ["bugs", "Bugs", "b"], ["ideas", "Ideas", "d"], ["loved", "Loved", "l"], ["media", "Media", "m"], ["reply", "To reply", "r"], ["all", "Everything", "e"]];
const AWAY = [["snoozed", "Snoozed"], ["done", "Done"]];
const NUMBERS = [["players", "Players", "p"], ["reviews", "Reviews", "v"], ["sales", "Sales", "s"], ["wishlists", "Wishlists", "w"]];
const PAGES = [["updates", "Updates"], ["achievements", "Achievements"], ["stats", "Steam stats"], ["curators", "Curators"], ["bundles", "Bundles"], ["competitors", "Competitors"]];
const phone = () => matchMedia("(max-width: 820px)").matches;
const scopeGame = () => GAMES.find((x) => x.id === S.scope) || null;
const scoped = () => { const x = scopeGame(); return x ? [x] : GAMES; };

const markOf = (e) => { const m = S.marks[e.id]; return !m ? "open" : m.done ? "done" : m.until > now ? "snoozed" : "open"; };
const inFilter = (e, f) => f === "inbox" ? e.score >= NEEDS : f === "bugs" ? e.kind === "bug" : f === "ideas" ? e.kind === "idea" : f === "loved" ? e.kind === "loved" : f === "media" ? e.type === "media" : f === "reply" ? !!e.reply : true;
const haystack = (e) => [e.title, e.sub, e.why, e.game.meta.name, e.facts, ...(e.kids || []).map((k) => k.text), ...(e.posts || []).map((p) => p.text)].join(" ").toLowerCase();
function list(filter = S.filter, scope = S.scope, q = S.q) {
  const away = filter === "done" || filter === "snoozed";
  return ENTRIES.filter((e) => (scope === "all" || e.game.id === scope) && (away ? markOf(e) === filter : markOf(e) === "open" && inFilter(e, filter)) && (!q || haystack(e).includes(q.toLowerCase())))
    .sort((a, b) => (away ? b.at - a.at : b.score - a.score || b.at - a.at));
}
const count = (filter, scope = S.scope) => list(filter, scope, "").length;

function setHash() {
  const h = `#${S.scope}/${S.filter}${S.pane ? `/~${S.pane}` : S.sel ? `/${S.sel}` : ""}`;
  if (location.hash !== h) history.replaceState(null, "", h);
}
function readHash() {
  const [scope, filter, ...rest] = decodeURIComponent(location.hash.slice(1)).split("/");
  const last = rest.join("/");
  if (scope && (scope === "all" || GAMES.some((x) => x.id === scope))) S.scope = scope;
  if (filter && [...FILTERS, ...AWAY].some(([k]) => k === filter)) S.filter = filter;
  S.pane = last.startsWith("~") ? last.slice(1) : null;
  if (BY_ID[last]) S.sel = last;
}

// ---- actions ------------------------------------------------------------------------------------
let undo = null, toastTimer = 0;
function toast(text, undoable = false) {
  const el = document.getElementById("toast");
  el.replaceChildren(text, undoable ? $("button", { onclick: doUndo }, "Undo") : null, undoable ? $("kbd", {}, "u") : null);
  el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
function mark(what) {
  const e = BY_ID[S.sel]; if (!e || S.pane) return;
  const rows = list(), at = rows.findIndex((r) => r.id === e.id), next = rows[at + 1] || rows[at - 1];
  const before = S.marks[e.id];
  const back = markOf(e) !== "open";
  if (back) delete S.marks[e.id]; else S.marks[e.id] = what === "done" ? { done: now } : { until: now + DAY };
  undo = () => { if (before) S.marks[e.id] = before; else delete S.marks[e.id]; S.sel = e.id; };
  store.set("marks", S.marks);
  S.sel = next && !phone() ? next.id : null;
  if (phone()) closeReader();
  draw();
  toast(back ? "Back in the inbox" : what === "done" ? "Done" : "Snoozed until tomorrow", true);
}
function doUndo() { if (!undo) return; undo(); undo = null; store.set("marks", S.marks); draw(); document.getElementById("toast").hidden = true; }
function go(patch) { Object.assign(S, patch); if ("scope" in patch || "filter" in patch) { if (!("sel" in patch)) S.sel = null; if (!("pane" in patch)) S.pane = null; } draw(); if (phone() && (S.sel || S.pane)) openReader(); }
function openEntry(id) { S.sel = id; S.pane = null; draw(); openReader(); }
function openPane(p) { S.pane = p; draw(); openReader(); }
const openReader = () => { if (phone()) document.getElementById("app").classList.add("reading"); document.getElementById("reader").scrollTop = 0; };
const closeReader = () => document.getElementById("app").classList.remove("reading");
function move(d) {
  const rows = list(); if (!rows.length) return;
  const at = rows.findIndex((r) => r.id === S.sel);
  const next = rows[Math.max(0, Math.min(rows.length - 1, S.pane || at < 0 ? 0 : at + d))];
  S.sel = next.id; S.pane = null; draw();
  document.querySelector('.row[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
async function copy(text, label = "Copied") { try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Couldn't copy"); } }

// ---- rail, strip, stream ------------------------------------------------------------------------
function renderRail() {
  const navBtn = (cur, onclick, kids) => $("button", { "aria-current": String(cur), onclick }, kids);
  document.getElementById("scopes").replaceChildren(
    navBtn(S.scope === "all", () => go({ scope: "all" }), [$("i.sw.all"), "All games", $("span.n", {}, count("inbox", "all") || "")]),
    ...GAMES.map((x) => navBtn(S.scope === x.id, () => go({ scope: x.id }), [$("i.sw", { style: `--hue:${x.hue}` }), x.meta.name, $("span.n", {}, count("inbox", x.id) || "")])));
  document.getElementById("filters").replaceChildren(...FILTERS.map(([k, label]) => navBtn(S.filter === k, () => go({ filter: k }), [label, $("span.n", {}, count(k) || "")])));
  document.getElementById("away").replaceChildren(...AWAY.map(([k, label]) => navBtn(S.filter === k, () => go({ filter: k }), [label, $("span.n", {}, count(k) || "")])));
  document.getElementById("source").textContent = IS_SAMPLE ? "Sample data (invented)" : "Your data, read locally";
}

function numbers() {
  const xs = scoped(), live = xs.filter((x) => !x.upcoming), one = xs.length === 1;
  const reviews = sum(live.map((x) => x.reviewsTotal)), pos = one ? live[0]?.pos : reviews ? Math.round(sum(live.map((x) => (x.pos || 0) * x.reviewsTotal)) / reviews) : null;
  return {
    players: { v: live.length ? fmt(sum(live.map((x) => x.playersNow))) : "–", sub: live.length ? "now" : "not out yet" },
    reviews: { v: pos != null ? `${pos}%` : "–", sub: live.length ? `${signed(sum(live.map((x) => x.reviewsNew7)))} this week` : "not out yet" },
    sales: { v: xs.some((x) => x.hasSales) ? money(sum(xs.map((x) => x.yesterday.gross))) : "–", sub: xs.some((x) => x.hasSales) ? "yesterday" : "not out yet" },
    wishlists: { v: xs.some((x) => x.hasWish) ? signed(sum(xs.map((x) => x.wish7))) : "–", sub: "7 days" },
  };
}
function renderStrip() {
  const n = numbers();
  document.getElementById("strip").replaceChildren(
    ...NUMBERS.map(([k, label]) => $("button.stat", { "aria-current": String(S.pane === k), onclick: () => openPane(k), title: `Open ${label.toLowerCase()} in the reading pane` },
      $("span.l", {}, label), $("span.v", {}, n[k].v, $("small", {}, n[k].sub)))),
    ...(scopeGame() ? [$("div.pages", {}, PAGES.map(([k, label]) => $("button", { "aria-current": String(S.pane === k), onclick: () => openPane(k) }, label)))] : []));
}

function rowEl(e) {
  const l = level(e.score);
  return $(`button.row${l ? "" : ".low"}`, { role: "option", "aria-selected": String(!S.pane && S.sel === e.id), onclick: () => openEntry(e.id) },
    $("span.imp", { "data-l": l, title: `Importance ${e.score}` }, $("i"), $("i"), $("i")),
    $("span.t", {}, e.title), $("span.when", {}, ago(e.at)),
    $("span.m", {}, $("span.why", {}, e.why), S.scope === "all" ? [" · ", $("b", {}, e.game.meta.name)] : null, e.facts ? ` · ${e.facts}` : ""),
    e.sub && e.sub !== e.title ? $("span.s", {}, e.sub) : null);
}
function renderStream() {
  const rows = list(), x = scopeGame();
  const label = [...FILTERS, ...AWAY].find(([k]) => k === S.filter)[1];
  const zero = S.q ? ["No matches", `Nothing here matches "${S.q}".`] : S.filter === "inbox" ? ["Inbox zero", "Nothing needs you right now."] : ["Nothing here", "This list is empty."];
  const shown = rows.slice(0, 200);
  document.getElementById("stream").replaceChildren(
    $("div.stream-head", {}, $("h1", {}, label), $("span.muted", {}, `${x ? x.meta.name : "All games"} · ${rows.length}`),
      $("span.hint", {}, ["done", "snoozed"].includes(S.filter) ? "newest first" : "most important first")),
    rows.length ? $("div", { role: "listbox", "aria-label": label }, shown.map(rowEl), rows.length > 200 ? $("p.zero", {}, `${rows.length - 200} more. Search or pick a filter to narrow it down.`) : null)
      : $("div.zero", {}, S.filter === "inbox" && !S.q ? $("div.ring", {}, "✓") : null, $("b", {}, zero[0]), zero[1]));
  return rows;
}

// ---- reading pane -------------------------------------------------------------------------------
const fact = (l, v, small) => $("div.fact", {}, $("div.l", {}, l), $("div.v", {}, v, small ? $("small", {}, small) : null));
const bars = (values, labels) => { const max = Math.max(1, ...values); return $("div.bars", {}, values.map((v, i) => $(`span${i === values.length - 1 ? ".hi" : ""}`, { style: `height:${(v / max) * 100}%`, title: `${labels[i]}: ${v}` }))); };
const meter = (label, pct, text) => $("div.meter", {}, $("span", {}, label), $("span.tr", {}, $("i", { style: `width:${Math.max(0, Math.min(100, pct))}%` })), $("span.r", {}, text));
const linkRow = (left, right, onclick) => $("button.link-row", { onclick }, $("span.g", {}, left), $("span.r", {}, right));

function postEl(i, small = false) {
  const head = i.kind === "review" ? (i.votedUp === false ? "Negative review" : "Positive review") : KIND[i.kind] || i.kind;
  const s = i.triage?.summary, text = i.text || "";
  return $(`div.post${small ? ".small" : ""}`, {},
    $("div.ph", {}, $("b", {}, head), [i.author?.name, i.playtime != null && i.kind === "review" ? `${i.playtime} h played` : null, i.refundReason, `${ago(i.created)} ago`, i.devResponse ? "answered" : null].filter(Boolean).map((t) => $("span", {}, t))),
    i.kind === "topic" || i.kind === "video" ? $("p.sum", {}, $("b", {}, i.title || "")) : null,
    s ? $("p.sum", {}, s) : null,
    text && text !== s ? $("p.orig", {}, text) : null);
}
function foldedComments(kids, open = false) {
  return kids.length ? $("details.folded", { open }, $("summary", {}, `${plural(kids.length, "YouTube comment")} (lowest weight, folded)`), kids.map((k) => postEl(k, true))) : null;
}
const linkedIssues = (e) => e.linked?.length ? [$("h2", {}, "Part of"), e.linked.map((s) => linkRow([$("b", {}, s.title)], `${s.kind === "bug" ? "Bug" : s.kind === "suggestion" ? "Idea" : "Loved"} · ${plural(s.mentions || 0, "player")}`, () => openEntry(`${e.game.id}:issue:${s.id}`)))] : null;

function entryDoc(e) {
  const x = e.game, eyebrow = $("div.eyebrow", {}, $("span.why", {}, e.why), $("span", {}, x.meta.name), $("span", {}, `${ago(e.at)} ago`), $("span.muted", { title: "The score that ranks the inbox" }, `importance ${e.score}`));
  if (e.type === "issue") {
    const s = e.issue, main = e.posts.filter((p) => p.kind !== "comment").sort((a, b) => POST_WEIGHT[b.kind] - POST_WEIGHT[a.kind] || b.created - a.created), kids = e.posts.filter((p) => p.kind === "comment");
    const patch = s.kind === "bug" ? `Fixed: ${s.title} (reported by ${plural(s.mentions || 0, "player")})` : `${s.title} (suggested by ${plural(s.mentions || 0, "player")})`;
    return [eyebrow, $("h1", {}, s.title), s.summary ? $("p.lead", {}, s.summary) : null,
      $("div.facts", {}, fact("Players", s.mentions || 0), s.kind === "bug" ? fact("Negative reviews", s.negativeReviews || 0) : null, s.kind !== "praise" ? fact("Refunds", s.refunds || 0) : null,
        s.firstSeen ? fact("First seen", ago(s.firstSeen), "ago") : null, fact("Last seen", ago(s.lastSeen || e.at), "ago")),
      $("div.actions", {}, s.fixPrompt ? $("button.btn.primary", { onclick: () => copy(s.fixPrompt, "Fix prompt copied") }, "Copy fix prompt") : null,
        s.kind !== "praise" ? $("button.btn", { onclick: () => copy(patch, "Patch-note line copied") }, "Copy patch-note line") : null),
      $("h2", {}, `${plural(e.posts.length, "post")} · reviews, threads, videos and refunds first`),
      main.length || kids.length ? [main.map((p) => postEl(p, p.kind === "reply")), foldedComments(kids)] : $("p.muted", {}, "No posts linked.")];
  }
  if (e.type === "media") {
    const m = e.media, lines = (e.note?.text || "").split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean);
    return [eyebrow, $("h1", {}, m.title),
      $("div.facts", {}, fact("By", m.author || "–"), m.views != null ? fact("Views", fmt(m.views)) : null, m.comments != null ? fact("Comments", fmt(m.comments)) : null, m.review?.verdict && m.review.verdict !== "unclear" ? fact("Creator's verdict", m.review.verdict) : null),
      $("div.actions", {}, m.url ? $("a.btn.primary", { href: m.url, target: "_blank", rel: "noopener" }, `Open ${e.src.toLowerCase()} ↗`) : null),
      e.sub ? [$("h2", {}, "In short"), $("p", {}, e.sub)] : null,
      lines.length ? [$("h2", {}, "What the creator said"), lines.map((l) => $("div.post.small", {}, $("p.sum", {}, l)))] : null,
      linkedIssues(e),
      e.kids.length ? [$("h2", {}, "Under the video"), foldedComments(e.kids)] : null];
  }
  const i = e.item, draft = $("textarea.draft", { placeholder: "Write a reply…", "aria-label": "Reply" });
  draft.value = e.draft;
  return [eyebrow, $("h1", {}, e.title),
    $("div.facts", {}, i.author?.name ? fact(i.kind === "review" ? "Player" : "By", i.author.name) : null, i.kind === "review" && i.playtime != null ? fact("Played", i.playtime, "h") : null,
      i.kind === "review" ? fact("Recommends", i.votedUp === false ? "No" : "Yes") : null, i.refundReason ? fact("Reason", i.refundReason) : null, i.triage?.language ? fact("Language", i.triage.language) : null),
    i.text ? [$("h2", {}, i.kind === "refund" ? "The note" : "In their words"), $("p.orig", { style: "white-space:pre-line;border-left:2px solid var(--line);padding-left:12px;color:var(--ink2)" }, i.text)] : null,
    i.devResponse ? [$("h2", {}, "Your answer"), $("p", {}, i.devResponse)] : null,
    e.kids?.length ? [$("h2", {}, plural(e.kids.length, "reply")), e.kids.map((k) => postEl(k, true))] : null,
    linkedIssues(e),
    e.reply ? [$("h2", {}, e.draft ? "Reply draft" : "Reply"), draft,
      $("div.actions", {}, $("button.btn.primary", { onclick: () => copy(draft.value, "Reply copied") }, "Copy reply"), i.url ? $("a.btn", { href: i.url, target: "_blank", rel: "noopener" }, "Open on Steam ↗") : null)]
      : i.url ? $("div.actions", {}, $("a.btn", { href: i.url, target: "_blank", rel: "noopener" }, i.kind === "refund" ? "Open in Steamworks ↗" : "Open on Steam ↗")) : null];
}

// Numbers open here instead of on their own tabs. All games: one table, one row per game.
function numberDoc(kind) {
  const xs = scoped(), one = scopeGame(), n = numbers()[kind], d30 = lastDays(30, 1);
  const head = (title, lead) => [$("div.eyebrow", {}, $("span", {}, one ? one.meta.name : "All games")), $("h1", {}, title), lead ? $("p.lead", {}, lead) : null];
  const table = (cols, row) => $("table.tbl", {}, $("tr", {}, ["Game", ...cols].map((c) => $("th", {}, c))),
    xs.map((x) => $("tr.click", { onclick: () => go({ scope: x.id, pane: kind }) }, $("td", {}, x.meta.name), row(x).map((c, i) => $(`td${i ? "" : ".strong"}`, {}, c)))));
  const tableNote = one ? null : $("p.muted", { style: "margin-top:10px" }, "Click a game for its own chart.");
  if (kind === "sales") {
    const y = (x) => x.yesterday, tot = sum(xs.map((x) => y(x).gross)), rev30 = d30.map((_, i) => sum(xs.map((x) => x.rev30[i]))), r7 = sum(xs.map((x) => x.rev7)), p7 = sum(xs.map((x) => x.revPrev7));
    return [head("Sales", "Gross, in whole days. Yesterday is the last bar."),
      $("div.facts", {}, fact("Yesterday", money(tot), `${fmt(sum(xs.map((x) => y(x).units)))} sold`), fact("Net yesterday", money(sum(xs.map((x) => y(x).net)))), fact("7 days", money(r7), change(r7, p7)), fact("30 days", money(sum(rev30)))),
      $("h2", {}, "Per day, 30 days"), bars(rev30, d30),
      one ? (sum(xs.map((x) => y(x).refunds)) ? $("p.note", {}, `${plural(sum(xs.map((x) => y(x).refunds)), "refund")} yesterday.`) : null)
        : [$("h2", {}, "Per game"), table(["Yesterday", "Sold", "7 days", "vs week before", "30 days"], (x) => x.hasSales ? [money(y(x).gross), fmt(y(x).units), money(x.rev7), change(x.rev7, x.revPrev7) || "–", money(sum(x.rev30))] : ["–", "–", "–", "not out yet", "–"]), tableNote]];
  }
  if (kind === "players") {
    const p30 = lastDays(30).map((_, i) => sum(xs.map((x) => x.players[i])));
    return [head("Players", "Most players at once, per day."),
      $("div.facts", {}, fact("Now", n.v), fact("Best day, 7 days", fmt(sum(xs.map((x) => x.peak7))), change(sum(xs.map((x) => x.peak7)), sum(xs.map((x) => x.peakPrev7)))), one?.median ? fact("Median playtime", one.median.replace(/ hours?/, " h").replace(/ minutes?/, " min")) : null),
      $("h2", {}, "Per day, 30 days"), bars(p30, lastDays(30)),
      one ? null : [$("h2", {}, "Per game"), table(["Now", "Best day, 7 d", "vs week before"], (x) => x.upcoming ? ["–", "–", "not out yet"] : [fmt(x.playersNow), fmt(x.peak7), change(x.peak7, x.peakPrev7) || "–"]), tableNote]];
  }
  if (kind === "reviews") {
    const recent = ENTRIES.filter((e) => e.item?.kind === "review" && (S.scope === "all" || e.game.id === S.scope)).sort((a, b) => b.at - a.at).slice(0, 8);
    return [head("Reviews"),
      $("div.facts", {}, fact("Positive", n.v), fact("In all", fmt(sum(xs.map((x) => x.reviewsTotal)))), fact("New this week", signed(sum(xs.map((x) => x.reviewsNew7)))), fact("Waiting for an answer", count("reply"))),
      one ? null : [$("h2", {}, "Per game"), table(["Positive", "In all", "This week"], (x) => x.upcoming ? ["–", "–", "not out yet"] : [x.pos != null ? `${x.pos}%` : "–", fmt(x.reviewsTotal), signed(x.reviewsNew7)])],
      $("h2", {}, "Latest"), recent.length ? recent.map((e) => linkRow([$("b", {}, e.item.votedUp === false ? "👎 " : "👍 "), e.title], `${one ? "" : `${e.game.meta.name} · `}${ago(e.at)}`, () => openEntry(e.id))) : $("p.muted", {}, "No reviews yet.")];
  }
  const w30 = d30.map((_, i) => sum(xs.map((x) => x.wish30[i])));
  return [head("Wishlists", "Net is adds minus removals, purchases and gifts."),
    $("div.facts", {}, fact("Net, 7 days", n.v, change(sum(xs.map((x) => x.wish7)), sum(xs.map((x) => x.wishPrev7)))), fact("Net yesterday", signed(sum(xs.map((x) => x.wishYesterday)))), fact("Adds, 30 days", fmt(sum(w30)))),
    $("h2", {}, "Adds per day, 30 days"), bars(w30, d30),
    one ? null : [$("h2", {}, "Per game"), table(["Net, 7 d", "Yesterday", "Adds, 30 d"], (x) => [signed(x.wish7), signed(x.wishYesterday), fmt(sum(x.wish30))]), tableNote]];
}

// The quieter per-game pages (Updates, Achievements, Steam stats, Curators, Bundles, Competitors)
// also open in the reading pane, from the strip.
function pageDoc(kind) {
  const x = scopeGame(); if (!x) return [$("h1", {}, "Pick a game"), $("p.lead", {}, "This page belongs to one game. Pick one in the rail.")];
  const g = x.g, head = (t, lead) => [$("div.eyebrow", {}, $("span", {}, x.meta.name)), $("h1", {}, t), lead ? $("p.lead", {}, lead) : null], none = (t) => $("p.muted", {}, t);
  if (kind === "updates") {
    const rs = (g.releases || []).slice().sort((a, b) => b.time - a.time);
    return [head("Updates", "Each update, and the bugs seen since."), rs.length ? rs.slice(0, 20).map((r) => {
      const since = ENTRIES.filter((e) => e.game === x && e.kind === "bug" && e.issue.lastSeen > r.time).length;
      return $("div.post", {}, $("div.ph", {}, $("b", {}, r.version ? `v${r.version}` : r.name), $("span", {}, `${ago(r.time)} ago`)), $("p.sum", {}, r.name), $("p.sum.muted", {}, since ? `${plural(since, "open bug")} reported since` : "No open bugs reported since"));
    }) : none("No updates yet.")];
  }
  if (kind === "achievements") {
    const l = (g.achievements?.list || []).slice().sort((a, b) => b.percent - a.percent);
    return [head("Achievements", "Share of players who have each one."), l.length ? l.slice(0, 40).map((a) => meter(a.name, a.percent, `${Math.round(a.percent * 10) / 10}%`)) : none("None yet.")];
  }
  if (kind === "stats") return [head("Steam stats", "From Steamworks: how long players stay."),
    $("div.facts", {}, fact("Median playtime", x.median ? x.median.replace(/ hours?/, " h").replace(/ minutes?/, " min") : "–"), fact("Best day, 7 days", fmt(x.peak7), "players")),
    x.reach.length ? [$("h2", {}, "Played at least"), x.reach.map((r) => meter(r.label, r.pct, `${r.pct}%`))] : none("No Steamworks numbers yet.")];
  if (kind === "curators") {
    const l = g.curators?.list || [];
    return [head("Curators", "Most followers first."), l.length ? l.slice(0, 30).map((c) => $("div.link-row", {}, $("span.g", {}, $("b", {}, c.name)), $("span.r", {}, `${(c.state || "").replace("_", " ")} · ${fmt(c.followers)} followers`))) : none("No curators yet.")];
  }
  if (kind === "bundles") {
    const l = g.bundles?.list || [];
    return [head("Bundles", "The Steam bundles this game is in."), l.length ? l.map((b) => $("div.link-row", {}, $("span.g", {}, $("b", {}, b.name)), $("span.r", {}, [Array.isArray(b.apps) ? plural(b.apps.length, "game") : b.apps ? plural(b.apps, "game") : null, b.bundleDiscount ? `−${b.bundleDiscount}%` : null].filter(Boolean).join(" · ")))) : none("Not in a bundle.")];
  }
  const l = Object.values(g.competitors || {});
  return [head("Competitors", "The games you compare this one with."), l.length ? l.map((c) => $("div.link-row", {}, $("span.g", {}, $("b", {}, c.name)), $("span.r", {}, "players and reviews compared in the full build"))) : none("None picked yet.")];
}

function diffDoc() {
  const tasks = [
    ["See what needs attention across all games", "1", "Open All games, then scan Needs attention, Live now and All posts.", "0", "It is the page you land on, already ranked."],
    ["Open the top bug of one game and read its posts", "3", "Game, Bugs, Show posts.", "1", "Click the row; its posts are in the pane. 0 when it tops the inbox."],
    ["See yesterday's sales for one game", "2", "Game, Sales.", "1", "Sales in the strip lists every game's yesterday. The total shows with 0."],
    ["Find new videos about a game", "2", "Game, Media. Comments sit apart in All posts.", "1", "Media. New videos are also in the inbox already, comments folded inside."],
  ];
  return [$("div.eyebrow", {}, $("span.why", {}, "Variant 1")), $("h1", {}, "What's different"),
    $("p.lead", {}, "The dashboard as a mail client: one ranked list, a reading pane, and a way to finish."),
    $("h2", {}, "Three ideas"),
    $("ol.ideas", {},
      $("li", {}, $("span", {}, $("b", {}, "One list, ranked by importance. "), "Bugs, reviews, threads, videos and refund notes from every game share one stream. A score orders them, not the clock. Replies fold into their thread and YouTube comments into their video.")),
      $("li", {}, $("span", {}, $("b", {}, "Nothing opens a new page. "), "Posts, issues, videos, sales and the quieter pages all open in the pane on the right. The list stays where it was.")),
      $("li", {}, $("span", {}, $("b", {}, "It can reach zero. "), "Mark a row done or snooze it until tomorrow, from the keyboard. What's left is what still needs you."))),
    $("h2", {}, "Clicks"),
    $("table.tbl", {}, $("tr", {}, ["Task", "Today", "Inbox"].map((t) => $("th", {}, t))),
      tasks.map(([t, a, an, b, bn]) => $("tr", {}, $("td", {}, $("b", {}, t), $("div.muted", { style: "font-size:12px" }, `Today: ${an} Inbox: ${bn}`)), $("td", {}, a), $("td.strong", {}, b))),
      $("tr", {}, $("td", {}, $("b", {}, "All four")), $("td", {}, "8"), $("td.strong", {}, "3"))),
    $("h2", {}, "Keyboard"),
    $("div.keys", {}, [["j  k", "Next, previous row"], ["e", "Done (or back to the inbox)"], ["s", "Snooze until tomorrow"], ["u", "Undo"], ["/", "Search"], ["g a", "All games"], ["g 1 … 9", "A game"],
      ["g i  b  d  l  m  r  e", "Inbox, Bugs, Ideas, Loved, Media, To reply, Everything"], ["g s  p  v  w", "Sales, Players, Reviews, Wishlists"], ["?", "This panel"], ["Esc", "Close"]].map(([k, t]) => [$("span", {}, k.split("  ").map((x) => [$("kbd", {}, x), " "])), $("span", {}, t)])),
    $("h2", {}, "Where things went"),
    $("p", {}, "Bugs, Ideas, Loved, Media and To reply are filters in the rail. All posts is Everything. Sales, Players, Reviews and Wishlists are the strip. Updates, Achievements, Steam stats, Curators, Bundles and Competitors appear in the strip once you pick a game."),
    $("p", {}, $("a", { href: "home.html" }, "The public home page in the same style →")),
    $("h2", {}, "Faked or unfinished"),
    $("p.muted", {}, IS_SAMPLE ? "All data here is invented sample data." : "This is your data, read from feedback/data on this machine.", " Reply drafts are sample text; nothing is sent to Steam. Done and snooze are kept in this browser only. Mark fixed, Live now, the market, creators and events tools, and the status and cost pages are not rebuilt. Competitors, bundles and curators are short lists, not the full views.")];
}

function renderReader(rows) {
  const reader = document.getElementById("reader"), e = !S.pane && BY_ID[S.sel];
  const back = $("button.btn.quiet.back", { onclick: () => { closeReader(); } }, "← Back");
  let bar, doc;
  if (e) {
    const at = rows.findIndex((r) => r.id === e.id), away = markOf(e) !== "open";
    bar = [back, $("button.btn", { onclick: () => mark("done") }, away ? "Back to inbox" : "Done", $("kbd.hide-phone", {}, "e")),
      away ? null : $("button.btn", { onclick: () => mark("snooze") }, "Snooze", $("kbd.hide-phone", {}, "s")),
      $("span.sp"), at >= 0 ? $("span.muted.num", {}, `${at + 1} of ${rows.length}`) : null,
      $("button.btn.quiet.hide-phone", { onclick: () => move(-1), "aria-label": "Previous" }, "↑"), $("button.btn.quiet.hide-phone", { onclick: () => move(1), "aria-label": "Next" }, "↓")];
    doc = entryDoc(e);
  } else if (S.pane) {
    bar = [back, $("span.muted", {}, S.pane === "diff" ? "About this variant" : NUMBERS.some(([k]) => k === S.pane) ? "Numbers" : "Game page"), $("span.sp"),
      $("button.btn.quiet", { onclick: () => { S.pane = null; closeReader(); draw(); } }, "Close", $("kbd.hide-phone", {}, "Esc"))];
    doc = S.pane === "diff" ? diffDoc() : NUMBERS.some(([k]) => k === S.pane) ? numberDoc(S.pane) : pageDoc(S.pane);
  } else {
    bar = [back, $("span.muted", {}, "Nothing selected")];
    doc = [$("div.zero", {}, $("b", {}, rows.length ? "Pick a row" : "All clear"), rows.length ? "Its posts, numbers and actions show here." : "Nothing in this list.")];
  }
  reader.replaceChildren($("div.reader-bar", {}, bar), $("div.doc", {}, doc));
}

function draw() {
  let rows = list();
  // Desktop always has something in the pane: the top row unless a number or page is open.
  if (!S.pane && !rows.some((r) => r.id === S.sel) && !(S.sel && BY_ID[S.sel] && S.keep) && !phone()) S.sel = rows[0]?.id || null;
  S.keep = false;
  renderRail(); renderStrip(); rows = renderStream(); renderReader(rows); setHash();
}

// ---- keyboard -----------------------------------------------------------------------------------
let gWait = 0;
document.addEventListener("keydown", (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const q = document.getElementById("q"), typing = /^(INPUT|TEXTAREA)$/.test(ev.target.tagName);
  if (ev.key === "Escape") {
    if (typing) { if (ev.target === q) { q.value = ""; S.q = ""; draw(); } ev.target.blur(); }
    else if (S.pane) { S.pane = null; closeReader(); draw(); } else closeReader();
    return;
  }
  if (typing) return;
  const k = ev.key;
  if (gWait) {
    clearTimeout(gWait); gWait = 0;
    const f = FILTERS.find((x) => x[2] === k), n = NUMBERS.find((x) => x[2] === k);
    if (k === "a") go({ scope: "all" }); else if (/^[1-9]$/.test(k) && GAMES[k - 1]) go({ scope: GAMES[k - 1].id });
    else if (f) go({ filter: f[0] }); else if (n) openPane(n[0]); else return;
    ev.preventDefault(); return;
  }
  const act = { j: () => move(1), k: () => move(-1), ArrowDown: () => move(1), ArrowUp: () => move(-1), e: () => mark("done"), s: () => mark("snooze"), u: doUndo,
    "/": () => q.focus(), "?": () => openPane("diff"), g: () => { gWait = setTimeout(() => { gWait = 0; }, 1200); }, Enter: () => { if (S.sel) openReader(); } }[k];
  if (act) { ev.preventDefault(); act(); }
});

// ---- start --------------------------------------------------------------------------------------
(async () => {
  let data = null;
  // Python's http.server lists feedback/, so look there first: no 404 in the console when the
  // private data isn't on this machine.
  const listing = await fetch("../../").then((r) => (r.ok ? r.text() : ""), () => "");
  const index = !listing || /href="data\/"/.test(listing) ? await get("index.json") : null;
  if (index?.games?.length) {
    const [sales, wishlists, steamworks, ...games] = await Promise.all([get("sales.json"), get("wishlists.json"), get("steamworks.json"), ...index.games.map((m) => get(`games/${m.appId}.json`))]);
    data = { index, sales, wishlists, steamworks, games: Object.fromEntries(index.games.map((m, i) => [m.appId, games[i]])) };
  } else { data = window.SAMPLE; IS_SAMPLE = true; }
  build(data);
  readHash();
  document.getElementById("q").addEventListener("input", (ev) => { S.q = ev.target.value.trim(); S.sel = null; draw(); });
  document.getElementById("diff").addEventListener("click", () => openPane("diff"));
  document.getElementById("theme").addEventListener("click", () => {
    const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark"; try { localStorage.setItem("inbox-lab:theme", root.dataset.theme); } catch {}
  });
  addEventListener("hashchange", () => { readHash(); draw(); });
  draw();
  document.querySelector('.row[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  if (phone() && (S.pane || (S.sel && location.hash.split("/").length > 2))) openReader();
})();
