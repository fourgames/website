// Daily brief: the dashboard as one page you read top to bottom. Plain DOM, no build step.
// Data: the private feedback data if a local copy is in feedback/data/ (never committed), else the
// invented sample in sample.js. Both have the same shape, so everything below reads one format.
const DATA = "../../data";
const DAY = 86400, now = Date.now() / 1000;

// ---- small helpers ----------------------------------------------------------
const h = (sel, ...kids) => {
  const [tag, ...cls] = sel.split(".");
  const el = document.createElement(tag || "div");
  if (cls.length) el.className = cls.join(" ");
  const first = kids[0];
  if (first && typeof first === "object" && !first.nodeType && !Array.isArray(first)) {
    kids.shift();
    for (const [k, v] of Object.entries(first)) {
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const k of kids.flat(3)) if (k != null && k !== false && k !== "") el.append(k.nodeType ? k : String(k));
  return el;
};
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem("brief:" + k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("brief:" + k, JSON.stringify(v)); } catch {} },
};
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const days = (n, end = now) => Array.from({ length: n }, (_, i) => iso(end - (n - 1 - i) * DAY));
const num = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => "$" + num(n);
const plural = (n, one, many = one + "s") => `${num(n)} ${n === 1 ? one : many}`;
const ago = (t) => { const s = Math.max(60, now - t); return s < 3600 ? `${Math.round(s / 60)} min ago` : s < 2 * DAY ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / DAY)} d ago`; };
const when = (t) => new Date(t * 1000).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const span = (len) => len < 36 * 3600 ? `${Math.max(1, Math.round(len / 3600))} hours` : `${Math.round(len / DAY)} days`;
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const get = async (p) => { try { const r = await fetch(`${DATA}/${p}`, { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; } };
const copyBtn = (label, text, cls = "btn") => h(`button.${cls}`, { type: "button", onclick: async (e) => {
  const b = e.currentTarget;
  try { await navigator.clipboard.writeText(text()); b.textContent = "Copied"; } catch { b.textContent = "Could not copy"; }
  setTimeout(() => { b.textContent = label; }, 1400);
} }, label);
// How a number moved against the period before: words for sentences, a class for the colour.
const move = (a, b, invert = false) => {
  if (!a && !b) return null;
  if (!b) return { text: "up from nothing", short: "new", cls: invert ? "down" : "up" };
  const d = (a - b) / b;
  if (Math.abs(d) < 0.05) return { text: "about the same as", short: "≈ same", cls: "flat", same: true };
  return { text: `${d > 0 ? "up" : "down"} ${Math.round(Math.abs(d) * 100)}% on`, short: `${d > 0 ? "▲" : "▼"} ${Math.round(Math.abs(d) * 100)}%`, cls: (d > 0) !== invert ? "up" : "down" };
};
const moved = (m, before) => m ? h(`span.${m.cls}`, `, ${m.text} ${before}`) : null;
const spark = (values, w = 84, hgt = 26) => {
  const v = values.map((x) => x || 0), max = Math.max(1, ...v);
  const pts = v.map((x, i) => `${(i / Math.max(1, v.length - 1)) * (w - 4) + 2},${hgt - 3 - (x / max) * (hgt - 6)}`).join(" ");
  const svg = h("span"); svg.innerHTML = `<svg width="${w}" height="${hgt}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" opacity="0.7"/></svg>`;
  return svg.firstChild;
};
const bars = (values, labels, hi = -1) => {
  const max = Math.max(1, ...values), w = 100 / values.length;
  const box = h("div"); box.innerHTML = `<svg class="bars" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label="One bar per day">${values.map((v, i) =>
    `<rect class="${i === hi ? "hi" : ""}" x="${i * w + w * 0.12}" y="${40 - (v / max) * 38}" width="${w * 0.76}" height="${(v / max) * 38}"><title>${labels[i]}</title></rect>`).join("")}</svg>`;
  return box.firstChild;
};

// ---- the period: since you last looked, today, 7 days, 30 days --------------
let last = store.get("last", null), prevLook = store.get("prev", null);
if (!last) store.set("last", now);
else if (now - last > 3600) { prevLook = last; store.set("prev", prevLook); store.set("last", now); }
let period = store.get("period", "since");
const fromOf = () => period === "since" ? (prevLook ? Math.max(prevLook, now - 30 * DAY) : now - DAY) : now - Number(period) * DAY;

// ---- importance: what a post is worth ---------------------------------------
// Reviews, threads, videos and refund notes carry the page; replies sit under their thread;
// YouTube comments are folded under their video and never listed on their own by default.
const WEIGHT = { refund: 5, review: 4, topic: 4, video: 4, reply: 1.5, comment: 0.5 };
const isBug = (i) => i.triage?.category === "bug" || (i.triage?.points || []).some((p) => p.kind === "bug");
const weight = (i) => (WEIGHT[i.kind] || 1) + (i.kind === "review" && i.votedUp === false ? 1.5 : 0) + (isBug(i) ? 1 : 0) + Math.min(1, (i.text || "").length / 400) + (i.playtime > 20 ? 0.5 : 0);
const byWeight = (a, b) => weight(b) - weight(a) || b.created - a.created;
const parentOf = (i) => i.topic || i.parent || i.thread || null;

// ---- one game, read once ----------------------------------------------------
function derive(meta, g, sales, wish, sw) {
  const id = String(meta.appId);
  const items = Object.values(g.items || {}).filter((i) => !i.dev && !i.offTopic);
  const issues = Object.values(g.issues || {});
  const open = issues.filter((i) => ["open", "still_happening"].includes(i.status));
  const by = (k) => (a, b) => (b[k] || 0) - (a[k] || 0);
  const peakByDay = {};
  for (const [t, n] of g.players || []) { const d = iso(t); peakByDay[d] = Math.max(peakByDay[d] || 0, n); }
  const sDays = sales?.days || {}, wDays = wish?.apps?.[id]?.days || {};
  const rt = g.reviewTotals || {}, rKeys = Object.keys(rt).sort();
  const scoreAt = (d) => { const k = rKeys.filter((x) => x <= d).pop(), r = k && rt[k]; return r && r.positive + r.negative ? { pct: Math.round((r.positive / (r.positive + r.negative)) * 100), total: r.positive + r.negative } : null; };
  const play = (sw?.apps?.[id]?.pages?.playtime || []).flatMap((t) => t.rows || []);
  return {
    id, meta, g, name: meta.name, upcoming: meta.status === "upcoming", items, issues,
    bugs: open.filter((i) => i.kind === "bug").sort(by("priority")),
    ideas: open.filter((i) => i.kind === "suggestion").sort(by("priority")),
    loved: issues.filter((i) => i.kind === "praise").sort(by("mentions")),
    media: Object.values(g.media?.items || {}).filter((m) => m.source !== "copy" && !m.own),
    gross: (d) => sDays[d]?.[id]?.gross || 0, net: (d) => sDays[d]?.[id]?.net || 0, units: (d) => sDays[d]?.[id]?.units || 0,
    hasSales: Object.values(sDays).some((d) => d[id]),
    wishNet: (d) => { const w = wDays[d]; return w ? (w.adds || 0) - (w.deletes || 0) - (w.purchases || 0) - (w.gifts || 0) : 0; },
    wishAdds: (d) => wDays[d]?.adds || 0,
    peak: (d) => peakByDay[d] || 0, playersNow: (g.players || []).at(-1)?.[1] ?? null, scoreAt,
    median: play.find((r) => /^Median time played/.test(r[0]))?.[1] || null,
    reach: play.filter((r) => /^\d+ (minutes?|hours?)/.test(r[0]) && /%$/.test(r[1] || "")).map((r) => ({ label: r[0].replace(/ 0 minutes?/, "").replace(/ hours?/g, " h").replace(/ minutes?/g, " min"), pct: parseFloat(r[1]) })),
  };
}

// The headline numbers of one game for the window [from, now], and the same length before it.
function stats(x, from) {
  const len = now - from, n = Math.max(1, Math.round((now - Date.parse(iso(from)) / 1000) / DAY + 0.49));
  const cur = days(n), old = days(2 * n).slice(0, n);
  const inWin = (i) => i.created >= from, before = (i) => i.created >= from - len && i.created < from;
  const reviews = x.items.filter((i) => i.kind === "review");
  const samples = x.g.players || [];
  const peakIn = (a, b) => Math.max(0, ...samples.filter(([t]) => t >= a && t < b).map(([, c]) => c));
  return {
    n, gross: sum(cur.map(x.gross)), grossOld: sum(old.map(x.gross)), units: sum(cur.map(x.units)), unitsOld: sum(old.map(x.units)),
    wish: sum(cur.map(x.wishNet)), wishOld: sum(old.map(x.wishNet)),
    reviews: reviews.filter(inWin).length, pos: reviews.filter((i) => inWin(i) && i.votedUp).length, reviewsOld: reviews.filter(before).length,
    score: x.scoreAt(iso(now)), scoreThen: x.scoreAt(iso(from - DAY)),
    peak: peakIn(from, now + 1), peakOld: peakIn(from - len, from),
    posts: x.items.filter((i) => inWin(i) && i.kind !== "comment").length,
  };
}
const addStats = (list) => {
  const t = { score: null, scoreThen: null };
  for (const s of list) for (const [k, v] of Object.entries(s)) if (typeof v === "number") t[k] = k === "n" ? v : (t[k] || 0) + v;
  return t;
};

// The opening sentences. Plain numbers and how each moved.
function lede(s, before, { you = true } = {}) {
  const out = [];
  const b = (t) => h("b", t);
  if (s.units || s.unitsOld) out.push(h("span", you ? "You sold " : "It sold ", b(plural(s.units, "copy", "copies")), " for ", b(money(s.gross)), " gross", moved(move(s.gross, s.grossOld), before), ". "));
  if (s.wish || s.wishOld) out.push(h("span", "Wishlists ", s.wish >= 0 ? "grew by " : "shrank by ", b(num(Math.abs(s.wish))), moved(move(s.wish, s.wishOld), before), ". "));
  if (s.reviews) out.push(h("span", b(plural(s.reviews, "new review")), s.reviews === s.pos ? ", all positive" : `, ${s.pos} positive and `, s.reviews === s.pos ? null : h("span.down", `${s.reviews - s.pos} negative`),
    s.score ? `; the score is ${s.score.pct}%${s.scoreThen && s.scoreThen.pct !== s.score.pct ? ` (was ${s.scoreThen.pct}%)` : ""}` : null, ". "));
  else if (s.score) out.push(h("span", `No new reviews; the score holds at ${s.score.pct}%. `));
  if (s.peak || s.peakOld) out.push(h("span", "Players peaked at ", b(num(s.peak)), moved(move(s.peak, s.peakOld), before), "."));
  return out.length ? out : [h("span.quiet", "Nothing moved.")];
}

// ---- posts ------------------------------------------------------------------
const KIND = { topic: ["Thread", ""], reply: ["Reply", ""], video: ["Video", ""], comment: ["YouTube comment", "", "Comment"], refund: ["Refund note", "warn", "Refund"] };
const kindOf = (i) => i.kind === "review" ? (i.votedUp === false ? ["Negative review", "bad", "Negative"] : ["Positive review", "good", "Positive"]) : KIND[i.kind] || [i.kind, ""];
const postMeta = (i, x, game) => [game ? x.name : null, i.author?.name, i.kind === "review" && i.playtime != null ? `${i.playtime} h played` : null, i.refundReason, ago(i.created)].filter(Boolean).join(" · ");
const oneLine = (i) => i.triage?.summary || i.title || (i.text || "").replace(/\s+/g, " ").slice(0, 160) || "(no text)";
const openLink = (i) => i.url ? h("a.meta", { href: i.url, target: "_blank", rel: "noopener" }, i.kind === "video" || i.kind === "comment" ? "Open on YouTube ↗" : "Open on Steam ↗") : null;
const line = (tag, cls, text, meta, body, low = false) => h(`details.line${low ? ".low" : ""}`, h("summary", h(`span.tag${cls ? "." + cls : ""}`, tag), h("span.t", text), h("span.meta", meta)), h("div.in", body));
const quote = (i) => i.text ? h(`blockquote${i.kind === "review" ? (i.votedUp === false ? ".neg" : ".pos") : ""}`, i.text) : h("p", oneLine(i));
const repliesOf = (i, x) => i.kind === "topic" ? x.items.filter((r) => r.kind === "reply" && parentOf(r) === i.id).sort((a, b) => a.created - b.created) : [];
const replyFold = (i, x) => { const r = repliesOf(i, x); return r.length ? h("details.more", h("summary", plural(r.length, "reply", "replies")), h("div.in", r.map((p) => h("div", h("div.meta", `${p.author?.name || "A player"} · ${ago(p.created)}`), h("p", p.text))))) : null; };
function postFull(i, x, game) {
  const [label, cls] = kindOf(i);
  return h("article.story", h("div.kicker", h(`span${cls ? "." + cls : ""}`, label), " · ", postMeta(i, x, game)),
    i.title ? h("h3", i.title) : null, quote(i), i.devResponse ? h("p.meta", "You answered this.") : null,
    replyFold(i, x), h("div.acts", openLink(i)));
}
function postLine(i, x, game, low = false) {
  const [long, cls, label = long] = kindOf(i);
  return line(label, cls, oneLine(i), game ? `${x.name} · ${ago(i.created)}` : ago(i.created),
    [quote(i), h("div.meta", postMeta(i, x, game)), replyFold(i, x), openLink(i)], low || i.kind === "reply" || i.kind === "comment");
}
const issuePosts = (issue, x) => (issue.items || []).map((id) => x.g.items?.[id]).filter(Boolean).sort(byWeight);
const postsBlock = (posts, x) => { const big = posts.filter((p) => p.kind !== "comment" && p.kind !== "reply"), small = posts.filter((p) => p.kind === "comment" || p.kind === "reply");
  return [big.slice(0, 8).map((p) => postFull(p, x)), small.length || big.length > 8 ? h("div.lines", [...big.slice(8), ...small].map((p) => postLine(p, x, false, true))) : null]; };

// ---- needs you: things to act on, each with its one action ------------------
function needs(x) {
  const out = [];
  for (const b of x.bugs) if (b.status === "still_happening" || ["urgent", "high"].includes(b.urgency))
    out.push({ type: "bug", x, issue: b, rank: b.urgency === "urgent" ? 10 : b.status === "still_happening" ? 9 : 7, at: b.lastSeen, key: `${x.id}:${b.id}` });
  const refunds = x.items.filter((i) => i.kind === "refund" && i.created > now - 14 * DAY);
  if (refunds.length) out.push({ type: "refund", x, posts: refunds, rank: 8, at: Math.max(...refunds.map((r) => r.created)), key: `${x.id}:refunds:${refunds.length}` });
  for (const r of x.items.filter((i) => i.kind === "review" && i.votedUp === false && !i.devResponse && i.created > now - 7 * DAY))
    out.push({ type: "review", x, post: r, rank: 6, at: r.created, key: `${x.id}:${r.id}` });
  return out;
}
const fixPrompt = (issue, x) => [`Fix this bug in ${x.name}: ${issue.title}`, `${plural(issue.mentions, "player")} report it. What they said:`,
  ...issuePosts(issue, x).slice(0, 10).map((p) => `- "${(p.text || oneLine(p)).replace(/\s+/g, " ").slice(0, 300)}" (${kindOf(p)[0].toLowerCase()})`),
  "Find the cause, fix it, and give me one patch-notes line for what changed."].join("\n");
// A reply draft from a fixed template (the real thing would be written by Claude from the review).
const replyDraft = (post, x) => { const bug = x.issues.find((i) => i.kind === "bug" && (i.items || []).includes(post.id));
  return `Hi ${post.author?.name || "there"}, thanks for telling us, and sorry about this. ${bug ? `We know about it ("${bug.title}") and a fix is coming in the next update.` : "We read every review and this one helps us decide what to work on next."} If you give ${x.name} another go after the patch, we'd love to hear how it went.`; };
