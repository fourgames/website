// Variant 5, "Refined current look": today's dashboard, restructured for fewer clicks.
// Plain DOM, no build step. Real data is read from feedback/data when a local copy exists
// (gitignored); otherwise the invented data in sample.js is used.
const DAY = 86400;
const now = Math.floor(Date.now() / 1000);
const DATA = "../../data";

// ---- small helpers -----------------------------------------------------------
function h(sel, props, ...kids) {
	const [tag, ...cls] = sel.split(".");
	const el = document.createElement(tag || "div");
	if (cls.length) el.className = cls.join(" ");
	if (props && (props.nodeType || typeof props !== "object" || Array.isArray(props))) { kids.unshift(props); props = null; }
	for (const [k, v] of Object.entries(props || {})) {
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
	}
	for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
	return el;
}
const store = {
	get(k, d) { try { return JSON.parse(localStorage.getItem("rf:" + k)) ?? d; } catch { return d; } },
	set(k, v) { try { localStorage.setItem("rf:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const lastDays = (n) => Array.from({ length: n }, (_, i) => iso(now - (n - 1 - i) * DAY));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmtNum = (n) => n == null ? "–" : n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const usd = (v) => "$" + Math.round(v || 0).toLocaleString("en-US");
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
function ago(t) {
	const s = now - t;
	return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : s < DAY ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / DAY)} d ago`;
}
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const change = (a, b) => {
	if (!b) return null;
	const d = (a - b) / b;
	return Math.abs(d) < 0.03 ? h("span.muted", "about the same") : h(`span.${d > 0 ? "up" : "down"}`, `${d > 0 ? "▲" : "▼"} ${Math.round(Math.abs(d) * 100)}%`);
};
function spark(values, color = "var(--positive)", w = 120, ht = 28) {
	const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), v = values.map((x) => x || 0);
	svg.setAttribute("width", w); svg.setAttribute("height", ht); svg.setAttribute("class", "spark"); svg.setAttribute("aria-hidden", "true");
	if (!v.some(Boolean)) return svg;
	const max = Math.max(...v), pt = (x, i) => [(i / Math.max(1, v.length - 1)) * (w - 6) + 3, ht - 4 - (x / (max || 1)) * (ht - 8)];
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", v.map((x, i) => (i ? "L" : "M") + pt(x, i).map((n) => n.toFixed(1)).join(",")).join(""));
	path.setAttribute("fill", "none"); path.setAttribute("stroke", color); path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linejoin", "round");
	const dot = document.createElementNS(ns, "circle"), [cx, cy] = pt(v.at(-1), v.length - 1);
	dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("r", 3); dot.setAttribute("fill", color);
	svg.append(path, dot);
	return svg;
}
function toast(msg) {
	document.querySelector(".toast")?.remove();
	const t = h("div.toast", { role: "status" }, msg);
	document.body.append(t);
	setTimeout(() => t.remove(), 1800);
}
const copy = (text, what) => { navigator.clipboard?.writeText(text).catch(() => {}); toast(`${what} copied`); };
const seg = (options, value, onChange, cls = "") => h(`div.seg${cls}`, { role: "group" }, options.map(([k, label, count]) =>
	h("button", { type: "button", "aria-pressed": String(k === value), onclick: () => onChange(k) }, label, count != null ? h("b", count) : null)));
const thumb = (meta) => meta.capsule ? h("img.thumb", { src: meta.capsule, alt: "", loading: "lazy" }) : h("span.thumb", { style: `--hue:${meta.hue ?? (meta.appId % 360)}` });

// ---- data ----------------------------------------------------------------------
const state = { games: [], real: false };
// How much a post weighs: what took a player effort (or cost money) counts most.
const WEIGHT = { refund: 5, review: 4, topic: 4, video: 4, reply: 2, comment: 1 };
const isMajor = (i) => WEIGHT[i.kind] >= 4;
const URGENCY = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };
const BARS = { urgent: 4, high: 3, medium: 2, low: 1 };
const KIND = { bug: "Bug", suggestion: "Idea", praise: "Loved", question: "Question", complaint: "Complaint" };
const MEDIA = { twitch: ["Twitch", "#9146ff"], youtube: ["YouTube", "#ff0033"], news: ["News", "#3e63dd"], reddit: ["Reddit", "#ff4500"], web: ["Web", "#12a594"], copy: ["Download copies", "#71717a"] };
const VIEWS = [["players", "Players", "Bugs, Ideas, Loved"], ["posts", "All posts", "Every post, ranked"], ["media", "Media", "Media, Curators"], ["sales", "Sales", "Sales, Bundles, Competitors"], ["health", "Game", "Updates, Achievements, Steam stats"]];

async function load() {
	const get = async (p) => { try { const r = await fetch(`${DATA}/${p}`); return r.ok ? await r.json() : null; } catch { return null; } };
	let src = null;
	// The lab server lists folders, so look for feedback/data there first: asking for a file that
	// isn't there would put a 404 in the console on every load without the real data.
	const listing = await fetch("../../").then((r) => (r.ok ? r.text() : "")).catch(() => "");
	const index = /href="data\/"/.test(listing) ? await get("index.json") : null;
	if (index?.games?.length) {
		const [sales, wishlists, steamworks, ...games] = await Promise.all([get("sales.json"), get("wishlists.json"), get("steamworks.json"), ...index.games.map((m) => get(`games/${m.appId}.json`))]);
		src = { index, sales: sales || { days: {} }, wishlists: wishlists || { apps: {} }, steamworks, games: Object.fromEntries(index.games.map((m, i) => [m.appId, games[i]])) };
		state.real = true;
	} else src = window.SAMPLE;
	state.games = src.index.games.filter((m) => src.games[m.appId]).map((m) => derive(m, src.games[m.appId], src));
	state.games.sort((a, b) => b.attention.length - a.attention.length || b.gross7 - a.gross7);
}

function derive(meta, g, src) {
	const id = String(meta.appId);
	const items = Object.entries(g.items || {}).map(([k, i]) => ({ ...i, id: i.id ?? k })).filter((i) => !i.offTopic && !i.dev);
	const byId = Object.fromEntries(items.map((i) => [i.id, i]));
	const issues = Object.entries(g.issues || {}).map(([k, i]) => ({ ...i, id: i.id ?? k }));
	const active = (i) => i.status !== "likely_fixed";
	const of = (kind) => issues.filter((i) => i.kind === kind);
	const bugs = of("bug").filter(active).sort((a, b) => b.priority - a.priority);
	const day = (d) => src.sales?.days?.[d]?.[id] || null;
	const d60 = lastDays(60);
	const gross60 = d60.map((d) => day(d)?.gross || 0);
	const allDays = Object.entries(src.sales?.days || {}).map(([d, apps]) => apps[id]).filter(Boolean);
	const wDays = src.wishlists?.apps?.[id]?.days || {};
	const wishNet = (d) => { const x = wDays[d]; return x ? (x.adds || 0) - (x.deletes || 0) - (x.purchases || 0) - (x.gifts || 0) : 0; };
	const rt = g.reviewTotals || {}, rKeys = Object.keys(rt).sort();
	const rAt = (d) => { const k = rKeys.filter((x) => x <= d).pop(); return k ? rt[k] : null; };
	const tot = (r) => r ? r.positive + r.negative : 0;
	const rNow = rAt(iso(now)), r7 = rAt(iso(now - 7 * DAY));
	const media = Object.entries(g.media?.items || {}).map(([k, m]) => ({ ...m, id: m.id ?? k })).filter((m) => m.source !== "copy");
	const isLive = (m) => !!m.live && now - (m.end && m.end < now ? m.end : now) < 1800;
	const attention = [
		...bugs.filter((i) => i.status === "still_happening" || i.urgency === "urgent" || i.urgency === "high").map((i) => ({ rank: 3, at: i.lastSeen, title: i.title, tag: i.status === "still_happening" ? "Came back" : `${URGENCY[i.urgency]} bug`, cls: "bug",
			what: [plural(i.mentions, "player"), i.negativeReviews ? plural(i.negativeReviews, "negative review") : null, `last ${ago(i.lastSeen)}`], href: `#/g/${id}/players/bug/${i.id}` })),
		...items.filter((i) => i.kind === "refund" && now - i.created < 3 * DAY).map((i) => ({ rank: 2, at: i.created, title: i.triage?.summary || i.text, tag: "Refund note", cls: "warn", what: [i.refundReason, ago(i.created)], href: `#/g/${id}/posts/${i.id}` })),
		...items.filter((i) => i.kind === "review" && i.votedUp === false && now - i.created < 3 * DAY && !i.devResponse).map((i) => ({ rank: 1, at: i.created, title: i.triage?.summary || (i.text || "").slice(0, 120), tag: "Unanswered", cls: "bad",
			what: ["negative review", i.playtime != null ? `${i.playtime} h played` : null, ago(i.created)], href: `#/g/${id}/posts/${i.id}` })),
	].map((a) => ({ ...a, meta }));
	const yesterday = iso(now - DAY);
	return { meta, g, id, items, byId, issues, bugs, ideas: of("suggestion").filter(active).sort((a, b) => b.priority - a.priority), loved: of("praise").sort((a, b) => b.mentions - a.mentions),
		attention, media, live: media.filter(isLive), newVideos: media.filter((m) => (m.source === "youtube" || m.source === "twitch") && now - m.at < 7 * DAY),
		day, gross60, grossY: day(yesterday)?.gross ?? null, yesterday: day(yesterday), lastWeekSameDay: day(iso(now - 8 * DAY)),
		gross7: sum(gross60.slice(-7)), grossPrev7: sum(gross60.slice(-14, -7)), gross30: sum(gross60.slice(-30)), grossAll: sum(allDays.map((d) => d.gross)), netAll: sum(allDays.map((d) => d.net)),
		wish7: sum(lastDays(7).map(wishNet)), wish30: lastDays(30).map((d) => wDays[d]?.adds || 0),
		playersNow: (g.players || []).at(-1)?.[1] ?? null, pos: tot(rNow) ? Math.round((100 * rNow.positive) / tot(rNow)) : null, reviewsTotal: tot(rNow), reviewsNew7: tot(rNow) - tot(r7),
		new24: items.filter((i) => isMajor(i) && now - i.created < DAY).length, upcoming: meta.status === "upcoming" };
}
const game = (id) => state.games.find((x) => x.id === String(id));

// ---- memory: last view, filters and scroll per game ------------------------------
const mem = store.get("mem", {});
const memOf = (id) => (mem[id] ||= { view: "players", seg: "bug", issue: {}, f: {} });
const saveMem = () => store.set("mem", mem);
const filt = (id, view, defaults) => (memOf(id).f[view] ||= defaults);
const scrolls = store.get("scroll", {});
let routeKey = "";
addEventListener("scroll", () => { if (routeKey) { scrolls[routeKey] = Math.round(scrollY); clearTimeout(scrolls.t); scrolls.t = setTimeout(() => { const { t, ...rest } = scrolls; store.set("scroll", rest); }, 250); } }, { passive: true });

// ---- routing -----------------------------------------------------------------------
function parse() {
	const p = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
	if (p[0] === "g" && game(p[1])) return { page: "game", id: p[1], view: p[2], a: p[3], b: p[4] };
	if (p[0] === "diff") return { page: "diff" };
	return { page: "home" };
}
function render() {
	let r = parse();
	if (r.page === "game") {
		const m = memOf(r.id);
		if (!VIEWS.some(([v]) => v === r.view)) { history.replaceState(null, "", `#/g/${r.id}/${m.view}`); r = parse(); }
		m.view = r.view;
		if (r.view === "players" && r.a) { m.seg = r.a; if (r.b) m.issue[r.a] = r.b; }
		saveMem();
		store.set("last", location.hash);
	}
	const key = r.page === "game" ? `${r.id}/${r.view}` : r.page;
	const keep = key === routeKey ? scrollY : scrolls[key] || 0;
	routeKey = "";
	renderSide(r);
	const main = document.getElementById("main");
	main.replaceChildren(r.page === "home" ? homePage() : r.page === "diff" ? diffPage() : gamePage(r));
	document.getElementById("top-title").textContent = r.page === "game" ? game(r.id).meta.name : r.page === "diff" ? "What's different" : "All games";
	document.title = `${document.getElementById("top-title").textContent} · Dashboard (refined)`;
	closeSide();
	scrollTo(0, keep);
	routeKey = key;
	const focus = main.querySelector(".post.focus");
	if (focus) focus.scrollIntoView({ block: "center" });
}
addEventListener("hashchange", render);

// ---- sidebar -------------------------------------------------------------------------
function renderSide(r) {
	const cur = (on) => (on ? "page" : null);
	const counts = (x) => ({ players: x.bugs.length || null, posts: x.new24 ? `${x.new24} new` : null, media: x.live.length ? "live" : x.newVideos.length ? `${x.newVideos.length} new` : null, sales: x.grossY != null ? usd(x.grossY) : null });
	document.getElementById("side-games").replaceChildren(...state.games.flatMap((x) => {
		const open = r.page === "game" && r.id === x.id, c = counts(x);
		return [
			h("a.nav.g", { href: `#/g/${x.id}`, "aria-current": cur(open), title: `${x.meta.name}: back to where you left it` }, thumb(x.meta), h("span.g-name", x.meta.name),
				x.attention.length ? h("span.count.hot", { title: `${x.attention.length} need attention` }, x.attention.length) : null),
			open ? h("div.g-views", VIEWS.map(([v, label]) => h("a.nav", { href: `#/g/${x.id}/${v}`, "aria-current": cur(r.view === v) }, label, c[v] ? h(`span.count${v === "media" && x.live.length ? ".hot" : ""}`, c[v]) : null)))
				: h("div.g-quick", VIEWS.map(([v, label]) => h("a", { href: `#/g/${x.id}/${v}` }, label))),
		];
	}));
	document.getElementById("nav-home").setAttribute("aria-current", r.page === "home" ? "page" : "false");
	document.getElementById("nav-diff").setAttribute("aria-current", r.page === "diff" ? "page" : "false");
	const total = sum(state.games.map((x) => x.attention.length));
	document.getElementById("home-count").textContent = total || "";
	document.getElementById("home-count").className = total ? "count hot" : "count";
}
const openSide = () => { document.getElementById("side").classList.add("open"); document.getElementById("scrim").hidden = false; };
const closeSide = () => { document.getElementById("side").classList.remove("open"); document.getElementById("scrim").hidden = true; };

// ---- posts, ranked by importance --------------------------------------------------
function kindLabel(i) {
	if (i.kind === "review") return h(`span.kind.${i.votedUp ? "pos" : "neg"}`, i.votedUp ? "👍 Review" : "👎 Review");
	return h("span.kind", { refund: "Refund note", topic: "Thread", video: "Video", reply: "Reply", comment: "YouTube comment" }[i.kind] || i.kind);
}
const mini = (i) => h("div.mini", { title: i.text || "" }, h("span.who", i.author?.name || "player"), h("span.tx", i.triage?.english || i.text || ""), h("span.when", ago(i.created)));
const fold = (label, kids, open = false) => kids.length ? h("details.fold", { open }, h("summary", label), kids) : null;
// A full card for a review, thread, video or refund note; its replies sit under it as one-line
// rows and a video's comments stay folded until asked for.
function postCard(i, x, { showGame = false, focus = false, plain = false } = {}) {
	const t = i.triage || {}, text = t.english || i.text || "";
	const body = h("p.text", { title: "Click to read it all", onclick: (e) => e.currentTarget.classList.toggle("open") }, text);
	const replies = x.items.filter((k) => k.kind === "reply" && k.topic === i.id).sort((a, b) => a.created - b.created);
	const comments = x.items.filter((k) => k.kind === "comment" && k.video === i.id).sort((a, b) => a.created - b.created);
	return h(`article.card.post${focus ? ".focus" : ""}`,
		h("div.post-h",
			showGame ? h("a.gt", { href: `#/g/${x.id}` }, thumb(x.meta), x.meta.name) : null,
			kindLabel(i), t.category && KIND[t.category] ? h(`span.pill.${t.category}`, KIND[t.category]) : null,
			h("span", [i.author?.name, i.playtime != null ? `${i.playtime} h played` : null, i.refundReason, t.language && t.language !== "English" ? t.language : null].filter(Boolean).join(" · ")),
			i.kind === "review" && i.votedUp === false && !i.devResponse ? h("span.pill.warn", "Not answered") : null,
			h("span.when", ago(i.created), " · ", h("a", { href: i.url || "#", target: "_blank", rel: "noopener" }, "Open ↗"))),
		i.title || (!plain && t.summary && t.summary !== text) ? h("h4", i.title || t.summary) : null,
		body,
		replies.length ? h("div.kids", replies.slice(0, 3).map(mini), fold(`${replies.length - 3} more replies`, replies.slice(3).map(mini))) : null,
		comments.length ? h("div.kids", fold(`${plural(comments.length, "YouTube comment")}`, comments.map(mini))) : null);
}
// A list of posts: the heavy ones as cards (newest first), then loose replies and comments folded.
function postList(list, x, opts = {}) {
	const major = list.filter(isMajor).sort((a, b) => b.created - a.created);
	const shownIds = new Set(major.map((i) => i.id));
	const loose = list.filter((i) => !isMajor(i) && !shownIds.has(i.topic) && !shownIds.has(i.video)).sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind] || b.created - a.created);
	const replies = loose.filter((i) => i.kind === "reply"), comments = loose.filter((i) => i.kind === "comment");
	const gameOf = opts.gameOf || (() => x);
	return h("div.posts",
		major.length ? major.map((i) => postCard(i, gameOf(i), { showGame: !!opts.gameOf, focus: opts.focus === i.id, plain: opts.plain })) : (loose.length ? null : h("p.empty", "Nothing here yet.")),
		replies.length ? h("div.card.post", h("div.post-h", h("span.kind", plural(replies.length, "reply")), h("span", "in threads not listed here")), replies.slice(0, 4).map(mini), fold(`${replies.length - 4} more`, replies.slice(4).map(mini))) : null,
		comments.length ? h("details.fold.lesser", h("summary", `${plural(comments.length, "YouTube comment")} · low weight, folded`), h("div.card.post", comments.map(mini))) : null);
}

