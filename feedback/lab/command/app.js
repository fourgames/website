// Command center: one board for all games, one board per game, and a drawer for every detail.
// No tabs and no page changes: clicking a number, a game or an item opens the drawer over the right
// side; Escape closes it. The range control (24 h, 7 d, 30 d) drives every panel and the drawer.
import { loadData, NOW, WEIGHT } from "./data.js";

const DAY = 86400;
const RANGES = { "24h": { days: 1, label: "24 h" }, "7d": { days: 7, label: "7 d" }, "30d": { days: 30, label: "30 d" } };
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
const S = { data: null, range: RANGES[store.get("cc-range")] ? store.get("cc-range") : "7d", drawer: [], filter: "all", opener: null };

// ---- small helpers ------------------------------------------------------------------------------
const NS = "http://www.w3.org/2000/svg";
function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split(".");
  const el = document.createElement(name || "div");
  if (cls.length) el.className = cls.join(" ");
  for (const [k, v] of Object.entries(props || {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(3)) if (k != null && k !== false && k !== "") el.append(k.nodeType ? k : String(k));
  return el;
}
const s = (tag, attrs = {}) => { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };
const fmt = (n) => n == null ? "–" : Math.abs(n) >= 10000 ? `${Math.round(n / 1000)}k` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const money = (n) => n == null ? "–" : `$${n >= 10000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n)}`;
const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
const ago = (t) => { const d = NOW - t; return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < DAY ? `${Math.round(d / 3600)}h` : `${Math.round(d / DAY)}d`; };
const dayLabel = (i, n) => new Date((NOW - (n - 1 - i) * DAY) * 1000).toLocaleDateString("en", { month: "short", day: "numeric" });
const sum = (a) => a.reduce((x, y) => x + y, 0);
const R = () => RANGES[S.range];
const game = (id) => S.data.games.find((g) => g.id === id);
const KIND = { review: "Review", topic: "Thread", video: "Video", refund: "Refund", reply: "Reply", comment: "Comment" };

function delta(a, b, invert = false) {
  if (b == null || !b || a == null) return null;
  const d = (a - b) / b;
  if (Math.abs(d) < 0.03) return h("span.muted", null, "≈");
  return h(`span.${(invert ? d < 0 : d > 0) ? "good" : "bad"}`, null, `${d > 0 ? "▲" : "▼"}${Math.round(Math.abs(d) * 100)}%`);
}

// A sparkline: thin line, last value dotted. One hue; the number beside it carries the value.
function spark(values, w = 46, ht = 18) {
  const svg = s("svg", { width: w, height: ht, viewBox: `0 0 ${w} ${ht}`, "aria-hidden": "true" });
  if (!values.some((x) => x)) return svg;
  const max = Math.max(...values), min = Math.min(0, ...values);
  const pt = (x, i) => [((i / Math.max(1, values.length - 1)) * (w - 5) + 2).toFixed(1), (ht - 3 - ((x - min) / (max - min || 1)) * (ht - 6)).toFixed(1)];
  svg.append(s("path", { d: values.map((x, i) => (i ? "L" : "M") + pt(x, i).join(",")).join(""), fill: "none", stroke: "var(--accent)", "stroke-width": 1.5, "stroke-linejoin": "round" }));
  const [cx, cy] = pt(values.at(-1), values.length - 1);
  svg.append(s("circle", { cx, cy, r: 2, fill: "var(--accent)" }));
  return svg;
}

// A chart with one series and one axis: bars or a line, a hover tooltip, first and last date labelled.
function chart(values, labels, { fmt: f = fmt, type = "bar", ht = 120 } = {}) {
  const W = 600, pad = { l: 2, r: 2, t: 14, b: 16 }, n = values.length, max = Math.max(1, ...values);
  const step = (W - pad.l - pad.r) / n, y = (v) => pad.t + (1 - v / max) * (ht - pad.t - pad.b), base = ht - pad.b;
  const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${ht}`, role: "img", "aria-label": `${labels[0]} to ${labels.at(-1)}, highest ${f(max)}` });
  svg.append(s("line", { x1: 0, x2: W, y1: y(max), y2: y(max), stroke: "var(--line)", "stroke-dasharray": "2 4" }), s("line", { x1: 0, x2: W, y1: base, y2: base, stroke: "var(--line2)" }));
  const marks = [];
  if (type === "bar") values.forEach((v, i) => { const bh = Math.max(v ? 1.5 : 0, base - y(v)), bw = Math.max(2, step - 2); const r = s("rect", { x: pad.l + i * step + 1, y: base - bh, width: bw, height: bh, rx: Math.min(2, bw / 2), fill: "var(--accent)" }); marks.push(r); svg.append(r); });
  else {
    svg.append(s("path", { d: values.map((v, i) => `${i ? "L" : "M"}${(pad.l + (i + 0.5) * step).toFixed(1)},${y(v).toFixed(1)}`).join(""), fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round" }));
    const dot = s("circle", { r: 4, fill: "var(--accent)", stroke: "var(--panel)", "stroke-width": 2, visibility: "hidden" }); svg.append(dot); marks.dot = dot;
  }
  const text = (x, yy, anchor, str) => { const t = s("text", { x, y: yy, "text-anchor": anchor }); t.textContent = str; svg.append(t); };
  text(0, 9, "start", f(max)); text(0, ht - 3, "start", labels[0]); text(W, ht - 3, "end", labels.at(-1));
  const tip = h("div.tip", { hidden: true }), box = h("div.chartbox", null, svg, tip);
  const move = (e) => {
    const rect = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - rect.left) / rect.width) * n)));
    tip.hidden = false; tip.textContent = `${labels[i]}  ${f(values[i])}`;
    tip.style.left = `${svg.offsetLeft + ((i + 0.5) / n) * rect.width}px`; tip.style.top = `${svg.offsetTop + (y(values[i]) / ht) * rect.height}px`;
    if (marks.dot) { marks.dot.setAttribute("cx", pad.l + (i + 0.5) * step); marks.dot.setAttribute("cy", y(values[i])); marks.dot.setAttribute("visibility", "visible"); }
    else marks.forEach((m, j) => m.setAttribute("opacity", j === i ? 1 : 0.45));
  };
  const leave = () => { tip.hidden = true; if (marks.dot) marks.dot.setAttribute("visibility", "hidden"); else marks.forEach((m) => m.removeAttribute("opacity")); };
  svg.addEventListener("pointermove", move); svg.addEventListener("pointerdown", move); svg.addEventListener("pointerleave", leave);
  return box;
}

// ---- numbers for one game in the chosen range ---------------------------------------------------
const RANK = { urgent: 3, high: 2, medium: 1, low: 0 };
const issueScore = (i) => (i.status === "still_happening" ? 400 : 0) + (RANK[i.urgency] || 0) * 100 + i.mentions + i.refunds * 5;
const kids = (g, p) => g.posts.filter((x) => x.parent === p.id);

function metrics(g) {
  const n = R().days, since = NOW - n * DAY, show = Math.max(7, n);
  const lastN = (a) => sum(a.slice(30 - n)), prevN = (a) => n <= 15 ? sum(a.slice(30 - 2 * n, 30 - n)) : null;
  const peaks = (days) => Array.from({ length: days }, (_, i) => Math.max(...g.hourly.slice(720 - (days - i) * 24, 720 - (days - i - 1) * 24)));
  const inRange = g.posts.filter((p) => p.t > since);
  const open = g.issues.filter((i) => i.kind === "bug").sort((a, b) => issueScore(b) - issueScore(a));
  const perDay = (list) => Array.from({ length: show }, (_, i) => list.filter((p) => p.t > NOW - (show - i) * DAY && p.t <= NOW - (show - i - 1) * DAY).length);
  const main = g.posts.filter((p) => WEIGHT[p.kind] >= 4);
  return { n, since, show,
    playersNow: g.hourly.at(-1), playersPeak: Math.max(...g.hourly.slice(-n * 24)), playersPrev: n <= 15 ? Math.max(...g.hourly.slice(-2 * n * 24, -n * 24)) : null,
    playersSeries: n === 1 ? g.hourly.slice(-24) : peaks(n), playersLabels: n === 1 ? Array.from({ length: 24 }, (_, i) => `${23 - i}h ago`) : Array.from({ length: n }, (_, i) => dayLabel(i, n)),
    reviewsNew: lastN(g.d.pos) + lastN(g.d.neg), reviewsNeg: lastN(g.d.neg), reviewsSeries: g.d.pos.slice(-show).map((x, i) => x + g.d.neg.slice(-show)[i]),
    wishNet: lastN(g.d.wish), wishSeries: g.d.wish.slice(-show),
    salesY: g.d.gross[28], salesYPrev: g.d.gross[27], salesRange: n === 1 ? g.d.gross[28] : lastN(g.d.gross), salesPrev: prevN(g.d.gross), sales30: sum(g.d.gross), salesSeries: g.d.gross.slice(-show), units: lastN(g.d.units),
    bugs: open, bugsHot: open.filter((i) => RANK[i.urgency] >= 2 || i.status === "still_happening").length, bugsNew: open.filter((i) => i.firstSeen > since).length,
    posts: inRange.filter((p) => WEIGHT[p.kind] >= 4), minor: inRange.filter((p) => p.kind === "reply").length, postsSeries: perDay(main),
    media: g.media.filter((m) => m.live || m.t > since), videos: g.media.filter((m) => m.source === "youtube" && m.t > since).length, live: g.media.filter((m) => m.live),
    labels: Array.from({ length: show }, (_, i) => dayLabel(i, show)) };
}

// What needs attention, most pressing first. Everything is limited to the chosen range.
function attention(games) {
  const out = [];
  for (const g of games) {
    const m = metrics(g);
    for (const b of m.bugs.filter((i) => i.lastSeen > m.since && (RANK[i.urgency] >= 2 || i.status === "still_happening")))
      out.push({ score: issueScore(b), tag: b.status === "still_happening" ? "Back" : b.urgency, cls: b.urgency === "urgent" || b.status === "still_happening" ? "urgent" : "high", g, title: b.title,
        sub: `${b.mentions} players${b.refunds ? ` · ${b.refunds} refunds` : ""}${b.status === "still_happening" ? ` · still there after ${b.fixedIn}` : ""} · ${ago(b.lastSeen)}`, open: { type: "issue", gid: g.id, id: b.id } });
    const refunds = g.posts.filter((p) => p.kind === "refund" && p.t > m.since);
    if (refunds.length) out.push({ score: 180 + refunds.length * 10, tag: "Refund", cls: "refund", g, title: `${refunds.length} refund note${refunds.length > 1 ? "s" : ""}`, sub: refunds[0].summary, open: { type: "posts", gid: g.id, filter: "refund" } });
    const neg = g.posts.filter((p) => p.kind === "review" && p.up === false && !p.answered && p.t > m.since);
    if (neg.length) out.push({ score: 120 + neg.length * 10, tag: "Review", cls: "neg", g, title: `${neg.length} negative review${neg.length > 1 ? "s" : ""} unanswered`, sub: neg[0].summary, open: { type: "reviews", gid: g.id } });
    if (m.salesPrev && m.salesRange < m.salesPrev * 0.75) out.push({ score: 90, tag: "Sales", cls: "warn", g, title: `Sales down ${Math.round((1 - m.salesRange / m.salesPrev) * 100)}%`, sub: `${money(m.salesRange)} vs ${money(m.salesPrev)} the ${R().label} before`, open: { type: "sales", gid: g.id } });
  }
  return out.sort((a, b) => b.score - a.score);
}

// The important posts: reviews, threads, videos and refund notes. Replies and YouTube comments are
// never listed here; they are counted on the thread or video they belong to.
function feed(games, limit) {
  const span = R().days * DAY, list = [];
  for (const g of games) for (const p of g.posts) if (p.t > NOW - span && WEIGHT[p.kind] >= 4)
    list.push({ g, p, score: WEIGHT[p.kind] * (p.up === false ? 1.15 : 1) * (1 - (0.5 * (NOW - p.t)) / span) });
  // One row per subject: more posts about the same bug or idea fold into the strongest one.
  const seen = new Map(), out = [];
  for (const x of list.sort((a, b) => b.score - a.score)) {
    const key = x.p.kind !== "video" && x.p.issues[0] ? `${x.g.id}/${x.p.issues[0]}` : null, first = key && seen.get(key);
    if (first) { first.similar++; continue; }
    x.similar = 0; if (key) seen.set(key, x); out.push(x);
  }
  return out.slice(0, limit);
}

// ---- rows ---------------------------------------------------------------------------------------
const weightBar = (kind) => h("span.wbar", { title: `Importance ${WEIGHT[kind]} of 5` }, Array.from({ length: 5 }, (_, i) => h(i < WEIGHT[kind] ? "i.on" : "i")));
const kindTag = (p) => h(`span.tag.${p.kind === "refund" ? "refund" : p.kind === "review" ? (p.up ? "pos" : "neg") : p.kind}`, null, p.kind === "review" ? (p.up ? "👍 Review" : "👎 Review") : KIND[p.kind]);
const openPost = (g, p) => ({ type: p.kind === "video" ? "video" : "post", gid: g.id, id: p.id });

function feedRow({ g, p, similar }, withGame) {
  const c = kids(g, p).length;
  return h("button.item", { onclick: (e) => openDrawer(openPost(g, p), e) }, kindTag(p),
    h("span.t", null, h("b", null, p.title || p.summary || p.text), h("small.clip", null, [withGame ? g.name : null, p.who, p.kind === "video" && p.views ? `${fmt(p.views)} views` : null, c ? `${c} ${p.kind === "video" ? "comments" : "replies"}` : null, similar ? `+${similar} similar` : null].filter(Boolean).join(" · "))),
    h("span.n", null, ago(p.t)));
}
function issueRow(g, i, e0) {
  const tag = i.kind === "bug" ? h(`span.tag.${i.status === "still_happening" ? "urgent" : i.urgency}`, null, i.status === "still_happening" ? "back" : i.urgency) : null;
  return h("button.item", { onclick: (e) => openDrawer({ type: "issue", gid: g.id, id: i.id }, e, e0) }, tag,
    h("span.t", null, i.title), i.refunds ? h("span.n.bad", { title: "Refunds" }, `${i.refunds}↩`) : null, h("span.n", { title: "Players who mention it" }, `${i.mentions}×`), h("span.n.muted", null, ago(i.lastSeen)));
}
function mediaRow(g, m) {
  const p = m.post && g.posts.find((x) => x.id === m.post), c = p ? kids(g, p).length : 0;
  const SRC = { youtube: "Video", twitch: m.live ? "● Live" : "Stream", news: "Article", reddit: "Reddit" };
  return h("button.item", { onclick: (e) => openDrawer(p ? { type: "video", gid: g.id, id: p.id } : { type: "media", gid: g.id }, e) }, h(`span.tag${m.live ? ".live" : ""}`, null, SRC[m.source] || m.source),
    h("span.t", null, h("b", null, m.title), h("small.clip", null, [m.by, m.views ? `${fmt(m.views)} views` : null, m.viewers ? `${m.viewers} watching` : null, c ? `${c} comments` : null].filter(Boolean).join(" · "))), h("span.n", null, m.live ? "now" : ago(m.t)));
}
function postRow(g, p, { link = true, low = false } = {}) {
  const body = [h("div.meta", null, kindTag(p), weightBar(p.kind), h("span", null, p.who), p.hours != null && p.kind === "review" ? h("span", null, `${p.hours} h played`) : null, h("span", null, `${ago(p.t)} ago`)),
    p.title ? h("p.sum", null, p.title) : p.summary && !low ? h("p.sum", null, p.summary) : null, h("p", null, p.text)];
  return link ? h("button.post", { onclick: (e) => openDrawer(openPost(g, p), e, true) }, body) : h(`div.post${low ? ".low" : ""}`, null, body);
}
const panel = (cls, title, count, more, ...body) => h(`section.panel${cls}`, null, h("header", null, h("h2", null, title), count != null ? h("span.count", null, count) : null, more), h("div.body", null, body));
const moreBtn = (label, spec) => h("button.more", { onclick: (e) => openDrawer(spec, e) }, label);
const list = (rows, empty) => rows.length ? rows : h("p.empty", null, empty);

// The eight numbers of a game, the same in a grid row and on top of its board.
function cells(g, m) {
  const cell = (lbl, val, sub, sp, spec) => h("button.cell", { onclick: (e) => openDrawer(spec, e), title: `${g.name}: ${lbl}` }, h("span.lbl", null, lbl), h("span.val", null, val), sp || h("span"), h("span.sub", null, sub));
  return [
    cell("Players now", fmt(m.playersNow), [`peak ${fmt(m.playersPeak)} `, delta(m.playersPeak, m.playersPrev)], spark(m.playersSeries), { type: "players", gid: g.id }),
    cell("Reviews", g.pos != null ? `${g.pos}%` : "–", [`+${m.reviewsNew}`, m.reviewsNeg ? h("span.bad", null, ` ${m.reviewsNeg}👎`) : null, ], spark(m.reviewsSeries), { type: "reviews", gid: g.id }),
    cell("Wishlists", signed(m.wishNet), g.wishTotal != null ? `${fmt(g.wishTotal)} total` : "", spark(m.wishSeries), { type: "wishlists", gid: g.id }),
    cell("Sales yesterday", money(m.salesY), [delta(m.salesY, m.salesYPrev) || "≈", " d/d"], null, { type: "sales", gid: g.id }),
    cell("Sales 30 d", money(m.sales30), m.n === 7 ? [`${S.range} ${money(m.salesRange)} `, delta(m.salesRange, m.salesPrev)] : "", spark(m.salesSeries), { type: "sales", gid: g.id }),
    cell("Open bugs", h("span", null, m.bugs.length, m.bugsHot ? h("span.bad", null, ` ${m.bugsHot}!`) : null), m.bugsNew ? `${m.bugsNew} new` : m.bugs[0] ? m.bugs[0].title : "none", null, { type: "issues", gid: g.id, kind: "bug" }),
    cell("New posts", m.posts.length, m.minor ? `+${m.minor} replies` : "", spark(m.postsSeries), { type: "posts", gid: g.id }),
    cell("New media", m.media.length, [m.live.length ? h("span.bad", null, `${m.live.length} live · `) : null, `${m.videos} vid`], null, { type: "media", gid: g.id }),
  ];
}
const HEADS = ["Game", "Players now", "Reviews", "Wishlists", "Sales yday", "Sales 30 d", "Open bugs", "New posts", "New media"];

// ---- boards -------------------------------------------------------------------------------------
function allBoard() {
  const games = S.data.games, ms = games.map(metrics), lbl = R().label;
  const tot = (f) => sum(ms.map(f)), series = (k) => ms[0][k].map((_, i) => sum(ms.map((m) => m[k][i] || 0)));
  const tile = (l, v, sub, sp) => h("div.cell", null, h("span.lbl", null, l), h("span.val", null, v), sp || h("span"), h("span.sub", null, sub));
  const att = attention(games), live = games.flatMap((g, i) => ms[i].live.map((m) => [g, m]));
  const diff = [["See what needs attention across all games", "0–1", "0", "It is on the first screen, ranked."], ["Open a game's top bug and read its posts", "2", "1", "Click the game's bug count."],
    ["See yesterday's sales for one game", "2", "0", "In the game's row. 1 click for the chart."], ["Find new videos about a game", "2–3", "1", "Count in the row. 1 click for the list."]];
  return h("div.stack", null,
    h("div.strip.big", null,
      tile("Players now", fmt(tot((m) => m.playersNow)), `${games.length} games`, spark(series("playersSeries"), 60, 22)),
      tile("Sales yesterday", money(tot((m) => m.salesY)), [delta(tot((m) => m.salesY), tot((m) => m.salesYPrev)), " vs day before"]),
      tile(`Sales ${S.range === "24h" ? "30 d" : lbl}`, money(tot((m) => (m.n === 1 ? m.sales30 : m.salesRange))), "gross", spark(series("salesSeries"), 60, 22)),
      tile(`Wishlists ${lbl}`, signed(tot((m) => m.wishNet)), "net", spark(series("wishSeries"), 60, 22)),
      tile(`Reviews ${lbl}`, `+${tot((m) => m.reviewsNew)}`, [h("span.bad", null, `${tot((m) => m.reviewsNeg)} negative`)], spark(series("reviewsSeries"), 60, 22)),
      tile("Open bugs", tot((m) => m.bugs.length), [h("span.bad", null, `${tot((m) => m.bugsHot)} urgent or high`)]),
      tile(`Posts ${lbl}`, tot((m) => m.posts.length), `+${tot((m) => m.minor)} replies`, spark(series("postsSeries"), 60, 22)),
      tile(`Media ${lbl}`, tot((m) => m.media.length), `${live.length} live now`)),
    h("div.board", null,
      h("div.stack", null,
        h("section.panel.games", null, h("header", null, h("h2", null, "Games"), h("span.hint", null, "Click a number for its detail, a name for the game's board")),
          h("div.head", null, HEADS.map((x) => h("span", null, x))),
          games.map((g, i) => h("div.row", null, h("a.gname", { href: `#/g/${g.id}`, style: `--hue:${g.hue}` }, h("span.art"), h("span.grow", null, h("b.clip", null, g.name), h("small", null, g.genre || `app ${g.id}`))), cells(g, ms[i])))),
        panel("", "What's different", null, h("span.hint", null, "clicks: today → here"),
          h("table.t.diff", null, h("tr", null, h("th", null, "Task"), h("th", null, "Today"), h("th", null, "Here")), diff.map(([t, a, b, how]) => h("tr", null, h("td", null, t, h("small", null, how)), h("td", null, a), h("td", null, b)))),
          h("p.empty", null, "Today's counts are from the current dashboard, starting on All games. Here nothing is a page: every detail is a drawer, and Esc returns to the same board. Keys 1, 2, 3 set the range."))),
      h("div.stack.side", null,
        panel("", "Needs attention", att.length, null, list(att.slice(0, 9).map((a) => h("button.item", { onclick: (e) => openDrawer(a.open, e) }, h(`span.tag.${a.cls}`, null, a.tag), h("span.t", null, h("b", null, a.title), h("small.clip", null, `${a.g.name} · ${a.sub}`)))), `Nothing new in ${lbl}.`)),
        panel("", "Live now", live.length, null, list(live.map(([g, m]) => mediaRow(g, m)), "No one is streaming.")),
        panel("", "Latest important posts", null, moreBtn("All →", { type: "posts" }), list(feed(games, 10).map((x) => feedRow(x, true)), `No posts in ${lbl}.`)))));
}