const doneBox = (n, node) => { const set = (on) => node.classList.toggle("done", on); set(!!store.get("done:" + n.key, false));
  return h("label.meta", h("input", { type: "checkbox", checked: !!store.get("done:" + n.key, false), onchange: (e) => { store.set("done:" + n.key, e.target.checked); set(e.target.checked); } }), " Done"); };
const needTitle = (n) => n.type === "bug" ? n.issue.title : n.type === "refund" ? `${plural(n.posts.length, "refund note")} in 14 days` : oneLine(n.post);
const needKick = (n) => n.type === "bug" ? (n.issue.status === "still_happening" ? ["Came back after a fix", "bad"] : [`${n.issue.urgency} bug`, "bad"]) : n.type === "refund" ? ["Refunds", "warn"] : ["Unanswered negative review", "bad"];
const needFacts = (n) => n.type === "bug" ? [plural(n.issue.mentions, "player"), n.issue.negativeReviews ? plural(n.issue.negativeReviews, "negative review") : null, n.issue.refunds ? plural(n.issue.refunds, "refund") : null, `last seen ${ago(n.issue.lastSeen)}`].filter(Boolean).join(" · ")
  : n.type === "refund" ? `latest ${ago(n.at)}` : postMeta(n.post, n.x);
function needBody(n) {
  const x = n.x;
  if (n.type === "bug") { const posts = issuePosts(n.issue, x);
    return [h("details.more", h("summary", `Read the ${plural(posts.length, "post")}`), h("div.in", postsBlock(posts, x))),
      h("div.acts", copyBtn("Copy fix prompt", () => fixPrompt(n.issue, x)))]; }
  if (n.type === "refund") return [n.posts.map((p) => h("blockquote", p.text, h("div.meta", [p.refundReason, ago(p.created)].filter(Boolean).join(" · ")))),
    h("div.acts", h("span.meta", "Refund notes can't be answered. Check they match a known bug."))];
  const draft = replyDraft(n.post, x);
  return [quote(n.post), h("div.draft", h("span.draft-label", "Reply draft"), draft),
    h("div.acts", copyBtn("Copy reply", () => draft), n.post.url ? h("a.btn.ghost", { href: n.post.url, target: "_blank", rel: "noopener" }, "Open on Steam ↗") : null)];
}
function needNode(n, game) {
  const [k, cls] = needKick(n);
  const node = h("article.story", h("div.kicker", h(`span.${cls}`, k), game ? ` · ${n.x.name}` : ""), h("h3", needTitle(n)), h("p.meta", needFacts(n)), needBody(n));
  node.querySelector(":scope > .acts").append(doneBox(n, node));
  return node;
}

