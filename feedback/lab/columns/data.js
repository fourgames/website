// Data for the Columns prototype.
// load() first tries a local copy of the real data (feedback/data, gitignored) and falls back to
// the invented sample below, written in the same raw shape as data/index.json, data/games/<id>.json,
// data/sales.json and data/wishlists.json. Everything in SAMPLE is made up: names, texts, numbers.
(function () {
const DAY = 86400, NOW = Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const lastDays = (n) => Array.from({ length: n }, (_, i) => iso(NOW - (n - i) * DAY)); // ends yesterday
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const CAP = "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/";

// ---- invented sample --------------------------------------------------------------------------
// issue: [kind, title, urgency, status, players, negReviews, refunds, lastSeenDaysAgo, firstSeenDaysAgo, posts]
// post:  [kind, author, daysAgo, text, votedUp, hoursPlayed, answered]   (a reply follows its thread)
const SPECS = [
	{
		appId: 2807130, name: "Reforge Front", hue: 20, capsule: CAP + "2807130/f709685fb160ba9042b9b5ef18d36fad0b58f5c1/header.jpg",
		players: 34, sales: 150, pos: 0.89, reviews: 418, wish: 9,
		issues: [
			["bug", "Game freezes when wave 12 starts", "urgent", "open", 9, 3, 2, 0.3, 4, [
				["review", "ember_fox", 0.3, "Loved it until wave 12. The game freezes every time the boss spawns and I lose the whole run.", false, 1.4],
				["topic", "Tallow", 1.2, "Freeze at wave 12 (every run). Happens right when the horn sounds. Windows 11, RTX 3060.", null],
				["reply", "quietmoss", 1.1, "Same here, also on Linux.", null],
				["reply", "Brask", 0.9, "Turning shadows to low fixed it for me.", null],
				["refund", "refund note", 2, "Freezes on wave 12, can't finish a run.", null],
			]],
			["bug", "Turrets stop shooting after a reforge", "high", "still_happening", 6, 1, 0, 1.5, 21, [
				["topic", "OddLantern", 1.5, "Turrets go idle after reforging. Still happens in 1.4.2, thought this was fixed?", null],
				["review", "pinecrate", 6, "Fun, but my upgraded turrets sometimes just stop. Have to sell and rebuild.", true, 7.5],
				["reply", "Tallow", 1.4, "Yes, it came back for me after the last patch.", null],
			]],
			["bug", "Controller can't pick the last build slot", "medium", "open", 3, 0, 0, 5, 30, [
				["topic", "DeckDweller", 5, "On Steam Deck the d-pad skips the bottom right build slot.", null],
			]],
			["bug", "Typo in the Swedish tutorial text", "low", "open", 1, 0, 0, 12, 12, [
				["reply", "nordvind", 12, "Small thing: 'smedja' is misspelled in the tutorial.", null],
			]],
			["suggestion", "Endless mode after the last wave", "medium", "open", 11, 0, 0, 0.8, 60, [
				["review", "Marrow", 0.8, "Great loop. Please add an endless mode, 20 waves is over too soon.", true, 12],
				["topic", "saltpan", 3, "Endless mode? Would love leaderboards with it.", null],
				["reply", "Brask", 2.8, "+1, with a wave counter.", null],
			]],
			["suggestion", "Co-op for two players", "low", "open", 7, 1, 0, 4, 90, [
				["review", "hollowreed", 4, "Good solo, but this begs for co-op. Not recommending until then.", false, 3.1, true],
			]],
			["suggestion", "Rebind keys", "medium", "open", 4, 0, 0, 9, 40, [
				["topic", "leftyplays", 9, "Any chance of key rebinding? Left-handed here.", null],
			]],
			["praise", "Building while fighting feels great", "", "open", 22, 0, 0, 0.5, 200, [
				["review", "copperwren", 0.5, "Placing walls mid-fight never gets old. Best five bucks this year.", true, 9.2],
			]],
			["praise", "The furnace music", "", "open", 8, 0, 0, 6, 150, [
				["review", "dusk_owl", 6, "The soundtrack when the furnace overheats is so good.", true, 5],
			]],
		],
		media: [
			["youtube", "I tried to beat Reforge Front without walls", "Kettle Plays", 0.6, 18400, 212000, "positive", "A no-walls challenge run. Praises the build-while-fighting loop and the upgrade tree; hits the wave 12 freeze at 14:20 and restarts.",
				[["bug", "Freeze at wave 12", "14:20"], ["praise", "Upgrade tree has real choices", "06:05"], ["suggestion", "Wants an endless mode", "21:40"]],
				[["mossy", "The freeze got me too lol"], ["ArcLight", "Underrated game"], ["bn_77", "wave 12 gang"], ["Yuki", "music is a banger"]]],
			["twitch", "Tower defense night: Reforge Front", "sleepyharbor", 0.02, 61, 3400, "", "", [], [], true],
			["youtube", "5 cheap Steam games worth your time", "Budget Backlog", 5, 96000, 540000, "positive", "A list video; Reforge Front is number 3, about two minutes. Calls it 'a tight little FPS tower defense'.", [["praise", "Good value at the price", "07:12"]], [["piper", "bought #3, no regrets"], ["Hale", "nice list"]]],
			["news", "Small studio, big furnace: an FPS tower defense made in Godot", "Indie Ledger", 9, null, null, "", "A short article on the studio and the Godot engine.", [], []],
		],
		releases: [["1.4.2", "Turret fixes and a new map", 3, ["Fixed turrets going idle after a reforge", "New map: The Quarry", "Balance: goblin sappers are slower"]], ["1.4.1", "Hotfix", 17, ["Fixed a crash when alt-tabbing"]], ["1.4", "The Reforge update", 31, ["Reforge any tower", "Steam Deck layout"]]],
		achievements: [["First furnace lit", 91], ["Survive wave 5", 64], ["Survive wave 10", 38], ["Survive wave 12", 17], ["Beat the campaign", 11]],
		curators: [["Tower Defense Fans", 48000, "recommended", "Tight, cheap and clever."], ["Godot Games", 12500, "recommended", "A showcase for the engine."], ["Hard Pass", 3100, "not_recommended", "Too short."]],
		competitors: [["Goblin Gate", 120, -8], ["Bastion Shift", 410, 3]],
		bundles: [["Four Games Collection", 15, "$10.17"]],
	},
	{
		appId: 3958210, name: "Digging A Hole In Ice With A Chainsaw", short: "Digging A Hole", hue: 200, capsule: CAP + "3958210/31c125b9f63a0f8c5329e902bfd08f6c7a6c85d8/header.jpg",
		players: 212, sales: 620, pos: 0.93, reviews: 1304, wish: 55,
		issues: [
			["bug", "Save file lost after the depth 400 cutscene", "high", "open", 7, 2, 1, 0.6, 3, [
				["review", "glacierpup", 0.6, "Lost a six hour save after the cutscene at depth 400. Heartbroken.", false, 6.2],
				["topic", "Rime", 1, "Save gone after the 400 m cutscene. Cloud save has the empty one too.", null],
				["reply", "thawline", 0.9, "Check the backup folder, mine was there.", null],
				["refund", "refund note", 1.5, "Lost my save.", null],
			]],
			["bug", "Dynamite sometimes does no damage", "medium", "open", 5, 0, 0, 2, 14, [
				["topic", "boomshelf", 2, "Dynamite duds: about one in five just vanish.", null],
				["reply", "Rime", 1.9, "Only when thrown while falling, I think.", null],
			]],
			["bug", "Ultrawide: shop menu is cut off", "low", "open", 2, 0, 0, 8, 20, [
				["topic", "wide_boi", 8, "21:9 cuts the shop's right column.", null],
			]],
			["suggestion", "A map of how deep friends got", "medium", "open", 14, 0, 0, 0.4, 25, [
				["topic", "icicle", 0.4, "Show my friends' depth on the rope! Would make me dig all night.", null],
				["review", "lowtide", 2, "Addictive. Wish I could see friends' depths.", true, 15],
			]],
			["suggestion", "More chainsaw skins", "low", "open", 9, 0, 0, 3, 28, [
				["review", "sawbones", 3, "Give me a pink chainsaw and I'm set.", true, 8],
			]],
			["praise", "The sound of the chainsaw in ice", "", "open", 31, 0, 0, 0.2, 40, [
				["review", "Fjell", 0.2, "The crunch. THE CRUNCH. 10/10 would dig again.", true, 11],
			]],
			["praise", "One more upgrade loop", "", "open", 27, 0, 0, 1, 40, [
				["review", "nightshift", 1, "Said one more upgrade at 11pm. It's 3am.", true, 19],
			]],
		],
		posts: [["review", "coldsnap", 0.1, "Too grindy past depth 300. Refunded.", false, 1.1], ["refund", "refund note", 0.7, "Not what I expected from the trailer.", null]],
		media: [
			["youtube", "This chainsaw game ate my whole weekend", "Northbit", 0.3, 241000, 1300000, "positive", "A full first-hours playthrough. Loves the sound and the upgrade loop, wishes for friend depths; no bugs shown.",
				[["praise", "The upgrade loop", "03:30"], ["suggestion", "Friend depth markers", "18:02"], ["praise", "Sound design", "09:44"]],
				[["kibo", "bought it halfway through the video"], ["Ana", "the crunch is real"], ["dev_fan", "made in Godot!"], ["zzt", "depth 400 save bug got me"], ["Per", "part 2?"]]],
			["youtube", "Digging A Hole speedrun in 41 minutes", "FastThaw", 2, 12800, 45000, "positive", "A speedrun with commentary. Uses a dynamite clip to skip depth 250.", [["bug", "Dynamite clip skips a layer", "12:10"]], [["Rime", "that clip is wild"]]],
			["twitch", "digging until I hit water", "polarbun", 1.2, 480, 22000, "", "", [], []],
			["reddit", "The cosiest stressful game I played this year", "r/indiegames", 4, 2300, null, "", "A recommendation thread, mostly positive.", [], []],
		],
		releases: [["1.1", "Deeper: the 500 m update", 6, ["New layer: the lake under the ice", "Two new chainsaws", "Fixed the shop on 16:10 screens"]], ["1.0.3", "Hotfix", 24, ["Fixed dynamite price"]], ["1.0", "Out now", 42, ["Release"]]],
		achievements: [["First block", 96], ["Depth 100", 71], ["Depth 250", 44], ["Depth 400", 21], ["Hit water", 9]],
		curators: [["Cozy Corner", 86000, "recommended", "Strangely calming."], ["Idle & Incremental", 30200, "recommended", "A great loop."]],
		competitors: [["Hole Story", 950, 12], ["Drill Bit", 260, -3], ["Ice Fishing Sim", 1800, 1]],
		bundles: [["Four Games Collection", 15, "$10.17"], ["Dig Deep Bundle", 10, "$8.98"]],
	},
	{
		appId: 5207970, name: "Pomo Valley", hue: 135, capsule: CAP + "5207970/0cb9242e668b929659c8705c9c4b3c1da19c108b/header.jpg",
		players: 96, sales: 380, pos: 0.95, reviews: 167, wish: 120,
		issues: [
			["bug", "Timer keeps running when the laptop sleeps", "high", "open", 5, 1, 0, 0.9, 8, [
				["topic", "focusfern", 0.9, "Closed the lid during a focus round and came back to three finished rounds.", null],
				["review", "plum", 2, "Lovely, but the timer cheats when my laptop sleeps.", false, 4],
			]],
			["bug", "Crops reset at midnight", "medium", "open", 3, 0, 0, 3, 9, [
				["topic", "beetroot", 3, "My pumpkins went back to seeds at 00:00.", null],
			]],
			["suggestion", "Custom focus lengths", "high", "open", 18, 0, 0, 0.2, 11, [
				["review", "halfmoon", 0.2, "Perfect study buddy. Please let me set 50/10 rounds.", true, 22],
				["topic", "tomato_timer", 1, "Custom lengths? 25 minutes is too short for me.", null],
				["reply", "focusfern", 0.8, "Yes please, 45/15.", null],
			]],
			["suggestion", "Always-on-top mini window", "medium", "open", 10, 0, 0, 2, 10, [
				["topic", "sidecar", 2, "A tiny always-on-top window would be perfect.", null],
			]],
			["praise", "Makes focusing feel like a reward", "", "open", 25, 0, 0, 0.3, 11, [
				["review", "ivy", 0.3, "I study more because I want to water my turnips.", true, 31],
			]],
			["praise", "Pixel art", "", "open", 12, 0, 0, 2, 11, [
				["review", "moss_agate", 2, "The valley is gorgeous.", true, 6],
			]],
		],
		media: [
			["youtube", "Study with me in Pomo Valley (2 hours)", "Quiet Desk", 1, 34000, 88000, "positive", "A study-with-me video using the game as a timer. No commentary; the description recommends it.", [["praise", "Used as a real study timer", "00:00"]], [["Lia", "this got me through exams"], ["rowan", "need 50/10 rounds"]]],
			["youtube", "Cozy games for people who can't focus", "Softlock", 3, 152000, 410000, "mixed", "Third of six games. Likes the idea, finds the farming thin after a few hours.", [["praise", "Clever idea", "08:15"], ["suggestion", "More to do in the valley", "10:02"]], [["Jun", "the timer bug is annoying"], ["P", "cute"]]],
			["news", "A farming game you can only play on your breaks", "Pixel Post", 7, null, null, "", "A launch-week write-up.", [], []],
		],
		releases: [["1.0.2", "Sleep fix and autumn crops", 1, ["Fixed crops resetting at midnight", "New crops: pumpkin, leek"]], ["1.0", "Out now", 12, ["Release"]]],
		achievements: [["First focus round", 88], ["First harvest", 73], ["Ten rounds", 41], ["Build the barn", 19], ["100 rounds", 4]],
		curators: [["Cozy Corner", 86000, "recommended", "The nicest way to work."], ["Productivity Games", 4100, "informative", "A timer with a farm."]],
		competitors: [["Focus Farm", 540, -5], ["Desk Garden", 2100, 6]],
		bundles: [["Four Games Collection", 15, "$10.17"]],
	},
];

function sample() {
	const index = { games: [] }, games = {}, sales = { days: {} }, wishlists = { apps: {} };
	for (const s of SPECS) {
		const r = rng(s.appId), id = String(s.appId);
		const g = { items: {}, issues: {}, media: { items: {} }, releases: [], players: [], reviewTotals: {} };
		let n = 0;
		const addPost = ([kind, author, ago, text, up, hours, answered], issue, category, parent) => {
			const key = `${kind[0]}${++n}`;
			g.items[key] = { id: key, kind, created: NOW - ago * DAY, author: { name: author }, text, votedUp: up, playtime: hours, devResponse: answered ? "Thanks, noted!" : null,
				parent: kind === "reply" ? parent : undefined, refundReason: kind === "refund" ? "Gameplay / technical" : undefined,
				title: kind === "topic" ? text.split(/[.?!(]/)[0] : undefined, url: `https://store.steampowered.com/app/${id}`,
				triage: { summary: text, language: "english", category, points: issue ? [{ kind: category, issue }] : [] } };
			return key;
		};
		s.issues.forEach(([kind, title, urgency, status, mentions, neg, refunds, last, first, posts], i) => {
			const iid = `i${i + 1}`; let thread = null;
			const ids = posts.map((p) => { const k = addPost(p, iid, kind, thread); if (p[0] === "topic") thread = k; return k; });
			g.issues[iid] = { id: iid, kind, title, urgency: urgency || "low", status, priority: { urgent: 4, high: 3, medium: 2, low: 1 }[urgency] * 10 + mentions || mentions, mentions, negativeReviews: neg, refunds,
				lastSeen: NOW - last * DAY, firstSeen: NOW - first * DAY, items: ids, trending: last < 1 && mentions > 6 };
		});
		for (const p of s.posts || []) addPost(p, null, p[0] === "refund" ? "bug" : "question");
		s.media.forEach(([source, title, author, ago, views, subs, verdict, summary, points, comments, live], i) => {
			const key = `${source.slice(0, 2)}${i}`;
			g.media.items[key] = { id: key, source, title, author, at: NOW - ago * DAY, views, subscribers: subs, live: !!live, url: "https://example.com/", review: verdict || summary ? { verdict: verdict || "unclear", summary, points: points.map(([kind, text, at]) => ({ kind, text, at })) } : null };
			comments.forEach(([name, text], j) => { g.items[`y${i}_${j}`] = { id: `y${i}_${j}`, kind: "comment", parent: key, created: NOW - (ago - 0.05 * (j + 1)) * DAY, author: { name }, text, triage: { summary: text, points: [] } }; });
		});
		g.releases = s.releases.map(([version, name, ago, notes]) => ({ version, name, time: NOW - ago * DAY, notes, votesUp: 20 + Math.floor(r() * 80), votesDown: Math.floor(r() * 4), url: "https://example.com/" }));
		g.achievements = { list: s.achievements.map(([name, percent]) => ({ name, percent })) };
		g.curators = { list: s.curators.map(([name, followers, state, blurb]) => ({ name, followers, state, blurb })) };
		g.competitors = Object.fromEntries(s.competitors.map(([name, peak, change], i) => [i, { name, peak, change }]));
		g.bundles = { list: s.bundles.map(([name, bundleDiscount, price]) => ({ name, bundleDiscount, price })) };
		let pos = Math.round(s.reviews * s.pos), neg = s.reviews - pos;
		wishlists.apps[id] = { days: {} };
		lastDays(30).forEach((d, i) => {
			const wave = 1 + 0.35 * Math.sin(i / 2.3 + s.hue) + (i % 7 > 4 ? 0.3 : 0), bump = s.releases.some((x) => Math.round(x[2]) === 30 - i) ? 1.7 : 1;
			const gross = Math.round(s.sales * wave * bump * (0.8 + r() * 0.4));
			(sales.days[d] ||= {})[id] = { gross, net: Math.round(gross * 0.62), units: Math.max(1, Math.round(gross / 4.4)), returnedUnits: r() < 0.3 ? 1 : 0 };
			wishlists.apps[id].days[d] = { adds: Math.round(s.wish * wave * (0.7 + r() * 0.6)), deletes: Math.round(s.wish * 0.2 * r()), purchases: Math.round(s.wish * 0.15 * r()), gifts: 0 };
			g.players.push([NOW - (30 - i) * DAY, Math.round(s.players * wave * bump * (0.8 + r() * 0.4))]);
			if (i > 22) pos += Math.round(r() * s.reviews / 150 + 0.6);
			g.reviewTotals[d] = { positive: pos, negative: neg + (i > 26 ? 1 : 0) };
		});
		g.players.push([NOW, s.players]);
		games[id] = g;
		index.games.push({ appId: s.appId, name: s.name, short: s.short, capsule: s.capsule, hue: s.hue, status: "released" });
	}
	return { index, games, sales, wishlists, sample: true };
}

// ---- real data, when a local copy exists ------------------------------------------------------
async function real() {
	for (const base of ["../../data"]) {
		const get = async (p) => { try { const r = await fetch(`${base}/${p}`); return r.ok ? await r.json() : null; } catch { return null; } };
		const index = await get("index.json");
		if (!index?.games?.length) continue;
		const [sales, wishlists, ...list] = await Promise.all([get("sales.json"), get("wishlists.json"), ...index.games.map((m) => get(`games/${m.appId}.json`))]);
		const games = {};
		index.games.forEach((m, i) => { if (list[i]) games[m.appId] = list[i]; });
		return { index, games, sales: sales || { days: {} }, wishlists: wishlists || { apps: {} }, sample: false };
	}
	return null;
}

// ---- one tidy model for the page, from the raw shape ------------------------------------------
const HUES = [20, 200, 135, 280, 340, 50];
function normalize(raw) {
	const d30 = lastDays(30);
	return raw.index.games.filter((m) => raw.games[m.appId]).map((m, gi) => {
		const g = raw.games[m.appId], id = String(m.appId);
		const posts = Object.entries(g.items || {}).filter(([, i]) => !i.dev && !i.offTopic).map(([key, i]) => {
			const t = i.triage || {};
			return { id: i.id || key, game: id, kind: i.kind === "topic" ? "thread" : i.kind, created: i.created, author: i.author?.name || "a player", text: t.english || i.text || "", summary: t.summary || "",
				title: i.title || "", url: i.url, up: i.kind === "review" ? !!i.votedUp : null, hours: i.playtime, lang: t.language, answered: !!i.devResponse, parent: i.parent ?? i.video ?? i.thread ?? null,
				reason: i.refundReason, category: t.category, issueIds: (t.points || []).map((p) => p.issue).filter(Boolean) };
		});
		const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
		const issues = Object.values(g.issues || {}).map((i) => ({ id: i.id, game: id, kind: i.kind === "suggestion" ? "idea" : i.kind === "praise" ? "loved" : "bug", title: i.title, urgency: i.urgency || "low", status: i.status,
			priority: i.priority || 0, players: i.mentions || 0, neg: i.negativeReviews || 0, refunds: i.refunds || 0, lastSeen: i.lastSeen, firstSeen: i.firstSeen, trending: !!i.trending,
			posts: (i.items || []).map((k) => byId[k]).filter(Boolean) })).filter((i) => i.status !== "likely_fixed");
		const latest = (g.releases || []).reduce((a, r) => Math.max(a, r.time), 0);
		for (const i of issues) i.sinceUpdate = latest && i.firstSeen >= latest;
		const media = Object.entries(g.media?.items || {}).filter(([, x]) => x.source !== "copy" && !x.own).map(([key, x]) => ({ id: x.id || key, game: id, source: x.source, title: x.title, author: x.author, url: x.url, at: x.at,
			views: x.views, subs: x.subscribers, live: !!x.live, thumb: x.thumb, verdict: x.review?.verdict, summary: x.review?.summary || "", points: x.review?.points || [],
			comments: posts.filter((p) => p.kind === "comment" && (p.parent === key || p.parent === x.id || (x.url && p.url && p.url.startsWith(x.url)))) }));
		const sDay = (d) => raw.sales?.days?.[d]?.[id] || {};
		const wDay = (d) => { const w = raw.wishlists?.apps?.[id]?.days?.[d]; return w ? (w.adds || 0) - (w.deletes || 0) - (w.purchases || 0) - (w.gifts || 0) : 0; };
		const peak = {}; for (const [t, n] of g.players || []) peak[iso(t)] = Math.max(peak[iso(t)] || 0, n);
		const rt = g.reviewTotals || {}, rk = Object.keys(rt).sort(), rNow = rt[rk.at(-1)], rWeek = rt[rk.filter((k) => k <= iso(NOW - 7 * DAY)).pop()];
		const tot = (x) => x ? x.positive + x.negative : 0;
		return { id, name: m.name, short: m.short || m.name, capsule: m.capsule, hue: m.hue ?? HUES[gi % HUES.length], posts, issues, media,
			releases: (g.releases || []).slice().sort((a, b) => b.time - a.time).map((r) => ({ name: r.name, version: r.version, time: r.time, notes: r.notes || [], up: r.votesUp, down: r.votesDown, url: r.url })),
			days: d30.map((d) => ({ day: d, gross: sDay(d).gross || 0, net: sDay(d).net || 0, units: sDay(d).units || 0, refunded: sDay(d).returnedUnits || 0, wish: wDay(d), players: peak[d] || 0 })),
			playersNow: (g.players || []).at(-1)?.[1] ?? null, pos: tot(rNow) ? Math.round((rNow.positive / tot(rNow)) * 100) : null, reviews: tot(rNow), reviewsWeek: tot(rNow) - tot(rWeek),
			achievements: g.achievements?.list || [], curators: g.curators?.list || [],
			competitors: Object.values(g.competitors || {}).map((c) => ({ name: c.name, peak: c.peak ?? Object.values(c.peaks || {}).at(-1) ?? null, change: c.change ?? null })),
			bundles: g.bundles?.list || [] };
	});
}

window.FG = { DAY, NOW, async load() { const raw = (await real()) || sample(); return { games: normalize(raw), sample: raw.sample }; } };
})();