function gameBoard(g) {
  const m = metrics(g), lbl = R().label, ideas = g.issues.filter((i) => i.kind === "idea").sort((a, b) => issueScore(b) - issueScore(a)), loved = g.issues.filter((i) => i.kind === "loved").sort((a, b) => b.mentions - a.mentions);
  const hot = m.bugs.filter((i) => i.urgency !== "low"), later = [...m.bugs, ...ideas].filter((i) => i.urgency === "low");
  const media = [...m.live, ...g.media.filter((x) => !x.live && x.t > m.since).sort((a, b) => b.t - a.t)];
  const bar = (name, pct, text) => h("div.b", null, h("span.clip", null, name), h("span.track", null, h("i", { style: `width:${Math.min(100, pct)}%` })), h("span.n", null, text ?? `${pct}%`));
  const plain = (title, sub, n) => h("div.item", null, h("span.t", null, h("b", null, title), sub ? h("small", null, sub) : null), n != null ? h("span.n", null, n) : null);
  return h("div", null,
    h("div.ghead", { style: `--hue:${g.hue}` }, h("span.art"), h("div.grow", null, h("h1", null, g.name), h("span.muted.mono", null, g.genre || `app ${g.id}`))),
    h("div.gboard", null,
      h("div.strip.big.s12", null, cells(g, m)),
      panel(".s5", "Bugs", m.bugs.length, moreBtn("Top bug + posts →", { type: "issues", gid: g.id, kind: "bug" }), list(hot.slice(0, 9).map((i) => issueRow(g, i)), "No open bugs.")),
      panel(".s4", "Sales", money(m.salesRange), moreBtn("By day →", { type: "sales", gid: g.id }), chart(m.salesSeries, m.labels, { fmt: money }),
        h("div.kv", null, h("div", null, h("b", null, money(m.salesY)), "yesterday"), m.n === 7 ? h("div", null, h("b", null, money(m.salesRange)), lbl) : null, h("div", null, h("b", null, money(m.sales30)), "30 d"), h("div", null, h("b", null, fmt(m.units)), `units, ${lbl}`))),
      panel(".s3", "Posts", m.posts.length, moreBtn("All →", { type: "posts", gid: g.id }), list(feed([g], 6).map((x) => feedRow(x, false)), `No posts in ${lbl}.`)),
      panel(".s4", "Ideas", ideas.length, moreBtn("All →", { type: "issues", gid: g.id, kind: "idea" }), list(ideas.filter((i) => i.urgency !== "low").slice(0, 6).map((i) => issueRow(g, i)), "No ideas yet.")),
      panel(".s4", "Loved", loved.length, moreBtn("All →", { type: "issues", gid: g.id, kind: "loved" }), list(loved.slice(0, 6).map((i) => issueRow(g, i)), "Nothing yet.")),
      panel(".s4", "Media", media.length, moreBtn("All →", { type: "media", gid: g.id }), list(media.slice(0, 6).map((x) => mediaRow(g, x)), `Nothing new in ${lbl}.`)),
      panel(".s3", "Players", fmt(m.playersNow), moreBtn("More →", { type: "players", gid: g.id }), chart(m.playersSeries, m.playersLabels, { type: "line", ht: 110 })),
      panel(".s3", "Updates", g.updates.length, null, list(g.updates.slice(0, 4).map((u) => plain(u.title, [u.notes, u.fixed ? `${u.fixed} fixed` : null].filter(Boolean).join(" · "), ago(u.t))), "No updates yet.")),
      panel(".s3", "Achievements", null, null, h("div.bars", null, list(g.achievements.slice(0, 6).map((a) => bar(a.name, a.pct)), "No data."))),
      panel(".s3", "Steam stats", null, null, h("div.kv", null, h("div", null, h("b", null, g.stats.median), "median playtime"), g.stats.refundRate != null ? h("div", null, h("b", null, `${g.stats.refundRate}%`), "refund rate") : null),
        h("div.bars", null, g.stats.reach.map(([l, p]) => bar(`played ${l}`, p)))),
      panel(".s4", "Curators", g.curators.length, null, list(g.curators.map((c) => plain(c.name, `${fmt(c.followers)} followers`, h(`span.${c.up ? "good" : "muted"}`, null, c.up ? "recommends" : "informational"))), "No curator reviews.")),
      panel(".s4", "Bundles", g.bundles.length, null, list(g.bundles.map((b) => plain(b.name, `${b.games} games`, `${fmt(b.units)} sold`)), "No bundles.")),
      panel(".s4", "Competitors", g.competitors.length, null, list(g.competitors.map((c) => plain(c.name, `${c.pos}% positive`, `${fmt(c.players)} now`)), "None picked.")),
      panel(".s12", "Later", later.length, h("span.hint", null, "low priority, out of the way"), list(later.map((i) => issueRow(g, i)), "Nothing parked."))));
}

