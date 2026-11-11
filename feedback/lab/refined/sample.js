// Invented sample data in the shape of the real feedback data (index.json, games/<appId>.json,
// sales.json, wishlists.json). Every game, player, post and number here is made up: the repo is
// public, so real feedback never ships with the prototype. Dates are relative to today.
window.SAMPLE = (() => {
	const DAY = 86400, now = Math.floor(Date.now() / 1000);
	let seed = 42;
	const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
	const pick = (a) => a[Math.floor(rnd() * a.length)];
	const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
	const WHO = ["moth_lamp", "Quillfeather", "brassfox", "N0ctua", "pebble.jar", "Ostrava77", "tinroof", "Halcyon_M", "greywren", "saltpan", "Juniper Vex", "kettlebird", "oddsock", "Marrow&Co", "lanternfish", "dustbunny9"];
	const LANG = ["English", "English", "English", "German", "Japanese", "Spanish", "French", "English"];

	// kind, title, urgency, players, negative reviews, refunds, status, area, summary, what players wrote
	const SPECS = {
		9000010: { name: "Cinder Keep", hue: 14, status: "released", scale: 1, issues: [
			["bug", "Crash when loading a save from before update 1.3", "urgent", 23, 9, 4, "open", "Saves", "Old saves crash to desktop on load since 1.3.", ["Updated and now my 30 hour save crashes on load.", "Every save from last month crashes the game.", "Crash on continue, new games work fine."]],
			["bug", "Controller stops responding after alt-tab", "high", 14, 3, 1, "still_happening", "Input", "Gamepad input is lost when the window loses focus.", ["Alt-tab once and my controller is dead until restart.", "Said fixed in 1.3 but the pad still drops out."]],
			["bug", "Wave 12 boss sometimes never spawns", "high", 11, 4, 0, "open", "Combat", "The run cannot end because the boss does not appear.", ["Stuck on wave 12, nothing spawns, had to quit.", "Boss didn't show up twice in a row."]],
			["bug", "Text overflows buttons in German", "medium", 6, 0, 0, "open", "Localization", "Long German labels run past their buttons.", ["Half the menu text is cut off in German."]],
			["bug", "Ultrawide: HUD is stretched", "low", 4, 1, 0, "likely_fixed", "Display", "On 21:9 the HUD scales with the width.", ["HUD looks stretched on my ultrawide."]],
			["bug", "Achievement 'Ember Lord' does not unlock", "medium", 5, 1, 0, "open", "Achievements", "Finishing on hard does not grant the achievement.", ["Beat hard mode, no achievement."]],
			["suggestion", "Co-op for two players", "high", 31, 2, 0, "open", "Multiplayer", "Players want to defend together online.", ["Would be perfect with a friend.", "Please add co-op, even just two players."]],
			["suggestion", "Let me rebind every key", "medium", 12, 1, 0, "open", "Input", "Some keys cannot be changed in the settings.", ["I can't rebind the build menu key."]],
			["suggestion", "Endless mode after the campaign", "medium", 17, 0, 0, "open", "Modes", "More to do once the story is done.", ["Finished it in 9 hours and want more waves."]],
			["suggestion", "Speed up the first hour", "low", 7, 3, 2, "open", "Pacing", "The tutorial waves feel slow.", ["First hour drags, almost refunded."]],
			["praise", "Building while fighting feels great", "", 44, 0, 0, "open", "Core loop", "The mix of shooting and building is the hook.", ["The build-and-shoot loop is so satisfying."]],
			["praise", "The soundtrack", "", 19, 0, 0, "open", "Audio", "Players mention the music by name.", ["The music in the forge level is incredible."]],
			["praise", "Runs well on Steam Deck", "", 13, 0, 0, "open", "Performance", "Smooth and readable on the Deck.", ["Plays great on Deck, 60 fps."]],
		] },
		9000020: { name: "Mossline", hue: 130, status: "released", scale: 0.45, issues: [
			["bug", "Rain audio keeps playing in menus", "medium", 7, 1, 0, "open", "Audio", "The rain loop does not stop when pausing.", ["Rain sound never stops, even in settings."]],
			["bug", "Soft lock in the greenhouse puzzle", "high", 9, 3, 1, "open", "Puzzles", "Pushing the crate into the corner blocks progress.", ["Crate stuck in corner, had to restart the chapter."]],
			["suggestion", "A hint button", "medium", 15, 2, 0, "open", "Puzzles", "Players get stuck with no way forward.", ["A small hint system would save me from guides."]],
			["suggestion", "Photo mode", "low", 8, 0, 0, "open", "Extras", "The art invites screenshots.", ["So pretty, I want a photo mode."]],
			["praise", "The art style", "", 38, 0, 0, "open", "Art", "Hand-painted look is the top reason to recommend.", ["Every screen looks like a painting."]],
			["praise", "Short and complete", "", 16, 0, 0, "open", "Length", "Players like that it ends in an evening.", ["Four hours, no filler. Lovely."]],
		] },
		9000030: { name: "Paper Harbor", hue: 205, status: "released", scale: 0.18, issues: [
			["bug", "Trade route list scrolls back to the top", "low", 3, 0, 0, "open", "UI", "The list resets after each edit.", ["The route list jumps to the top every time."]],
			["suggestion", "More ship types", "medium", 9, 0, 0, "open", "Content", "Late game has little to buy.", ["Needs a few bigger ships for the late game."]],
			["praise", "Relaxing to play", "", 21, 0, 0, "open", "Mood", "A calm game to wind down with.", ["My evening wind-down game."]],
		] },
		9000040: { name: "Tinker Tides", hue: 265, status: "released", demo: true, scale: 0.3, issues: [
			["bug", "Demo save does not carry over", "high", 8, 2, 0, "open", "Saves", "Demo progress is lost in the full game.", ["Lost my demo progress after buying."]],
			["bug", "Stutter when the tide changes", "medium", 10, 2, 1, "still_happening", "Performance", "A hitch each time the water level moves.", ["Big stutter at every tide change, still there after the patch."]],
			["suggestion", "Mouse-only controls", "medium", 6, 0, 0, "open", "Input", "Players want to play one-handed.", ["Would love to play with just the mouse."]],
			["praise", "Clever machines", "", 12, 0, 0, "open", "Design", "Contraptions feel inventive.", ["The gear puzzles are so clever."]],
		] },
		9000050: { name: "Nightshift Bakery", hue: 40, status: "upcoming", scale: 0, issues: [] },
	};
	const VIDEOS = {
		9000010: [["youtube", "Cinder Keep is the tower defense I wanted", "Brass Lantern Plays", 48200, 2, "positive"], ["youtube", "I tried Cinder Keep's hard mode (it broke me)", "TwoHeartsLeft", 9100, 0.4, "mixed"], ["twitch", "Cinder Keep first look", "kiln_and_co", 0, 0.01, null], ["youtube", "Cinder Keep review: build, shoot, repeat", "The Slow Gamer", 3300, 9, "positive"], ["news", "Cinder Keep adds a new biome in update 1.3", "Indie Dispatch", 0, 6, null], ["reddit", "Anyone else stuck on wave 12?", "r/towerdefense", 0, 3, null]],
		9000020: [["youtube", "Mossline: a perfect rainy-day puzzle game", "Quiet Corner", 12400, 5, "positive"], ["news", "Ten short games worth an evening", "Small Screens", 0, 12, null]],
		9000030: [["youtube", "Paper Harbor, one year later", "Dockside Dan", 1900, 20, "positive"]],
		9000040: [["youtube", "Tinker Tides demo: full of ideas", "GearHead Indie", 6700, 1, "mixed"], ["twitch", "Tinker Tides blind run", "tidepool_tv", 0, 1.5, null]],
		9000050: [["news", "Nightshift Bakery announced for next spring", "Indie Dispatch", 0, 8, null]],
	};
	const POINTS = { positive: [["praise", "Loves how building and fighting mix"], ["suggestion", "Asks for co-op"], ["bug", "Hits a stutter in the last level"]], mixed: [["complaint", "Finds the first hour slow"], ["bug", "Loses controller input after alt-tab"], ["praise", "Likes the art and music"]] };

	const games = {}, sales = { days: {} }, wishlists = { apps: {} }, index = { changedAt: now, games: [] };
	for (const [idStr, spec] of Object.entries(SPECS)) {
		const appId = Number(idStr), s = spec.scale;
		index.games.push({ appId, name: spec.name, status: spec.status, hue: spec.hue, capsule: null });
		const g = { appId, items: {}, issues: {}, players: [], reviewTotals: {}, releases: [], media: { items: {} } };
		let n = 0;
		const add = (item) => { const id = `${appId}-${++n}`; g.items[id] = { id, url: "#", author: { name: pick(WHO) }, ...item }; return id; };
		spec.issues.forEach(([kind, title, urgency, mentions, neg, refunds, status, area, summary, quotes], k) => {
			const id = `${kind[0]}${k + 1}`, items = [];
			const lastSeen = now - Math.floor(rnd() * 5 * DAY) - 3600, count = Math.min(mentions, 7);
			for (let j = 0; j < count; j++) {
				const postKind = kind === "praise" ? pick(["review", "review", "topic", "comment"]) : j < refunds ? "refund" : pick(["review", "review", "topic", "topic", "reply", "reply", "comment"]);
				const created = j ? lastSeen - Math.floor(rnd() * 20 * DAY) : lastSeen;
				const text = quotes[j % quotes.length] + (postKind === "review" ? " " + pick(["Otherwise a good game.", "Hope this gets fixed soon.", "Still recommend it.", "Changing my review when it's sorted."]) : "");
				items.push(add({ kind: postKind, created, text, title: postKind === "topic" ? title : undefined, forum: postKind === "topic" ? "General Discussions" : undefined,
					votedUp: postKind === "review" ? (kind === "praise" || j >= neg) : undefined, playtime: postKind === "review" ? Math.round(1 + rnd() * 40) : undefined,
					refundReason: postKind === "refund" ? pick(["Game did not work", "Not what I expected"]) : undefined,
					devResponse: postKind === "review" && rnd() < 0.4 ? { text: "Thanks, looking into it." } : null,
					triage: { category: kind, language: pick(LANG), summary: summary, english: text, points: [{ kind, text: summary, issue: id }] } }));
			}
			g.issues[id] = { id, kind, title, urgency: urgency || "low", priority: ({ urgent: 400, high: 300, medium: 200, low: 100 }[urgency] || 0) + mentions, mentions, negativeReviews: neg, refunds,
				firstSession: kind === "praise" ? 0 : Math.round(mentions * rnd() * 0.4), status, fixedIn: status === "open" ? null : "v1.3", firstSeen: lastSeen - 25 * DAY, lastSeen, items, area,
				languages: ["English", "German"].slice(0, 1 + (k % 2)), summary, details: quotes.slice(0, 2),
				fixPrompt: `Fix: ${title}. ${summary} Reported by ${mentions} players.` };
		});
		// Replies hang under their thread; a few fresh, unanswered negative reviews for Needs attention.
		for (const issue of Object.values(g.issues)) {
			const own = issue.items.map((id) => g.items[id]), topic = own.find((i) => i.kind === "topic");
			for (const i of own) if (i.kind === "reply" && topic) i.topic = topic.id;
		}
		if (s >= 0.4) for (let j = 0; j < 2; j++) add({ kind: "review", created: now - (j + 1) * 9 * 3600, votedUp: false, playtime: 2 + j, text: pick(["Refunded after an hour. The start is too slow and my save broke.", "Not for me. Crashed twice in the first evening."]), devResponse: null,
			triage: { category: "bug", language: "English", summary: pick(["Crashes early and a slow start", "Lost a save in the first session"]), points: [] } });
		// Media, and each YouTube video as a post with its comments.
		(VIDEOS[appId] || []).forEach(([source, title, author, views, daysAgo, verdict], k) => {
			const at = now - Math.floor(daysAgo * DAY), mid = `m${k + 1}`, live = source === "twitch" && daysAgo < 0.05;
			g.media.items[mid] = { id: mid, source, title, author, url: "#", at, views: views || undefined, likes: views ? Math.round(views / 28) : undefined, comments: views ? Math.round(views / 400) : undefined,
				live, viewers: live ? 212 : undefined, peak: source === "twitch" ? 340 : undefined, end: source === "twitch" ? at + 5400 : undefined, duration: views ? 600 + k * 240 : undefined, subscribers: views ? views * 6 : undefined,
				text: source === "news" || source === "reddit" ? "A short write-up that names the game." : undefined,
				review: verdict ? { verdict, summary: verdict === "positive" ? "Recommends it, with one or two rough edges." : "Enjoys the idea but hits a few problems.", points: POINTS[verdict].map(([kind, text], p) => ({ kind, text, at: 90 + p * 210 })) } : undefined };
			if (source !== "youtube") return;
			const vid = add({ kind: "video", created: at, title, author: { name: author }, media: mid, text: g.media.items[mid].review.summary, triage: { category: verdict === "positive" ? "praise" : "suggestion", language: "English", summary: g.media.items[mid].review.summary, points: [] } });
			for (let c = 0; c < 3 + Math.round(rnd() * 6); c++) add({ kind: "comment", created: at + Math.floor(rnd() * DAY), video: vid, text: pick(["Picked this up because of your video.", "Does it have co-op?", "The music is so good.", "Looks great, wishlisted.", "Mine crashes on old saves too.", "How long is it?"]), triage: { category: "question", language: "English", summary: "", points: [] } });
		});
		// Daily numbers: players, reviews, sales, wishlists.
		let pos = Math.round(900 * s), neg = Math.round(120 * s);
		for (let d = 59; d >= 0; d--) {
			const t = now - d * DAY, day = iso(t), wk = new Date(t * 1000).getUTCDay(), weekend = wk === 0 || wk === 6 ? 1.35 : 1, bump = d < 8 && appId === 9000010 ? 1.6 : 1;
			if (s) {
				g.players.push([t, Math.round((180 + rnd() * 60) * s * weekend * bump)]);
				pos += Math.round(rnd() * 5 * s * bump); neg += rnd() < 0.3 * s ? 1 : 0;
				g.reviewTotals[day] = { positive: pos, negative: neg };
				const units = Math.round((22 + rnd() * 14) * s * weekend * bump), gross = Math.round(units * 13.6 * 100) / 100;
				(sales.days[day] ||= {})[appId] = { gross, net: Math.round(gross * 0.62 * 100) / 100, units, returnedUnits: Math.round(units * 0.07) };
			}
			const adds = Math.round((30 + rnd() * 25) * (s || 0.5) * bump);
			((wishlists.apps[appId] ||= { days: {} }).days)[day] = { adds, deletes: Math.round(adds * 0.25), purchases: Math.round(adds * 0.2 * (s ? 1 : 0)), gifts: 0 };
		}
		if (s) g.releases = [["1.3", "Update 1.3: new biome and fixes", 7], ["1.2", "Update 1.2: balance pass", 31], ["1.1", "Update 1.1: controller support", 55]].map(([version, name, d]) => ({ version, name, time: now - d * DAY, url: "#" }));
		g.achievements = s ? { at: now - 7200, list: [["First furnace lit", 91.2], ["Wave 5 cleared", 74.8], ["Ten towers built", 66.1], ["Wave 12 boss down", 31.4], ["Campaign finished", 24.9], ["Hard mode finished", 6.2]].map(([name, percent]) => ({ name, percent: Math.round(percent * (0.7 + s * 0.3) * 10) / 10 })) } : null;
		g.curators = { at: now - DAY, list: s ? [["Cozy Strategy Club", 48200, "recommended", "A tower defense with real weight to it."], ["Deck Verified Fans", 21900, "recommended", "Great on the Deck."], ["Hidden Gems Weekly", 9400, "informational", "Worth a look on sale."]].slice(0, 1 + Math.round(s * 2)).map(([name, followers, state, blurb]) => ({ name, followers, state, blurb, url: "#", time: now - 12 * DAY })) : [] };
		g.bundles = { list: s > 0.3 ? [{ id: 1, name: "Build & Defend Bundle", bundleDiscount: 15, price: "$24.98", fullPrice: "$29.38", apps: [{ appId, name: spec.name }, { appId: 1, name: "Gearwall" }] }] : [] };
		g.bundleIdeas = s > 0.3 ? [{ name: "Lantern Siege", status: "contacted", note: "Asked on 3 Nov, waiting." }, { name: "Root & Rampart", status: "idea", note: "Same audience, same price." }] : [];
		g.competitors = s ? [["Gearwall", 0.12, 410, 88], ["Lantern Siege", -0.21, 150, 79], ["Root & Rampart", 0.03, 95, 91]].map(([name, change, peak, positive]) => ({ name, change, peak, positive })) : [];
		g.steamStats = s ? { median: `${Math.round(1 + s * 3)} h ${Math.round(rnd() * 50)} min`, reach: [["10 min", 92], ["30 min", 81], ["1 h", 68], ["2 h", 54], ["5 h", 33], ["10 h", 17]].map(([label, pct]) => ({ label, pct })), deck: "14% of sessions", controller: "38% use a controller" } : null;
		games[appId] = g;
	}
	return { index, games, sales, wishlists };
})();