// ---- All games: the old All games home and All sales, merged -----------------------
function homePage() {
	const G = state.games, d30 = lastDays(30);
	const total30 = d30.map((_, i) => sum(G.map((x) => x.gross60[30 + i])));
	const need = G.flatMap((x) => x.attention).sort((a, b) => b.rank - a.rank || b.at - a.at);
	const live = G.flatMap((x) => x.live.map((m) => [x, m]));
	const yesterday = sum(G.map((x) => x.grossY)), y8 = sum(G.map((x) => x.lastWeekSameDay?.gross));
	const tile = (label, value, sub, extra, href) => h(href ? "a.card.tile" : "div.card.tile", href ? { href } : null, h("div.label", label), h("div.value.num", value), h("div.sub", sub), extra);
	const cell = (href, label, big, sm, bad) => h("a.cell", { href }, h("div.lab", label), h(`div.big.num${bad ? ".bad" : ""}`, big), h("div.sm", sm));
	const includeLow = store.get("home-low", false);
	const posts = G.flatMap((x) => x.items.filter((i) => now - i.created < 14 * DAY && (includeLow || isMajor(i))).map((i) => [x, i]));
	const owner = new Map(posts.map(([x, i]) => [i, x]));
	return h("div",
		h("div.head", h("div.hgrow", h("h1", "All games"), h("div.sub", `${plural(G.length, "game")} · ${state.real ? "your data" : "invented sample data"} · everything on this page links straight to its view`))),
		h("section.tiles",
			tile("Gross yesterday", usd(yesterday), [change(yesterday, y8), y8 ? " vs last week" : "every game"], null, "#sales-all"),
			tile("Gross, 7 days", usd(sum(G.map((x) => x.gross7))), [change(sum(G.map((x) => x.gross7)), sum(G.map((x) => x.grossPrev7))), " vs the week before"], spark(total30.slice(-14)), "#sales-all"),
			tile("Open bugs", sum(G.map((x) => x.bugs.length)), `${sum(G.map((x) => x.bugs.filter((b) => b.urgency === "urgent" || b.urgency === "high").length))} high or urgent`),
			tile("New posts", sum(G.map((x) => x.new24)), "reviews, threads, videos, refunds · 24 h"),
			tile("Playing now", fmtNum(sum(G.map((x) => x.playersNow))), "every game")),
		h("div.with-aside",
			h("section", h("div.sec-h", h("h2", "Needs attention"), need.length ? h("span.pill.bad", need.length) : null, h("span.hint", "urgent bugs, bugs that came back, refund notes and unanswered negative reviews")),
				need.length ? h("div.card.flush", need.slice(0, 6).map(needRow), need.length > 6 ? h("details.fold", h("summary", { style: "padding:0.6rem 1rem" }, `${need.length - 6} more`), need.slice(6).map(needRow)) : null)
					: h("p.calm", "Nothing right now.")),
			h("section", h("div.sec-h", h("h2", "Live now"), live.length ? h("span.pill.live", live.length) : null),
				live.length ? h("div.card.flush", live.map(([x, m]) => h("a.row", { href: `#/g/${x.id}/media` }, thumb(x.meta), h("span.t", h("b", m.title), h("span", [m.author, m.viewers ? `${fmtNum(m.viewers)} watching` : null].filter(Boolean).join(" · "))), h("span.go", "→"))))
					: h("p.calm", "Nobody is streaming your games right now."))),
		h("section", h("div.sec-h", h("h2", "Every game"), h("span.hint", "each number opens that view of that game")),
			h("div.card.flush.gtable",
				h("div.grow-h", ["Game", "Bugs", "Ideas", "Reviews", "Media", "Yesterday", "7 days"].map((t) => h("span", t))),
				G.map((x) => h("div.grow",
					h("a.cell.game", { href: `#/g/${x.id}` }, thumb(x.meta), h("span", h("b", x.meta.name), h("span.sm", x.upcoming ? "Coming soon" : x.playersNow != null ? `${fmtNum(x.playersNow)} playing now` : "Released"))),
					cell(`#/g/${x.id}/players/bug`, "Bugs", x.bugs.length, x.bugs[0] ? x.bugs[0].title : "none open", x.bugs.some((b) => b.urgency === "urgent" || b.urgency === "high")),
					cell(`#/g/${x.id}/players/suggestion`, "Ideas", x.ideas.length, x.ideas[0] ? x.ideas[0].title : "none yet"),
					cell(`#/g/${x.id}/posts`, "Reviews", x.pos != null ? `${x.pos}%` : "–", x.reviewsTotal ? `${fmtNum(x.reviewsTotal)} · +${x.reviewsNew7} this week` : "no reviews yet"),
					cell(`#/g/${x.id}/media`, "Media", x.newVideos.length, x.live.length ? "live now" : x.newVideos.length ? "new videos this week" : `${x.media.length} in all`),
					cell(`#/g/${x.id}/sales`, "Yesterday", x.grossY != null ? usd(x.grossY) : "–", x.yesterday ? `${x.yesterday.units} sold · ${x.yesterday.returnedUnits || 0} refunded` : `${x.wish7 >= 0 ? "+" : ""}${x.wish7} wishlists, 7 d`),
					h("a.cell", { href: `#/g/${x.id}/sales` }, h("div.lab", "7 days"), h("div.big.num", x.grossY != null ? usd(x.gross7) : "–"), x.grossY != null ? spark(x.gross60.slice(-14), "var(--positive)", 90, 20) : h("div.sm", "not out yet")))))),
		h("section", { id: "sales-all" }, h("div.sec-h", h("h2", "Sales, every game"), h("span.hint", "gross per day, last 30 days · was the separate All sales screen")),
			h("div.card", h("div.strip", [["All time", usd(sum(G.map((x) => x.grossAll)))], ["30 days", usd(sum(total30))], ["7 days", usd(sum(total30.slice(-7)))], ["Yesterday", usd(yesterday)]].map(([l, v]) => h("div", h("b.num", v), h("span", l)))),
				barChart(total30, d30, usd))),
		h("section", h("div.sec-h", h("h2", "Latest posts"), h("span.hint", "last 14 days, every game"),
			h("span.end", seg([[false, "What matters"], [true, "Everything"]], includeLow, (v) => { store.set("home-low", v); render(); }, ".small"))),
			postList(posts.map(([, i]) => i).sort((a, b) => b.created - a.created).slice(0, 40), null, { gameOf: (i) => owner.get(i) })));
}
const needRow = (a) => h("a.row", { href: a.href }, thumb(a.meta), h("span.t", h("b", a.title), h("span", [a.meta.name, ...a.what].filter(Boolean).join(" · "))), h(`span.pill.${a.cls}`, a.tag), h("span.go", "→"));
function barChart(values, days, fmt) {
	const max = Math.max(1, ...values);
	return h("div", h("div.barchart", { role: "img", "aria-label": "Bar chart, one bar per day" }, values.map((v, i) => h(`span${i === values.length - 1 ? ".last" : ""}`, { title: `${days[i]}: ${fmt(v)}`, style: `height:${(v / max) * 100}%` }))),
		h("div.axis", h("span", days[0]), h("span", `peak ${fmt(max)}`), h("span", "today (so far)")));
}