// ---- drawers ------------------------------------------------------------------------------------
function issueBody(g, i) {
  const posts = i.posts.map((id) => g.posts.find((p) => p.id === id)).filter(Boolean);
  const main = posts.filter((p) => WEIGHT[p.kind] >= 4).sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind] || b.t - a.t), low = posts.filter((p) => WEIGHT[p.kind] < 4).sort((a, b) => b.t - a.t);
  return [
    h("div.kv", null, h("div", null, h("b", null, i.mentions), "players"), i.kind === "bug" ? h("div", null, h("b", null, i.negativeReviews), "negative reviews") : null, i.refunds ? h("div", null, h("b.bad", null, i.refunds), "refunds") : null,
      h("div", null, h("b", null, ago(i.firstSeen)), "first seen"), h("div", null, h("b", null, ago(i.lastSeen)), "last seen")),
    i.status === "still_happening" ? h("p.lead.bad", null, `↻ Still reported after the fix in ${i.fixedIn}.`) : null,
    i.summary ? h("p.lead", null, i.summary) : null,
    h("section.panel", null, h("header", null, h("h2", null, "Posts"), h("span.count", null, main.length), h("span.hint", null, "reviews, refunds, threads and videos first")),
      list(main.map((p) => postRow(g, p)), "No posts."),
      low.length ? h("details.fold", null, h("summary", null, `${low.length} ${low.length === 1 ? "reply" : "replies"} and comments`), low.map((p) => postRow(g, p, { link: false, low: true }))) : null)];
}

