// Columns: a deck of side-by-side columns over the feedback data. Plain DOM, no build step.
(async function () {
const { DAY, NOW } = FG;
const { games: GAMES, sample } = await FG.load();
const G = Object.fromEntries(GAMES.map((g) => [g.id, g]));

// ---- small helpers ----------------------------------------------------------------------------
function h(sel, ...kids) {
	const [tag, ...cls] = sel.split(".");
	const el = document.createElement(tag || "div");
	if (cls.length) el.className = cls.join(" ");
	const first = kids[0];
	if (first && typeof first === "object" && !first.nodeType && !Array.isArray(first)) {
		kids.shift();
		for (const [k, v] of Object.entries(first)) {
			if (v == null || v === false) continue;
			if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
			else if (k === "style") el.style.cssText = v;
			else el.setAttribute(k, v === true ? "" : v);
		}
	}
	for (const k of kids.flat(3)) if (k != null && k !== false && k !== "") el.append(k.nodeType ? k : String(k));
	return el;
}
const sum = (list, f = (x) => x) => list.reduce((a, x) => a + (f(x) || 0), 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const num = (n) => n == null ? "–" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);
const money = (n) => `$${n >= 10000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toLocaleString("en-US")}`;
const ago = (t) => { const s = NOW - t; return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : s < DAY ? `${Math.round(s / 3600)} h` : `${Math.round(s / DAY)} d`; };
const dayName = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const delta = (a, b) => { if (!b) return null; const d = (a - b) / b; return h(`span.delta.${Math.abs(d) < 0.03 ? "flat" : d > 0 ? "up" : "down"}`, Math.abs(d) < 0.03 ? "same" : `${d > 0 ? "▲" : "▼"} ${Math.round(Math.abs(d) * 100)}%`); };
const press = (fn) => ({ role: "button", tabindex: "0", onclick: fn, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(e); } } });
function toast(msg) {
	const t = document.getElementById("toast");
	t.textContent = msg; t.classList.add("on");
	clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("on"), 1800);
}

// ---- column types -----------------------------------------------------------------------------
const BY = { players: ["players", "Most players"], fresh: ["new", "Newest"], rank: ["rank", "Importance"] };
const TYPES = {
	overview: { icon: "🎮", name: "Overview", hue: 212, w: 360, filters: [["all", "Everything"], ["attention", "Needs attention"], ["bugs", "Bugs"], ["ideas", "Ideas & loved"], ["posts", "Posts"], ["media", "Media"]], sorts: [BY.rank, BY.fresh] },
	attention: { icon: "🔥", name: "Needs attention", hue: 352, sorts: [BY.rank, BY.fresh], about: "Urgent and high bugs, bugs that came back, unanswered negative reviews, refund notes, live streams." },
	bugs: { icon: "🐛", name: "Bugs", hue: 14, filters: [["all", "All open"], ["high", "High & urgent"], ["trending", "Trending"], ["since", "Since last update"]], sorts: [["rank", "Priority"], BY.players, ["neg", "Negative reviews"], BY.fresh] },
	ideas: { icon: "💡", name: "Ideas", hue: 262, filters: [["all", "All"], ["trending", "Trending"]], sorts: [BY.players, BY.fresh] },
	loved: { icon: "💚", name: "Loved", hue: 150, sorts: [BY.players, BY.fresh] },
	posts: { icon: "💬", name: "Reviews & threads", hue: 212, filters: [["all", "All posts"], ["review", "Reviews"], ["neg", "Negative reviews"], ["thread", "Threads"], ["refund", "Refund notes"]], sorts: [BY.rank, BY.fresh] },
	media: { icon: "🎬", name: "Media", hue: 328, filters: [["all", "All"], ["youtube", "YouTube"], ["twitch", "Twitch"], ["news", "Articles & Reddit"]], sorts: [BY.fresh, ["reach", "Most views"]] },
	money: { icon: "💰", name: "Money", hue: 38, w: 360, filters: [["14", "14 days"], ["7", "7 days"], ["30", "30 days"]] },
	updates: { icon: "🚀", name: "Updates", hue: 182 },
	stats: { icon: "🏆", name: "Steam stats", hue: 285 },
	curators: { icon: "⭐", name: "Curators", hue: 48 },
	rivals: { icon: "⚔️", name: "Competitors", hue: 236 },
	bundles: { icon: "🎁", name: "Bundles", hue: 300 },
};
const newCol = (type, game = null) => ({ id: Math.random().toString(36).slice(2, 8), type, game, w: TYPES[type].w || 330, filter: TYPES[type].filters?.[0][0] || "all", sort: TYPES[type].sorts?.[0][0] || "rank" });
const defaults = (view) => view === "games" ? GAMES.map((g) => newCol("overview", g.id))
	: view === "kinds" ? ["attention", "bugs", "ideas", "posts", "media", "money"].map((t) => newCol(t))
	: ["bugs", "ideas", "loved", "media", "money", "updates"].map((t) => newCol(t, view.slice(5)));

