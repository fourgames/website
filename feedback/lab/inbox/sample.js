// Invented sample data in the shape of feedback-data (index.json, games/<appid>.json, sales.json,
// wishlists.json, steamworks.json). Every player name, post and number here is made up. Times are
// relative to now so the page always looks fresh. Used when feedback/data is not on this machine.
(() => {
  const now = Math.floor(Date.now() / 1000), H = 3600, DAY = 86400;
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  // A repeatable pseudo-random series, so numbers don't jump on reload.
  const rnd = (seed) => () => (seed = (seed * 9301 + 49297) % 233280) / 233280;

  const post = (id, kind, hoursAgo, author, text, more = {}) => ({
    id, kind, created: now - hoursAgo * H, updated: now - hoursAgo * H, author: author ? { name: author } : {}, text,
    url: "https://store.steampowered.com/", ...more,
  });
  const tri = (category, summary, points = [category]) => ({ category, summary, language: "English", points: points.map((kind) => ({ kind })) });

  function series(seed, base, swing, n = 60) {
    const r = rnd(seed);
    return Array.from({ length: n }, (_, i) => Math.max(0, Math.round(base + Math.sin(i / 3) * swing * 0.5 + (r() - 0.5) * swing + (i % 7 > 4 ? swing * 0.6 : 0))));
  }
  function players(seed, base) {
    const r = rnd(seed), out = [];
    for (let h = 30 * 24; h >= 0; h -= 2) out.push([now - h * H, Math.max(0, Math.round(base + Math.sin(h / 4) * base * 0.35 + (r() - 0.5) * base * 0.4))]);
    return out;
  }
  function reviewTotals(pos, neg, perDay) {
    const out = {};
    for (let d = 40; d >= 0; d--) out[iso(now - d * DAY)] = { positive: pos - d * perDay, negative: neg - Math.floor(d * perDay / 6) };
    return out;
  }

  // ---- Reforge Front: live, busy --------------------------------------------------------------
  const RF = 2807130;
  const rfItems = [
    post("r101", "review", 5, "mossy_kettle", "Loved the first ten hours but since the last patch my save won't load on Steam Deck. It sits on the loading screen forever. Refunding if this isn't fixed.", { votedUp: false, playtime: 11.4, triage: tri("bug", "Save won't load on Steam Deck since the last patch; stuck on the loading screen."), draft: "Sorry about that! We found the cause: saves made before 1.4 don't load on Deck. A fix is in testing and ships this week. Your save is safe." }),
    post("r102", "review", 20, "tin_lantern", "Crashes every time wave 30 starts. Three runs lost now.", { votedUp: false, playtime: 6.2, triage: tri("bug", "Crash when wave 30 starts; lost three runs.") }),
    post("r103", "review", 30, "quiet.harbor", "The furnace upgrade tree is the best part. Wish there was a way to queue upgrades though.", { votedUp: true, playtime: 24.0, triage: tri("suggestion", "Loves the furnace upgrade tree; wants to queue upgrades.", ["praise", "suggestion"]) }),
    post("r104", "review", 50, "bramble_fox", "Great tower defense with real shooting. Co-op when?", { votedUp: true, playtime: 8.1, triage: tri("suggestion", "Enjoys it; asks for co-op.", ["praise", "suggestion"]) }),
    post("r105", "review", 9, "saltpeter", "Too hard after wave 20 on normal, feels like the goblins double in health. Stopped having fun.", { votedUp: false, playtime: 4.5, triage: tri("suggestion", "Difficulty spike after wave 20 on normal."), draft: "Thanks for telling us. Wave 20 to 25 is steeper than we meant; the next update smooths the health curve on Normal." }),
    post("r106", "review", 70, "old_copper", "Runs great, looks great, sounds great.", { votedUp: true, playtime: 15.0, triage: tri("praise", "Praises performance, look and sound.") }),
    post("r107", "review", 100, "nettle", "Got stuck on the loading screen on my Deck too.", { votedUp: false, playtime: 2.0, devResponse: "Fix on the way.", triage: tri("bug", "Stuck on the loading screen on Steam Deck.") }),
    post("t201", "topic", 3, "glass_owl", "Is anyone else losing ammo crates when a wave ends? I had six, wave ended, zero.", { title: "Ammo crates vanish between waves", triage: tri("bug", "Ammo crates disappear when a wave ends.") }),
    post("c202", "reply", 2, "tin_lantern", "Yes, same. Happens when the crate is on the furnace platform.", { topic: "t201", triage: tri("bug", "Confirms: happens when the crate sits on the furnace platform.") }),
    post("c203", "reply", 1, "juniper_road", "Same here on 1.4.2.", { topic: "t201", triage: tri("bug", "Also sees it on 1.4.2.") }),
    post("t204", "topic", 26, "birch_signal", "A key to rotate turrets before placing them would save so much time.", { title: "Suggestion: rotate turrets before placing", triage: tri("suggestion", "Wants a key to rotate turrets before placing.") }),
    post("c205", "reply", 22, "bramble_fox", "+1, and let us pick a default facing.", { topic: "t204", triage: tri("suggestion", "Agrees; wants a default facing too.") }),
    post("t206", "topic", 60, "marrow", "How do I unlock the third furnace tier?", { title: "Third furnace tier?", devResponse: "Beat wave 15 on any map.", triage: tri("question", "Asks how to unlock the third furnace tier.") }),
    post("rf301", "refund", 14, null, "Does not start on my Deck after the update.", { refundReason: "Game would not start", triage: tri("bug", "Refunded: does not start on Steam Deck after the update.") }),
    post("rf302", "refund", 40, null, "Too difficult for me.", { refundReason: "Too difficult", triage: tri("suggestion", "Refunded: too difficult.") }),
    post("yv401", "video", 8, "Pixel Anvil", "- Praise at 2:10: the shooting feels punchy\n- Bug at 9:40: a crate vanished between waves\n- Suggestion at 14:05: wants co-op", { title: "This FPS tower defense is better than it has any right to be", media: "yt401", triage: tri("praise", "Positive first look: punchy shooting; saw the vanishing crate; wants co-op.", ["praise", "bug", "suggestion"]) }),
    post("yc402", "comment", 7, "viewer one", "Bought it because of this video. The crate bug got me too.", { media: "yt401", videoTitle: "This FPS tower defense is better than it has any right to be", triage: tri("bug", "Bought it after the video; hit the crate bug.") }),
    post("yc403", "comment", 6, "viewer two", "Needs co-op badly.", { media: "yt401", triage: tri("suggestion", "Wants co-op.") }),
    post("yc404", "comment", 6, "viewer three", "Looks fun, wishlisted.", { media: "yt401", triage: tri("praise", "Wishlisted.") }),
    post("yv405", "video", 52, "Nordic Indie Hour", "- Praise at 1:00: furnace upgrades are satisfying\n- Suggestion at 6:30: difficulty jumps at wave 20", { title: "Reforge Front: 20 waves in", media: "yt405", triage: tri("suggestion", "Likes the upgrades; says difficulty jumps at wave 20.", ["praise", "suggestion"]) }),
    post("yc406", "comment", 50, "viewer four", "Wave 20 wall is real.", { media: "yt405", triage: tri("suggestion", "Agrees about the wave 20 spike.") }),
  ];
  const rfIssues = [
    { id: "b1", kind: "bug", title: "Saves don't load on Steam Deck since 1.4", summary: "Saves made before 1.4 hang on the loading screen on Steam Deck.", mentions: 14, urgency: "urgent", priority: 96, status: "still_happening", firstSeen: now - 9 * DAY, lastSeen: now - 5 * H, refunds: 1, negativeReviews: 2, items: ["r101", "r107", "rf301"], fixPrompt: "Saves written before 1.4 fail to load on Steam Deck (hang on loading screen). Find the save migration for 1.4 and check the path and file-handle code under Proton." },
    { id: "b2", kind: "bug", title: "Crash when wave 30 starts", summary: "The game closes when wave 30 begins.", mentions: 6, urgency: "high", priority: 80, status: "open", firstSeen: now - 4 * DAY, lastSeen: now - 20 * H, refunds: 0, negativeReviews: 1, items: ["r102"], fixPrompt: "Crash at the start of wave 30. Check the spawner for the wave 30 boss and its pooled projectiles." },
    { id: "b3", kind: "bug", title: "Ammo crates vanish when a wave ends", summary: "Crates on the furnace platform are removed with the wave cleanup.", mentions: 5, urgency: "medium", priority: 62, status: "open", firstSeen: now - 2 * DAY, lastSeen: now - 1 * H, refunds: 0, negativeReviews: 0, items: ["t201", "c202", "c203", "yc402", "yv401"], fixPrompt: "Ammo crates on the furnace platform are deleted by the end-of-wave cleanup. Exclude player-owned crates from that cleanup." },
    { id: "b4", kind: "bug", title: "Music stops after alt-tab", summary: "Music doesn't resume after switching windows.", mentions: 2, urgency: "low", priority: 20, status: "open", firstSeen: now - 12 * DAY, lastSeen: now - 6 * DAY, refunds: 0, negativeReviews: 0, items: [] },
    { id: "s1", kind: "suggestion", title: "Co-op", summary: "Players and creators ask for two-player co-op.", mentions: 21, urgency: "medium", priority: 70, status: "open", firstSeen: now - 30 * DAY, lastSeen: now - 6 * H, items: ["r104", "yc403", "yv401"] },
    { id: "s2", kind: "suggestion", title: "Smoother difficulty after wave 20", summary: "Normal gets much harder at wave 20.", mentions: 9, urgency: "medium", priority: 58, status: "open", firstSeen: now - 14 * DAY, lastSeen: now - 9 * H, refunds: 1, items: ["r105", "rf302", "yv405", "yc406"] },
    { id: "s3", kind: "suggestion", title: "Rotate turrets before placing", summary: "A key to rotate, and a default facing.", mentions: 4, urgency: "low", priority: 35, status: "open", firstSeen: now - 3 * DAY, lastSeen: now - 22 * H, items: ["t204", "c205"] },
    { id: "s4", kind: "suggestion", title: "Queue furnace upgrades", summary: "Let upgrades be queued.", mentions: 3, urgency: "low", priority: 30, status: "open", firstSeen: now - 5 * DAY, lastSeen: now - 30 * H, items: ["r103"] },
    { id: "p1", kind: "praise", title: "The furnace upgrade tree", summary: "The most praised part of the game.", mentions: 18, status: "open", lastSeen: now - 30 * H, items: ["r103", "yv405"] },
    { id: "p2", kind: "praise", title: "Shooting feels punchy", summary: "Gunplay gets called out in reviews and videos.", mentions: 12, status: "open", lastSeen: now - 8 * H, items: ["r104", "yv401"] },
    { id: "p3", kind: "praise", title: "Runs well, looks good", summary: "Performance and art.", mentions: 7, status: "open", lastSeen: now - 70 * H, items: ["r106"] },
  ];
  const rfMedia = {
    yt401: { id: "yt401", source: "youtube", title: "This FPS tower defense is better than it has any right to be", author: "Pixel Anvil", url: "https://www.youtube.com/", at: now - 8 * H, views: 48200, comments: 131, review: { verdict: "positive" } },
    yt405: { id: "yt405", source: "youtube", title: "Reforge Front: 20 waves in", author: "Nordic Indie Hour", url: "https://www.youtube.com/", at: now - 52 * H, views: 6100, comments: 22, review: { verdict: "mixed" } },
    tw410: { id: "tw410", source: "twitch", title: "first time Reforge Front, hardest difficulty", author: "kettlestream", url: "https://www.twitch.tv/", at: now - 28 * H, views: 340 },
    nw411: { id: "nw411", source: "news", title: "Ten small tower defense games worth your weekend", author: "Indie Ledger", url: "https://example.com/", at: now - 4 * DAY },
  };

  // ---- Pomo Valley: live, quiet ---------------------------------------------------------------
  const PV = 3100010;
  const pvItems = [
    post("r501", "review", 16, "linen_cloud", "Sits on my second monitor all day. The break timer chime is too loud and there's no slider for it.", { votedUp: true, playtime: 61.0, triage: tri("suggestion", "Uses it all day; wants a volume slider for the break chime.", ["praise", "suggestion"]) }),
    post("r502", "review", 44, "half_moon", "Timer drifted by almost a minute over a long session.", { votedUp: false, playtime: 3.3, triage: tri("bug", "Timer drifts by about a minute over a long session.") }),
    post("r503", "review", 90, "ferncastle", "Cozy and it actually makes me work.", { votedUp: true, playtime: 40.2, triage: tri("praise", "Cozy; helps them focus.") }),
    post("t504", "topic", 12, "paper_kite", "Could the valley keep growing while the game is minimised? Right now the crops pause.", { title: "Crops pause when minimised", triage: tri("bug", "Crops stop growing while the window is minimised.") }),
    post("yv505", "video", 30, "Slow Desk", "- Praise at 0:40: the art\n- Suggestion at 5:10: more seasons", { title: "A pomodoro timer that grows a farm", media: "yt505", triage: tri("praise", "Positive: likes the art; wants more seasons.", ["praise", "suggestion"]) }),
    post("yc506", "comment", 29, "viewer five", "Does it work on Mac?", { media: "yt505", triage: tri("question", "Asks about Mac.") }),
  ];
  const pvIssues = [
    { id: "b1", kind: "bug", title: "Crops pause when the window is minimised", summary: "Growth stops while minimised.", mentions: 4, urgency: "high", priority: 74, status: "open", firstSeen: now - 6 * DAY, lastSeen: now - 12 * H, negativeReviews: 0, refunds: 0, items: ["t504"], fixPrompt: "Crop growth is tied to the render loop, so it pauses when minimised. Drive it from wall-clock time instead." },
    { id: "b2", kind: "bug", title: "Timer drifts on long sessions", summary: "About a minute off after several hours.", mentions: 3, urgency: "medium", priority: 55, status: "open", firstSeen: now - 10 * DAY, lastSeen: now - 44 * H, negativeReviews: 1, refunds: 0, items: ["r502"], fixPrompt: "The timer accumulates frame deltas and drifts. Compute remaining time from a start timestamp." },
    { id: "s1", kind: "suggestion", title: "Volume slider for the break chime", summary: "The chime is loud and can't be turned down.", mentions: 6, urgency: "medium", priority: 50, status: "open", firstSeen: now - 20 * DAY, lastSeen: now - 16 * H, items: ["r501"] },
    { id: "s2", kind: "suggestion", title: "More seasons", summary: "Asked for in reviews and a video.", mentions: 5, urgency: "low", priority: 32, status: "open", firstSeen: now - 25 * DAY, lastSeen: now - 30 * H, items: ["yv505"] },
    { id: "p1", kind: "praise", title: "Cozy art", summary: "The look of the valley.", mentions: 15, status: "open", lastSeen: now - 30 * H, items: ["r503", "yv505"] },
    { id: "p2", kind: "praise", title: "It helps people focus", summary: "Players say they get more done.", mentions: 9, status: "open", lastSeen: now - 16 * H, items: ["r501", "r503"] },
  ];
  const pvMedia = {
    yt505: { id: "yt505", source: "youtube", title: "A pomodoro timer that grows a farm", author: "Slow Desk", url: "https://www.youtube.com/", at: now - 30 * H, views: 12900, comments: 40, review: { verdict: "positive" } },
  };

  // ---- Lantern Road (an invented game): not out yet ------------------------------------------------------------------
  const DS = 3400020;
  const dsItems = [
    post("t601", "topic", 18, "rust_and_rain", "The demo ends right when it gets good. Will there be controller support at launch?", { title: "Demo feedback + controller support?", triage: tri("question", "Liked the demo; asks about controller support at launch.") }),
    post("yv602", "video", 4, "Late Shift Gaming", "- Praise at 3:00: the driving\n- Bug at 11:20: parcels fall through the van floor", { title: "Lantern Road demo: night deliveries and one stubborn gate", media: "yt602", triage: tri("bug", "Enjoyed the demo's driving; parcels fall through the van floor.", ["praise", "bug"]) }),
    post("yc603", "comment", 3, "viewer six", "The parcel thing happened to me as well lol", { media: "yt602", triage: tri("bug", "Also lost parcels through the van floor.") }),
  ];
  const dsIssues = [
    { id: "b1", kind: "bug", title: "Parcels fall through the van floor (demo)", summary: "Seen in a video and a comment.", mentions: 2, urgency: "medium", priority: 52, status: "open", firstSeen: now - 4 * H, lastSeen: now - 3 * H, items: ["yv602", "yc603"], fixPrompt: "Parcels fall through the van floor in the demo. Check the cargo area's collision shape and the parcels' physics layer." },
    { id: "s1", kind: "suggestion", title: "Controller support", summary: "Asked for before launch.", mentions: 3, urgency: "medium", priority: 48, status: "open", firstSeen: now - 8 * DAY, lastSeen: now - 18 * H, items: ["t601"] },
    { id: "p1", kind: "praise", title: "The driving", summary: "Cars feel good.", mentions: 4, status: "open", lastSeen: now - 4 * H, items: ["yv602"] },
  ];
  const dsMedia = {
    yt602: { id: "yt602", source: "youtube", title: "Lantern Road demo: night deliveries and one stubborn gate", author: "Late Shift Gaming", url: "https://www.youtube.com/", at: now - 4 * H, views: 2300, comments: 9, review: { verdict: "positive" } },
  };

  const keyed = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const game = (items, issues, media, more) => ({ items: keyed(items), issues: keyed(issues), media: { items: media }, ...more });
  const games = {
    [RF]: game(rfItems, rfIssues, rfMedia, {
      players: players(7, 120), reviewTotals: reviewTotals(1184, 141, 4),
      releases: [{ time: now - 6 * DAY, name: "Patch 1.4.2", version: "1.4.2", url: "#" }, { time: now - 10 * DAY, name: "The Furnace Update", version: "1.4", url: "#" }, { time: now - 41 * DAY, name: "Patch 1.3.1", version: "1.3.1", url: "#" }],
      achievements: { list: [{ name: "First spark", percent: 91.2 }, { name: "Wave 10", percent: 58.4 }, { name: "Wave 20", percent: 24.9 }, { name: "Wave 30", percent: 6.1 }, { name: "Master smith", percent: 2.3 }] },
      curators: { list: [{ name: "Tower Defense Digest", followers: 41000, state: "recommended" }, { name: "Small Studio Picks", followers: 9800, state: "recommended" }, { name: "Hard Mode Only", followers: 3100, state: "informative" }] },
      bundles: { list: [{ name: "Forge & Farm", apps: 2, bundleDiscount: 15 }] },
      competitors: { 900001: { name: "Gate Keepers", peaks: {}, reviews: {} }, 900002: { name: "Bastion Line", peaks: {}, reviews: {} } },
    }),
    [PV]: game(pvItems, pvIssues, pvMedia, {
      players: players(11, 45), reviewTotals: reviewTotals(402, 23, 1),
      releases: [{ time: now - 19 * DAY, name: "Autumn in the valley", version: "1.2", url: "#" }],
      achievements: { list: [{ name: "First pomodoro", percent: 96.0 }, { name: "A full day", percent: 41.5 }, { name: "Hundred harvests", percent: 12.8 }] },
      curators: { list: [{ name: "Cozy Corner", followers: 22000, state: "recommended" }] },
      bundles: { list: [{ name: "Forge & Farm", apps: 2, bundleDiscount: 15 }] },
      competitors: { 900003: { name: "Focus Meadow", peaks: {}, reviews: {} } },
    }),
    [DS]: game(dsItems, dsIssues, dsMedia, { players: [], reviewTotals: {}, releases: [], achievements: { list: [] }, curators: { list: [] }, bundles: { list: [] }, competitors: {} }),
  };

  const days = Array.from({ length: 60 }, (_, i) => iso(now - (59 - i) * DAY));
  const rfRev = series(3, 310, 180), pvRev = series(5, 90, 60);
  const sales = { days: Object.fromEntries(days.map((d, i) => [d, {
    [RF]: { gross: rfRev[i], net: Math.round(rfRev[i] * 0.62), units: Math.round(rfRev[i] / 13), refunds: i % 9 === 0 ? 1 : 0 },
    [PV]: { gross: pvRev[i], net: Math.round(pvRev[i] * 0.62), units: Math.round(pvRev[i] / 6), refunds: 0 },
  }])) };
  const wl = (seed, base) => { const a = series(seed, base, base * 0.8); return { days: Object.fromEntries(days.map((d, i) => [d, { adds: a[i], deletes: Math.round(a[i] * 0.15), purchases: Math.round(a[i] * 0.2), gifts: 0 }])) }; };
  const wishlists = { apps: { [RF]: wl(13, 40), [PV]: wl(17, 18), [DS]: wl(19, 95) } };
  const playtime = (median, reach) => ({ pages: { playtime: [{ rows: [["Median time played", median], ...reach] }] } });
  const steamworks = { apps: {
    [RF]: playtime("3 hours 12 minutes", [["10 minutes", "92%"], ["30 minutes", "81%"], ["1 hour", "68%"], ["2 hours", "55%"], ["5 hours", "31%"], ["10 hours", "14%"]]),
    [PV]: playtime("9 hours 40 minutes", [["10 minutes", "97%"], ["30 minutes", "90%"], ["1 hour", "84%"], ["2 hours", "76%"], ["5 hours", "61%"], ["10 hours", "48%"]]),
  } };

  window.SAMPLE = {
    index: { games: [
      { appId: RF, name: "Reforge Front", status: "released", hue: 18 },
      { appId: PV, name: "Pomo Valley", status: "released", hue: 140 },
      { appId: DS, name: "Lantern Road", status: "upcoming", hue: 262 },
    ] },
    games, sales, wishlists, steamworks,
  };
})();
