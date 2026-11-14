// Tests for video-impact.js. Run: node --test src/lib/feedback/video-impact.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, byViews, conversion, gmtDay, languageName, middleMean, pacificDay, tierOf, tookOff, videoImpact, weekdayFactors, youtubeVisits } from "./video-impact.js";

const at = (iso) => Date.parse(iso) / 1000;
const video = (id, iso, extra = {}) => ({ id, source: "youtube", at: at(iso), title: id, author: id, views: 1000, subscribers: 5000, ...extra });
// A steady game: 20 sold and 50 wishlisted a day from Sep 1 to Nov 10.
function steady(units = 20, adds = 50) {
  const sales = {}, wishlists = {};
  for (let d = "2026-09-01"; d <= "2026-11-10"; d = addDays(d, 1)) {
    sales[d] = { units, gross: units * 3 };
    wishlists[d] = { adds };
  }
  return { sales, wishlists };
}
const NOW = at("2026-11-20T12:00:00Z");
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("days are taken in each file's own time zone", () => {
  assert.equal(pacificDay(at("2026-11-06T02:00:00Z")), "2026-11-05");
  assert.equal(gmtDay(at("2026-11-06T02:00:00Z")), "2026-11-06");
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
});

test("extra over the usual of the 14 days before; real only above 2 × √expected", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-20"] = { units: 40, gross: 120 };
  sales["2026-10-21"] = { units: 30, gross: 90 };
  wishlists["2026-10-20"] = { adds: 70 }; // +20 over 150 expected: 2 × √150 ≈ 24.5, so chance
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW });
  assert.equal(r.day, "2026-10-20");
  close(r.units.expected, 60);
  assert.equal(r.units.after, 90);
  close(r.units.extra, 30);
  assert.equal(r.units.real, true);
  close(r.adds.extra, 20);
  assert.equal(r.adds.real, false);
  assert.equal(r.real, true);
  assert.deepEqual(r.flags, []);
  assert.equal(r.clean, true);
});

test("an earlier spike in the days before doesn't lift the usual", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-12"] = { units: 200, gross: 600 };
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW });
  close(r.units.expected, 60);
  assert.ok(middleMean([0, 1, 2, 100]) === 1.5);
});

test("weekdays: a game that sells double at weekends expects that from a weekend video", () => {
  const { sales, wishlists } = steady();
  for (const d of Object.keys(sales)) {
    const wd = new Date(d + "T00:00:00Z").getUTCDay();
    sales[d].units = wd === 0 || wd === 6 ? 40 : 20;
  }
  const f = weekdayFactors(sales, "units", "2026-10-24", (d) => d >= "2026-09-01");
  assert.ok(f[6] > 1.3 && f[2] < 0.9);
  // Oct 24 2026 is a Saturday: Sat + Sun + Mon at the usual weekend lift is no extra.
  const [r] = videoImpact({ videos: [video("a", "2026-10-24T17:00:00Z")], sales, wishlists, now: NOW });
  assert.ok(Math.abs(r.units.extra) < 10, `extra ${r.units.extra}`); // without weekdays it would be about +30
  assert.equal(r.units.real, false);
});

test("a falling launch curve is carried on, so the fall isn't read as a video doing nothing", () => {
  const sales = {}, wishlists = {};
  for (let i = 0; i < 40; i++) sales[addDays("2026-10-01", i)] = { units: Math.round(200 * 0.9 ** i), gross: 0 };
  const day = addDays("2026-10-01", 20);
  const [r] = videoImpact({ videos: [video("a", day + "T17:00:00Z")], sales, wishlists, now: NOW });
  assert.ok(r.units.falling > 0.4);
  // Truth: the curve's own next 3 days.
  const truth = [20, 21, 22].reduce((a, i) => a + 200 * 0.9 ** i, 0);
  assert.ok(Math.abs(r.units.expected - truth) / truth < 0.15, `${r.units.expected} vs ${truth}`);
});