// ---- state, remembered in this browser --------------------------------------------------------
const KEY = "fg-lab-columns-v1";
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })();
const state = { view: saved.view || "games", decks: saved.decks || {}, theme: saved.theme || "auto", hues: saved.hues || {} };
if (state.view.startsWith("game:") && !G[state.view.slice(5)]) state.view = "games";
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private window */ } };
const deck = () => (state.decks[state.view] ||= defaults(state.view)).filter((c) => TYPES[c.type] && (!c.game || G[c.game]));
const open = new Set(); // expanded cards, "<column>|<card>"
for (const g of GAMES) if (state.hues[g.id] != null) g.hue = state.hues[g.id];

// ---- importance -------------------------------------------------------------------------------
// Reviews, threads, videos and refund notes are full cards; replies one line; YouTube comments
// are only a count on their video.
const fresh = (t, span = 10) => Math.max(0, span - (NOW - t) / DAY);
const issueRank = (i) => i.kind === "bug" ? (i.status === "still_happening" ? 95 : { urgent: 100, high: 88, medium: 60, low: 35 }[i.urgency] || 35) + Math.min(i.players, 10) * 0.5 + fresh(i.lastSeen, 3)
	: i.kind === "idea" ? 40 + Math.min(i.players, 20) * 0.6 : 22 + Math.min(i.players, 20) * 0.4;
const postRank = (p) => ({ refund: 90, thread: 70, video: 60, reply: 15, comment: 0 }[p.kind] ?? (p.up ? 50 : p.answered ? 62 : 85)) + fresh(p.created);
const mediaRank = (m) => (m.live ? 96 : 56 + Math.log10((m.views || 0) + 1) * 3) + fresh(m.at);
const needs = {
	issue: (i) => i.kind === "bug" && (i.status === "still_happening" || i.urgency === "urgent" || i.urgency === "high"),
	post: (p) => NOW - p.created < 14 * DAY && (p.kind === "refund" || (p.kind === "review" && !p.up && !p.answered)),
};
const E = {
	issue: (i) => ({ k: `i${i.game}${i.id}`, t: "issue", x: i, game: i.game, rank: issueRank(i), at: i.lastSeen }),
	post: (p) => ({ k: `p${p.game}${p.id}`, t: "post", x: p, game: p.game, rank: postRank(p), at: p.created }),
	media: (m) => ({ k: `m${m.game}${m.id}`, t: "media", x: m, game: m.game, rank: mediaRank(m), at: m.at }),
	update: (r, g) => ({ k: `u${g.id}${r.time}`, t: "update", x: r, game: g.id, rank: 44 + fresh(r.time), at: r.time }),
};

function entries(col) {
	const f = col.filter, out = [];
	for (const g of col.game ? [G[col.game]] : GAMES) {
		const iss = g.issues.map(E.issue), posts = g.posts.filter((p) => p.kind !== "comment").map(E.post), med = g.media.map(E.media), ups = g.releases.map((r) => E.update(r, g));
		const of = (kind) => iss.filter((e) => e.x.kind === kind);
		const att = [...iss.filter((e) => needs.issue(e.x)), ...posts.filter((e) => needs.post(e.x)), ...med.filter((e) => e.x.live)];
		if (col.type === "attention") out.push(...att);
		if (col.type === "bugs") out.push(...of("bug").filter((e) => f === "all" || (f === "high" && needs.issue(e.x)) || (f === "trending" && e.x.trending) || (f === "since" && e.x.sinceUpdate)));
		if (col.type === "ideas") out.push(...of("idea").filter((e) => f === "all" || e.x.trending));
		if (col.type === "loved") out.push(...of("loved"));
		if (col.type === "posts") out.push(...posts.filter((e) => f === "all" || (f === "neg" ? e.x.kind === "review" && !e.x.up : e.x.kind === f)));
		if (col.type === "media") out.push(...med.filter((e) => f === "all" || (f === "news" ? !["youtube", "twitch"].includes(e.x.source) : e.x.source === f)));
		if (col.type === "updates") out.push(...ups);
		if (col.type === "overview") {
			// Posts already listed under a bug or idea stay there, unless they need an answer themselves.
			const linked = new Set(g.issues.flatMap((i) => i.posts.map((p) => p.id)));
			const loose = posts.filter((e) => !linked.has(e.x.id) || needs.post(e.x));
			out.push(...(f === "attention" ? att : f === "bugs" ? of("bug") : f === "ideas" ? [...of("idea"), ...of("loved")] : f === "posts" ? posts : f === "media" ? med
				: [...of("bug"), ...of("idea"), ...of("loved").sort((a, b) => b.rank - a.rank).slice(0, 2), ...loose, ...med, ...ups.slice(0, 1)]));
		}
	}
	const s = col.sort, by = (a, b) => b.rank - a.rank || b.at - a.at;
	return out.sort(s === "new" ? (a, b) => b.at - a.at : s === "players" ? (a, b) => (b.x.players || 0) - (a.x.players || 0) || by(a, b)
		: s === "neg" ? (a, b) => (b.x.neg || 0) - (a.x.neg || 0) || by(a, b) : s === "reach" ? (a, b) => (b.x.views || 0) - (a.x.views || 0) : by);
}