const DRAWERS = {
  issue(g, d) { const i = g.issues.find((x) => x.id === d.id); return { kicker: `${g.name} · ${i.kind}${i.urgency ? ` · ${i.urgency}` : ""}`, title: i.title, body: issueBody(g, i) }; },
  issues(g, d) {
    const all = g.issues.filter((i) => i.kind === d.kind).sort((a, b) => d.kind === "loved" ? b.mentions - a.mentions : issueScore(b) - issueScore(a)), [top, ...rest] = all;
    const NAME = { bug: "Bugs", idea: "Ideas", loved: "Loved" };
    return { kicker: `${g.name} · ${all.length} ${d.kind === "bug" ? "open" : ""}`, title: NAME[d.kind], body: top ? [h("div", null, h("h3", null, `Top: ${top.title}`), h("div.stack", null, issueBody(g, top))),
      rest.length ? panel("", `Other ${NAME[d.kind].toLowerCase()}`, rest.length, null, rest.map((i) => issueRow(g, i, true))) : null] : [h("p.empty", null, "Nothing here.")] };
  },
  post(g, d) {
    const p = g.posts.find((x) => x.id === d.id), re = kids(g, p).sort((a, b) => a.t - b.t), about = p.issues.map((id) => g.issues.find((i) => i.id === id)).filter(Boolean);
    const parent = p.parent && g.posts.find((x) => x.id === p.parent);
    return { kicker: `${g.name} · ${KIND[p.kind]}`, title: p.title || p.summary || "Post", body: [
      h("section.panel", null, postRow(g, p, { link: false })),
      parent ? panel("", "In reply to", null, null, postRow(g, parent)) : null,
      about.length ? panel("", "About", about.length, null, about.map((i) => issueRow(g, i, true))) : null,
      re.length ? h("section.panel", null, h("details.fold", { open: true }, h("summary", null, `${re.length} ${re.length === 1 ? "reply" : "replies"}`), re.map((x) => postRow(g, x, { link: false, low: true })))) : null] };
  },
  video(g, d) {
    const p = g.posts.find((x) => x.id === d.id), comments = kids(g, p).sort((a, b) => a.t - b.t);
    return { kicker: `${g.name} · video`, title: p.title, body: [
      h("div.thumb", null, "video thumbnail"),
      h("div.kv", null, h("div", null, h("b", null, p.who), "channel"), p.views != null ? h("div", null, h("b", null, fmt(p.views)), "views") : null, h("div", null, h("b", null, comments.length), "comments"), h("div", null, h("b", null, ago(p.t)), "ago")),
      panel("", "What the video says", (p.points || []).length, h("span.hint", null, "from the transcript"), list((p.points || []).map((pt) => { const i = g.issues.find((x) => x.title === pt.text);
        const row = [h(`span.tag.${pt.kind}`, null, pt.kind), h("span.t", null, pt.text), h("span.n", null, pt.at)];
        return i ? h("button.item", { onclick: (e) => openDrawer({ type: "issue", gid: g.id, id: i.id }, e, true) }, row) : h("div.item", null, row); }), "No points found.")),
      h("section.panel", null, h("details.fold", null, h("summary", null, `${comments.length} YouTube comments (low importance)`), list(comments.map((c) => postRow(g, c, { link: false, low: true })), "No comments.")))] };
  },
  media(g) {
    const m = metrics(g), rest = g.media.filter((x) => !x.live && x.t > m.since).sort((a, b) => b.t - a.t), vids = rest.filter((x) => x.source === "youtube"), other = rest.filter((x) => x.source !== "youtube");
    return { kicker: `${g.name} · ${R().label}`, title: "Media", body: [
      m.live.length ? panel("", "Live now", m.live.length, null, m.live.map((x) => mediaRow(g, x))) : null,
      panel("", "New videos", vids.length, h("span.hint", null, "comments are inside each video"), list(vids.map((x) => mediaRow(g, x)), `No new videos in ${R().label}.`)),
      panel("", "Streams, articles, threads", other.length, null, list(other.map((x) => mediaRow(g, x)), "Nothing else."))] };
  },
  sales(g) {
    const m = metrics(g), n = m.show, rows = m.labels.map((l, i) => [l, g.d.units.slice(-n)[i], m.salesSeries[i]]).reverse();
    return { kicker: `${g.name} · gross, last ${n} days`, title: "Sales", body: [
      h("div.kv", null, h("div", null, h("b", null, money(m.salesY)), "yesterday ", delta(m.salesY, m.salesYPrev)), m.n === 7 ? h("div", null, h("b", null, money(m.salesRange)), `${R().label} `, delta(m.salesRange, m.salesPrev)) : null, h("div", null, h("b", null, money(m.sales30)), "30 d"),
        h("div", null, h("b", null, fmt(m.units)), `units, ${R().label}`), g.stats.refundRate != null ? h("div", null, h("b", null, `${g.stats.refundRate}%`), "refund rate") : null),
      h("section.panel", null, chart(m.salesSeries, m.labels, { fmt: money, ht: 170 })),
      h("section.panel", null, h("table.t", null, h("tr", null, h("th", null, "Day"), h("th", null, "Units"), h("th", null, "Gross")), rows.map(([l, u, gr], i) => h("tr", null, h("td", null, i === 1 ? `${l} (yesterday)` : i === 0 ? `${l} (today, partial)` : l), h("td", null, u), h("td", null, money(gr))))))] };
  },
  players(g) {
    const m = metrics(g);
    return { kicker: `${g.name} · ${m.n === 1 ? "per hour" : "best hour per day"}`, title: "Players", body: [
      h("div.kv", null, h("div", null, h("b", null, fmt(m.playersNow)), "now"), h("div", null, h("b", null, fmt(m.playersPeak)), `peak, ${R().label} `, delta(m.playersPeak, m.playersPrev)), h("div", null, h("b", null, fmt(Math.max(...g.hourly))), "peak, 30 d")),
      h("section.panel", null, chart(m.playersSeries, m.playersLabels, { type: "line", ht: 170 })),
      panel("", "Live now", m.live.length, null, list(m.live.map((x) => mediaRow(g, x)), "No one is streaming."))] };
  },
  reviews(g) {
    const m = metrics(g), rs = g.posts.filter((p) => p.kind === "review" && p.t > m.since).sort((a, b) => (a.up === false ? 0 : 1) - (b.up === false ? 0 : 1) || b.t - a.t);
    return { kicker: `${g.name} · ${R().label}`, title: "Reviews", body: [
      h("div.kv", null, h("div", null, h("b", null, g.pos != null ? `${g.pos}%` : "–"), "positive"), h("div", null, h("b", null, fmt(g.reviewsTotal)), "in all"), h("div", null, h("b", null, `+${m.reviewsNew}`), `new, ${R().label}`), h("div", null, h("b.bad", null, m.reviewsNeg), "negative")),
      h("section.panel", null, chart(m.reviewsSeries, m.labels, { ht: 120 })),
      panel("", "Collected reviews", rs.length, h("span.hint", null, "negative first"), list(rs.map((p) => postRow(g, p)), `No reviews collected in ${R().label}.`))] };
  },
  wishlists(g) {
    const m = metrics(g);
    return { kicker: `${g.name} · net per day`, title: "Wishlists", body: [
      h("div.kv", null, h("div", null, h("b", null, fmt(g.wishTotal)), "total"), h("div", null, h("b", null, signed(m.wishNet)), `net, ${R().label}`), h("div", null, h("b", null, signed(sum(g.d.wish))), "net, 30 d")),
      h("section.panel", null, chart(m.wishSeries.map((x) => Math.max(0, x)), m.labels, { ht: 170 }))] };
  },
  posts(g, d) {
    const games = g ? [g] : S.data.games, f = d.filter || "all", since = NOW - R().days * DAY;
    const all = games.flatMap((x) => x.posts.filter((p) => p.t > since).map((p) => ({ g: x, p })));
    const main = all.filter((x) => WEIGHT[x.p.kind] >= 4 && (f === "all" || x.p.kind === f)).sort((a, b) => WEIGHT[b.p.kind] - WEIGHT[a.p.kind] || b.p.t - a.p.t), replies = all.filter((x) => x.p.kind === "reply").sort((a, b) => b.p.t - a.p.t), comments = all.filter((x) => x.p.kind === "comment").length;
    const chip = (k, label) => h("button.chip", { "aria-pressed": String(f === k), onclick: () => { d.filter = k; drawDrawer(); } }, `${label} ${k === "all" ? all.filter((x) => WEIGHT[x.p.kind] >= 4).length : all.filter((x) => x.p.kind === k).length}`);
    return { kicker: `${g ? g.name : "All games"} · ${R().label} · by importance`, title: "Posts", body: [
      h("div.crumbs", null, chip("all", "All"), chip("review", "Reviews"), chip("refund", "Refunds"), chip("topic", "Threads"), chip("video", "Videos")),
      h("section.panel", null, list(main.map((x) => { const row = postRow(x.g, x.p); if (!g) row.querySelector(".meta").prepend(h("b", null, x.g.name)); return row; }), "Nothing here."),
        f === "all" && replies.length ? h("details.fold", null, h("summary", null, `${replies.length} replies`), replies.map((x) => postRow(x.g, x.p, { link: false, low: true }))) : null),
      f === "all" || f === "video" ? h("p.empty", null, `${comments} YouTube comments are not listed here. They are counted on their video and shown inside it.`) : null] };
  },
};

