// Invented sample data in the same shape as the private feedback data (index.json, games/<id>.json,
// sales.json, wishlists.json, steamworks.json). Games, players, channels and every quote are made up.
// Times are relative to now, so the brief always has something recent to say.
(() => {
  const DAY = 86400, now = Math.floor(Date.now() / 1000);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  let seed = 4;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const hrs = (n) => now - Math.round(n * 3600);
  const A = 900101, B = 900202, C = 900303;

  const index = { sample: true, games: [
    { appId: A, name: "Ember Line", status: "released", hue: 18 },
    { appId: B, name: "Tidewatch", status: "released", hue: 196 },
    { appId: C, name: "Paper Harbor", status: "upcoming", hue: 262 },
  ] };

  // [id, kind, hours ago, author, text, extra]
  const post = (id, kind, h, name, text, extra = {}) => ({ id, kind, created: hrs(h), updated: hrs(h), author: { name }, text, url: "#", ...extra });
  const tri = (summary, category, points = []) => ({ triage: { summary, category, language: "english", points: points.map((kind) => ({ kind })) } });

  const emberItems = [
    post("r101", "review", 3, "mossy_kettle", "Updated to 1.4 last night and my 31 hour save is gone. The slot shows 'Empty'. I loved this game but I am not rebuilding the whole northern line from nothing. Refunding is not possible any more, so the least I can do is warn others: back up your saves before you update.", { votedUp: false, playtime: 31, ...tri("Lost a 31 hour save after updating to 1.4; warns others to back up.", "bug", ["bug"]) }),
    post("r102", "review", 9, "Brakevan", "Same as others here. Save wiped after the patch. Before that: easily the cosiest train builder I have played. Fix this and I flip the review.", { votedUp: false, playtime: 12, ...tri("Save wiped by the patch; will flip the review once fixed.", "bug", ["bug"]) }),
    post("t103", "topic", 14, "signalbox_ana", "After today's update the game starts on the title screen with Continue greyed out. My save folder still has the files (slot1.sav, 2.1 MB) but the game does not list them. Windows 11, Steam Cloud on. Anyone else?", { title: "1.4 does not find my save (files still there)", ...tri("1.4 no longer lists existing saves although the files are still on disk; Steam Cloud on.", "bug", ["bug"]) }),
    post("c104", "reply", 12, "Brakevan", "Same here. Turning Steam Cloud off and on did nothing.", { topic: "t103", ...tri("Same problem; toggling Steam Cloud did not help.", "bug", ["bug"]) }),
    post("c105", "reply", 11, "pinewood_44", "Renaming slot1.sav to slot_1.sav made it show up again for me. Looks like the file name changed in 1.4.", { topic: "t103", ...tri("Workaround: rename slot1.sav to slot_1.sav; the file name seems to have changed in 1.4.", "bug", ["bug"]) }),
    post("c106", "reply", 6, "signalbox_ana", "The rename worked. Thanks! Devs, please fix it properly though.", { topic: "t103", ...tri("Confirms the rename workaround.", "bug", ["bug"]) }),
    post("f107", "refund", 20, "A player", "Lost my progress after the update.", { refundReason: "Gameplay or technical issue", ...tri("Refunded after losing progress in the update.", "bug", ["bug"]) }),
    post("f108", "refund", 30, "A player", "Save disappeared. Not starting over.", { refundReason: "Gameplay or technical issue", ...tri("Refunded: save disappeared.", "bug", ["bug"]) }),
    post("r109", "review", 5, "Quillfeather", "Forty hours in and I still find new ways to route the mountain pass. The soundtrack alone is worth the price. The workshop menu sometimes ignores my controller until I press Start twice, which is the only reason this is not a perfect score.", { votedUp: true, playtime: 41, ...tri("Loves routing and the soundtrack; controller is sometimes ignored in the workshop menu.", "praise", ["praise", "bug"]) }),
    post("r110", "review", 16, "tin_lantern", "Relaxing, pretty, and it runs great on my old laptop. Would love an endless mode once the campaign is done.", { votedUp: true, playtime: 9, ...tri("Relaxing and runs well; asks for an endless mode.", "suggestion", ["praise", "suggestion"]) }),
    post("r111", "review", 22, "Oddment", "Good. Trains go choo.", { votedUp: true, playtime: 3, ...tri("Short positive review.", "praise", ["praise"]) }),
    post("t112", "topic", 28, "railyard_remy", "The campaign took me about 14 hours and now I mostly rebuild old maps. An endless or sandbox mode with random terrain would keep me playing for months. Even a simple seed input would do.", { title: "Suggestion: endless mode with random maps", ...tri("Asks for an endless or sandbox mode with random terrain and a seed input.", "suggestion", ["suggestion"]) }),
    post("c113", "reply", 26, "tin_lantern", "Yes please. +1", { topic: "t112", ...tri("Agrees.", "suggestion", ["suggestion"]) }),
    post("c114", "reply", 25, "Quillfeather", "I'd pay for this as DLC honestly.", { topic: "t112", ...tri("Would pay for endless mode as DLC.", "suggestion", ["suggestion"]) }),
    post("yv115", "video", 7, "Lowland Plays", "", { title: "Ember Line 1.4: the good, the bad and the missing saves", media: "yt115", ...tri("A fair 18 minute look at 1.4. Praises the new signal tools and the winter map, then spends four minutes on the save bug and shows the rename workaround. Ends by recommending the game 'once the patch lands'.", "bug", ["praise", "bug"]) }),
    post("yc116", "comment", 6, "viewer one", "Thanks for the rename tip, got my save back.", { media: "yt115", videoTitle: "Ember Line 1.4: the good, the bad and the missing saves", ...tri("Workaround worked.", "praise") }),
    post("yc117", "comment", 6, "viewer two", "Glad I waited to update.", { media: "yt115", ...tri("Waiting to update.", "question") }),
    post("yc118", "comment", 5, "viewer three", "This game looks so calm. Buying it tonight.", { media: "yt115", ...tri("Plans to buy.", "praise") }),
    post("yc119", "comment", 5, "viewer four", "Lost 20 hours to this bug. Not happy.", { media: "yt115", ...tri("Lost 20 hours to the save bug.", "bug", ["bug"]) }),
    post("yc120", "comment", 4, "viewer five", "The winter map is gorgeous.", { media: "yt115", ...tri("Likes the winter map.", "praise") }),
    post("yv121", "video", 50, "Cab Ride Carla", "", { title: "I built the longest bridge in Ember Line", media: "yt121", ...tri("A relaxed challenge video: one bridge across the whole lake map. No complaints; calls the building 'the best feeling in the genre'.", "praise", ["praise"]) }),
    post("yc122", "comment", 48, "viewer six", "That bridge is ridiculous, love it.", { media: "yt121", ...tri("Enjoyed it.", "praise") }),
    post("yc123", "comment", 47, "viewer seven", "What's the song at 6:20?", { media: "yt121", ...tri("Asks about the music.", "question") }),
    post("r124", "review", 70, "Ferrule", "Text is tiny on Steam Deck. Otherwise great.", { votedUp: true, playtime: 6, ...tri("Text too small on Steam Deck.", "bug", ["bug"]) }),
    post("r125", "review", 100, "Halfpenny", "Lovely little game. Controller support in menus needs work.", { votedUp: true, playtime: 15, devResponse: { text: "Thanks! Menu fixes are coming." }, ...tri("Controller support in menus needs work.", "bug", ["bug", "praise"]) }),
    post("r126", "review", 130, "Greywether", "Too short for the price in my opinion. What is there is polished.", { votedUp: false, playtime: 7, devResponse: { text: "Thanks for the honest take. More maps are on the way." }, ...tri("Too short for the price.", "suggestion", ["suggestion"]) }),
  ];
  const tideItems = [
    post("r201", "review", 40, "Saltmarsh", "Still my comfort game a year later. The tide cycle never gets old.", { votedUp: true, playtime: 88, ...tri("Long-time player; still loves the tide cycle.", "praise", ["praise"]) }),
    post("t202", "topic", 90, "kelp_and_co", "Is there any plan for more islands? I've finished all twelve.", { title: "More islands?", ...tri("Asks whether more islands are planned.", "suggestion", ["suggestion"]) }),
    post("r203", "review", 200, "Barnacle Bo", "Crashed once when I alt-tabbed during a storm. Otherwise flawless.", { votedUp: true, playtime: 20, ...tri("One crash when alt-tabbing during a storm.", "bug", ["bug"]) }),
  ];
  const paperItems = [
    post("t301", "topic", 8, "inkwell_ida", "The trailer looks wonderful. Will there be a demo before release? I'd like to check it runs on my Deck before I wishlist blindly.", { title: "Demo before launch?", ...tri("Asks for a demo before launch, mainly to check Steam Deck performance.", "question", ["suggestion"]) }),
    post("c302", "reply", 7, "paper_crane_9", "Also hoping for a demo in the next fest.", { topic: "t301", ...tri("Hopes for a Next Fest demo.", "suggestion", ["suggestion"]) }),
    post("yv303", "video", 19, "Tiny Game Radar", "", { title: "10 cosy games to wishlist this winter", media: "yt303", ...tri("Paper Harbor is number 4 of 10, about 50 seconds. Shows the folding animation from the trailer and calls it 'the one to watch'.", "praise", ["praise"]) }),
    post("yc304", "comment", 18, "viewer eight", "Paper Harbor looks amazing, wishlisted.", { media: "yt303", ...tri("Wishlisted.", "praise") }),
    post("yc305", "comment", 17, "viewer nine", "Number 4 is the one for me.", { media: "yt303", ...tri("Likes it.", "praise") }),
  ];
  // A tail of older short reviews so the 7 and 30 day views have something to count.
  const names = ["Wren", "Tollgate", "Marlow", "Sixpence", "Dovetail", "Hobnail", "Larkspur", "Cinder", "Postbox", "Thimble"];
  const lines = ["Great fun.", "Exactly what I wanted after work.", "Charming and polished.", "A bit short, but sweet.", "Runs perfectly on Deck.", "My kid and I play it together."];
  for (let i = 0; i < 46; i++) {
    const list = i % 4 === 3 ? tideItems : emberItems, up = rnd() > 0.12;
    list.push(post(`r9${i}`, "review", 30 + rnd() * 700, names[i % names.length] + (i + 3), up ? lines[i % lines.length] : "Not for me.", { votedUp: up, playtime: Math.round(1 + rnd() * 30), devResponse: up ? undefined : { text: "Thanks for trying it." }, ...tri(up ? "Short positive review." : "Short negative review.", up ? "praise" : "other") }));
  }
  const byId = (list) => Object.fromEntries(list.map((i) => [i.id, i]));
  const issue = (id, kind, title, urgency, mentions, items, extra = {}) => ({ id, kind, title, urgency, status: "open", mentions, priority: mentions * ({ urgent: 4, high: 3, medium: 2, low: 1 }[urgency] || 1), items, firstSeen: hrs(40), lastSeen: hrs(3), ...extra });

  const players = (base, dip = 1) => { const out = []; for (let t = now - 30 * DAY; t <= now; t += 3600) { const hour = new Date(t * 1000).getUTCHours(), wave = 0.55 + 0.45 * Math.sin(((hour - 14) / 24) * 2 * Math.PI); out.push([t, Math.max(1, Math.round(base * wave * (0.85 + rnd() * 0.3) * (t > now - 2 * DAY ? dip : 1)))]); } return out; };
  const totals = (start, perDay, posRate) => { const out = {}; let p = Math.round(start * posRate), n = start - p; for (let d = 30; d >= 0; d--) { const add = Math.round(perDay * (0.5 + rnd())); const neg = d < 2 ? Math.min(add, 2) : Math.round(add * (1 - posRate)); p += add - neg; n += neg; out[iso(now - d * DAY)] = { positive: p, negative: n }; } return out; };
  const release = (gid, name, h, up, down) => ({ gid, name, time: hrs(h), url: "#", votesUp: up, votesDown: down, comments: Math.round(up / 6) });

  const games = {
    [A]: {
      items: byId(emberItems),
      issues: byId([
        issue("i1", "bug", "Saves are not found after the 1.4 update", "urgent", 14, ["r101", "r102", "t103", "c104", "c105", "c106", "f107", "f108", "yc119"], { refunds: 2, negativeReviews: 2, firstSeen: hrs(30) }),
        issue("i2", "bug", "Controller is ignored in the workshop menu", "high", 9, ["r109", "r125"], { status: "still_happening", firstSeen: hrs(900), lastSeen: hrs(5), fixedIn: "1.3" }),
        issue("i3", "bug", "Text is too small on Steam Deck", "medium", 5, ["r124"], { firstSeen: hrs(400), lastSeen: hrs(70) }),
        issue("i4", "suggestion", "Endless mode with random maps", "medium", 11, ["t112", "c113", "c114", "r110"], { lastSeen: hrs(16) }),
        issue("i5", "suggestion", "More maps for the price", "low", 4, ["r126"], { lastSeen: hrs(130) }),
        issue("i6", "praise", "The soundtrack", "low", 23, ["r109"], { lastSeen: hrs(5) }),
        issue("i7", "praise", "Building track feels great", "low", 31, ["yv121", "r110"], { lastSeen: hrs(16) }),
      ]),
      players: players(210, 0.8), reviewTotals: totals(612, 3, 0.9),
      releases: [release("u3", "1.4: Signals and snow", 32, 96, 21), release("u2", "1.3: Workshop menu fixes", 30 * 24, 140, 4), release("u1", "1.2: The lake map", 75 * 24, 201, 6)],
      achievements: { list: [{ name: "First departure", desc: "Run your first train", percent: 93.1 }, { name: "Over the pass", desc: "Finish chapter 2", percent: 61.4 }, { name: "Timetabled", desc: "Finish the campaign", percent: 27.8 }, { name: "Not a single delay", desc: "Finish a map with no late trains", percent: 4.2 }] },
      curators: { list: [{ name: "Cosy Corner", followers: 48200, state: "recommended", blurb: "A gentle, generous train builder." }, { name: "Deck Verified-ish", followers: 12900, state: "informative", blurb: "Plays well on Deck; small text." }] },
      bundles: { list: [{ name: "Slow Sunday Bundle", bundleDiscount: 15, apps: 2 }] },
      competitors: { 1: { name: "Rail Garden", peak: 540, score: 91, lastUpdate: hrs(9 * 24) }, 2: { name: "Little Junction", peak: 130, score: 84, lastUpdate: hrs(60 * 24) } },
      media: { items: {
        yt115: { id: "yt115", source: "youtube", title: "Ember Line 1.4: the good, the bad and the missing saves", author: "Lowland Plays", views: 48200, at: hrs(7), url: "#", duration: "18:04", review: { verdict: "mixed" } },
        yt121: { id: "yt121", source: "youtube", title: "I built the longest bridge in Ember Line", author: "Cab Ride Carla", views: 9100, at: hrs(50), url: "#", duration: "24:31", review: { verdict: "positive" } },
        tw130: { id: "tw130", source: "twitch", title: "cosy trains and tea ☕ first playthrough", author: "hazelstreams", views: 310, at: hrs(2), url: "#", live: true },
        nw131: { id: "nw131", source: "news", title: "Ember Line's winter update adds signals, snow and one nasty bug", author: "Indie Dispatch", at: hrs(26), url: "#", review: { verdict: "mixed", summary: "A short news piece on 1.4. Positive about the content, mentions the save reports in the last paragraph." } },
      } },
    },
    [B]: {
      items: byId(tideItems),
      issues: byId([
        issue("i21", "bug", "Crash when alt-tabbing during a storm", "low", 2, ["r203"], { firstSeen: hrs(200), lastSeen: hrs(200) }),
        issue("i22", "suggestion", "More islands", "medium", 8, ["t202"], { lastSeen: hrs(90) }),
        issue("i23", "praise", "The tide cycle", "low", 40, ["r201"], { lastSeen: hrs(40) }),
      ]),
      players: players(46), reviewTotals: totals(1480, 1, 0.94),
      releases: [release("u21", "2.1: Lighthouse keeper's log", 50 * 24, 88, 2)],
      achievements: { list: [{ name: "Low tide", desc: "Reach the first island", percent: 96.0 }, { name: "All twelve", desc: "Visit every island", percent: 18.5 }] },
      curators: { list: [{ name: "Cosy Corner", followers: 48200, state: "recommended", blurb: "Still the best tide in games." }] },
      bundles: { list: [{ name: "Slow Sunday Bundle", bundleDiscount: 15, apps: 2 }] },
      competitors: { 3: { name: "Driftline", peak: 75, score: 88, lastUpdate: hrs(120 * 24) } },
      media: { items: {} },
    },
    [C]: {
      items: byId(paperItems),
      issues: byId([issue("i31", "suggestion", "A demo before launch", "medium", 3, ["t301", "c302"], { lastSeen: hrs(7) })]),
      players: [], reviewTotals: {}, releases: [], achievements: { list: [] }, curators: { list: [] }, bundles: { list: [] }, competitors: {},
      media: { items: { yt303: { id: "yt303", source: "youtube", title: "10 cosy games to wishlist this winter", author: "Tiny Game Radar", views: 132000, at: hrs(19), url: "#", duration: "12:47", review: { verdict: "positive" } } } },
    },
  };

  const sales = { days: {} }, wishlists = { apps: { [A]: { days: {} }, [B]: { days: {} }, [C]: { days: {} } } };
  for (let d = 400; d >= 0; d--) {
    const day = iso(now - d * DAY), wk = [0, 6].includes(new Date((now - d * DAY) * 1000).getUTCDay()) ? 1.35 : 1;
    const ua = Math.round((d > 150 ? 0 : 34 + (d < 2 ? 14 : 0)) * wk * (0.7 + rnd() * 0.6) * (d === 0 ? 0.4 : 1)), ub = Math.round(9 * wk * (0.6 + rnd() * 0.8) * (d === 0 ? 0.4 : 1));
    sales.days[day] = { [A]: { units: ua, gross: Math.round(ua * 11.6 * 100) / 100, net: Math.round(ua * 7.4 * 100) / 100 }, [B]: { units: ub, gross: Math.round(ub * 8.9 * 100) / 100, net: Math.round(ub * 5.7 * 100) / 100 } };
    const w = (base, spike = 0) => { const adds = Math.round((base + (d < 1 ? spike : 0)) * wk * (0.7 + rnd() * 0.6)); return { adds, deletes: Math.round(adds * 0.12), purchases: Math.round(adds * 0.2), gifts: 0 }; };
    wishlists.apps[A].days[day] = w(52); wishlists.apps[B].days[day] = w(11);
    wishlists.apps[C].days[day] = { ...w(38, 190), purchases: 0 };
  }
  const playtime = (median, reach) => ({ pages: { playtime: [{ rows: [["Median time played", median], ...reach.map(([l, p]) => [l, `${p}%`])] }] } });
  const steamworks = { apps: {
    [A]: playtime("3 hours 40 minutes", [["10 minutes", 94], ["30 minutes", 86], ["1 hour 0 minutes", 74], ["2 hours 0 minutes", 61], ["5 hours 0 minutes", 38], ["10 hours 0 minutes", 21], ["20 hours 0 minutes", 9]]),
    [B]: playtime("5 hours 10 minutes", [["10 minutes", 96], ["30 minutes", 90], ["1 hour 0 minutes", 81], ["2 hours 0 minutes", 70], ["5 hours 0 minutes", 51], ["10 hours 0 minutes", 30], ["20 hours 0 minutes", 14]]),
  } };

  window.SAMPLE = { index, games, sales, wishlists, steamworks };
})();