// ---- cards ------------------------------------------------------------------------------------
const hue = (id) => `--h:${G[id].hue}`;
const gameTag = (id) => h("span.gtag.hued", { style: hue(id), title: `Open ${G[id].name}`, ...press((e) => { e.stopPropagation(); go(`game:${id}`); }) }, h("i"), G[id].short);
const pill = (cls, text) => h(`span.pill.${cls}`, text);
const POST = { review: (p) => p.up ? ["good", "👍 Review"] : ["bad", "👎 Review"], thread: () => ["blue", "🧵 Thread"], refund: () => ["warn", "💸 Refund note"], reply: () => ["muted", "↳ Reply"], comment: () => ["muted", "Comment"], video: () => ["pink", "▶ Video"] };
const postPill = (p) => pill(...(POST[p.kind] || POST.reply)(p));
const postMeta = (p) => [p.author, p.hours != null ? `${p.hours} h played` : null, p.lang && p.lang !== "english" ? p.lang : null, `${ago(p.created)} ago`].filter(Boolean).join(" · ");
const fake = (label, msg = "Copied (demo)") => h("button.btn", { type: "button", onclick: (e) => { e.stopPropagation(); toast(msg); } }, label);

function issueCard(e, col, isOpen, toggle) {
	const i = e.x, label = i.kind === "bug" ? [i.urgency === "urgent" || i.urgency === "high" ? "bad" : "bug", `🐛 ${i.urgency[0].toUpperCase()}${i.urgency.slice(1)}`] : i.kind === "idea" ? ["idea", "💡 Idea"] : ["good", "💚 Loved"];
	return h(`article.card.full.k-${i.kind}`, { "aria-expanded": String(isOpen) },
		h("div.top", press(toggle),
			h("div.tags", pill(...label), !col.game && gameTag(i.game), i.status === "still_happening" && pill("bad", "↩ Came back"), i.trending && pill("warn", "Trending"), i.sinceUpdate && pill("muted", "Since last update"), h("time", ago(i.lastSeen))),
			h("h3", i.title),
			h("p.meta", [plural(i.players, "player"), i.neg ? plural(i.neg, "negative review") : null, i.refunds ? plural(i.refunds, "refund") : null, plural(i.posts.length, "post")].filter(Boolean).join(" · "))),
		isOpen && h("div.more",
			i.posts.slice().sort((a, b) => postRank(b) - postRank(a)).map((p) => p.kind === "reply" || p.kind === "comment"
				? h("p.line", h("b", `↳ ${p.author}`), ` ${p.text}`)
				: h("div.mini", h("div.tags", postPill(p), h("span.meta", postMeta(p))), h("p", p.text))),
			h("div.actions", i.kind === "bug" && fake("Copy fix prompt"), i.kind !== "loved" && fake("Copy patch-note line"), i.kind === "loved" ? fake("Copy for store page") : fake("✓ Mark fixed", "Marked fixed (demo)"))));
}

function postCard(e, col, isOpen, toggle) {
	const p = e.x, g = G[p.game];
	if (p.kind === "reply") return h("article.card.slim", { "aria-expanded": String(isOpen) }, h("div.top", press(toggle), !col.game && h("i.gdot.hued", { style: hue(p.game), title: g.name }), h("b", `↳ ${p.author}`), h("span.txt", p.text), h("time", ago(p.created))));
	const about = g.issues.filter((i) => i.posts.includes(p));
	const unanswered = p.kind === "review" && !p.up && !p.answered;
	return h("article.card.full", { "aria-expanded": String(isOpen) },
		h("div.top", press(toggle),
			h("div.tags", postPill(p), !col.game && gameTag(p.game), unanswered && pill("warn", "Not answered"), h("time", ago(p.created))),
			p.title && h("h3", p.title),
			h(`p.body${isOpen ? "" : ".clamp"}`, p.text),
			h("p.meta", postMeta(p))),
		isOpen && h("div.more",
			about.length ? h("p.meta", "About: ", about.map((i) => pill(i.kind === "bug" ? "bug" : i.kind === "idea" ? "idea" : "good", i.title))) : null,
			p.kind === "refund" && h("p.meta", `Steam's reason: ${p.reason || "none given"}`),
			(unanswered || p.kind === "thread") && h("div.draft", h("b", "Drafted reply"), h("p", about[0]?.kind === "bug" ? `Thanks for the report, ${p.author}. We can reproduce it and a fix is on the way in the next update.` : `Thanks ${p.author}! We read every post and this one is on our list.`)),
			h("div.actions", (unanswered || p.kind === "thread") && fake("Copy reply"), h("a.btn", { href: p.url || "#", target: "_blank", rel: "noopener" }, p.kind === "refund" ? "Open in Steamworks ↗" : "Open on Steam ↗"))));
}