// ---- media ------------------------------------------------------------------
function mediaCard(m, x, game) {
  const video = x.items.find((i) => i.kind === "video" && (i.media === m.id || (m.url && m.url !== "#" && i.url === m.url)));
  const summary = m.review?.summary || video?.triage?.summary;
  const comments = x.items.filter((i) => i.kind === "comment" && i.media === m.id).sort((a, b) => b.created - a.created);
  const pos = comments.filter((c) => c.triage?.category === "praise").length, neg = comments.filter(isBug).length;
  const tone = comments.length < 2 ? "" : pos > neg * 2 ? ", mostly positive" : neg > pos ? ", mostly negative" : ", mixed";
  const verdict = m.review?.verdict && m.review.verdict !== "unclear" ? m.review.verdict : null;
  const what = m.live ? "Live now" : m.source === "twitch" ? "Stream" : m.source === "youtube" ? "Video" : m.source === "news" ? "Article" : m.source;
  return h("article.video",
    h("a.thumb", { href: m.url, target: "_blank", rel: "noopener", "aria-label": m.title }, m.thumbnail ? h("img", { src: m.thumbnail, alt: "", loading: "lazy" }) : null, m.source === "news" ? "Aa" : h("span.play"), m.duration ? h("span.dur", m.duration) : null),
    h("div", h("div.kicker", h(`span${m.live ? ".live" : ""}`, what), game ? ` · ${x.name}` : ""),
      h("h3", h("a", { href: m.url, target: "_blank", rel: "noopener" }, m.title)),
      h("div.meta", [m.author, m.views != null ? `${num(m.views)} ${m.live ? "watching" : "views"}` : null, ago(m.at), verdict ? h(`span.${verdict === "positive" ? "up" : verdict === "negative" ? "down" : "flat"}`, `creator: ${verdict}`) : null].filter(Boolean).flatMap((v, i) => i ? [" · ", v] : [v])),
      summary ? h("p.sum", summary) : null,
      comments.length ? h("details.more", h("summary", `${plural(comments.length, "comment")}${tone}`), h("div.in", comments.map((c) => h("div", h("div.meta", `${c.author?.name || "Viewer"} · ${ago(c.created)}`), h("p", c.text))))) : null));
}
const mediaRank = (a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || (b.views || 0) - (a.views || 0);

// ---- the brief itself: the same shape for every game or for one -------------
function brief(list, from, single) {
  const x1 = single ? list[0] : null, game = !single;
  const len = now - from, before = `the ${span(len)} before`;
  const st = list.map((x) => stats(x, from)), total = addStats(st);
  if (single) { total.score = st[0].score; total.scoreThen = st[0].scoreThen; }
  const sections = [];
  const sec = (id, title, count, ...body) => { sections.push({ id, title, count }); return h("section", { id }, h("h2", title, count != null ? h("span.count", count) : null), body); };

  // Since you last looked
  const label = period === "since" ? (prevLook ? `since ${when(from)} (${ago(from)})` : "first visit, so the last 24 hours") : period === "1" ? "the last 24 hours" : `the last ${period} days`;
  const switcher = h("div.period", [["since", "Since you last looked"], ["1", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([k, t]) =>
    h("button", { type: "button", "aria-pressed": String(period === k), onclick: () => { period = k; store.set("period", k); render(true); } }, t)), h("span.when", label));
  const top = sec("since", period === "since" ? "Since you last looked" : period === "1" ? "Today" : `Last ${period} days`, null, h("p.lede", lede(total, before)));

  // Lead story and needs
  const need = list.flatMap(needs).sort((a, b) => b.rank - a.rank || b.at - a.at);
  const fresh = list.flatMap((x) => x.media.filter((m) => m.at >= from).map((m) => ({ m, x }))).sort((a, b) => mediaRank(a.m, b.m));
  let lead;
  if (need.length) { const n = need[0], [k, cls] = needKick(n);
    const stand = n.type === "bug" ? `${plural(n.issue.mentions, "player")} report it${game ? ` in ${n.x.name}` : ""}${n.issue.refunds ? `, with ${plural(n.issue.refunds, "refund")}` : ""}${n.issue.negativeReviews ? ` and ${plural(n.issue.negativeReviews, "negative review")}` : ""}. ${n.issue.status === "still_happening" ? "It was marked fixed, but players still see it." : `First seen ${ago(n.issue.firstSeen || n.issue.lastSeen)}, last ${ago(n.issue.lastSeen)}.`}`
      : n.type === "refund" ? `Players who refunded${game ? ` ${n.x.name}` : ""} left a note. These are the clearest sign of what makes people give up.` : `${n.x.name}: nobody has answered it yet. A reply in the first days is what turns reviews around.`;
    const node = h("article.story", h("div.kicker", h(`span.${cls}`, k), game ? ` · ${n.x.name}` : ""), h("h3", needTitle(n)), h("p.stand", stand), needBody(n));
    node.querySelector(":scope > .acts").append(doneBox(n, node));
    lead = node;
  } else if (fresh.length) { const { m, x } = fresh[0];
    lead = h("article.story", h("div.kicker", h("span.good", "Good news")), h("h3", `${m.author || "A creator"} covered ${x.name}${m.views ? ` for ${num(m.views)} viewers` : ""}`), h("p.stand", "Nothing needs you. The card is under In the media."));
  } else lead = h("article.story", h("div.kicker", "All calm"), h("h3", "Nothing needs you"), h("p.stand", "No urgent bugs, nothing came back after a fix, no refund notes, and every negative review is answered."));
  const leadSec = sec("lead", "Lead story", null, h("div.lead", lead));
  const rest = need.slice(1);
  const needSec = sec("needs", "Needs you", rest.length ? `${rest.length} more` : "nothing else", rest.length ? rest.map((n) => needNode(n, game)) : h("p.empty", need.length ? "Only the lead story." : "Nothing to act on."));

  // What players said: reviews, threads and refund notes, most important in full, the rest one line each
  const shown = new Set(need.flatMap((n) => n.type === "review" ? [n.post] : n.type === "refund" ? n.posts : []));
  const saidAll = list.flatMap((x) => x.items.filter((i) => i.created >= from && ["review", "topic", "refund"].includes(i.kind)).map((i) => ({ i, x })));
  const said = saidAll.filter(({ i }) => !shown.has(i)).sort((a, b) => byWeight(a.i, b.i)), above = saidAll.length - said.length;
  const loose = list.flatMap((x) => x.items.filter((i) => i.created >= from && i.kind === "reply" && !x.items.some((t) => t.id === parentOf(i) && t.created >= from)).map((i) => ({ i, x })));
  const fullN = 3, linesN = 8, tail = [...said.slice(fullN + linesN), ...loose];
  const saidSec = sec("said", "What players said", saidAll.length ? plural(saidAll.length, "post") : null,
    saidAll.length ? [above ? h("p.meta", { style: "margin-bottom:14px" }, `${plural(above, "post")} you need to act on ${above === 1 ? "is" : "are"} above, under Needs you.`) : null,
      said.slice(0, fullN).map(({ i, x }) => postFull(i, x, game)),
      said.length > fullN ? h("div.lines", said.slice(fullN, fullN + linesN).map(({ i, x }) => postLine(i, x, game))) : null,
      tail.length ? h("details.more", h("summary", `${plural(tail.length, "shorter post")} and replies`), h("div.lines", tail.map(({ i, x }) => postLine(i, x, game, true)))) : null]
      : h("p.empty", "No new reviews, threads or refund notes."));

  // In the media
  const mediaSec = sec("media", "In the media", fresh.length ? plural(fresh.length, "new piece") : null,
    fresh.length ? fresh.slice(0, 6).map(({ m, x }) => mediaCard(m, x, game)) : h("p.empty", "No new videos, streams or articles."),
    fresh.length > 6 ? h("details.more", h("summary", `${fresh.length - 6} more`), h("div.in", fresh.slice(6).map(({ m, x }) => mediaCard(m, x, game)))) : null);

  // Money
  const yday = iso(now - DAY), d30 = days(30), selling = list.filter((x) => x.hasSales || !x.upcoming);
  const daily = d30.map((d) => sum(list.map((x) => x.gross(d))));
  const mrow = (name, yg, yu, s, cls = "") => h(`tr${cls}`, h("td", name), h("td", money(yg), " ", h("small", `${num(yu)} sold`)), h("td", money(s.gross), " ", h("small", `${num(s.units)} sold`)),
    h("td", (() => { const m = move(s.gross, s.grossOld); return m ? h(`span.${m.cls}`, m.short) : "–"; })()), h("td", `${s.wish >= 0 ? "+" : "−"}${num(Math.abs(s.wish))}`));
  const moneySec = sec("money", "Money", null,
    h("p", "Yesterday brought in ", h("b", money(sum(list.map((x) => x.gross(yday))))), ` gross from ${plural(sum(list.map((x) => x.units(yday))), "copy", "copies")}. `,
      `Over this period: ${money(total.gross)} gross`, moved(move(total.gross, total.grossOld), before), "."),
    h("div.tablewrap", h("table", h("tr", ["Game", "Yesterday", period === "since" ? "Since last look" : period === "1" ? "Today" : `${period} days`, "vs before", "Wishlists"].map((t) => h("th", t))),
      list.map((x, i) => mrow(x.name, x.gross(yday), x.units(yday), st[i])),
      list.length > 1 ? mrow("All games", sum(list.map((x) => x.gross(yday))), sum(list.map((x) => x.units(yday))), total, ".total") : null)),
    selling.length ? [bars(daily, d30.map((d, i) => `${d}: ${money(daily[i])}`), 28), h("p.caption", "Gross per day, last 30 days. Yesterday in green; today is still counting.")] : null);

  // Quiet: what did not change, in one line
  const quiet = [];
  list.forEach((x, i) => { const q = [];
    if (!st[i].posts) q.push("no new posts");
    if (!x.media.some((m) => m.at >= from)) q.push("no new coverage");
    if (!x.bugs.length && !x.upcoming) q.push("no open bugs");
    if (st[i].score && st[i].scoreThen && st[i].score.pct === st[i].scoreThen.pct) q.push(`score steady at ${st[i].score.pct}%`);
    { const m = move(st[i].gross, st[i].grossOld); if (m?.same) q.push("sales flat"); }
    if (q.length) quiet.push(`${game ? x.name + ": " : ""}${q.join(", ")}`); });
  const quietSec = sec("quiet", "Quiet", null, h("p.quiet", quiet.length ? quiet.join(". ") + "." : "Everything moved a little."));

  const main = [switcher, top, leadSec, needSec, saidSec, mediaSec, moneySec, quietSec];

  if (game) {
    // Each game then gets its own short section in the same shape.
    main.push(h("p.band", "Game by game"));
    sections.push({ sep: "Games" });
    list.forEach((x, i) => {
      const n = needs(x).sort((a, b) => b.rank - a.rank), p = x.items.filter((it) => it.created >= from && ["review", "topic", "refund"].includes(it.kind)).sort(byWeight), m = x.media.filter((v) => v.at >= from).sort(mediaRank);
      sections.push({ id: `game-${x.id}`, title: x.name, count: n.length || null, alert: n.length });
      main.push(h("section", { id: `game-${x.id}` },
        h("h3.gamehead", h("a", { href: `#g/${x.id}` }, x.name), h("a.go", { href: `#g/${x.id}` }, "Full brief →")),
        h("p", lede(st[i], before, { you: false })),
        n.length || p.length || m.length ? h("div.lines",
          n.map((a) => { const [k, cls] = needKick(a); return line(k, cls, needTitle(a), needFacts(a).split(" · ")[0], needBody(a)); }),
          p.slice(0, 3).map((it) => postLine(it, x)),
          m.slice(0, 2).map((v) => line(v.live ? "Live now" : v.source === "news" ? "Article" : "Video", v.live ? "bad" : "", `${v.author || ""}: ${v.title}`, v.views != null ? `${num(v.views)} views` : ago(v.at), mediaCard(v, x)))) : h("p.quiet", "Nothing new."),
        p.length > 3 ? h("p.meta", { style: "margin-top:8px" }, `${p.length - 3} more posts in the `, h("a", { href: `#g/${x.id}` }, "full brief"), ".") : null));
    });
  } else main.push(...deeper(x1, sections));

  return { main, side: numbers(list, st, total, single), sections };
}

// ---- the side column: numbers -----------------------------------------------
function numbers(list, st, total, single) {
  const d30 = days(30), all = (f) => d30.map((d) => sum(list.map((x) => x[f](d))));
  const fig = (label, value, m, series, sub) => h("div.fig", h("div.label", label), h("div.value", value, m ? h(`small.${m.cls}`, m.short) : null), series ? spark(series) : h("span"), sub ? h("div.sub", sub) : null);
  const bugs = list.flatMap((x) => x.bugs), hot = bugs.filter((b) => ["urgent", "high"].includes(b.urgency) || b.status === "still_happening").length;
  return h("div.block.numbers", h("h2", "The numbers"), h("div.figs",
    fig("Gross", money(total.gross), move(total.gross, total.grossOld), all("gross"), `${plural(total.units, "copy", "copies")} sold`),
    fig("Wishlists, net", `${total.wish >= 0 ? "+" : "−"}${num(Math.abs(total.wish))}`, move(total.wish, total.wishOld), all("wishAdds"), "adds per day, 30 days"),
    fig("New reviews", num(total.reviews || 0), null, null, single && total.score ? `${total.score.pct}% positive of ${num(total.score.total)}` : `${num(total.pos || 0)} positive`),
    fig("Players, peak", num(total.peak || 0), move(total.peak, total.peakOld), all("peak"), single && list[0].playersNow != null ? `${num(list[0].playersNow)} right now` : "best hour, games added up"),
    fig("Open bugs", num(bugs.length), null, null, hot ? h("span.down", `${hot} urgent or high`) : "none urgent")),
    single ? null : h("table.mini", { style: "margin-top:14px" }, h("tr", ["Game", "Gross", "Wishl.", "Bugs"].map((t) => h("th", t))),
      list.map((x, i) => h("tr", h("td", h("a", { href: `#g/${x.id}` }, x.name)), h("td", st[i].gross ? money(st[i].gross) : "–"), h("td", `${st[i].wish >= 0 ? "+" : "−"}${num(Math.abs(st[i].wish))}`), h("td", x.bugs.length || "–")))));
}

// ---- deeper sections of one game: what the tabs hold today ------------------
function deeper(x, sections) {
  const out = [h("p.band", "Everything else about " + x.name)];
  sections.push({ sep: "Deeper" });
  const sec = (id, title, count, ...body) => { sections.push({ id, title, count }); out.push(h("section.deep", { id }, h("h2", title, count != null ? h("span.count", count) : null), body)); };
  const none = (t) => h("p.empty", t);
  const issueLine = (is, kind) => { const posts = issuePosts(is, x), fixedKey = `fixed:${x.id}:${is.id}`;
    const hot = kind === "bug" && (["urgent", "high"].includes(is.urgency) || is.status === "still_happening");
    const node = line(kind === "bug" ? (is.status === "still_happening" ? "came back" : is.urgency) : kind === "idea" ? "idea" : "loved", hot ? "bad" : kind === "loved" ? "good" : "", is.title, plural(is.mentions, "player"), [
      h("div.meta", [is.negativeReviews ? plural(is.negativeReviews, "negative review") : null, is.refunds ? plural(is.refunds, "refund") : null, is.firstSeen ? `first seen ${ago(is.firstSeen)}` : null, `last ${ago(is.lastSeen)}`].filter(Boolean).join(" · ")),
      kind === "loved" ? null : h("div.acts", copyBtn(kind === "bug" ? "Copy fix prompt" : "Copy as a task", () => kind === "bug" ? fixPrompt(is, x) : `Add this to ${x.name}: ${is.title}\n${plural(is.mentions, "player")} asked for it.`),
        h("label.meta", h("input", { type: "checkbox", checked: !!store.get(fixedKey, false), onchange: (e) => { store.set(fixedKey, e.target.checked); node.classList.toggle("low", e.target.checked); } }), kind === "bug" ? " Mark fixed" : " Done")),
      postsBlock(posts, x)]);
    if (store.get(fixedKey, false)) node.classList.add("low");
    return node; };
  sec("bugs", "Bugs", x.bugs.length, x.bugs.length ? h("div.lines", x.bugs.map((b) => issueLine(b, "bug"))) : none("No open bugs."));
  sec("ideas", "Ideas", x.ideas.length, x.ideas.length ? h("div.lines", x.ideas.map((b) => issueLine(b, "idea"))) : none("No open ideas."));
  sec("loved", "Loved", x.loved.length, x.loved.length ? h("div.lines", x.loved.map((b) => issueLine(b, "loved"))) : none("Nothing yet."));

  // All posts: ranked by importance, YouTube comments and replies hidden until asked for
  const kinds = [["top", "Important", (i) => !["comment", "reply"].includes(i.kind)], ["review", "Reviews"], ["topic", "Threads"], ["video", "Videos"], ["refund", "Refund notes"], ["reply", "Replies"], ["comment", "YouTube comments"]];
  let pick = "top", shown = 25, newest = false;
  const listBox = h("div"), chips = h("div.chips");
  const drawPosts = () => {
    const test = kinds.find((k) => k[0] === pick)[2] || ((i) => i.kind === pick);
    const posts = x.items.filter(test).sort(newest ? (a, b) => b.created - a.created : (a, b) => (b.created > now - 7 * DAY) - (a.created > now - 7 * DAY) || byWeight(a, b));
    chips.replaceChildren(...kinds.map(([k, t, f]) => h("button", { type: "button", "aria-pressed": String(pick === k), onclick: () => { pick = k; shown = 25; drawPosts(); } }, `${t} ${x.items.filter(f || ((i) => i.kind === k)).length}`)),
      h("button", { type: "button", "aria-pressed": String(newest), onclick: () => { newest = !newest; drawPosts(); } }, "Newest first"));
    listBox.replaceChildren(posts.length ? h("div.lines", posts.slice(0, shown).map((p) => postLine(p, x))) : none("None."),
      posts.length > shown ? h("div.acts", h("button.btn.ghost", { type: "button", onclick: () => { shown += 50; drawPosts(); } }, `Show more (${posts.length - shown} left)`)) : "");
  };
  drawPosts();
  sec("posts", "All posts", x.items.length, chips, listBox);

  const rel = [...(x.g.releases || [])].sort((a, b) => b.time - a.time);
  sec("updates", "Updates", rel.length, rel.length ? h("div.lines", rel.map((r) => { const after = x.items.filter((i) => i.created >= r.time && i.created < r.time + 7 * DAY && i.kind === "review");
    return line("update", "", r.name, ago(r.time), [h("p.meta", [r.votesUp != null ? `${r.votesUp} up, ${r.votesDown || 0} down` : null, r.comments != null ? plural(r.comments, "comment") : null, `${plural(after.length, "review")} in the week after, ${after.filter((i) => i.votedUp === false).length} negative`].filter(Boolean).join(" · ")), r.url ? h("a.meta", { href: r.url, target: "_blank", rel: "noopener" }, "Open the post ↗") : null]); })) : none("No updates yet."));

  const ach = x.g.achievements?.list || [];
  sec("achievements", "Achievements", ach.length, ach.length ? h("div.tablewrap", h("table", h("tr", ["Achievement", "Players"].map((t) => h("th", t))), [...ach].sort((a, b) => b.percent - a.percent).map((a) => h("tr", h("td", { style: "white-space:normal" }, a.name, " ", h("small", a.desc || "")), h("td", `${a.percent}%`))))) : none("None yet."));

  const d30 = days(30);
  sec("stats", "Steam stats", null, x.reach.length || x.median ? [h("p", "Median time played: ", h("b", x.median || "–"), x.playersNow != null ? `. ${num(x.playersNow)} playing right now, ${num(Math.max(...d30.map(x.peak)))} at the 30 day peak.` : "."),
    h("div.reach", x.reach.flatMap((r) => [h("span", r.label), h("span", h("i", { style: `width:${r.pct}%` })), h("span", `${r.pct}%`)])), h("p.caption", "Share of players who played at least this long.")] : none("No Steamworks numbers yet."));

  const media = [...x.media].sort((a, b) => b.at - a.at);
  sec("allmedia", "All media", media.length, media.length ? media.slice(0, 12).map((m) => mediaCard(m, x)) : none("No coverage yet."));

  const cur = x.g.curators?.list || [];
  sec("curators", "Curators", cur.length, cur.length ? h("div.lines", cur.map((c) => line(c.state === "recommended" ? "recommends" : c.state === "not_recommended" ? "against" : "informative", c.state === "recommended" ? "good" : c.state === "not_recommended" ? "bad" : "", c.name, `${num(c.followers || 0)} followers`, h("p", c.blurb || "No text.")))) : none("No curator reviews yet."));

  const d14 = days(14).reverse(), g30 = d30.map(x.gross);
  sec("sales", "Sales", null, x.hasSales ? [h("p", `Last 7 days: ${money(sum(days(7).map(x.gross)))} gross, ${money(sum(days(7).map(x.net)))} net. Last 30 days: ${money(sum(g30))} gross.`),
    bars(g30, d30.map((d, i) => `${d}: ${money(g30[i])}`), 28),
    h("div.tablewrap", h("table", h("tr", ["Day", "Sold", "Gross", "Net", "Wishlists"].map((t) => h("th", t))), d14.map((d, i) => h("tr", h("td", i === 0 ? "Today" : i === 1 ? "Yesterday" : d), h("td", num(x.units(d))), h("td", money(x.gross(d))), h("td", money(x.net(d))), h("td", `${x.wishNet(d) >= 0 ? "+" : "−"}${Math.abs(x.wishNet(d))}`)))))]
    : [none("Not on sale yet."), h("p", `Wishlists, last 7 days: +${num(sum(days(7).map(x.wishNet)))} net.`)]);

  const bun = x.g.bundles?.list || [];
  sec("bundles", "Bundles", bun.length, bun.length ? h("div.lines", bun.map((b) => line("bundle", "", b.name, b.bundleDiscount ? `−${b.bundleDiscount}%` : "", h("p.meta", `${b.apps?.length ?? b.apps ?? "?"} games`)))) : none("In no bundles."));

  const comp = Object.values(x.g.competitors || {});
  const latest = (o) => { const k = Object.keys(o || {}).sort().pop(); return k ? o[k] : null; };
  sec("competitors", "Competitors", comp.length, comp.length ? h("div.tablewrap", h("table", h("tr", ["Game", "Peak players", "Score", "Last update"].map((t) => h("th", t))),
    h("tr.total", h("td", x.name), h("td", num(Math.max(...days(7).map(x.peak)))), h("td", x.scoreAt(iso(now)) ? `${x.scoreAt(iso(now)).pct}%` : "–"), h("td", rel[0] ? ago(rel[0].time) : "–")),
    comp.map((c) => { const r = latest(c.reviews), up = c.lastUpdate || c.updates?.[0]?.time;
      return h("tr", h("td", c.name), h("td", num(c.peak ?? Math.max(0, ...Object.values(c.peaks || {}).slice(-7)))), h("td", c.score != null ? `${c.score}%` : r ? `${Math.round((r.positive / (r.positive + r.negative)) * 100)}%` : "–"), h("td", up ? ago(up) : "–")); }))) : none("No games to compare with yet."));
  return out;
}

// ---- shell ------------------------------------------------------------------
let all = [], sample = false;
const root = document.getElementById("app");
function setTheme(t) { if (t) document.documentElement.dataset.theme = t; }
setTheme(store.get("theme", null));
const isDark = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";

const TASKS = [
  ["See what needs attention across all games", "1", "Open All games (it is not where you land after picking a game)", "0", "Lead story and Needs you are the top of the page"],
  ["Open the top bug of one game and read its posts", "3", "Pick the game, Bugs tab, open the bug", "1", "Open “Read the posts” under the bug, in place"],
  ["See yesterday's sales for one game", "2", "Pick the game, Sales tab (then find the day in the chart)", "0", "Money lists yesterday per game"],
  ["Find new videos about a game", "2", "Pick the game, Media tab", "0", "In the media shows them with a summary, labelled by game"],
];
function diffPanel() {
  return h("div.diff", h("details", { open: store.get("diff", false) || null, ontoggle: (e) => store.set("diff", e.currentTarget.open) },
    h("summary", "What's different ", h("span", "· the four everyday tasks take 8 clicks today, 1 here")),
    h("div.tablewrap", h("table", h("tr", ["Task", "Today", "Daily brief"].map((t) => h("th", t))),
      TASKS.map(([task, a, how, b, how2]) => h("tr", h("td", task), h("td", h("b", a), h("small", how)), h("td", h("b.up", b), h("small", how2)))),
      h("tr.total", h("td", "Total"), h("td", h("b", "8")), h("td", h("b.up", "1"))))),
    h("ul", h("li", "One page read top to bottom. Tabs became sections; a sticky contents list jumps between them."),
      h("li", "Sentences first, numbers in the margin. Everything opens in place; nothing navigates away."),
      h("li", "Ranked by importance: reviews, threads, videos and refund notes lead. Replies sit under their thread, YouTube comments under their video as one line."),
      h("li", "Clicks today are counted from the current dashboard's code, starting on a game's page."))));
}

function render(keepScroll = false) {
  const y = window.scrollY;
  const id = location.hash.match(/^#g\/(\d+)/)?.[1], x = all.find((g) => g.id === id);
  const list = x ? [x] : all, from = fromOf();
  const { main, side, sections } = brief(list, from, !!x);
  const contents = h("nav.block.contents", { "aria-label": "Contents" }, h("h2", "Contents"), h("ol", sections.map((s) => s.sep ? h("li.sep", s.sep)
    : h("li", h("a", { href: "#" + s.id, "data-to": s.id, onclick: (e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); } }, s.title, s.count ? h("span.n", s.count) : null)))));
  document.title = `${x ? x.name : "All games"} · Daily brief`;
  root.replaceChildren(
    h("header.mast", h("div.mast-in",
      h("div.mast-top", h("span", new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })),
        h("span.tools", h("span.source", sample ? h("b", "Sample data") : "Your data", sample ? " (invented)" : ""), h("a", { href: "home.html" }, "Public home page"),
          h("button.linkbtn", { type: "button", onclick: () => { const d = !isDark(); setTheme(d ? "dark" : "light"); store.set("theme", d ? "dark" : "light"); } }, "Light / dark"),
          h("button.linkbtn", { type: "button", title: "Start “since you last looked” from now", onclick: () => { prevLook = now; store.set("prev", now); store.set("last", now); period = "since"; store.set("period", "since"); render(); } }, "Mark all read"))),
      h("h1", "The Daily Brief", h("small", x ? x.name : "Four Games, all games")),
      h("nav.editions", { "aria-label": "Games" }, h("a", { href: "#", "aria-current": x ? null : "page" }, "All games"),
        all.map((g) => h("a", { href: `#g/${g.id}`, "aria-current": g === x ? "page" : null }, g.name, needs(g).length ? h("span.dot", { title: `${needs(g).length} need you` }) : null))))),
    diffPanel(),
    h("div.page", h("main.main", main), h("aside.side", h("div.side-stick", contents, side))),
    h("footer.end", "Daily brief, redesign variant 3. A prototype in feedback/lab/brief: nothing here saves to the data repo."));
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  spy();
}
// Highlight the section being read in the contents list.
let observer;
function spy() {
  observer?.disconnect();
  const links = new Map([...document.querySelectorAll(".contents a[data-to]")].map((a) => [a.dataset.to, a]));
  const seen = new Set();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
    const first = [...links.keys()].find((k) => seen.has(k));
    for (const [k, a] of links) a.classList.toggle("on", k === first);
  }, { rootMargin: "-10% 0px -55% 0px" });
  for (const k of links.keys()) { const el = document.getElementById(k); if (el) observer.observe(el); }
}

(async () => {
  let index = await get("index.json"), src;
  if (index?.games?.length) {
    const [sales, wishlists, steamworks] = await Promise.all([get("sales.json"), get("wishlists.json"), get("steamworks.json")]);
    const games = Object.fromEntries(await Promise.all(index.games.map(async (m) => [m.appId, await get(`games/${m.appId}.json`)])));
    src = { index, games, sales, wishlists, steamworks };
  } else { src = window.SAMPLE; sample = true; }
  all = src.index.games.map((m) => src.games[m.appId] && derive(m, src.games[m.appId], src.sales, src.wishlists, src.steamworks)).filter(Boolean)
    .sort((a, b) => Math.max(0, ...needs(b).map((n) => n.rank)) - Math.max(0, ...needs(a).map((n) => n.rank)) || b.items.length - a.items.length);
  window.addEventListener("hashchange", () => render());
  render();
})();