// ---- one game -----------------------------------------------------------------------
function gamePage(r) {
	const x = game(r.id), go = (v) => `#/g/${x.id}/${v}`;
	const strip = [[go("players/bug"), x.bugs.length, "open bugs"], [go("posts"), x.pos != null ? `${x.pos}%` : "–", "positive reviews"], [go("sales"), x.grossY != null ? usd(x.grossY) : "–", "gross yesterday"],
		[go("sales"), `${x.wish7 >= 0 ? "+" : ""}${x.wish7}`, "wishlists, 7 days"], [go("media"), x.newVideos.length, "new videos, 7 days"]];
	const body = { players: playersView, posts: postsView, media: mediaView, sales: salesView, health: healthView }[r.view](x, r);
	return h("div",
		h("div.head", thumb(x.meta), h("div.hgrow", h("h1", x.meta.name), h("div.sub", x.upcoming ? "Coming soon" : `${fmtNum(x.playersNow)} playing now · ${fmtNum(x.reviewsTotal)} reviews`)),
			h("div.strip", strip.map(([href, v, l]) => h("a", { href }, h("b.num", v), h("span", l))))),
		h("nav.tabs", { "aria-label": "Views" }, VIEWS.map(([v, label, was]) => h("a", { href: go(v), "aria-current": r.view === v ? "page" : null, title: `Today: ${was}` }, label))),
		body);
}