const SOURCE = { youtube: ["▶", "YouTube"], twitch: ["◉", "Twitch"], news: ["📰", "Article"], reddit: ["👽", "Reddit"] };
function mediaCard(e, col, isOpen, toggle, redraw) {
	const m = e.x, [glyph, source] = SOURCE[m.source] || ["🔗", m.source], big = m.source === "youtube" || m.source === "twitch";
	const cKey = `${col.id}|${e.k}|c`, cOpen = open.has(cKey);
	return h(`article.card.full.media${m.live ? ".live" : ""}`, { "aria-expanded": String(isOpen) },
		h("div.top", press(toggle),
			big && h("div.thumb.hued", { style: hue(m.game) }, m.thumb ? h("img", { src: m.thumb, alt: "", loading: "lazy" }) : null, h("span", glyph), m.live && h("em", "LIVE")),
			h("div.tags", pill(m.live ? "bad" : "pink", m.live ? "🔴 Live now" : `${glyph} ${source}`), !col.game && gameTag(m.game), m.verdict && m.verdict !== "unclear" && pill(m.verdict === "positive" ? "good" : m.verdict === "negative" ? "bad" : "warn", m.verdict === "positive" ? "Liked it" : m.verdict === "negative" ? "Didn't like it" : "Mixed"), h("time", ago(m.at))),
			h("h3", m.title),
			h("p.meta", [m.author, m.views != null ? `${num(m.views)} ${m.live ? "watching" : "views"}` : null, m.subs ? `${num(m.subs)} ${m.source === "twitch" ? "followers" : "subscribers"}` : null].filter(Boolean).join(" · "))),
		m.comments.length ? h("button.cbtn", { type: "button", "aria-expanded": String(cOpen), onclick: () => { cOpen ? open.delete(cKey) : open.add(cKey); redraw(); } }, `💬 ${plural(m.comments.length, "comment")}`, h("span", cOpen ? "▴" : "▾")) : null,
		cOpen && h("div.comments", m.comments.map((c) => h("p.line", h("b", c.author), ` ${c.text}`))),
		isOpen && h("div.more",
			m.summary ? h("div.draft", h("b", "✳ Claude's summary"), h("p", m.summary)) : h("p.meta", m.live ? "Live right now. A summary comes once the stream is over." : "No summary for this one."),
			m.points.map((pt) => h("p.line", pill(pt.kind === "bug" ? "bug" : pt.kind === "praise" ? "good" : "idea", pt.kind === "bug" ? "Bug" : pt.kind === "praise" ? "Loved" : "Idea"), ` ${pt.text}`, pt.at ? h("span.meta", ` at ${pt.at}`) : null)),
			h("div.actions", h("a.btn", { href: m.url || "#", target: "_blank", rel: "noopener" }, m.live ? "Join the chat ↗" : `Open on ${source} ↗`), m.source === "youtube" && fake("Copy a comment"))));
}

function updateCard(e, col, isOpen, toggle) {
	const r = e.x;
	return h("article.card.full", { "aria-expanded": String(isOpen) },
		h("div.top", press(toggle),
			h("div.tags", pill("teal", `🚀 ${r.version ? "v" + r.version : "Update"}`), !col.game && gameTag(e.game), h("time", ago(r.time))),
			h("h3", r.name),
			h("p.meta", [r.up != null ? `👍 ${r.up}` : null, r.down ? `👎 ${r.down}` : null, plural(r.notes.length, "change")].filter(Boolean).join(" · "))),
		isOpen && h("div.more", h("ul.notes", r.notes.map((n) => h("li", typeof n === "string" ? n : n.text || ""))), h("div.actions", h("a.btn", { href: r.url || "#", target: "_blank", rel: "noopener" }, "Open on Steam ↗"))));
}
const CARD = { issue: issueCard, post: postCard, media: mediaCard, update: updateCard };