function openDrawer(spec, e, push = false) {
  if (!S.drawer.length) S.opener = e?.currentTarget || null;
  S.drawer = push ? [...S.drawer, spec] : [spec];
  drawDrawer(true);
}
function closeDrawer() { S.drawer = []; drawDrawer(); S.opener?.isConnected && S.opener.focus(); S.opener = null; }
function drawDrawer(focus = false) {
  const root = document.getElementById("drawer"), d = S.drawer.at(-1);
  if (!d) { root.replaceChildren(); return; }
  const g = d.gid ? game(d.gid) : null, v = DRAWERS[d.type](g, d), onAll = !location.hash.startsWith("#/g/");
  const close = h("button.btn", { onclick: closeDrawer, "aria-label": "Close" }, "Esc ✕");
  root.replaceChildren(h("div.scrim", { onclick: closeDrawer }),
    h("aside.drawer", { role: "dialog", "aria-modal": "true", "aria-label": v.title },
      h("header", null, S.drawer.length > 1 ? h("button.btn", { onclick: () => { S.drawer = S.drawer.slice(0, -1); drawDrawer(true); } }, "← Back") : null,
        h("h2", null, h("small", null, v.kicker), v.title), g && onAll ? h("a.btn", { href: `#/g/${g.id}`, onclick: () => { S.drawer = []; } }, "Open board") : null, close),
      h("div.dbody", null, v.body)));
  if (focus) close.focus();
}