// Players: Bugs, Ideas and Loved as one page. The list stays put; the picked one opens beside it
// with its posts already showing.
function playersView(x) {
	const m = memOf(x.id), f = filt(x.id, "players", { status: "open", sort: "priority", q: "" });
	const kind = ["bug", "suggestion", "praise"].includes(m.seg) ? m.seg : "bug";
	const SORT = { priority: (a, b) => b.priority - a.priority, players: (a, b) => b.mentions - a.mentions, negative: (a, b) => (b.negativeReviews || 0) - (a.negativeReviews || 0), recent: (a, b) => b.lastSeen - a.lastSeen };
	const all = x.issues.filter((i) => i.kind === kind);
	const list = all.filter((i) => kind === "praise" || f.status === "all" || (f.status === "open" ? i.status !== "likely_fixed" : f.status === "still" ? i.status === "still_happening" : i.status === "likely_fixed"))
		.filter((i) => !f.q || `${i.title} ${i.area} ${i.summary}`.toLowerCase().includes(f.q.toLowerCase()))
		.sort(kind === "praise" ? SORT.players : SORT[f.sort]);
	const picked = list.find((i) => i.id === m.issue[kind]) || list[0];
	const set = (k, v) => { f[k] = v; saveMem(); render(); };
	const count = (k) => x.issues.filter((i) => i.kind === k && (k === "praise" || i.status !== "likely_fixed")).length;
	const search = h("input", { type: "search", placeholder: "Search", value: f.q, "aria-label": "Search issues", onchange: (e) => set("q", e.target.value) });
	const row = (i) => h("a.irow", { href: `#/g/${x.id}/players/${kind}/${i.id}`, "aria-current": String(i === picked) },
		kind === "praise" ? h("span.kdot") : kind === "suggestion" ? h("span.kdot.suggestion") : h(`span.bars4.${i.urgency}`, { title: `${URGENCY[i.urgency]} priority` }, [1, 2, 3, 4].map((n) => h(n <= BARS[i.urgency] ? "i.on" : "i"))),
		h("span", h("b", i.title), h("span.sm", [i.area, i.status === "still_happening" ? "came back" : i.status === "likely_fixed" ? `likely fixed in ${i.fixedIn}` : null, i.negativeReviews ? plural(i.negativeReviews, "neg. review") : null, `last ${ago(i.lastSeen)}`].filter(Boolean).join(" · "))),
		h("span.n.num", i.mentions, h("small", "players")));
	// On a phone the list and the detail take turns; the hash says which.
	const opened = !!parse().b;
	return h(`div${opened ? ".is-open" : ""}`,
		h("div.toolbar",
			seg([["bug", "Bugs", count("bug")], ["suggestion", "Ideas", count("suggestion")], ["praise", "Loved", count("praise")]], kind, (k) => { location.hash = `#/g/${x.id}/players/${k}`; }),
			h("span.end",
				kind === "praise" ? null : seg([["open", "Open"], ["still", "Came back"], ["fixed", "Likely fixed"], ["all", "All"]], f.status, (v) => set("status", v), ".small"),
				kind === "praise" ? null : h("select", { "aria-label": "Sort", onchange: (e) => set("sort", e.target.value) }, [["priority", "Priority"], ["players", "Most players"], ["negative", "Negative reviews"], ["recent", "Newest report"]].map(([k, l]) => h("option", { value: k, selected: f.sort === k }, `Sort: ${l}`))),
				search)),
		list.length ? h(`div.split${opened ? ".has-open" : ""}`,
			h("div.card.flush.split-list", list.map(row)),
			issueDetail(picked, x, kind))
			: h("p.calm", kind === "bug" ? "No bugs here." : "Nothing here."));
}
function issueDetail(i, x, kind) {
	const posts = (i.items || []).map((id) => x.byId[id]).filter(Boolean);
	const patch = kind === "bug" ? `Fixed: ${i.title} (reported by ${plural(i.mentions, "player")})` : `${i.title} (suggested by ${plural(i.mentions, "player")})`;
	const stat = (n, label, cls = "") => h(`div${cls}`, h("b.num", n), h("span", label));
	return h("div.detail",
		h("a.btn.back", { href: `#/g/${x.id}/players/${kind}` }, "← Back to the list"),
		h("div.card", { style: "margin-bottom:1rem" },
			h("div.detail-top", h(`span.pill.${kind}`, KIND[kind]), kind === "praise" ? null : h("span", `${URGENCY[i.urgency]} priority`),
				i.status === "still_happening" ? h("span.pill.warn", `↻ Came back after ${i.fixedIn}`) : i.status === "likely_fixed" ? h("span.pill.good", `✓ Likely fixed in ${i.fixedIn}`) : null,
				now - i.firstSeen < 2 * DAY ? h("span.pill.new", "New") : now - i.lastSeen < 2 * DAY ? h("span.pill.new", "New report") : null,
				h("span", [i.area, (i.languages || []).join(", "), `last reported ${ago(i.lastSeen)}`].filter(Boolean).join(" · "))),
			h("h2", i.title),
			h("div.impact", stat(i.mentions, kind === "praise" ? "players love it" : "players reported it"),
				kind === "praise" ? null : stat(i.negativeReviews || 0, "negative reviews", i.negativeReviews ? ".bad" : ""),
				i.refunds ? stat(i.refunds, "refunds", ".bad") : null, i.firstSession ? stat(i.firstSession, "in the first 2 hours", ".warn") : null),
			i.summary ? h("p", i.summary) : null,
			(i.details || []).length ? h("details.fold", h("summary", `Details players gave (${i.details.length})`), h("ul", i.details.map((d) => h("li", d)))) : null,
			kind === "praise" ? null : h("div.actions", { style: "margin-top:0.5rem" },
				h("button.btn.primary", { onclick: () => copy(i.fixPrompt || `${i.title}. ${i.summary || ""}`, kind === "bug" ? "Fix prompt" : "Summary") }, kind === "bug" ? "Copy fix prompt" : "Copy summary"),
				h("button.btn", { onclick: () => copy(patch, "Patch-note line") }, "Copy patch-note line"),
				h("button.btn", { onclick: () => toast("Marked fixed (not saved in this prototype)") }, "Mark fixed"))),
		h("div.sec-h", h("h3", `Posts (${posts.length}${i.mentions > posts.length ? ` of ${i.mentions}` : ""})`), h("span.hint", "reviews, threads, videos and refund notes first")),
		postList(posts, x, { plain: true }));
}

