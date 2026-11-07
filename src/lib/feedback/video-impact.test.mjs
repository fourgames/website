// Tests for video-impact.js. Run: node --test src/lib/feedback/video-impact.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, bySize, gmtDay, languageName, pacificDay, sizeOf, videoImpact } from "./video-impact.js";

const at = (iso) => Date.parse(iso) / 1000;
const video = (id, iso, extra = {}) => ({ id, source: "youtube", at: at(iso), title: id, author: id, views: 1000, subscribers: 5000, ...extra });
// A steady game: 2 sold and 5 wishlisted a day from Oct 1 to Nov 10.
function steady() {
  const sales = {}, wishlists = {};
  for (let d = "2026-10-01"; d <= "2026-11-10"; d = addDays(d, 1)) {
    sales[d] = { units: 2, gross: 6 };
    wishlists[d] = { adds: 5 };
  }
  return { sales, wishlists };
}
const NOW = at("2026-11-20T12:00:00Z");

test("days are taken in each file's own time zone", () => {
  // 02:00 GMT on Nov 6 is still Nov 5 in California.
  assert.equal(pacificDay(at("2026-11-06T02:00:00Z")), "2026-11-05");
  assert.equal(gmtDay(at("2026-11-06T02:00:00Z")), "2026-11-06");
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
});

test("extra sales: the 3 days from the video's day minus what the 7 days before would give", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-20"] = { units: 12, gross: 36 };
  sales["2026-10-21"] = { units: 8, gross: 24 };
  wishlists["2026-10-20"] = { adds: 35 };
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW });
  assert.equal(r.day, "2026-10-20");
  assert.equal(r.units.before, 2);
  assert.equal(r.units.after, 22);
  assert.equal(r.units.extra, 16);
  assert.equal(r.gross.extra, 48);
  assert.equal(r.adds.extra, 30);
  assert.deepEqual(r.flags, []);
  assert.equal(r.clean, true);
});

test("days missing from the sales file count as zero sales", () => {
  const { sales, wishlists } = steady();
  delete sales["2026-10-15"];
  const [r] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales, wishlists, now: NOW });
  assert.equal(r.units.beforeDays, 7);
  assert.ok(Math.abs(r.units.before - 12 / 7) < 1e-9);
});

test("another big video in the same days is flagged, a tiny one isn't", () => {
  const { sales, wishlists } = steady();
  const videos = [video("a", "2026-10-20T17:00:00Z"), video("b", "2026-10-21T17:00:00Z", { views: 800 }), video("tiny", "2026-10-20T18:00:00Z", { views: 9 })];
  const rows = videoImpact({ videos, sales, wishlists, now: NOW });
  const a = rows.find((r) => r.video.id === "a"), tiny = rows.find((r) => r.video.id === "tiny");
  assert.deepEqual(a.flags.map((f) => f.kind), ["video"]);
  assert.match(a.flags[0].text, /same days: b/);
  assert.equal(a.clean, false);
  // The tiny one sits next to both bigger ones.
  assert.equal(tiny.flags.filter((f) => f.kind === "video").length, 2);
});

test("a bigger video in the week before is flagged: it lifts the days before", () => {
  const { sales, wishlists } = steady();
  const videos = [video("big", "2026-10-15T17:00:00Z", { views: 200000 }), video("after", "2026-10-20T17:00:00Z", { views: 300 })];
  const after = videoImpact({ videos, sales, wishlists, now: NOW }).find((r) => r.video.id === "after");
  assert.match(after.flags[0].text, /bigger video came out 5 days before \(big\)/);
  // The big one isn't flagged by the small one after it.
  const big = videoImpact({ videos, sales, wishlists, now: NOW }).find((r) => r.video.id === "big");
  assert.deepEqual(big.flags, []);
});

test("launch day, launch week and before launch", () => {
  const { sales, wishlists } = steady();
  const events = [{ time: at("2026-10-01T17:00:00Z"), name: "Out now", launch: true }];
  const rows = videoImpact({ videos: [video("day", "2026-10-01T18:00:00Z"), video("week", "2026-10-04T18:00:00Z"), video("pre", "2026-09-28T18:00:00Z")], sales, wishlists, events, now: NOW });
  const get = (id) => rows.find((r) => r.video.id === id);
  assert.equal(get("day").units.extra, null);
  assert.match(get("day").flags[0].text, /Launch day/);
  assert.equal(get("week").units.beforeDays, 3);
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
  // Updates alone are a note: the video still counts as clean.
  const [u] = videoImpact({ videos: [video("a", "2026-10-20T17:00:00Z")], sales: steady().sales, wishlists, events: events.slice(0, 2), now: NOW });
  assert.deepEqual(u.flags.map((f) => f.kind), ["update"]);
  assert.equal(u.clean, true);
});

test("a new video counts only the days that are over", () => {
  const { sales, wishlists } = steady();
  const now = at("2026-11-09T20:00:00Z"); // Nov 9 in California: Nov 8 is the last full day
  const [r] = videoImpact({ videos: [video("a", "2026-11-07T17:00:00Z")], sales, wishlists, now });
  assert.equal(r.units.afterDays, 2);
  assert.equal(r.units.extra, 0);
  assert.match(r.flags.at(-1).text, /Only 2 of 3 days/);
  assert.equal(r.clean, true);
  const [fresh] = videoImpact({ videos: [video("b", "2026-11-09T17:00:00Z")], sales, wishlists, now });
  assert.equal(fresh.units.extra, null);
  assert.match(fresh.flags.at(-1).text, /Too new/);
});

test("rows go biggest extra sales first; live streams and other sources are left out", () => {
  const { sales, wishlists } = steady();
  sales["2026-11-01"].units = 30;
  const videos = [video("small", "2026-10-15T17:00:00Z", { views: 100 }), video("hit", "2026-11-01T17:00:00Z", { views: 100 }),
    video("live", "2026-11-02T17:00:00Z", { live: true }), { ...video("tw", "2026-11-02T17:00:00Z"), source: "twitch" }];
  assert.deepEqual(videoImpact({ videos, sales, wishlists, now: NOW }).map((r) => r.video.id), ["hit", "small"]);
});

test("channel sizes add up only clean videos and leave our own channel out", () => {
  const { sales, wishlists } = steady();
  sales["2026-10-20"].units = 12;
  const videos = [video("big", "2026-10-20T17:00:00Z", { subscribers: 1610000, views: 190000 }), video("mine", "2026-10-10T17:00:00Z", { own: true, views: 300 }),
    video("near", "2026-10-21T17:00:00Z", { subscribers: 2000, views: 100 })];
  const sizes = bySize(videoImpact({ videos, sales, wishlists, now: NOW }));
  assert.deepEqual(sizes.map((s) => [s.label, s.videos, s.counted, s.units]), [["1M+ subscribers", 1, 1, 10], ["1k–10k", 1, 0, 0]]);
  assert.equal(sizeOf(null), "Under 1k");
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("en-CA"), "English");
  assert.equal(languageName(null), null);
});