// ---- page ---------------------------------------------------------------------------------------
function draw() {
  const id = (location.hash.match(/^#\/g\/(.+)$/) || [])[1], g = id && game(decodeURIComponent(id));
  document.getElementById("games").replaceChildren(h("a.chip", { href: "#/", "aria-current": g ? null : "page" }, "All games"), ...S.data.games.map((x) => h("a.chip", { href: `#/g/${x.id}`, "aria-current": g === x ? "page" : null }, x.name)));
  document.getElementById("range").replaceChildren(...Object.entries(RANGES).map(([k, r]) => h("button", { "aria-pressed": String(S.range === k), onclick: () => setRange(k) }, r.label)));
  document.getElementById("sample").hidden = !S.data.sample;
  document.getElementById("main").replaceChildren(g ? gameBoard(g) : allBoard());
  document.title = `${g ? g.name : "All games"} · Command center`;
  drawDrawer();
}
function setRange(k) { S.range = k; store.set("cc-range", k); draw(); }
function setTheme(t) { document.documentElement.dataset.theme = t; store.set("cc-theme", t); }

document.getElementById("theme").addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
addEventListener("hashchange", () => { scrollTo(0, 0); draw(); });
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.drawer.length) return closeDrawer();
  if (e.metaKey || e.ctrlKey || e.altKey || /input|textarea|select/i.test(e.target.tagName)) return;
  const k = Object.keys(RANGES)[Number(e.key) - 1];
  if (k) setRange(k);
});
S.data = await loadData();
draw();