// All posts: every post of the game, the same ranking.
function postsView(x, r) {
	const f = filt(x.id, "posts", { kind: "all", cat: "all", shown: 30 });
	const set = (k, v) => { f[k] = v; f.shown = 30; saveMem(); if (r.a) location.hash = `#/g/${x.id}/posts`; else render(); };
	const n = (k) => x.items.filter((i) => i.kind === k).length;
	const list = x.items.filter((i) => f.kind === "all" || (f.kind === "low" ? !isMajor(i) : i.kind === f.kind)).filter((i) => f.cat === "all" || i.triage?.category === f.cat).sort((a, b) => b.created - a.created);
	const focused = r.a && x.byId[r.a];
	const shown = list.slice(0, f.shown);
	if (focused && !shown.includes(focused)) shown.unshift(focused);
	return h("div",
		h("div.toolbar",
			seg([["all", "All", x.items.length], ["review", "Reviews", n("review")], ["topic", "Threads", n("topic")], ["video", "Videos", n("video")], ["refund", "Refunds", n("refund")], ["low", "Replies & comments", n("reply") + n("comment")]], f.kind, (v) => set("kind", v)),
			h("span.end", h("select", { "aria-label": "Category", onchange: (e) => set("cat", e.target.value) }, [["all", "Any category"], ["bug", "Bugs"], ["suggestion", "Ideas"], ["question", "Questions"], ["praise", "Praise"]].map(([k, l]) => h("option", { value: k, selected: f.cat === k }, l))))),
		postList(shown, x, { focus: r.a }),
		list.length > f.shown ? h("p", h("button.btn", { onclick: () => { f.shown += 30; saveMem(); render(); } }, `Show more (${list.length - f.shown} left)`)) : null);
}