test("wishlists turn into sales at the game's own rate", () => {
  const { sales, wishlists } = steady();
  assert.equal(conversion(wishlists), null);
  for (const d of Object.keys(wishlists)) wishlists[d].purchases = 5;
  close(conversion(wishlists), 0.1);
  wishlists["2026-10-20"].adds = 250; // +200, real
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW });
  assert.equal(r.adds.real, true);
  close(r.value, r.units.extra + conversion(wishlists) * r.adds.extra);
});

test("view history: a video that took off a week later is lined up with that day", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-27"].units = 80;
  const v = video("late", "2026-10-20T17:00:00Z", { viewsByDay: { "2026-10-21": 300, "2026-10-26": 600, "2026-10-27": 30600, "2026-10-28": 35000 } });
  assert.deepEqual(tookOff(v), { day: "2026-10-27", views: 30000 });
  const [r] = videoImpact({ videos: [v], sales, wishlists, now: NOW });
  assert.equal(r.day, "2026-10-27");
  assert.equal(r.units.real, true);
  assert.equal(r.viewsAfter, 34400);
  assert.match(r.flags[0].text, /Took off later/);
  assert.equal(r.clean, true);
  // A video whose biggest day is its first doesn't move.
  assert.equal(tookOff(video("now", "2026-10-20T17:00:00Z", { viewsByDay: { "2026-10-20": 5000, "2026-10-21": 6000 } })), null);
});

test("store visits from youtube.com are counted when the traffic page was read", () => {
  const entry = (n) => ({ cols: ["Source", "Impressions", "Visits", "Owner Visits"], rows: [["External Website", 900, 300, 1], ["youtube.com", 400, n, 0], ["www.youtube.com", 10, 2, 0]] });
  assert.equal(youtubeVisits(entry(50)), 52);
  assert.equal(youtubeVisits({ cols: ["Source", "Visits"], rows: [["YouTube (all)", 9]] }), 9);
  assert.equal(youtubeVisits({ missing: true, cols: [], rows: [] }), null);
  const { sales, wishlists } = steady();
  const traffic = {};
  for (let d = "2026-10-01"; d <= "2026-11-10"; d = addDays(d, 1)) traffic[d] = entry(10);
  traffic["2026-10-20"] = entry(120);
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, traffic, now: NOW });
  assert.equal(r.visits.real, true);
  close(r.visits.extra, 110);
  assert.equal(r.real, true);
  // Without traffic there is no visits column.
  assert.equal(videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW })[0].visits, null);
});

test("another big video in the same days is flagged, a tiny one isn't", () => {
  const { sales, wishlists } = steady();
  const videos = [video("a", "2026-10-20T17:00:00Z"), video("b", "2026-10-21T17:00:00Z", { views: 800 }), video("tiny", "2026-10-20T18:00:00Z", { views: 9 })];
  const rows = videoImpact({ videos, sales, wishlists, now: NOW });
  const a = rows.find((r) => r.video.id === "a"), tiny = rows.find((r) => r.video.id === "tiny");
  assert.deepEqual(a.flags.map((f) => f.kind), ["video"]);
  assert.match(a.flags[0].text, /same days: b/);
  assert.equal(a.clean, false);
  assert.equal(tiny.flags.filter((f) => f.kind === "video").length, 2);
});

test("launch day, launch week and before launch", () => {
  const { sales, wishlists } = steady();
  const events = [{ time: at("2026-09-01T17:00:00Z"), name: "Out now", launch: true }];
  const rows = videoImpact({ videos: [video("day", "2026-09-01T18:00:00Z"), video("week", "2026-09-04T18:00:00Z"), video("pre", "2026-08-28T18:00:00Z")], sales, wishlists, events, now: NOW });
  const get = (id) => rows.find((r) => r.video.id === id);
  assert.equal(get("day").units.extra, null);
  assert.match(get("day").flags[0].text, /Launch day/);
  assert.equal(get("week").units.beforeDays, 3);
  assert.equal(get("week").units.extra, null); // under 5 days before: no usual to compare with
  assert.match(get("week").flags[0].text, /Launch week/);
  assert.match(get("pre").flags[0].text, /Before launch/);
  assert.equal(get("pre").units.extra, null);
});