// ---- column bodies that aren't lists of cards ---------------------------------------------------
const tile = (label, value, sub) => h("div.tile", h("span", label), h("b", value), sub ? h("small", sub) : null);
function dayTable(g, n = 7) {
	return h("table.days", h("tr", ["Day", "Gross", "Net", "Sold", "Refunds", "Wishlists"].map((t) => h("th", t))),
		g.days.slice(-n).reverse().map((d, i) => h(`tr${i ? "" : ".y"}`, h("td", i ? dayName(d.day) : "Yesterday"), h("td", money(d.gross)), h("td", money(d.net)), h("td", d.units), h("td", d.refunded), h("td", `${d.wish >= 0 ? "+" : ""}${d.wish}`))));
}
function moneyBody(col, redraw) {
	const gs = col.game ? [G[col.game]] : GAMES, n = Number(col.filter) || 14;
	const total = (back, k = "gross") => sum(gs, (g) => g.days.at(-back)?.[k]);
	const span = (days, k = "gross") => sum(gs, (g) => sum(g.days.slice(-days), (d) => d[k]));
	const idx = Array.from({ length: n }, (_, i) => gs[0].days.length - n + i), top = Math.max(1, ...idx.map((i) => sum(gs, (g) => g.days[i]?.gross)));
	return [
		h("div.card.hero", h("span.meta", "Yesterday"), h("div.big", money(total(1)), delta(total(1), total(2))),
			h("p.meta", `${total(1, "units")} sold · ${money(total(1, "net"))} net · ${total(1, "refunded")} refunded · ${total(1, "wish") >= 0 ? "+" : ""}${total(1, "wish")} wishlists`),
			h("div.bars", idx.map((i) => h("div.bar", { title: `${dayName(gs[0].days[i].day)}: ${money(sum(gs, (g) => g.days[i]?.gross))}` }, gs.map((g) => h("i.hued", { style: `${hue(g.id)};height:${((g.days[i]?.gross || 0) / top) * 100}%` }))))),
			h("p.meta", `Gross per day, last ${n} days${gs.length > 1 ? ", one colour per game" : ""}`)),
		h("div.tiles", tile("7 days", money(span(7)), `${money(span(7, "net"))} net`), tile("30 days", money(span(30)), `${span(30, "units")} sold`)),
		gs.length === 1 ? h("div.card", dayTable(gs[0])) : gs.map((g) => {
			const key = `${col.id}|$${g.id}`, isOpen = open.has(key), y = g.days.at(-1);
			return h("article.card.full", { "aria-expanded": String(isOpen) },
				h("div.top", press(() => { isOpen ? open.delete(key) : open.add(key); redraw(); }),
					h("div.tags", gameTag(g.id), h("time", "yesterday")),
					h("div.big.sm", money(y.gross), delta(y.gross, g.days.at(-2).gross)),
					h("p.meta", `${y.units} sold · ${money(y.net)} net · ${money(sum(g.days.slice(-7), (d) => d.gross))} in 7 days`)),
				isOpen && h("div.more", dayTable(g)));
		}),
	];
}
const section = (g, col, ...kids) => h("div.card", !col.game && h("div.tags", gameTag(g.id)), ...kids);
const BODY = {
	money: moneyBody,
	stats: (col) => (col.game ? [G[col.game]] : GAMES).map((g) => {
		const drop = g.achievements.reduce((best, a, i, l) => i && l[i - 1].percent - a.percent > best[1] ? [i, l[i - 1].percent - a.percent] : best, [-1, 0])[0];
		return section(g, col, h("div.tiles", tile("Players now", num(g.playersNow)), tile("Reviews", g.pos != null ? `${g.pos}%` : "–", `${num(g.reviews)} · +${g.reviewsWeek} this week`)),
			h("div.bars.thin", g.days.map((d) => h("div.bar", { title: `${dayName(d.day)}: ${d.players} players` }, h("i.hued", { style: `${hue(g.id)};height:${(d.players / Math.max(1, ...g.days.map((x) => x.players))) * 100}%` })))),
			h("p.meta", "Best hour per day, 30 days"),
			h("h4", "Achievements"),
			g.achievements.map((a, i) => h("div.ach", h("span", a.name, i === drop ? pill("warn", "Many stop here") : null), h("div.track", h("i.hued", { style: `${hue(g.id)};width:${a.percent}%` })), h("b", `${a.percent}%`))));
	}),
	curators: (col) => (col.game ? [G[col.game]] : GAMES).flatMap((g) => g.curators.map((c) => section(g, col,
		h("div.tags", pill(c.state === "recommended" ? "good" : c.state === "not_recommended" ? "bad" : "muted", c.state === "recommended" ? "👍 Recommends" : c.state === "not_recommended" ? "👎 Doesn't" : "Informative"), h("time", `${num(c.followers)} followers`)), h("h3", c.name), h("p.body", c.blurb)))),
	rivals: (col) => (col.game ? [G[col.game]] : GAMES).map((g) => {
		const me = g.days.at(-1).players, before = g.days.at(-8)?.players || me, mine = Math.round(((me - before) / (before || 1)) * 100);
		return section(g, col, h("h4", "Best hour yesterday, change in a week"),
			[{ name: "You", peak: me, change: mine, own: true }, ...g.competitors].map((c) => h(`div.rival${c.own ? ".own" : ""}`, h("span", c.name), h("b", num(c.peak)), c.change != null ? h(`span.delta.${c.change > 2 ? "up" : c.change < -2 ? "down" : "flat"}`, `${c.change > 0 ? "+" : ""}${c.change}%`) : null)));
	}),
	bundles: (col) => (col.game ? [G[col.game]] : GAMES).map((g) => section(g, col, h("h4", "In these bundles"), g.bundles.length ? g.bundles.map((b) => h("div.rival", h("span", b.name), h("b", b.price), h("span.delta.flat", `-${b.bundleDiscount}%`))) : h("p.meta", "Not in a bundle yet."))),
};