// Media with Curators beside it.
function mediaCard(m, x) {
	const [name, color] = MEDIA[m.source] || [m.source, "gray"], live = x.live.includes(m);
	const facts = [m.author, m.viewers && live ? `${fmtNum(m.viewers)} watching now` : null, m.views != null ? `${fmtNum(m.views)} views` : null, m.peak && !live ? `peak ${m.peak} viewers` : null, m.subscribers ? `${fmtNum(m.subscribers)} subscribers` : null].filter(Boolean);
	const video = x.items.find((i) => i.kind === "video" && (i.media === m.id || i.url === m.url && m.url !== "#"));
	const comments = video ? x.items.filter((i) => i.kind === "comment" && i.video === video.id) : [];
	const r = m.review, verdict = { positive: ["Liked it", "good"], mixed: ["Mixed", "warn"], negative: ["Didn't like it", "bad"] }[r?.verdict];
	return h("article.card.md", h("div.md-thumb", { style: `--hue:${(x.meta.hue ?? 200) + m.title.length * 7}` }, m.source === "youtube" || m.source === "twitch" ? "▶" : "¶"),
		h("div", h("div.facts", h("span.src", { style: `--c:${color}` }, name), ` · ${live ? "live now" : ago(m.at)}`, live ? [" ", h("span.pill.live", "Live")] : now - m.at < 7 * DAY ? [" ", h("span.pill.new", "New")] : null),
			h("h4", h("a", { href: m.url || "#", target: "_blank", rel: "noopener" }, m.title)), h("div.facts", facts.join(" · ")),
			r ? h("p.sum", verdict ? [h(`span.pill.${verdict[1]}`, verdict[0]), " "] : null, r.summary) : m.text ? h("p.sum.muted", m.text) : null,
			r?.points?.length ? h("ul", r.points.slice(0, 3).map((p) => h("li", h(`span.pill.${p.kind === "complaint" ? "warn" : p.kind}`, KIND[p.kind] || p.kind), h("span", p.text), p.at != null ? h("a.at", { href: m.url || "#" }, `${Math.floor(p.at / 60)}:${String(p.at % 60).padStart(2, "0")}`) : null))) : null,
			comments.length ? h("div.kids", fold(plural(comments.length, "YouTube comment"), comments.map(mini))) : null));
}
function mediaView(x) {
	const f = filt(x.id, "media", { source: "all" });
	const fresh = x.media.filter((m) => !x.live.includes(m) && now - m.at < 7 * DAY).sort((a, b) => b.at - a.at);
	const rest = x.media.filter((m) => !x.live.includes(m) && !fresh.includes(m) && (f.source === "all" || m.source === f.source)).sort((a, b) => b.at - a.at);
	const sources = [...new Set(x.media.map((m) => m.source))];
	const cur = x.g.curators?.list || [];
	const block = (title, hint, list, extra) => list.length || extra ? h("section", h("div.sec-h", h("h2", title), hint ? h("span.hint", hint) : null, extra ? h("span.end", extra) : null), h("div.posts", list.length ? list.map((m) => mediaCard(m, x)) : h("p.empty", "Nothing found yet."))) : null;
	return h("div.with-aside",
		h("div",
			block("Live now", null, x.live),
			block("New this week", "videos, streams and articles from the last 7 days", fresh) || h("section", h("div.sec-h", h("h2", "New this week")), h("p.calm", "Nothing new in the last 7 days.")),
			block("Earlier", null, rest, seg([["all", "All"], ...sources.map((s) => [s, MEDIA[s]?.[0] || s])], f.source, (v) => { f.source = v; saveMem(); render(); }, ".small"))),
		h("aside", h("div.sec-h", h("h2", "Curators"), h("span.hint", cur.length ? `${cur.length} · ${fmtNum(sum(cur.map((c) => c.followers)))} followers` : "")),
			cur.length ? h("div.card.flush", cur.map((c) => h("a.row", { href: c.url || "#", target: "_blank", rel: "noopener" }, h("span.t", h("b", c.name), h("span", { title: c.blurb || "" }, [`${fmtNum(c.followers)} followers`, c.blurb].filter(Boolean).join(" · "))), h(`span.pill.${c.state === "recommended" ? "good" : c.state === "not_recommended" ? "bad" : ""}`, c.state === "recommended" ? "Recommends" : c.state === "not_recommended" ? "Against" : "Info"))))
				: h("p.calm", "No curator has reviewed this game yet.")));
}