test("updates, the 10th review and sales in the window are listed", () => {
  const { sales, wishlists } = steady();
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22"]) sales[d].discount = 40;
  const events = [{ time: at("2026-10-15T17:00:00Z"), name: "Update 1.1" }, { time: at("2026-10-20T07:00:00Z"), name: "Update 1.2" }, { time: at("2026-10-22T07:00:00Z"), name: "Hotfix 1.2.1" },
    { time: at("2026-10-21T10:00:00Z"), name: "10 reviews", milestone: true }, { time: at("2026-11-05T10:00:00Z"), name: "Update 1.3" }];
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, events, now: NOW });
  assert.deepEqual(r.flags.map((f) => f.text), ["10 reviews reached around then (Steam shows the game more)", "2 updates came out around then (Update 1.2, Hotfix 1.2.1)", "On sale in the days after (40% off)"]);
  assert.equal(r.clean, false);
  const [u] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales: steady().sales, wishlists, events: events.slice(0, 2), now: NOW });
  assert.deepEqual(u.flags.map((f) => f.kind), ["update"]);
  assert.equal(u.clean, true);
});

test("a new video counts only the days that are over", () => {
  const { sales, wishlists } = steady();
  const now = at("2026-11-09T20:00:00Z"); // Nov 9 in California: Nov 8 is the last full day
  const [r] = videoImpact({ videos: [video("a", "2026-11-07T17:00:00Z")], sales, wishlists, now });
  assert.equal(r.units.afterDays, 2);
  close(r.units.extra, 0);
  assert.match(r.flags.at(-1).text, /Only 2 of 3 days/);
  assert.equal(r.clean, true);
  const [fresh] = videoImpact({ videos: [video("b", "2026-11-09T17:00:00Z")], sales, wishlists, now });
  assert.equal(fresh.units.extra, null);
  assert.match(fresh.flags.at(-1).text, /Too new/);
});

test("rows go biggest extra first; live streams and other sources are left out", () => {
  const { sales, wishlists } = steady();
  sales["2026-11-01"].units = 60;
  const videos = [video("small", "2026-10-15T17:00:00Z", { views: 100 }), video("hit", "2026-11-01T17:00:00Z", { views: 100 }),
    video("live", "2026-11-02T17:00:00Z", { live: true }), { ...video("tw", "2026-11-02T17:00:00Z"), source: "twitch" }];
  assert.deepEqual(videoImpact({ videos, sales, wishlists, now: NOW }).map((r) => r.video.id), ["hit", "small"]);
});

test("by video views: medians per video over clean videos, our own channel left out", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-20"].units = 60;
  sales["2026-09-18"].units = 50;
  const videos = [video("big", "2026-10-20T17:00:00Z", { subscribers: 1610000, views: 190000 }), video("big2", "2026-09-18T17:00:00Z", { views: 150000 }),
    video("mine", "2026-10-10T17:00:00Z", { own: true, views: 300 }), video("small", "2026-10-05T17:00:00Z", { subscribers: 2000, views: 100 })];
  const tiers = byViews(videoImpact({ videos, sales, wishlists, now: NOW }));
  assert.deepEqual(tiers.map((s) => [s.label, s.videos, s.counted, s.real]), [["100k+ views", 2, 2, 2], ["Under 1k views", 1, 1, 0]]);
  close(tiers[0].units, 35);
  assert.equal(tierOf(null), "Under 1k views");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("en-CA"), "English");
  assert.equal(languageName(null), null);
});