// ---- a column ---------------------------------------------------------------------------------
let dragging = null;
function select(options, value, onChange, label) {
	return h("select", { "aria-label": label, onchange: (e) => onChange(e.target.value) }, options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)));
}
function column(col) {
	const T = TYPES[col.type], g = col.game && G[col.game], body = h("div.col-body");
	const count = h("span.count");
	const draw = () => {
		const y = body.scrollTop;
		if (BODY[col.type]) { body.replaceChildren(...[BODY[col.type](col, draw)].flat(2).filter(Boolean)); count.hidden = true; } else {
			const list = entries(col);
			count.textContent = list.length;
			body.replaceChildren(...(list.length ? list.map((e) => {
				const key = `${col.id}|${e.k}`, isOpen = open.has(key);
				return CARD[e.t](e, col, isOpen, () => { isOpen ? open.delete(key) : open.add(key); draw(); }, draw);
			}) : [h("p.empty", col.type === "attention" ? "Nothing needs you right now. 🎉" : "Nothing here.")]));
		}
		body.scrollTop = y;
	};
	const set = (k, v) => { col[k] = v; save(); k === "game" ? drawDeck() : draw(); };
	const move = (by) => { const d = state.decks[state.view], i = d.indexOf(col), j = i + by; if (j < 0 || j >= d.length) return; d.splice(i, 1); d.splice(j, 0, col); save(); drawDeck(); };
	const width = (by) => { col.w = Math.max(280, Math.min(720, col.w + by)); save(); el.style.setProperty("--w", col.w + "px"); };
	const remove = () => { const d = state.decks[state.view]; d.splice(d.indexOf(col), 1); save(); drawDeck(); toast("Column removed. Add it back with + Column."); };
	const y = g?.days.at(-1), highs = g ? g.issues.filter(needs.issue).length : 0;
	const head = h("header.col-head",
		col.type === "overview" && g && h("div.banner", { title: `Open ${g.name}`, ...press(() => go(`game:${g.id}`)) },
			g.capsule && h("img", { src: g.capsule, alt: "", onerror: (e) => e.currentTarget.remove() }), h("strong", g.name), h("span.go", "Open deck →")),
		col.type === "overview" && g && h("div.nums",
			h("span", { title: "Players right now" }, "👥 ", h("b", num(g.playersNow))), h("span", { title: `${num(g.reviews)} reviews` }, "👍 ", h("b", g.pos != null ? `${g.pos}%` : "–")),
			h("span", { title: `Yesterday: ${y.units} sold, ${money(y.net)} net` }, "💰 ", h("b", money(y.gross)), h("small", " yesterday")), h("span", { title: "Open bugs, high or urgent" }, "🐛 ", h("b", g.issues.filter((i) => i.kind === "bug").length), highs ? h("small.badtxt", ` ${highs} high`) : null)),
		h("div.col-title", { draggable: "true", title: "Drag to reorder",
			ondragstart: (e) => { dragging = col; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", col.id); requestAnimationFrame(() => el.classList.add("dragging")); },
			ondragend: () => { dragging = null; document.querySelectorAll(".col").forEach((c) => c.classList.remove("dragging", "drop-before", "drop-after")); } },
			h("span.grip", { "aria-hidden": "true" }, "⠿"), h("span.ico", T.icon), h("h2", col.type === "overview" ? "Ranked by importance" : T.name), count,
			h("details.menu", h("summary", { "aria-label": "Column menu", title: "Column menu" }, "⋯"),
				h("div.pop", h("button", { type: "button", onclick: () => move(-1) }, "← Move left"), h("button", { type: "button", onclick: () => move(1) }, "Move right →"),
					h("button", { type: "button", onclick: () => width(60) }, "Wider"), h("button", { type: "button", onclick: () => width(-60) }, "Narrower"), h("button.danger", { type: "button", onclick: remove }, "Remove column")))),
		h("div.col-tools",
			select([...(col.type === "overview" ? [] : [["", "All games"]]), ...GAMES.map((x) => [x.id, x.short])], col.game || "", (v) => set("game", v || null), "Game"),
			T.filters && select(T.filters, col.filter, (v) => set("filter", v), "Filter"),
			T.sorts && select(T.sorts, col.sort, (v) => set("sort", v), "Sort")),
		T.about && h("p.about", T.about));
	const grab = h("div.col-resize", { title: "Drag to change width", onpointerdown: (e) => {
		const x0 = e.clientX, w0 = col.w; grab.setPointerCapture(e.pointerId);
		grab.onpointermove = (m) => { col.w = Math.max(280, Math.min(720, w0 + m.clientX - x0)); el.style.setProperty("--w", col.w + "px"); };
		grab.onpointerup = () => { grab.onpointermove = grab.onpointerup = null; save(); };
	} });
	const el = h("section.col.hued", { style: `--h:${g ? g.hue : T.hue};--w:${col.w}px`, "data-id": col.id, "aria-label": `${T.name}${g ? `, ${g.name}` : ""}`,
		ondragover: (e) => { if (!dragging || dragging === col) return; e.preventDefault(); const r = el.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2; el.classList.toggle("drop-after", after); el.classList.toggle("drop-before", !after); },
		ondragleave: (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove("drop-before", "drop-after"); },
		ondrop: (e) => {
			if (!dragging || dragging === col) return;
			e.preventDefault();
			const d = state.decks[state.view], after = el.classList.contains("drop-after");
			d.splice(d.indexOf(dragging), 1); d.splice(d.indexOf(col) + (after ? 1 : 0), 0, dragging);
			save(); drawDeck();
		} }, head, body, grab);
	draw();
	return el;
}

// ---- the page ---------------------------------------------------------------------------------
const $deck = document.getElementById("deck"), $dots = document.getElementById("dots");
function drawStrip() {
	const g = state.view.startsWith("game:") ? G[state.view.slice(5)] : null, gs = g ? [g] : GAMES;
	const y = sum(gs, (x) => x.days.at(-1).gross), week = sum(gs, (x) => sum(x.days.slice(-7), (d) => d.gross));
	const bugs = gs.flatMap((x) => x.issues.filter((i) => i.kind === "bug")), newPosts = sum(gs, (x) => x.posts.filter((p) => NOW - p.created < DAY && p.kind !== "comment").length);
	const strip = document.getElementById("strip");
	strip.className = `strip${g ? " hued game" : ""}`; strip.style.cssText = g ? hue(g.id) : "";
	strip.replaceChildren(
		g ? h("div.who", g.capsule && h("img", { src: g.capsule, alt: "", onerror: (e) => e.currentTarget.remove() }), h("div", h("h1", g.name), h("p", "One game, every view side by side"))) : h("div.who", h("div", h("h1", state.view === "games" ? "All games, by game" : "All games, by kind"), h("p", state.view === "games" ? "One column per game, most important first" : "One column per kind of thing, every game mixed"))),
		h("div.kpis", tile("Yesterday", money(y), `${money(week)} in 7 days`), tile("Players now", num(sum(gs, (x) => x.playersNow))), tile("Open bugs", bugs.length, `${bugs.filter(needs.issue).length} high or urgent`), tile("New posts", newPosts, "last 24 h"),
			g && tile("Reviews", g.pos != null ? `${g.pos}%` : "–", `+${g.reviewsWeek} this week`), g && tile("Wishlists", `${g.days.at(-1).wish >= 0 ? "+" : ""}${g.days.at(-1).wish}`, "yesterday, net")));
}
function drawNav() {
	document.getElementById("views").replaceChildren(
		...[["games", "By game"], ["kinds", "By kind"]].map(([v, t]) => h("button.seg", { type: "button", "aria-pressed": String(state.view === v), onclick: () => go(v) }, t)));
	document.getElementById("games").replaceChildren(...GAMES.map((g) => h("button.gchip.hued", { type: "button", style: hue(g.id), title: g.name, "aria-pressed": String(state.view === `game:${g.id}`), onclick: () => go(`game:${g.id}`) }, h("i"), g.short)));
	document.getElementById("sample").hidden = !sample;
}
function drawDots() {
	const cols = [...$deck.querySelectorAll('.col')], at = Math.round($deck.scrollLeft / Math.max(1, $deck.clientWidth));
	$dots.replaceChildren(...cols.map((c, i) => h("button.hued", { type: "button", style: `--h:${c.style.getPropertyValue("--h")}`, "aria-label": c.getAttribute("aria-label"), "aria-current": String(i === at), onclick: () => c.scrollIntoView({ behavior: "smooth", inline: "start", block: "nearest" }) })));
}
function drawDeck() {
	const d = deck();
	$deck.replaceChildren(...d.map(column), h("button.addcol", { type: "button", onclick: openAdd }, h("b", "+"), "Add a column"));
	drawDots();
}
function go(view) {
	state.view = view; save();
	drawNav(); drawStrip(); drawDeck(); $deck.scrollLeft = 0; drawDots();
}
$deck.addEventListener("scroll", () => requestAnimationFrame(drawDots), { passive: true });
document.addEventListener("click", (e) => document.querySelectorAll("details.menu[open]").forEach((m) => { if (!m.contains(e.target)) m.open = false; }));

// Add a column: pick a game (or all), then a kind.
const $add = document.getElementById("add");
function openAdd() {
	let game = state.view.startsWith("game:") ? state.view.slice(5) : "";
	const draw = () => $add.querySelector(".inner").replaceChildren(
		h("h2", "Add a column"),
		h("div.pick", [["", "All games"], ...GAMES.map((g) => [g.id, g.short])].map(([id, name]) => h(`button.gchip${id ? ".hued" : ""}`, { type: "button", style: id ? hue(id) : "", "aria-pressed": String(game === id), onclick: () => { game = id; draw(); } }, id ? h("i") : null, name))),
		h("div.kinds", Object.entries(TYPES).map(([type, T]) => h("button.hued", { type: "button", style: `--h:${T.hue}`, disabled: type === "overview" && !game, onclick: () => {
			const col = newCol(type, game || null); deck(); state.decks[state.view].push(col); save(); $add.close(); drawDeck();
			document.querySelector(`.col[data-id="${col.id}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
		} }, h("span", T.icon), T.name))),
		h("div.actions", h("button.btn", { type: "button", onclick: () => { delete state.decks[state.view]; save(); $add.close(); drawDeck(); toast("This deck is back to its preset."); } }, "Reset this deck"), h("button.btn", { type: "button", onclick: () => $add.close() }, "Close")));
	draw(); $add.showModal();
}
document.getElementById("btn-add").onclick = openAdd;
const $diff = document.getElementById("diff");
document.getElementById("btn-diff").onclick = () => $diff.showModal();
for (const d of [$add, $diff]) d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });

// Theme: follows the system until you pick one.
const dark = () => state.theme === "dark" || (state.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
const paintTheme = () => { state.theme === "auto" ? document.documentElement.removeAttribute("data-theme") : document.documentElement.setAttribute("data-theme", state.theme); document.getElementById("btn-theme").textContent = dark() ? "☀️" : "🌙"; };
document.getElementById("btn-theme").onclick = () => { state.theme = dark() ? "light" : "dark"; save(); paintTheme(); };
paintTheme();

drawNav(); drawStrip(); drawDeck();

// Each game's colour comes from its capsule art: the strongest hue in the picture that no earlier
// game already took, so two games never end up looking the same.
const before = GAMES.map((g) => g.hue).join();
const hueBins = (g) => new Promise((done) => {
	const img = new Image(); img.crossOrigin = "anonymous"; setTimeout(() => done(null), 3000);
	img.onerror = () => done(null);
	img.onload = () => {
		try {
			const c = document.createElement("canvas"); c.width = 46; c.height = 21;
			const ctx = c.getContext("2d"); ctx.drawImage(img, 0, 0, 46, 21);
			const px = ctx.getImageData(0, 0, 46, 21).data, bins = new Float32Array(36);
			for (let i = 0; i < px.length; i += 4) {
				const r = px[i] / 255, gr = px[i + 1] / 255, b = px[i + 2] / 255, max = Math.max(r, gr, b), d = max - Math.min(r, gr, b);
				if (max < 0.2 || d / max < 0.25) continue;
				const hh = (max === r ? ((gr - b) / d + 6) % 6 : max === gr ? (b - r) / d + 2 : (r - gr) / d + 4) * 60;
				bins[Math.floor(hh / 10) % 36] += (d / max) * max;
			}
			done(Array.from(bins, (_, i) => [i * 10 + 5, bins[(i + 35) % 36] + 2 * bins[i] + bins[(i + 1) % 36]]).sort((a, b) => b[1] - a[1]));
		} catch { done(null); /* no CORS: keep the preset colour */ }
	};
	img.src = g.capsule;
});
const todo = GAMES.filter((g) => g.capsule && state.hues[g.id] == null), ranked = await Promise.all(todo.map(hueBins));
const apart = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
todo.forEach((g, i) => {
	const taken = GAMES.filter((x) => x !== g && state.hues[x.id] != null).map((x) => x.hue);
	const pick = ranked[i]?.find(([hh, w]) => w > 2 && taken.every((t) => apart(t, hh) >= 45));
	if (pick) state.hues[g.id] = g.hue = pick[0];
});
if (GAMES.map((g) => g.hue).join() !== before) { save(); drawNav(); drawStrip(); drawDeck(); }
})();