// Sales with Bundles and Competitors on the same page. Yesterday comes first.
function salesView(x) {
	if (x.grossY == null && !x.grossAll) return h("div", h("p.calm", x.upcoming ? "Not out yet: sales show here from launch." : "No sales in Steam's data yet."),
		h("section", { style: "margin-top:1.25rem" }, h("div.sec-h", h("h2", "Wishlists")), h("div.card.tile", h("div.label", "Net, 7 days"), h("div.value.num", `${x.wish7 >= 0 ? "+" : ""}${x.wish7}`), h("div.sub", "adds per day, 30 days"), spark(x.wish30, "var(--idea)", 240, 40))));
	const f = filt(x.id, "sales", { range: 30 });
	const days = lastDays(f.range), values = x.gross60.slice(-f.range);
	const y = x.yesterday || {}, units = sum(lastDays(30).map((d) => x.day(d)?.units)), ret = sum(lastDays(30).map((d) => x.day(d)?.returnedUnits));
	const reasons = {};
	for (const i of x.items.filter((k) => k.kind === "refund")) reasons[i.refundReason || "No reason given"] = (reasons[i.refundReason || "No reason given"] || 0) + 1;
	const tile = (label, value, sub, extra) => h("div.card.tile", h("div.label", label), h("div.value.num", value), h("div.sub", sub), extra);
	const bundles = x.g.bundles?.list || [], ideas = x.g.bundleIdeas || [], comp = x.g.competitors || [];
	return h("div",
		h("section.tiles",
			tile("Yesterday", usd(x.grossY), [`${y.units ?? 0} sold · ${y.returnedUnits ?? 0} refunded · `, change(x.grossY, x.lastWeekSameDay?.gross), x.lastWeekSameDay ? " vs last week" : ""]),
			tile("7 days", usd(x.gross7), [change(x.gross7, x.grossPrev7), " vs the week before"], spark(x.gross60.slice(-14))),
			tile("30 days", usd(x.gross30), `${units - ret} units kept · ${units ? Math.round((100 * ret) / units) : 0}% refunded`),
			tile("All time", usd(x.grossAll), `${usd(x.netAll)} net`),
			tile("Wishlists, 7 days", `${x.wish7 >= 0 ? "+" : ""}${x.wish7}`, "net of removals and purchases", spark(x.wish30.slice(-14), "var(--idea)"))),
		h("section", h("div.sec-h", h("h2", "Gross per day"), h("span.end", seg([[7, "1w"], [30, "1m"], [60, "2m"]], f.range, (v) => { f.range = v; saveMem(); render(); }, ".small"))),
			h("div.card", barChart(values, days, usd))),
		h("div.cols3",
			h("section", h("div.sec-h", h("h2", "Refund reasons"), h("span.hint", "from refund notes")),
				Object.keys(reasons).length ? h("div.card", Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => hbar(k, n, Math.max(...Object.values(reasons)), n)), h("p", { style: "margin:8px 0 0" }, h("a", { href: `#/g/${x.id}/posts` }, "Read the refund notes →")))
					: h("p.calm", "No refund notes.")),
			h("section", h("div.sec-h", h("h2", "Bundles"), h("span.hint", "on Steam, and ones you want")),
				bundles.length || ideas.length ? h("div.card.flush",
					bundles.map((b) => h("div.row", h("span.t", h("b", b.name), h("span", `${plural(b.apps.length, "game")} · ${b.price || ""}`)), b.bundleDiscount ? h("span.pill.good", `−${b.bundleDiscount}%`) : null)),
					ideas.map((b) => h("div.row", h("span.t", h("b", b.name), h("span", b.note || "")), h("span.pill", b.status))))
					: h("p.calm", "Not in a bundle yet.")),
			h("section", h("div.sec-h", h("h2", "Competitors"), h("span.hint", "players this week vs last")),
				comp.length ? h("div.card.flush", comp.map((c) => h("div.row", h("span.t", h("b", c.name), h("span", `peak ${fmtNum(c.peak)} yesterday · ${c.positive}% positive`)),
					h(`span.${c.change > 0.05 ? "up" : c.change < -0.05 ? "down" : "muted"}`, `${c.change > 0 ? "+" : c.change < 0 ? "−" : "±"}${Math.abs(Math.round(c.change * 100))}%`))))
					: h("p.calm", "No games to compare with yet."))));
}
const hbar = (label, value, max, text) => h("div.hbar", { title: label }, h("span.t", label), h("span.track", h("i", { style: `width:${Math.max(1, (value / (max || 1)) * 100)}%` })), h("span.v.num", text));

// Game: Updates, Achievements and Steam stats on one page.
function healthView(x) {
	const rel = (x.g.releases || []).slice().sort((a, b) => b.time - a.time);
	const reviews = x.items.filter((i) => i.kind === "review");
	const ach = (x.g.achievements?.list || []).slice().sort((a, b) => b.percent - a.percent);
	let drop = -1, by = 0;
	ach.forEach((a, i) => { if (i && ach[i - 1].percent - a.percent > by) { by = ach[i - 1].percent - a.percent; drop = i; } });
	const st = x.g.steamStats;
	const update = (r, i) => {
		const until = rel[i - 1]?.time ?? now, after = reviews.filter((v) => v.created >= r.time && v.created < until), pos = after.filter((v) => v.votedUp).length;
		const share = after.length ? pos / after.length : null;
		return h("div.row", h("span.t", h("b", r.version ? `v${r.version}` : r.name), h("span", [r.version ? r.name : null, fmtDate(r.time)].filter(Boolean).join(" · "))),
			share == null ? h("span.muted", "no reviews since") : h(`span.pill.${share >= 0.7 ? "good" : share >= 0.4 ? "warn" : "bad"}`, { title: `${pos} of ${after.length} reviews since were positive` }, share >= 0.7 ? "Liked" : share >= 0.4 ? "Mixed" : "Disliked"));
	};
	return h("div.cols3",
		h("section", h("div.sec-h", h("h2", "Updates"), h("span.hint", "and how players took each")),
			rel.length ? h("div.card.flush", rel.map(update)) : h("p.calm", "No updates yet.")),
		h("section", h("div.sec-h", h("h2", "Achievements"), h("span.hint", "share of players")),
			ach.length ? h("div.card", ach.map((a, i) => h("div", hbar(a.name, a.percent, 100, `${a.percent.toFixed(1)}%`), i === drop && by >= 10 ? h("div", { style: "margin:-2px 0 4px" }, h("span.pill.new", `−${by.toFixed(1)} points: biggest drop`)) : null)))
				: h("p.calm", x.upcoming ? "Not out yet." : "No achievement stats.")),
		h("section", h("div.sec-h", h("h2", "Steam stats"), h("span.hint", "from Steamworks")),
			st ? h("div.card", h("div.strip", { style: "margin-bottom:0.75rem" }, h("div", h("b", st.median), h("span", "median playtime")), h("div", h("b", x.playersNow ?? "–"), h("span", "playing now"))),
				st.reach.map((m) => hbar(`Played ${m.label}`, m.pct, 100, `${m.pct}%`)), h("p.muted", { style: "margin:8px 0 0" }, [st.deck ? `Steam Deck: ${st.deck}` : null, st.controller].filter(Boolean).join(" · ")))
				: h("p.calm", state.real ? "Steam stats are not wired to the real data in this prototype." : "Not out yet.")));
}

// ---- What's different ------------------------------------------------------------------
function diffPage() {
	const tasks = [
		["See what needs attention across all games", "1", "Click All games in the side list.", "0", "It's the start page, and the red counts in the sidebar show on every page."],
		["Open one game's top bug and read its posts", "3", "Pick the game, open Bugs, press Show posts on the first card.", "1", "Click the game's Bugs number on All games (or the game in the sidebar): the top bug is open with its posts showing."],
		["See yesterday's sales for one game", "3 + hover", "Pick the game, open Sales, zoom to 1w, then hover the last bar: there is no yesterday number.", "0", "Yesterday is a column on All games and sits in every game's header. One click opens Sales, where Yesterday is the first tile."],
		["Find new videos about a game", "3", "Pick the game, open Media, filter to YouTube, then read the dates.", "0–1", "The Media column on All games counts new videos this week; one click opens Media with New this week on top."],
	];
	const merged = [["Bugs · Ideas · Loved", "Players (a switch, list and detail side by side)"], ["All posts", "All posts (same place, ranked by weight)"], ["Media · Curators", "Media (curators beside the list)"], ["Sales · Bundles · Competitors", "Sales"], ["Updates · Achievements · Steam stats", "Game"],
		["All games · All sales (behind the money tiles)", "All games (one page)"], ["More data · Coming soon", "Not rebuilt here: would become a footer link"]];
	return h("div.prose", { style: "max-width:60rem" },
		h("div.head", h("div.hgrow", h("h1", "What's different"), h("div.sub", "Variant 5: the current look, restructured. Clicks are counted from any page of the dashboard."))),
		h("section", h("div.sec-h", h("h2", "Clicks")), h("div.card.flush", { style: "overflow-x:auto" }, h("table.clicks", h("thead", h("tr", ["Task", "Today", "Here"].map((t) => h("th", t)))),
			h("tbody", tasks.map(([t, a, how, b, now_]) => h("tr", h("td", h("b", t)), h("td.n", a, h("small", how)), h("td.n.now", b, h("small", now_)))))))),
		h("section", h("div.sec-h", h("h2", "What merged"), h("span.hint", "14 tabs and 2 home screens become 5 views and 1 home")),
			h("div.card.merge", merged.flatMap(([a, b]) => [h("span", a), h("span.arrow.muted", "→"), h("b", b)]))),
		h("section", h("div.sec-h", h("h2", "Where the clicks went today")), h("div.card", h("ul", { style: "margin:0;padding-left:1.1rem" },
			["Picking a game, then picking one of 14 tabs in four groups: two clicks before anything shows.", "Posts of a bug or idea are behind a Show posts button on every card.", "All sales is hidden behind the money tiles on All games.", "Yesterday's revenue only exists as a chart tooltip.",
				"Curators, Bundles, Competitors, Achievements and Steam stats each take a tab for a short list.", "Switching games resets you to the top of the same tab."].map((t) => h("li", t))))),
		h("section", h("div.sec-h", h("h2", "What replaces them")), h("div.card", h("ul", { style: "margin:0;padding-left:1.1rem" },
			["Sidebar: every game, and under the open one its five views. Hover another game for its views: any view of any game is one click.", "⌘K / Ctrl+K (or /): type a game, view, bug, idea, post or video and press Enter.",
				"All games: numbers, Needs attention, Live now, then one row per game where every number is a link into that view.", "Each game remembers its view, filters, picked issue and scroll position.",
				"Weight: reviews, threads, videos and refund notes are cards; replies are one-line rows under their thread; YouTube comments are folded under their video."].map((t) => h("li", t))))));
}

// ---- command palette -----------------------------------------------------------------------
function paletteIndex() {
	const out = [{ ty: "Page", tt: "All games", href: "#/", w: 9 }, { ty: "Page", tt: "What's different", href: "#/diff", w: 5 }, { ty: "Page", tt: "Public home page (restyled)", href: "home.html", w: 5 }];
	for (const x of state.games) {
		out.push({ ty: "Game", tt: x.meta.name, href: `#/g/${x.id}`, w: 8 });
		for (const [v, label, was] of VIEWS) out.push({ ty: "View", tt: `${x.meta.name}: ${label}`, wh: was, key: was, href: `#/g/${x.id}/${v}`, w: 7 });
		for (const i of x.issues) out.push({ ty: KIND[i.kind], tt: i.title, wh: `${x.meta.name} · ${plural(i.mentions, "player")}`, key: i.area, href: `#/g/${x.id}/players/${i.kind}/${i.id}`, w: i.kind === "bug" ? 6 : 5 });
		for (const m of x.media) out.push({ ty: MEDIA[m.source]?.[0] || "Media", tt: m.title, wh: `${x.meta.name} · ${m.author || ""}`, href: `#/g/${x.id}/media`, w: 4 });
		for (const i of x.items.filter(isMajor)) out.push({ ty: { review: "Review", topic: "Thread", video: "Video", refund: "Refund" }[i.kind], tt: i.title || i.triage?.summary || i.text || "", key: `${i.text || ""} ${i.author?.name || ""}`, wh: `${x.meta.name} · ${ago(i.created)}`, href: `#/g/${x.id}/posts/${i.id}`, w: 3 });
	}
	return out;
}
function openPalette() {
	if (document.querySelector(".pal-back")) return;
	const index = paletteIndex();
	let results = [], at = 0;
	const list = h("div.pal-list", { role: "listbox" });
	const input = h("input", { type: "text", placeholder: "Jump to a game, view, bug, idea, post or video…", "aria-label": "Search everything", autocomplete: "off", spellcheck: "false" });
	const close = () => back.remove();
	const go = (r) => { close(); if (r.href.startsWith("#")) location.hash = r.href; else location.href = r.href; };
	const draw = () => {
		list.replaceChildren(...(results.length ? results.map((r, i) => h("div.pal-item", { role: "option", "aria-selected": String(i === at), onclick: () => go(r), onmousemove: () => { if (at !== i) { at = i; draw(); } } },
			h("span.ty", r.ty), h("span.tt", r.tt), r.wh ? h("span.wh", r.wh) : null)) : [h("p.empty", { style: "padding:0.75rem" }, "Nothing matches.")]));
		list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	};
	const search = () => {
		const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
		results = index.map((r) => {
			const hay = `${r.tt} ${r.wh || ""} ${r.key || ""} ${r.ty}`.toLowerCase(), title = r.tt.toLowerCase();
			if (!words.every((w) => hay.includes(w))) return null;
			return { ...r, score: r.w + (words.length && title.startsWith(words[0]) ? 6 : 0) + sum(words.map((w) => (title.includes(w) ? 3 : 0))) };
		}).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, words.length ? 30 : 12);
		at = 0;
		draw();
	};
	input.addEventListener("input", search);
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); at = (at + (e.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(1, results.length); draw(); }
		else if (e.key === "Enter" && results[at]) go(results[at]);
		else if (e.key === "Escape") close();
	});
	const back = h("div.pal-back", { onmousedown: (e) => { if (e.target === back) close(); } },
		h("div.pal", { role: "dialog", "aria-label": "Jump to" }, input, list, h("div.pal-foot", h("span", h("kbd", "↑"), " ", h("kbd", "↓"), " move"), h("span", h("kbd", "Enter"), " open"), h("span", h("kbd", "Esc"), " close"))));
	document.body.append(back);
	search();
	input.focus();
}
addEventListener("keydown", (e) => {
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
	if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) { e.preventDefault(); openPalette(); }
});

// ---- theme and start -------------------------------------------------------------------------
function setTheme(t) {
	store.set("theme", t);
	document.documentElement.dataset.theme = t === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
	document.getElementById("theme").replaceChildren(seg([["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]], t, setTheme, ".small"));
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => setTheme(store.get("theme", "auto")));

(async () => {
	setTheme(store.get("theme", "auto"));
	document.getElementById("find").addEventListener("click", openPalette);
	document.getElementById("top-find").addEventListener("click", openPalette);
	document.getElementById("top-menu").addEventListener("click", openSide);
	document.getElementById("scrim").addEventListener("click", closeSide);
	await load();
	render();
})();
