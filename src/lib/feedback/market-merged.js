// The dashboard's Market section, final merged design: the Briefing layout (a "Today" summary in
// sentences, then three big question tabs) with the best parts of the other designs:
//   1. What should I make next?  one small-team filter for the whole tab; "Rising now" (tags whose
//      share of releases climbs fastest, with sparklines, a stage and an action); the top 25 by score
//      as bars; every tag as a dot (rivals vs hit chance, sized by reviews, brightness by review pace); a niche table whose
//      rows open a line in plain words; and the gap finder from market-gaps.js.
//   2. Who should I sign?        market-sign.js (its own state and CSS).
//   3. How is Steam doing?       games released vs Steam's peak players (this year as a dashed pace),
//      what's doing well right now (releases by hit index), and all of today's alerts, folded.
//   4. My game ideas             market-ideas.js: score an idea against the market.
// Same contract as market.js: marketTop(ctx) fills the header, marketView(ctx) returns one root that
// redraws itself. The data files come from server/steamdata/market.py.

import { signView } from "./market-sign.js";
import { gapView, topPairsWith } from "./market-gaps.js";
import { ideasView } from "./market-ideas.js";

const DAY = 86400;
const PREFIX = "mkv-merged-";
const INDIE = 492;
const PRIOR = 30;          // shrinkage: as if each niche also had 30 games at the base rate
const MIN_SINGLE = 20;     // a niche needs this many games to be listed at all
const HUGE = ["Massively Multiplayer", "MMORPG", "Open World", "Open World Survival Craft", "Realistic", "Photorealistic"];
const BIG = ["Multiplayer", "Online Co-Op", "PvP", "Online PvP", "Co-op", "Third-Person Shooter", "Souls-like", "Sandbox", "Story Rich", "3D", "First-Person"];
const ADULT = ["Nudity", "Sexual Content", "NSFW", "Hentai", "Mature"];
// Tags that say how a game is sold or how players feel about it, not what it is.
const META = ["Indie", "Free to Play", "Early Access", "Replay Value", "Great Soundtrack", "Masterpiece", "Addictive", "Classic", "Beautiful", "Singleplayer", "Casual"];
// Joke and crude games (e.g. "Penis Bird") stay out of the Today box and sink to the end of the alerts.
const CRUDE = /\b(penis|dick|cock|boobs?|tits|butt|fart|poop|hentai|waifu|sex|sexy|nsfw|porn|nude|horny|manhole|wiener|weiner)\b/i;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TABS = [
  ["make", "What should I make next?", "Niches where games often become hits"],
  ["sign", "Who should I sign?", "Self-published games worth a message"],
  ["steam", "How is Steam doing?", "Games vs players, what's working now"],
  ["ideas", "My game ideas", "Score an idea against the market"],
];
const SEEN_DAYS = 30;      // the Today box forgets a seen item after this long
const F = { linux: 1, mac: 2, deckOk: 4, godot: 64, demo: 128, self: 256 };
const REVIEW_STEPS = [10, 50, 100];

// Plain words for jargon tags, keyed by the tag's lowercase name. Shown on a niche's card and as a
// hover title on chart labels and table rows.
const GLOSSARY = {
  "fmv": "Full-motion video: games built from filmed live-action footage.",
  "roguelite": "Runs that end on death, but some progress (unlocks, upgrades) carries over to the next run.",
  "roguelike": "Each run is new (random levels) and death sends you back to the start.",
  "action roguelike": "Fast real-time combat in short, randomly built runs that end on death.",
  "traditional roguelike": "Turn-based dungeon crawling on a grid with permanent death, like the original Rogue.",
  "roguelike deckbuilder": "Build a card deck during a run, fight with it, start over on death (like Slay the Spire).",
  "metroidvania": "A big connected map that opens up as you gain abilities (like Metroid or Castlevania).",
  "souls-like": "Hard, deliberate combat with stamina, checkpoints and losing your currency on death (like Dark Souls).",
  "immersive sim": "Systems-driven worlds where problems have many solutions (like Deus Ex or Prey).",
  "bullet heaven": "You auto-attack while hordes swarm you and you pick upgrades (like Vampire Survivors).",
  "extraction shooter": "Drop into a map, grab loot and get out alive; die and you lose what you carried (like Tarkov).",
  "cozy": "Low-stress, comforting games: no fail states, soft art, gentle goals.",
  "wholesome": "Kind, feel-good themes with nothing dark or violent.",
  "wuxia": "Chinese martial-arts heroes and chivalry in a historical setting.",
  "xianxia": "Chinese fantasy of cultivating immortal powers, with Taoist magic and sects.",
  "hobby sim": "Simulates a hobby (gardening, model building, fishing) for relaxed play.",
  "job simulator": "You do a job's tasks for fun (store clerk, mechanic, cleaner).",
  "boomer shooter": "Fast first-person shooters in the style of 90s games like Doom and Quake.",
  "collectathon": "3D platformers about collecting lots of items across levels (like Banjo-Kazooie).",
  "idler": "Progress keeps going while you wait or are away; mostly about upgrades.",
  "incremental": "Numbers go up: repeat actions to unlock bigger multipliers and new layers.",
  "clicker": "You click to earn, then buy upgrades that earn for you.",
  "4x": "Strategy about explore, expand, exploit, exterminate (like Civilization).",
  "grand strategy": "Run a whole nation over decades: economy, diplomacy and war (like Europa Universalis).",
  "visual novel": "Story told through text and character art, with choices.",
  "otome": "A story game aimed at women, about a heroine romancing male characters.",
  "dating sim": "Build relationships and romance characters.",
  "bullet hell": "Shooters where the screen fills with dense patterns of enemy bullets to dodge.",
  "shoot 'em up": "Scrolling shooters: fly and shoot waves of enemies (shmups).",
  "precision platformer": "Hard platformers that demand exact jumps and timing (like Celeste).",
  "deckbuilding": "You build a deck of cards during play and win with it.",
  "card battler": "Battles fought by playing cards.",
  "auto battler": "Set up a team, then fights play out on their own.",
  "colony sim": "Manage a group of settlers' needs, jobs and building (like RimWorld).",
  "city builder": "Plan and grow a city: zones, roads, services.",
  "base building": "Build and defend your own base.",
  "automation": "Build machines and production lines that run themselves (like Factorio).",
  "walking simulator": "Explore and take in a story with little or no challenge.",
  "lovecraftian": "Cosmic horror in the style of H.P. Lovecraft: unknowable gods and madness.",
  "solarpunk": "Hopeful futures with green technology and community.",
  "cyberpunk": "High-tech, low-life futures: megacorps, hackers and neon cities.",
  "gacha": "Pay or grind for random draws of characters or items.",
  "mahjong": "The Chinese tile-matching game, or solitaire versions of it.",
  "sokoban": "Box-pushing puzzles on a grid.",
  "match 3": "Swap tiles to line up three of a kind (like Candy Crush).",
  "hidden object": "Find listed items hidden in busy pictures.",
  "point & click": "Adventure games played by clicking on things to explore and solve puzzles.",
  "interactive fiction": "Text-driven stories you steer with choices or typed commands.",
  "crpg": "Classic computer RPGs: party, stats, dialogue, often isometric (like Baldur's Gate).",
  "jrpg": "Japanese-style RPGs: story-led, party-based, often turn-based combat.",
  "tactical rpg": "RPG battles on a grid where positioning matters (like Fire Emblem).",
  "mystery dungeon": "Turn-based, grid-based dungeon runs (like Pokémon Mystery Dungeon).",
  "musou": "One hero mowing down huge crowds of enemies (like Dynasty Warriors).",
  "spectacle fighter": "Stylish combo-driven action combat (like Devil May Cry).",
  "character action game": "Stylish combo-driven action combat (like Devil May Cry).",
  "hack and slash": "Melee combat against many enemies.",
  "beat 'em up": "Walk forward and punch your way through waves of enemies.",
  "twin stick shooter": "Move with one stick, aim with the other.",
  "tower defense": "Place towers along a path to stop waves of enemies.",
  "creature collector": "Catch, raise and battle creatures (like Pokémon).",
  "life sim": "Live a day-to-day life: work, friends, home (like The Sims or Stardew Valley).",
  "farming sim": "Grow crops and raise animals on your own farm.",
  "shop keeper": "Run a shop: stock, price and sell.",
  "time management": "Juggle tasks under time pressure (like Diner Dash).",
  "social deduction": "Find the traitor among the players (like Among Us).",
  "asymmetric vr": "One player in VR, the others on a screen, with different roles.",
  "6dof": "Six degrees of freedom: move and turn freely in every direction (like Descent).",
  "outbreak sim": "Spread or stop a disease across the world (like Plague Inc.).",
  "god game": "You play a god shaping a world and its people.",
  "real-time with pause": "Real-time combat you can pause to give orders.",
  "litrpg": "Stories where life works like an RPG: levels, stats and skills.",
  "trading card game": "Collect cards and build decks to play against others.",
  "tabletop": "Board or tabletop games played on screen.",
  "on-rails shooter": "The game moves you along a set path while you aim and shoot.",
  "rail shooter": "The game moves you along a set path while you aim and shoot.",
  "score attack": "Play for the highest score.",
  "perma death": "When a character dies, they're gone for good.",
  "voxel": "Worlds built out of small cubes (like Minecraft).",
  "intentionally awkward controls": "Clumsy controls on purpose, for comedy (like Octodad).",
  "desktop companion": "Sits on your desktop while you do other things.",
  "falling blocks": "Pieces fall and you fit them together (like Tetris).",
  "organizing": "Calm games about sorting and tidying things into place (like Unpacking).",
  "boss rush": "A run of boss fights with little in between.",
  "arena shooter": "Fast multiplayer shooters in small arenas (like Quake III).",
  "hero shooter": "Team shooters with characters who each have special powers (like Overwatch).",
  "looter shooter": "Shoot enemies to collect ever-better guns and gear (like Borderlands).",
  "dungeon crawler": "Explore dungeons, fight monsters, collect loot.",
  "cleaning": "Calm games about washing and tidying (like PowerWash Simulator).",
  "rhythm": "Press buttons in time with music.",
};
export const glossary = (name) => GLOSSARY[String(name || "").trim().toLowerCase()] || null;

// ---------------------------------------------------------------------------
// Plain helpers (no DOM): also used by the smoke test
// ---------------------------------------------------------------------------

const num = (n) => n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString("en-US");
const short = (n) => n == null ? "–" : n >= 1e6 ? `${+(n / 1e6).toFixed(1)} million` : num(n);
const fmtK = (n) => n == null || !Number.isFinite(n) ? "–" : Math.abs(n) < 1000 ? String(Math.round(n)) : Math.abs(n) < 1e6 ? `${+(n / 1000).toFixed(Math.abs(n) < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(1)}M`;
const pct = (x, d = 0) => x == null || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(d)}%`;
const times = (x) => x == null || !Number.isFinite(x) ? "–" : `×${x.toFixed(x >= 10 ? 0 : 1)}`;
const usd = (n) => n >= 1e6 ? `$${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`;
const money = (c) => c == null ? "–" : c === 0 ? "Free" : `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dayDate = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
const dayShort = (d) => { const t = new Date(d * DAY * 1000); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };
export const isJoke = (name) => CRUDE.test(name || "");

// "1 in 4": a share said the way people say it.
export function oneIn(p) {
  if (p == null) return "–";
  if (p >= 0.5) return p >= 0.7 ? "most" : "more than half";
  if (p <= 0) return "none";
  return `1 in ${Math.max(2, Math.round(1 / p))}`;
}
// How sure: by how many games the number stands on.
export function confidence(n) { return n >= 100 ? "solid" : n >= 40 ? "likely" : "thin data"; }
// A rough 90% range for a shrunk rate (as a fraction; ×100 for percentage points).
export const spread = (p, n) => 1.64 * Math.sqrt(Math.max(p * (1 - p), 0.0001) / (n + PRIOR));
// "likely · ±7 pts": the word and the range together.
export const sureLabel = (p, n) => `${confidence(n)} · ±${Math.max(1, Math.round(spread(p, n) * 100))} pts`;
// A tag's releases as a share of Steam's, against a year ago.
function growthWords(supply) {
  if (supply == null) return "no year-ago count";
  if (supply >= 2) return "growing much faster than Steam";
  if (supply >= 1.15) return "growing faster than Steam";
  if (supply >= 0.87) return "growing with Steam";
  if (supply >= 0.6) return "growing slower than Steam";
  return "losing ground on Steam";
}
const growthDir = (supply) => supply == null ? 0 : supply >= 1.1 ? 1 : supply <= 0.9 ? -1 : 0;
// An upcoming game's release date from its day number, as precise as the store's kind of date says.
// `kind` (release_display) is "date_full", "date_month", "date_quarter" or "date_year": never shown as is.
function releaseText(day, kind) {
  if (day == null) return kind && !String(kind).startsWith("date_") ? String(kind).toLowerCase() : "no date yet";
  const t = new Date(day * DAY * 1000), y = t.getUTCFullYear();
  if (kind === "date_year") return `sometime in ${y}`;
  if (kind === "date_quarter") return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${y}`;
  if (kind === "date_month") return `${MONTHS[t.getUTCMonth()]} ${y}`;
  return dayDate(day);
}

const tagSets = (tagNames) => {
  const byName = new Map(Object.entries(tagNames || {}).map(([id, n]) => [n.trim().toLowerCase(), Number(id)]));
  const ids = (list) => new Set(list.map((n) => byName.get(n.toLowerCase())).filter((x) => x != null));
  return { big: ids([...HUGE, ...BIG]), adult: ids(ADULT), meta: ids(META), byName };
};

// --- 1. Niches from trends.json -------------------------------------------------

// Every tag with a hit rate, best first. trends.hitRate is already pulled toward Steam's rate (as if
// the tag also had `priorGames` average games), so a tag with a handful of games can't top the list.
// The opportunity score: each signal as a percentile among the listed tags (0 = worst, 1 = best),
// mixed by these weights, then cut by up to 30% for a tag that stands on fewer than 100 games.
export const SCORE_WEIGHTS = { hit: 0.4, typical: 0.25, quiet: 0.2, growth: 0.15 };
export const SCORE_TEXT = "Score 0–100: how a tag ranks against the others on hit chance (40%), reviews for a typical game (25%), how few new games it gets (20%) and growth (15%), cut by up to 30% when it rests on fewer than 100 games.";
const SIGNAL_WORDS = { hit: "hit chance", typical: "reviews per game", quiet: "few rivals", growth: "growth" };
const SIGNAL_WEAK = { hit: "a low hit chance", typical: "few reviews per game", quiet: "crowding", growth: "slow growth" };

function percentiler(values) {
  const s = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  return (v) => {
    if (v == null || !Number.isFinite(v) || !s.length) return 0.5;
    let lo = 0, hi = 0;
    for (const x of s) { if (x < v) lo++; else if (x === v) hi++; }
    return s.length === 1 ? 0.5 : (lo + (hi - 1) / 2) / (s.length - 1);
  };
}

export function opportunityScores(rows) {
  const pHit = percentiler(rows.map((r) => r.hitRate)), pTyp = percentiler(rows.map((r) => r.medianReviews));
  const pCrowd = percentiler(rows.map((r) => r.releases)), pGrow = percentiler(rows.map((r) => r.supply));
  return rows.map((r) => {
    const parts = { hit: pHit(r.hitRate), typical: pTyp(r.medianReviews), quiet: 1 - pCrowd(r.releases), growth: pGrow(r.supply) };
    const sure = 0.7 + 0.3 * clamp(r.hitGames / 100);
    const raw = Object.entries(SCORE_WEIGHTS).reduce((s, [k, w]) => s + w * parts[k], 0);
    const strong = Object.keys(parts).filter((k) => parts[k] >= 0.75).sort((a, b) => parts[b] - parts[a]);
    const weak = Object.keys(parts).filter((k) => parts[k] <= 0.25).sort((a, b) => parts[a] - parts[b]);
    const list = (ks, words) => ks.map((k) => words[k]).join(ks.length > 2 ? ", " : " and ").replace(/, ([^,]*)$/, " and $1");
    const why = strong.length
      ? `Strong on ${list(strong.slice(0, 3), SIGNAL_WORDS)}${weak.length ? `; held back by ${list(weak.slice(0, 2), SIGNAL_WEAK)}` : ""}${sure < 0.85 ? "; few games to judge by" : ""}.`
      : weak.length ? `Middling; held back by ${list(weak.slice(0, 2), SIGNAL_WEAK)}.` : "Middling on every count.";
    return { ...r, parts, score: Math.round(100 * raw * sure), why };
  });
}

export function rankNiches(trends, tagNames, { small = true, sort = "best" } = {}) {
  const s = tagSets(tagNames);
  const rows = opportunityScores((trends.tags || []).filter((r) => r.hitRate != null && r.hitGames >= MIN_SINGLE && !s.meta.has(r.tag) && !s.adult.has(r.tag) && (!small || !s.big.has(r.tag)))
    .map((r) => ({ ...r, conf: confidence(r.hitGames), sure: sureLabel(r.hitRate, r.hitGames), range: spread(r.hitRate, r.hitGames), lift: r.hitLift ?? r.hitRate / trends.baseHitRate, dir: growthDir(r.supply) })));
  const thinLast = (a, b) => (a.conf === "thin data") - (b.conf === "thin data");
  const by = {
    best: (a, b) => b.score - a.score || b.hitRate - a.hitRate,
    // Quiet only among niches that beat Steam's hit rate by half: a quiet tag nobody plays isn't news.
    quiet: (a, b) => (b.lift >= 1.5) - (a.lift >= 1.5) || thinLast(a, b) || a.releases - b.releases,
  }[sort] || ((a, b) => b.score - a.score);
  return rows.sort(by);
}

// --- 1b. The gap finder, from games.json ------------------------------------------

export function unpackGames(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  const top = file.topTags || 5;
  return file.rows.map((r) => {
    const tags = r[col.tags] || [];
    return {
      appid: r[col.appid], name: r[col.name], day: r[col.day], price: r[col.price] || 0, reviews: r[col.reviews] || 0,
      pos: r[col.pos], top: tags.slice(0, top), indie: tags.includes(INDIE), flags: r[col.flags] || 0, hit: r[col.hit],
    };
  });
}

// How fast each tag's newest games are collecting reviews: for games out 2 weeks to 3 months,
// reviews per month since release; the tag's "typical pace" is the geometric-style mean of
// (1 + reviews a month), minus 1, so one viral game can't carry it. `ratio`: against all of Steam's
// new games the same way. Needs PACE_MIN games. (trends.demand, the share of new reviews against the
// window before, needs a few days of daily history; it shows in the tooltip once it exists.)
export const PACE_MIN = 8;
export function tagReviewPace(list, today, { from = 14, to = 90 } = {}) {
  const acc = new Map();
  let all = 0, allN = 0;
  for (const g of list) {
    const age = today - g.day;
    if (age < from || age > to) continue;
    const v = Math.log1p((g.reviews / age) * 30.4);
    all += v; allN++;
    for (const t of g.top) { const e = acc.get(t); if (e) { e.s += v; e.n++; } else acc.set(t, { s: v, n: 1 }); }
  }
  const base = allN ? Math.expm1(all / allN) : 0;
  const out = new Map();
  for (const [t, e] of acc) if (e.n >= PACE_MIN) { const rate = Math.expm1(e.s / e.n); out.set(t, { rate, n: e.n, ratio: base > 0 ? rate / base : null }); }
  return { base, tags: out };
}
// A dot's pace level: 0 (slower than Steam's typical new game) up to 3 (2.5× or faster).
export const paceLevel = (ratio) => ratio == null ? 0 : ratio >= 2.5 ? 3 : ratio >= 1.5 ? 2 : ratio >= 0.9 ? 1 : 0;
// How solid a dot is by pace level: slow tags fade back, the fastest are fully lit. No outline, so a
// crowded corner stays readable (the earlier yellow rings turned it into one blob).
export const PACE_OPACITY = [0.2, 0.45, 0.75, 1];
const PACE_WORDS = [
  "Faint: reviews come in slower than for a typical new Steam game",
  "Light: about as fast as a typical new Steam game",
  "Strong: 1.5 to 2.5 times as fast",
  "Solid: 2.5 times as fast or faster",
];

// --- 1c. Rising now: trends to get into early, from growth.json's monthly counts -----------

// Each tag's share of Steam's releases in the last 3 full months against the 12 before (`mult`), from
// a small base (under 1.5% of releases a year before), kept only when its games still become hits at
// least as often as Steam's (trends.hitRate, already pulled toward the base rate). Pseudo-counts keep a
// jump from 1 game to 6 from reading as ×6. Ordered by stage (Early first, Late last), then by `mult`.
// `revRatio`: reviews per release of its last 3 months' games against all of Steam's from the same
// months. `top2`: the share of those reviews that its two biggest new games hold (from games.json,
// when given): at 70%+ one or two big releases make the tag look good, and it's left out.
// Stage, so "Early" means a small, young rise a small team can still join:
//   early:   under 0.5% of releases, the rise only started lately (it wasn't rising the year before:
//            under ×2.5 against the 12 months before that), and not a big build (the HUGE/BIG lists);
//   late:    1.5%+ of all releases: the rush has arrived;
//   crowded: everything between.
export const RISE_MIN_GAMES = 12;
export const RISE_RULES = { earlyShare: 0.005, earlyStarted: 2.5, lateShare: 0.015, fewBig: 0.7 };
export function risingNow(growth, trends, tagNames, { small = true, limit = 8, games = null } = {}) {
  if (!growth?.tags || !growth.total?.m || !trends?.tags) return [];
  const T = growth.total.m, TR = growth.total.mr || [], n = T.length;
  const full = growth.monthDone > 0 && growth.monthDone < 1 ? n - 1 : n; // months before `full` are complete
  const sum = (a, i, j) => { let s = 0; for (let k = Math.max(0, i); k < j; k++) s += a[k] || 0; return s; };
  const now = [full - 3, full], before = [full - 15, full - 3], prior = [full - 27, full - 15];
  const tNow = sum(T, ...now), tBefore = sum(T, ...before), tPrior = sum(T, ...prior);
  if (!tNow || !tBefore) return [];
  const revAll = sum(TR, ...now) / tNow;
  const s = tagSets(tagNames), base = trends.baseHitRate, tm = new Map(trends.tags.map((r) => [r.tag, r]));
  const K = 4;
  const months = (growth.months || []).slice(Math.max(0, full - 24), full);
  const conc = games ? newGameReviews(games, growth, full) : null;
  const out = [];
  for (const [id, g] of Object.entries(growth.tags)) {
    const tag = Number(id), tr = tm.get(tag), big = s.big.has(tag);
    if (!tr || tr.hitRate == null || tr.hitRate < base || tag === INDIE || s.meta.has(tag) || s.adult.has(tag) || (small && big)) continue;
    const m = g.m || [], mr = g.mr || [];
    const cNow = sum(m, ...now), cBefore = sum(m, ...before), cPrior = sum(m, ...prior);
    if (cNow < RISE_MIN_GAMES) continue;
    const shareNow = cNow / tNow, shareBefore = cBefore / tBefore, sharePrior = tPrior ? cPrior / tPrior : 0;
    if (shareBefore >= 0.015) continue;
    const mult = (cNow + K) / (shareBefore * tNow + K);
    if (mult < 1.5) continue;
    const started = (cBefore + K) / (sharePrior * tBefore + K);
    // Pulled toward Steam's average as if it also had K average games: one big game can't make ×30.
    const revRatio = revAll > 0 ? ((sum(mr, ...now) + K * revAll) / (cNow + K)) / revAll : null;
    const c = conc?.get(tag);
    const top2 = c && c.total >= 50 ? (c.top[0].reviews + (c.top[1]?.reviews || 0)) / c.total : null;
    // Carried by one or two big releases (e.g. a famous studio's game): a big-release story, not a
    // niche to join, so it stays off the list.
    const fewBig = top2 != null && top2 >= RISE_RULES.fewBig;
    if (fewBig) continue;
    const stage = shareNow >= RISE_RULES.lateShare ? "late"
      : shareNow < RISE_RULES.earlyShare && started < RISE_RULES.earlyStarted && !big ? "early" : "crowded";
    const spark = [];
    for (let i = Math.max(0, full - 24); i < full; i++) spark.push(T[i] ? (m[i] || 0) / T[i] : 0);
    const x = mult >= 10 ? String(Math.round(mult)) : mult.toFixed(1).replace(/\.0$/, "");
    const rev = revRatio == null ? "" : revRatio >= 3 ? ", and they get far more reviews than an average new game" : revRatio >= 1.2 ? `, and they get ${times(revRatio)} the reviews of an average new game` : revRatio < 0.8 ? ", though they get fewer reviews than an average new game" : "";
    const words = `${x}× its share of releases a year before (${pct(shareNow, 1)} of all new games now), ${oneIn(tr.hitRate)} still become hits, ${num(tr.releases)} new in ${trends.supplyWindow || 90} days${rev}.`;
    out.push({ tag, name: tr.name || g.name, cNow, cBefore, shareNow, shareBefore, mult, started, revRatio, top2, big, stage, hitRate: tr.hitRate, lift: tr.hitRate / base, releases: tr.releases, hitGames: tr.hitGames, spark, months, words });
  }
  // Best chances first: Early, then Getting crowded, then Late, each by rise speed. `limit` caps the
  // Early + crowded rows and, separately, the Late ones (shown folded away).
  out.sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || b.mult - a.mult || b.hitRate - a.hitRate);
  return [...out.filter((r) => r.stage !== "late").slice(0, limit), ...out.filter((r) => r.stage === "late").slice(0, limit)];
}
export const STAGE_ORDER = { early: 0, crowded: 1, late: 2 };

// Per tag: the reviews of games released in the 3 full months risingNow looks at, and its biggest two.
function newGameReviews(games, growth, full) {
  const dayOf = (ym) => { const [y, m] = String(ym).split("-").map(Number); return Date.UTC(y, m - 1, 1) / 1000 / DAY; };
  const ms = growth.months || [];
  if (!ms[full - 3]) return null;
  const a = dayOf(ms[full - 3]), b = ms[full] ? dayOf(ms[full]) : Infinity;
  const out = new Map();
  for (const g of games) {
    if (g.day < a || g.day >= b) continue;
    for (const t of g.top) {
      let e = out.get(t);
      if (!e) out.set(t, e = { total: 0, top: [] });
      e.total += g.reviews;
      if (e.top.length < 2 || g.reviews > e.top[1].reviews) { e.top.push({ name: g.name, reviews: g.reviews }); e.top.sort((x, y) => y.reviews - x.reviews); e.top.length = Math.min(2, e.top.length); }
    }
  }
  return out;
}

// What to do about a rising tag, in one short line. `pair`: the best tag pair containing it, from the
// gap finder (topPairsWith in market-gaps.js), for the "find an angle" hint.
export function riseAction(row, pair) {
  if (row.stage === "early") return { lead: "Get in now:", rest: "few rivals yet." };
  if (row.stage === "late") return { lead: "Only with a clear twist:", rest: "the rush has arrived." };
  return pair
    ? { lead: "Move fast or find an angle:", rest: `${row.name} + ${pair.other}`, pair }
    : { lead: "Move fast or find an angle:", rest: "no tag pair clearly beats it yet, so the twist is yours to find." };
}

// --- Leads for the Today box (the full "who to sign" view lives in market-sign.js) ----------

export function unpackUpcoming(file) {
  const col = Object.fromEntries(file.columns.map((c, i) => [c, i]));
  return file.rows.map((r) => ({
    appid: r[col.appid], name: r[col.name], day: r[col.day], display: r[col.display], price: r[col.price],
    tags: r[col.tags] || [], flags: r[col.flags] || 0, langs: r[col.langs], devs: r[col.devs] || [], pubs: r[col.pubs] || [],
    devGames: r[col.devGames] || 0, devBest: r[col.devBest] || 0, devReviews: r[col.devReviews] || 0, pubGames: r[col.pubGames] || 0,
  }));
}

function hotTag(tags, hot) {
  let best = null;
  for (const t of tags.slice(0, 5)) { const r = hot.get(t); if (r && r.lift >= 1.4 && (!best || r.lift > best.lift)) best = r; }
  return best;
}
const hotMap = (trends) => new Map((trends?.tags || []).filter((r) => r.hitRate != null && r.tag !== INDIE).map((r) => [r.tag, { tag: r.tag, name: r.name, lift: r.hitLift, rate: r.hitRate }]));

// Upcoming games, the ones worth a message first. "self": no outside publisher; "label": a small one
// (1–2 games); "published": a real publisher (3+ games). Joke games are left out.
export function upcomingLeads(list, trends, today, { godotOnly = true, tagNames = {} } = {}) {
  const hot = hotMap(trends), adult = tagSets(tagNames).adult;
  return list.filter((g) => (!godotOnly || g.flags & F.godot) && !isJoke(g.name) && !g.tags.some((t) => adult.has(t))).map((g) => {
    const deal = g.flags & F.self || !g.pubGames ? "self" : g.pubGames <= 2 ? "label" : "published";
    const until = g.day == null ? null : g.day - today;
    const exact = g.display === "date_full" || g.display === "date_month";
    const tag = hotTag(g.tags, hot);
    const demo = !!(g.flags & F.demo);
    let score = { self: 30, label: 14, published: 0 }[deal] + (g.flags & F.godot ? 20 : 0);
    score += until == null ? 1 : until < -30 ? 0 : !exact ? 4 : until <= 30 ? 15 : until <= 120 ? 12 : until <= 270 ? 8 : 4;
    if (tag) score += Math.min(15, (tag.lift - 1) * 10);
    score += g.devBest >= 1000 ? 15 : g.devBest >= 200 ? 11 : g.devBest >= 50 ? 7 : g.devGames ? 2 : 0;
    if (demo) score += 6;
    const who = `${deal === "self" ? "Self-published" : deal === "label" ? "Small-label" : "Published"}${g.flags & F.godot ? " Godot" : ""} game`;
    const when = until == null ? (demo ? "no date yet, but a demo is out" : "no date yet")
      : until < 0 ? `its date (${dayShort(g.day)}) just passed: still coming`
      : !exact ? `planned for ${releaseText(g.day, g.display)}`
      : until === 0 ? "out today" : until <= 60 ? `out in ${plural(until, "day")} (${dayShort(g.day)})` : `out ${releaseText(g.day, g.display)}`;
    const parts = [`${who}, ${when}`];
    if (tag) parts.push(`in ${tag.name}, where ${oneIn(tag.rate)} recent games became a hit`);
    if (g.devBest >= 50) parts.push(`the studio's best game has ${num(g.devBest)} reviews`);
    else if (!g.devGames) parts.push("the studio's first game");
    if (demo && until != null) parts.push("demo out");
    return { ...g, deal, until, tag, demo, score: Math.round(score), reason: parts.join("; ") + "." };
  }).sort((a, b) => (a.deal === "published") - (b.deal === "published") || b.score - a.score);
}

// Released self-published (or small-label) Godot games: well liked but not reaching many players yet.
export function releasedLeads(godot, today, tagNames = {}) {
  const adult = tagSets(tagNames).adult;
  return godot.filter((g) => !g.comingSoon && g.day != null && today - g.day <= 730 && g.reviews >= 10 && g.pos != null && g.pos >= 75
    && (g.selfPublished || g.publisherGames <= 2) && !isJoke(g.name) && !(g.tags || []).some((t) => adult.has(t))).map((g) => {
    const trust = clamp(Math.log10(g.reviews + 1) / 2);
    const gaps = [];
    if (g.languages != null && g.languages < 5) gaps.push(`only ${plural(g.languages, "language")}`);
    const ports = [!g.mac && "Mac", !g.linux && "Linux"].filter(Boolean);
    if (ports.length) gaps.push(`no ${ports.join(" or ")} build`);
    if (!g.deck) gaps.push("no Steam Deck rating");
    const age = today - g.day;
    let score = 30 * clamp((g.pos - 75) / 20) * trust;
    score += 15 * clamp(1 - Math.log10(Math.max(g.reviews, 10)) / Math.log10(5000));
    score += Math.min(25, gaps.length * 8) * trust;
    score += age <= 180 ? 15 : age <= 365 ? 8 : 0;
    score += g.selfPublished ? 10 : 4;
    const reason = `${g.selfPublished ? "Self-published" : "On a small label"}, ${g.pos}% positive from ${num(g.reviews)} reviews, out for ${age < 60 ? plural(age, "day") : `${Math.round(age / 30.4)} months`}`
      + (gaps.length ? `, but ${gaps.join(", ")}: room to reach more players.` : ": well liked, still a small audience.");
    return { ...g, score: Math.round(score), reason };
  }).sort((a, b) => b.score - a.score);
}

// --- 3. Steam's growth, releases and alerts ------------------------------------------

export function steamGrowth(g, minReviews = 10) {
  if (!g?.users?.y) return null;
  const first = Math.max(g.years.indexOf(2018), g.users.y.findIndex((v) => v != null));
  if (first < 0) return null;
  const last = g.years.length - 1;
  const partial = g.yearDone > 0 && g.yearDone < 1;
  const paced = (xs) => xs.map((n, i) => n == null ? null : i === last && partial ? n / g.yearDone : n).slice(first);
  const rel = paced(g.total.y);
  // Games that reached `minReviews` reviews (growth.json total.q; missing in older files).
  const qRaw = g.total.q?.[String(minReviews)];
  const q = Array.isArray(qRaw) && qRaw.length === g.years.length && qRaw[first] ? paced(qRaw) : null;
  const users = g.users.y.slice(first);
  const years = g.years.slice(first);
  const idx = (xs) => xs.map((v) => v == null ? null : (v / xs[0]) * 100);
  const lastUsers = users.filter((v) => v != null).at(-1);
  const gr = rel.at(-1) / rel[0], ur = lastUsers / users[0], per = ur / gr;
  const sentence = `Since ${years[0]}, the number of games released a year has grown ${times(gr)} (${num(rel[0])} to about ${num(rel.at(-1))} at this year's pace), while Steam's peak players grew ${times(ur)} (${short(users[0])} to ${short(lastUsers)}). `
    + (per < 0.95 ? `Games are arriving faster than players: each new game now shares the crowd with about ${pct(1 - per)} fewer players than in ${years[0]}.`
      : per > 1.05 ? `Players are arriving faster than games: about ${pct(per - 1)} more players per new game than in ${years[0]}.` : `Players and games have grown about as fast as each other.`);
  return { years, rel, users, relIdx: idx(rel), usersIdx: idx(users), gr, ur, per, sentence, partial, sofar: g.total.y.at(-1),
    q, qIdx: q ? idx(q) : null, qMin: minReviews, qSofar: q ? qRaw.at(-1) : null };
}

// Recent releases ranked by the hit index (review-count percentile among games out within ±7 days).
export function releasesList(list, today, { days = 30, indie = true, self = false, godot = false, adult = false } = {}, adultIds = new Set()) {
  return list.filter((g) => today - g.day <= days && today - g.day >= 0 && g.hit != null && (!indie || g.indie) && (!self || g.flags & F.self) && (!godot || g.flags & F.godot)
    && (adult || (!g.top.some((t) => adultIds.has(t)) && !isJoke(g.name))))
    .sort((a, b) => b.hit - a.hit || b.reviews - a.reviews);
}

// The alerts, ranked for a publisher: rising niches first (what to make), then self-published Godot
// games (who to sign), then breakouts (worth a look), then Godot games that already have a publisher.
export function rankAlerts(trends, godotGames) {
  const gd = new Map((godotGames || []).map((g) => [g.appid, g]));
  const tm = new Map((trends.tags || []).map((t) => [t.tag, t]));
  const out = [];
  for (const a of trends.alerts || []) {
    if (a.kind === "tag") {
      const t = tm.get(a.tag);
      out.push({ ...a, group: 0, label: "Rising niche", head: t?.name || a.title,
        plain: t ? `${num(t.releases)} games out in the last 90 days, ${times(t.supply)} its share of releases a year ago, and its games become hits ${times(t.hitLift)} as often as Steam's (${t.hitRate != null ? sureLabel(t.hitRate, t.hitGames) : "no hit rate yet"}).` : a.detail });
    } else if (a.kind === "godot") {
      const g = gd.get(a.appid);
      const self = g?.selfPublished;
      out.push({ ...a, group: self ? 1 : 3, label: self ? "Self-published Godot" : "Godot, has a publisher", head: a.title.replace(/^Godot game taking off:\s*/, ""),
        plain: g ? `${num(g.reviews)} reviews (${g.pos ?? "?"}% positive), more than ${g.hit}% of the games out the same fortnight. ${self ? `Self-published by ${g.developers.join(", ")}: no publisher yet.` : `Published by ${g.publishers.join(", ")}: probably taken.`}` : a.detail });
    } else {
      out.push({ ...a, group: 2, label: "Breakout", head: a.title.replace(/^Breakout:\s*/, ""), plain: `${a.detail.replace(/;?\s*hit index \d+\.?/, "")}: ahead of 99% of its launch fortnight. Likely out of reach; worth studying.` });
    }
  }
  return out.map((a) => ({ ...a, joke: a.kind !== "tag" && isJoke(a.head) }))
    .sort((a, b) => a.joke - b.joke || a.group - b.group || (b.score ?? 0) - (a.score ?? 0));
}

// --- Today: the few things worth knowing ------------------------------------------

// Each item has `keys`: stable ids (tag id, appid) the page uses to tell what the owner has seen.
export function todayItems({ trends, tagNames, upcoming, godot, growth, games = null }) {
  const out = [];
  if (trends) {
    const n = rankNiches(trends, tagNames, { small: true }).find((r) => r.conf !== "thin data");
    if (n) out.push({ kind: "Niche", text: `Best niche right now: ${n.name} (score ${n.score}). ${num(n.hits)} of its ${num(n.hitGames)} recent games became hits, about ${oneIn(n.hitRate)} even after allowing for chance (Steam average: ${oneIn(trends.baseHitRate)}; ${n.sure}). New ones are ${growthWords(n.supply)}.`, tab: "make", tag: n.tag, keys: [`niche:${n.tag}`] });
  }
  if (trends && growth) {
    // The fastest riser that isn't already the best niche above.
    const r = risingNow(growth, trends, tagNames, { small: true, limit: 3, games }).find((x) => x.tag !== out[0]?.tag);
    if (r) out.push({ kind: "Rising", text: `Rising fast: ${r.name} (${STAGE[r.stage].toLowerCase()}). ${r.words.charAt(0).toUpperCase()}${r.words.slice(1)}`, tab: "make", tag: r.tag, keys: [`rising:${r.tag}`] });
  }
  if (upcoming) {
    const l = upcoming.find((g) => g.deal !== "published");
    if (l) out.push({ kind: "Lead", text: `Best upcoming lead: ${l.name} by ${l.devs.join(", ") || "an unknown studio"}. ${l.reason}`, appid: l.appid, tab: "sign", keys: [`lead:${l.appid}`] });
  }
  if (godot) {
    const r = godot[0];
    if (r) out.push({ kind: "Lead", text: `Released and worth a look: ${r.name} by ${r.developers.join(", ") || "?"}. ${r.reason}`, appid: r.appid, tab: "sign", keys: [`lead:${r.appid}`] });
  }
  const breakouts = (trends?.alerts || []).filter((a) => a.kind === "breakout" && !isJoke(a.title)).slice(0, 5)
    .map((a) => ({ appid: a.appid, name: a.title.replace(/^Breakout:\s*/, ""), text: a.detail.replace(/;?\s*hit index \d+\.?/, "").replace(/\.$/, "") }));
  if (breakouts.length) out.push({ kind: "Breakout", text: `${plural(breakouts.length, "game")} breaking out right now`, note: "Top 1% of their launch fortnight: worth studying, rarely signable.", list: breakouts, keys: breakouts.map((b) => `breakout:${b.appid}`) });
  return out;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

let C;
const st = {
  files: {}, loading: {}, errors: {}, root: null, cache: {}, open: {}, seen: {},
  tab: "make", small: true, sort: "best", shown: 15, q: "", sel: null, qMin: 10,
  rel: { days: 30, indie: true, self: false, godot: false, adult: false }, relShown: 25,
};
const NEEDS = { make: ["trends", "games", "growth"], sign: ["trends", "upcoming", "godot"], steam: ["growth", "trends", "games", "godot"], ideas: ["trends", "games", "growth"] };
const today = () => st.files.overview?.today ?? Math.floor(Date.now() / 1000 / DAY);
const tagNames = () => st.files.overview?.tags || {};
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;

const save = (k, v) => { try { C.store.set(PREFIX + k, typeof v === "string" ? v : JSON.stringify(v)); } catch {} };
function restore() {
  const get = (k) => { try { const v = C.store.get(PREFIX + k); return v == null ? null : v; } catch { return null; } };
  const tab = get("tab"); if (TABS.some(([id]) => id === tab)) st.tab = tab;
  const small = get("small"); if (small === "true" || small === "false") st.small = small === "true";
  const sort = get("sort"); if (["best", "quiet"].includes(sort)) st.sort = sort;
  const qMin = Number(get("qMin")); if (REVIEW_STEPS.includes(qMin)) st.qMin = qMin;
  try { const r = JSON.parse(get("rel") || "null"); if (r && typeof r === "object") Object.assign(st.rel, r); } catch {}
  if (![7, 30, 90].includes(st.rel.days)) st.rel.days = 30;
  // Seen Today items: { key: unix seconds when seen }, forgotten after SEEN_DAYS.
  try {
    const s = JSON.parse(get("seen") || "null"), cut = Date.now() / 1000 - SEEN_DAYS * DAY;
    st.seen = s && typeof s === "object" ? Object.fromEntries(Object.entries(s).filter(([, t]) => Number.isFinite(t) && t >= cut)) : {};
    save("seen", st.seen);
  } catch { st.seen = {}; }
}
const isNew = (it) => (it.keys || []).some((k) => !(k in st.seen));
function markSeen(it) {
  if (!isNew(it)) return;
  const t = Math.floor(Date.now() / 1000);
  for (const k of it.keys || []) st.seen[k] = t;
  save("seen", st.seen);
}
function goTab(id) { st.tab = id; save("tab", id); load(NEEDS[id]); draw(); }

// Cached by inputs: the heavy work runs once per setting, not on every redraw.
function memo(key, fn) { if (!(key in st.cache)) st.cache[key] = fn(); return st.cache[key]; }
const gamesList = () => memo("games", () => unpackGames(st.files.games));
const upcomingList = () => memo("upcoming", () => unpackUpcoming(st.files.upcoming));
const upLeads = () => memo("up", () => upcomingLeads(upcomingList(), st.files.trends, today(), { godotOnly: true, tagNames: tagNames() }));
const relLeads = () => memo("rel", () => releasedLeads(st.files.godot.games, today(), tagNames()));
const growthNow = () => memo(`growth:${st.qMin}`, () => steamGrowth(st.files.growth, st.qMin));
const risingRows = () => memo(`rising:${st.small}:${!!st.files.games}`, () => risingNow(st.files.growth, st.files.trends, tagNames(), { small: st.small, games: st.files.games ? gamesList() : null }));
// The best tag pair containing a rising tag, for its "find an angle" line (from the gap finder).
const anglePair = (tag) => memo(`angle:${st.small}:${tag}`, () => { try { return topPairsWith({ overview: st.files.overview, games: st.files.games }, tag, { small: st.small, minGames: 25 })[0] || null; } catch (e) { console.error(e); return null; } });
const reviewPace = () => memo("pace", () => tagReviewPace(gamesList(), today()));
const nichesNow = () => memo(`niches:${st.small}:${st.sort}`, () => rankNiches(st.files.trends, tagNames(), { small: st.small, sort: st.sort }));
const adultIds = () => memo("adult", () => tagSets(tagNames()).adult);

export function marketTop(ctx) {
  C = ctx;
  const o = st.files.overview;
  const set = (id, ...kids) => { const el = document.getElementById(id); if (el) el.replaceChildren(...kids); };
  const cap = document.getElementById("fb-capsule"); if (cap) cap.hidden = true;
  set("fb-title", "Market");
  set("fb-updated", o ? `All of Steam: ${num(o.games)} games, ${num(o.comingSoon)} still to come out. Updated ${C.fmtDateTime(o.builtAt)}.` : "All of Steam, from the server's collector");
  for (const id of ["fb-links", "fb-stats", "fb-expand"]) set(id);
}

export function marketView(ctx) {
  C = ctx;
  injectStyle();
  restore();
  st.root = C.h("div.mk.mkv-merged");
  draw();
  load(["overview", "trends", "upcoming", "godot", "growth", ...NEEDS[st.tab]]);
  return st.root;
}

async function load(names) {
  const wanted = [...new Set(names)].filter((n) => !st.files[n] && !st.loading[n]);
  if (!wanted.length) return;
  for (const n of wanted) { st.loading[n] = true; delete st.errors[n]; }
  await Promise.all(wanted.map(async (n) => {
    try {
      if (C.dataOverride) {
        const res = await fetch(`${C.dataOverride}/market/${n}.json`, { cache: "no-store", signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`${n}: HTTP ${res.status}`);
        st.files[n] = await res.json();
      } else st.files[n] = await (await C.adminGet(`market/${n}`)).json();
      st.cache = {};
    } catch (e) {
      if (!e.signedOut) st.errors[n] = e.name === "TimeoutError" ? "The server didn't answer; try again." : /not_built|404/.test(e.message) ? "The market files aren't built yet: the server makes them once a day." : e.message;
    }
    st.loading[n] = false;
    if (n === "overview") marketTop(C);
    draw();
  }));
}

function draw() {
  if (!st.root) return;
  const y = window.scrollY, h = C.h;
  const tabs = h("div.mm-tabs", { role: "tablist" }, ...TABS.map(([id, q, sub], i) => h("button.mm-tab", {
    type: "button", role: "tab", "aria-selected": String(st.tab === id), onclick: () => goTab(id),
  }, h("span.mm-tab-n", String(i + 1)), h("span.mm-tab-q", q), h("span.mm-tab-sub", sub))));
  const sign = ["overview", "trends", "upcoming", "godot"];
  const body = {
    make: () => waitFor(["overview", "trends"], "Loading the niches…", makeView),
    sign: () => waitFor(sign, "Loading the games still to come out…", signTab),
    steam: () => waitFor(["overview", "growth"], "Loading Steam's history…", steamView),
    ideas: () => waitFor(["overview", ...NEEDS.ideas], "Loading the market data to score your ideas…", ideasTab),
  }[st.tab]();
  st.root.replaceChildren(
    waitFor(["overview", "trends"], "Loading today's briefing…", todayView),
    tabs, h("div.mm-body", { role: "tabpanel" }, body), detectionNote());
  window.scrollTo(0, y);
}

// Tab 2 lives in market-sign.js; a bug there shouldn't blank the whole page.
function signTab() {
  try { return signView(C, { overview: st.files.overview, trends: st.files.trends, upcoming: st.files.upcoming, godot: st.files.godot }, draw); }
  catch (e) { console.error(e); return C.h("p.mm-note", `This view couldn't draw: ${e.message}`); }
}

// Tab 4 lives in market-ideas.js; same guard.
function ideasTab() {
  try { return ideasView(C, { overview: st.files.overview, trends: st.files.trends, games: st.files.games, growth: st.files.growth }, draw); }
  catch (e) { console.error(e); return C.h("p.mm-note", `The ideas view couldn't draw: ${e.message}. The rest of the page still works.`); }
}

function waitFor(names, text, fn) {
  const h = C.h;
  const err = names.map((n) => st.errors[n]).find(Boolean);
  if (err) return h("p.mm-note", err, " ", btn("Try again", () => load(names)));
  if (names.some((n) => !st.files[n])) return h("p.mm-note", text);
  return fn();
}

function redrawKeeping(e) {
  const key = e?.target?.dataset?.key, pos = e?.target?.selectionStart;
  draw();
  if (!key) return;
  const el = st.root.querySelector(`[data-key="${key}"]`);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch {} }
}

// Jump to a niche's table row (from the Today box, a rising trend or an alert), pick it and open its line.
function pickTag(tag, { toggle = true } = {}) {
  if (toggle && st.sel === tag && st.tab === "make") { st.sel = null; draw(); return; }
  st.sel = tag;
  let rows = nichesNow();
  if (!rows.some((r) => r.tag === tag) && st.small) { st.small = false; save("small", false); rows = nichesNow(); }
  const q = st.q.trim().toLowerCase();
  if (q && !rows.some((r) => r.tag === tag && r.name.toLowerCase().includes(q))) st.q = "";
  const i = rows.findIndex((r) => r.tag === tag);
  if (i >= st.shown) st.shown = Math.ceil((i + 1) / 15) * 15;
  if (st.tab !== "make") goTab("make"); else draw();
  requestAnimationFrame(() => st.root?.querySelector(`.mm-nrow[data-tag="${tag}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

// --- small UI pieces -----------------------------------------------------------------

const h0 = (...a) => C.h(...a);
const btn = (label, onclick, extra = {}) => C.h("button.mm-btn", { type: "button", onclick, ...extra }, label);
const link = (href, label) => C.h("a.mm-link", { href, target: "_blank", rel: "noopener" }, label);
function seg(options, value, onChange, label) {
  return C.h("div.mm-seg", { role: "group", "aria-label": label }, ...options.map(([v, text]) => C.h("button", {
    type: "button", "aria-pressed": String(v === value), onclick: () => { onChange(v); draw(); },
  }, text)));
}
const toggle = (label, on, flip) => C.h("button.mm-toggle", { type: "button", "aria-pressed": String(on), onclick: () => { flip(); draw(); } }, h0("span.mm-check", on ? "✓" : ""), label);
const SURE_TIP = { solid: "Based on 100+ games", likely: "Based on 40 to 99 games", "thin data": "Based on fewer than 40 games: could be luck" };
const confPill = (conf, label) => C.h("span.mm-conf", { class: conf === "solid" ? "is-solid" : conf === "likely" ? "is-likely" : "is-thin", title: `${SURE_TIP[conf]}. The ± is a rough 90% range for the rate, in percentage points.` }, label);
const more = (shown, total, bump) => total > shown ? btn(`Show more (${num(total - shown)} more)`, () => { bump(); draw(); }, { class: "mm-more" }) : null;
const section = (title, sub, ...kids) => C.h("section.mm-section", C.h("h2", title), sub ? C.h("p.mm-sub", sub) : null, ...kids);
const badge = (text, kind) => C.h("span.mm-badge", { class: kind ? `mm-b-${kind}` : null }, text);
// A <details> that stays open across redraws.
function fold(key, summary, ...kids) {
  return C.h("details.mm-details", { open: st.open[key] || null, ontoggle: (e) => { st.open[key] = e.target.open; } }, C.h("summary", summary), ...kids);
}
// A bar inside a table cell: value 0..1 of the column's max, the number beside it.
const barCell = (frac, text, color = "var(--sw-1)") => C.h("td.mm-num", C.h("div.mm-barcell", C.h("span.mm-cbar", C.h("i", { style: `width:${clamp(frac) * 100}%;background:${color}` })), C.h("span", text)));
// A table with sortable headers. cols: [{key, label, tip, num}].
function sortTable(cols, rows, sort, onSort, cls = null) {
  const h = C.h;
  return h("div.mm-scroll", h("table.mm-table", { class: cls },
    h("thead", h("tr", ...cols.map((c) => h("th", { title: c.tip || null, class: c.num ? "mm-num" : null, "aria-sort": sort && c.key === sort.key ? (sort.dir > 0 ? "ascending" : "descending") : null },
      c.key && onSort ? h("button", { type: "button", onclick: () => onSort(c.key) }, c.label, sort?.key === c.key ? (sort.dir > 0 ? " ↑" : " ↓") : "") : c.label)))),
    h("tbody", ...rows)));
}

// A tooltip living inside a positioned box.
function tipFor(box) {
  let tip = box.querySelector(":scope > .mm-tip");
  if (!tip) { tip = C.h("div.mm-tip", { role: "status" }); box.append(tip); }
  return {
    show(nodes, ev) {
      tip.replaceChildren(...nodes.filter(Boolean));
      tip.style.display = "block";
      const b = box.getBoundingClientRect();
      let left = ev.clientX - b.left + 14, top = ev.clientY - b.top + 14;
      if (left + tip.offsetWidth > b.width - 6) left = ev.clientX - b.left - tip.offsetWidth - 14;
      if (top + tip.offsetHeight > b.height - 6) top = ev.clientY - b.top - tip.offsetHeight - 14;
      tip.style.left = `${Math.max(4, left)}px`; tip.style.top = `${Math.max(4, top)}px`;
    },
    hide() { tip.style.display = "none"; },
  };
}

function todayView() {
  const h = C.h;
  const items = memo(`today:${!!st.files.upcoming}:${!!st.files.godot}:${!!st.files.growth}:${!!st.files.games}`, () => todayItems({
    trends: st.files.trends, tagNames: tagNames(),
    upcoming: st.files.upcoming ? upLeads() : null,
    godot: st.files.godot ? relLeads() : null,
    growth: st.files.growth, games: st.files.games ? gamesList() : null,
  }));
  // Seen = shown and then clicked or expanded: the badge goes at once (no redraw), the item stays.
  const seen = (it, li) => { if (!isNew(it)) return; markSeen(it); li.querySelector(".mm-new")?.remove(); };
  const fresh = items.filter(isNew).length;
  return h("section.mm-today",
    h("div.mm-today-head", h("h2", "Today"), h("span.mm-sub", st.files.overview ? dayDate(today()) : ""),
      fresh ? h("span.mm-sub", { title: `Marked New until you click or open it. Seen items are forgotten after ${SEEN_DAYS} days.` }, `${fresh} new since you last looked`) : null),
    h("ul.mm-today-list", ...items.map((it) => {
      const badge = isNew(it) ? h("span.mm-new", { title: "You haven't opened this one yet." }, "New") : null;
      const li = h("li", {
        onpointerdown: () => seen(it, li),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") seen(it, li); },
      },
      h("span.mm-kind", { class: `k-${it.kind.toLowerCase()}` }, it.list ? `${it.kind}s` : it.kind),
      it.list
        ? h("div.mm-today-text", h("details.mm-today-fold", { open: st.open.breakouts || null, ontoggle: (e) => { st.open.breakouts = e.target.open; if (e.target.open) seen(it, li); } },
            h("summary", badge, it.text),
            h("p.mm-small.mm-tight", it.note),
            h("ol.mm-today-sub", ...it.list.map((b) => h("li", link(storeUrl(b.appid), b.name), h("span.mm-dim", ` · ${b.text}`))))))
        : h("div.mm-today-text", badge, it.text, " ",
          it.appid ? link(storeUrl(it.appid), "Store page ↗") : null,
          it.tag != null ? btn("Show", () => pickTag(it.tag, { toggle: false }), { class: "mm-inline" })
            : it.tab && it.tab !== st.tab ? btn("More", () => goTab(it.tab), { class: "mm-inline" }) : null));
      return li;
    })));
}

function detectionNote() {
  const o = st.files.overview;
  if (!o) return null;
  return C.h("p.mm-foot", `Godot detection: ${num(o.withMetadata)} of ${num(o.games)} games checked so far (${pct(o.withMetadata / o.games)}); the rest are checked over the coming days, so more Godot games will appear. ${num(o.historyDays)} ${o.historyDays === 1 ? "day" : "days"} of daily history so far.`);
}

// --- 1. What should I make next? ------------------------------------------------------

function makeView() {
  const h = C.h, t = st.files.trends;
  // Files built by an older market.py lack hitGames, topReviews and the rest the niches need.
  if (t && t.priorGames == null) return h("div", h("p.mm-note.mm-stale",
    h("b", "The server's market files are from an older version."), " They're rebuilt every night at 04:00 Swedish time with the current code; to see this tab now, rebuild them on the server: ",
    h("code", "sudo systemctl start steamdata-market")));
  const all = nichesNow();
  return h("div",
    filterBar(),
    risingSection(),
    section("The 25 best niches right now",
      `Ranked by the opportunity score (0–100). A hit is a game in the top 10% by reviews among the games released the same fortnight (on Steam, ${oneIn(t.baseHitRate)}).`,
      scoreBars(all)),
    section("Every niche: rivals against hit chance", "Up and to the left is where you want to be: few new games to compete with, and many of them become hits. Click a dot to pick a tag.",
      scatterCard(all, t.baseHitRate)),
    nicheTable(all, t),
    gapBlock());
}

// One switch for the whole tab, saying what it changes.
function filterBar() {
  const h = C.h;
  return h("div.mm-filterbar",
    toggle("Small-team niches only", st.small, () => { st.small = !st.small; save("small", st.small); }),
    h("span.mm-filterbar-t",
      st.small ? h("span", { title: [...HUGE, ...BIG].join(", ") }, "Leaves out big-build tags (MMO, open world, multiplayer, 3D…). ") : "Every tag, big builds included. ",
      h("b", "Applies to everything on this tab:"), " rising trends, the score bars, the chart, the niche table and the gap finder."));
}

// Select a tag everywhere on the tab (dot, bar and table row) without scrolling away.
function selectTag(tag) { st.sel = st.sel === tag ? null : tag; draw(); }

// Green is good for you: fewer rivals coming. Orange: more new games joining every month.
const DIR_COLOR = (r) => r.dir < 0 ? "var(--sw-3)" : r.dir > 0 ? "var(--sw-2)" : "var(--fb-muted)";
const DIR_WORDS = [
  ["var(--sw-3)", "Fewer rivals coming: its share of new Steam games is down 10% or more on a year ago"],
  ["var(--fb-muted)", "Same crowding as a year ago: its share of new Steam games is within 10% of a year ago"],
  ["var(--sw-2)", "More rivals coming: its share of new Steam games is up 10% or more on a year ago"],
];
const DIR_TIP = "Its share of all Steam releases in the last 90 days, against the same 90 days a year ago.";
const dirLegend = (what) => [C.h("b", `${what} color:`), ...DIR_WORDS.map(([c, w]) => C.h("span", { title: DIR_TIP }, C.h("i.mm-key", { style: `background:${c}` }), w))];

// "New games collect about 3.1 reviews a month (×1.8 Steam's pace)", for the tooltip.
function paceLine(r) {
  if (!st.files.games) return null;
  const p = reviewPace().tags.get(r.tag);
  const demand = r.demand != null ? ` · share of new reviews ${times(r.demand)} the window before` : "";
  return p ? C.h("div", `New games collect ${p.rate < 10 ? p.rate.toFixed(1) : fmtK(p.rate)} reviews a month (${times(p.ratio)} Steam's pace)${demand}`) : demand ? C.h("div", demand.slice(3)) : null;
}

// " (52 opportunity + 9 growth)": the score's two bar parts in points.
function scoreSplit(r) {
  if (!r.parts) return [];
  const g = SCORE_WEIGHTS.growth * r.parts.growth, all = Object.keys(SCORE_WEIGHTS).reduce((a, k) => a + SCORE_WEIGHTS[k] * r.parts[k], 0) || 1;
  const gp = Math.round((g / all) * r.score);
  return [` (${r.score - gp} opportunity + ${gp} growth)`];
}
function tagTip(r) {
  const h = C.h, gl = glossary(r.name);
  return [h("div.mm-tip-t", r.name), gl ? h("div.mm-tip-raw", gl) : null, h("div", "Opportunity score ", h("b", String(r.score)), "/100", ...scoreSplit(r)),
    h("div", h("b", pct(r.hitRate)), ` become hits (${times(r.lift)} Steam's)`),
    h("div", `${fmtK(r.releases)} new games in 90 days · ${growthWords(r.supply)}`),
    h("div", `Typical game ${fmtK(r.medianReviews)} reviews, top 10% ${fmtK(r.topReviews)}`),
    paceLine(r),
    h("div.mm-tip-raw", `How sure: ${r.sure} (${num(r.hitGames)} games)`)];
}

// --- Rising now ---

const STAGE = { early: "Early", crowded: "Getting crowded", late: "Late" };
const STAGE_TIP = {
  early: `Under ${pct(RISE_RULES.earlyShare, 1)} of new releases and the rise only started lately: few rivals yet.`,
  crowded: "A sizable share of releases already, or it was rising the year before too: others got there first.",
  late: `${pct(RISE_RULES.lateShare, 1)} or more of all new releases: the rush has arrived.`,
};

function sparkline(vals, label) {
  const svgEl = C.svgEl, W = 120, H = 30, n = vals.length, max = Math.max(...vals, 1e-9);
  const x = (i) => 1.5 + (i * (W - 5)) / Math.max(1, n - 1), y = (v) => H - 2 - (v / max) * (H - 6);
  const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-spark", role: "img", "aria-label": label });
  svg.append(svgEl("rect", { x: x(n - 3) - 2, y: 0, width: x(n - 1) - x(n - 3) + 4, height: H, class: "mm-spark-now" }),
    svgEl("path", { d: `${d}L${x(n - 1).toFixed(1)},${H - 1}L${x(0).toFixed(1)},${H - 1}Z`, class: "mm-spark-area" }),
    svgEl("path", { d, class: "mm-spark-line" }),
    svgEl("circle", { cx: x(n - 1), cy: y(vals[n - 1]), r: 2.6, class: "mm-spark-dot" }));
  const tt = svgEl("title"); tt.textContent = label; svg.append(tt);
  return svg;
}

function risingSection() {
  const h = C.h, title = "Rising now: jump in early";
  if (st.errors.growth) return section(title, null, h("p.mm-note", st.errors.growth, " ", btn("Try again", () => load(["growth"]))));
  if (!st.files.growth) return section(title, null, h("p.mm-note", "Loading the monthly release counts…"));
  const rows = risingRows();
  const g = st.files.growth;
  const sub = h("p.mm-sub", h("b", "How it's ranked: "), "best chances first. ", h("b", "Early"), " rises come first, then ", h("b", "Getting crowded"),
    ", and ", h("b", "Late"), " ones are folded away at the end. Within each stage, the tag whose share of new Steam releases is climbing fastest (the last 3 full months against the 12 before) comes first.",
    " Only tags whose games still become hits at least as often as Steam's are listed; a rise carried by one or two big releases is left out.",
    st.small ? "" : " Big-build tags (MMO, open world, multiplayer…) are in, marked \u201cbig build\u201d.");
  if (!rows.length) return h("section.mm-section", h("h2", title), sub, h("p.mm-note", "Nothing is rising fast right now with these settings."));
  const [from, to] = [rows[0].months[0], rows[0].months.at(-1)];
  const active = rows.filter((r) => r.stage !== "late"), late = rows.filter((r) => r.stage === "late");
  const row = (r, i) => {
    const act = riseAction(r, r.stage === "crowded" && st.files.games ? anglePair(r.tag) : null);
    return h("li.mm-rise-row", { class: r.tag === st.sel ? "is-sel" : null },
      h("div.mm-rise-side", h("span.mm-rise-n", `${i + 1}`),
        h("span.mm-stage", { class: `is-${r.stage}`, title: STAGE_TIP[r.stage] }, STAGE[r.stage]),
        r.big ? h("span.mm-stage.is-big", { title: "A big-build tag (in the MMO / open world / multiplayer / 3D lists): hard for a small team, whatever its stage." }, "big build") : null),
      h("div.mm-rise-main",
        h("button.mm-linkbtn", { type: "button", title: glossary(r.name) ? `${r.name}: ${glossary(r.name)}` : "Show it in the niche table", onclick: () => pickTag(r.tag, { toggle: false }) }, r.name),
        glossary(r.name) ? h("span.mm-dim", { title: glossary(r.name) }, " ⓘ") : null,
        h("p.mm-rise-words", r.words),
        h("p.mm-rise-act", { class: `is-${r.stage}` }, h("b", act.lead), " ", act.rest,
          act.pair ? h("span.mm-dim", ` (${pct(act.pair.hit)} hit chance, ${plural(act.pair.n, "game")}, ${act.pair.recent} new in 90 days)`) : null)),
      sparkline(r.spark, `${r.name}: ${pct(r.spark[0], 2)} of Steam's releases in ${monthName(from)}, ${pct(r.spark.at(-1), 2)} in ${monthName(to)}`));
  };
  return h("section.mm-section", h("h2", title), sub,
    active.length ? h("ol.mm-rise", ...active.map(row)) : h("p.mm-note", "No early or getting-crowded rise right now: only late ones."),
    late.length ? fold("rise-late", h("span", h("b", `Already late (${late.length})`), h("span.mm-late-arrow", " ▸"), h("span.mm-dim", ` the rush has arrived: ${pct(RISE_RULES.lateShare, 1)}+ of all new releases`)),
      h("ol.mm-rise", ...late.map((r, i) => row(r, active.length + i)))) : null,
    h("p.mm-small", `Lines: each tag's share of all Steam releases per month, ${monthName(from)} to ${monthName(to)} (its own scale; the shaded end is the last 3 months). ${g.monthDone > 0 && g.monthDone < 1 ? "This month is still going, so it's left out. " : ""}Stages: `,
      ...Object.keys(STAGE).flatMap((k, i) => [i ? "; " : "", h("b", STAGE[k]), ` ${STAGE_TIP[k].charAt(0).toLowerCase()}${STAGE_TIP[k].slice(1, -1)}`]),
      ". The angle is the best-scoring tag pair with it in the gap finder below."));
}
const monthName = (ym) => { const [y, m] = String(ym).split("-"); return `${MONTHS[Number(m) - 1]} ${y}`; };

// --- Score bars (top 25) ---

// A bar in two parts: opportunity (hit chance, reviews per game and few rivals together) in blue, and
// growth on top in the niche's direction, so "growing" no longer paints the whole bar. The exact
// split is in the tooltip.
const BAR_PARTS = [["opp", ["hit", "typical", "quiet"]], ["growth", ["growth"]]];

function scoreBars(rows) {
  const h = C.h, svgEl = C.svgEl;
  const top = [...rows].sort((a, b) => b.score - a.score).slice(0, 25);
  if (!top.length) return h("p.mm-note", "No niche to show.");
  const W = 760, H = 300, M = { top: 8, right: 52, bottom: 104, left: 30 };
  const base = H - M.bottom, ymax = 100, mid = median(rows.map((r) => r.score));
  const bw = (W - M.left - M.right) / top.length;
  const y = (v) => base - (v / ymax) * (base - M.top);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-svg mm-bars-svg", role: "img", "aria-label": "The 25 best niches by opportunity score" });
  const text = (attrs, s, parent = svg) => { const el = svgEl("text", attrs); el.textContent = s; parent.append(el); return el; };
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: v ? "mm-grid" : "mm-base" }));
    text({ x: M.left - 5, y: y(v) + 4, "text-anchor": "end", class: "mm-axis" }, String(v));
  }
  top.forEach((r, i) => {
    const on = r.tag === st.sel, cx = M.left + (i + 0.5) * bw, w = bw * 0.74, top_ = y(r.score);
    const g = svgEl("g", { class: `mm-barg${on ? " is-sel" : ""}`, "data-tag": r.tag, tabindex: "0", role: "button", "aria-label": `${r.name}: score ${r.score}. Pick it.` });
    // The bar as a stack of its score parts, scaled so they add up to the score; the growth part on
    // top, colored by where the niche is heading.
    const pts = BAR_PARTS.map(([, ks]) => ks.reduce((a, k) => a + SCORE_WEIGHTS[k] * (r.parts?.[k] ?? 0), 0));
    const sum = pts.reduce((a, b) => a + b, 0) || 1;
    const clip = `mm-bc-${i}`;
    const cp = svgEl("clipPath", { id: clip });
    cp.append(svgEl("rect", { x: cx - w / 2, y: top_, width: w, height: base - top_, rx: 3 }));
    g.append(cp);
    const stack = svgEl("g", { "clip-path": `url(#${clip})` });
    let at = base;
    BAR_PARTS.forEach(([k], j) => {
      const v = (pts[j] / sum) * r.score, hgt = base - y(v);
      if (hgt <= 0) return;
      stack.append(svgEl("rect", { x: cx - w / 2, y: at - hgt, width: w, height: hgt, fill: k === "growth" ? DIR_COLOR(r) : "var(--sw-1)", class: "mm-bar-seg" }));
      at -= hgt;
    });
    g.append(stack);
    if (on) g.append(svgEl("rect", { x: cx - w / 2 - 2, y: top_ - 2, width: w + 4, height: base - top_ + 2, rx: 4, class: "mm-bar-selbox" }));
    text({ x: cx, y: top_ - 5, "text-anchor": "middle", class: "mm-barval-out" }, String(r.score), g);
    const name = r.name.length > 17 ? `${r.name.slice(0, 16)}…` : r.name;
    text({ x: cx + 4, y: base + 10, "text-anchor": "end", transform: `rotate(-55 ${cx + 4} ${base + 10})`, class: `mm-barname${on ? " is-sel" : ""}` }, name, g);
    g.append(svgEl("rect", { x: cx - bw / 2, y: M.top, width: bw, height: H - M.top, fill: "transparent" }));
    g.__row = r;
    svg.append(g);
  });
  // The median score of every listed tag, drawn over the bars, named in the right margin.
  if (mid != null) {
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(mid), y2: y(mid), class: "mm-ref mm-ref-bars" }));
    text({ x: W - M.right + 6, y: y(mid) - 2, class: "mm-axis" }, "Median");
    text({ x: W - M.right + 6, y: y(mid) + 11, class: "mm-axis" }, String(Math.round(mid)));
  }
  const box = h("div.mm-chart",
    h("div.mm-legend", h("span", h("i.mm-key", { style: "background:var(--sw-1)" }), h("b", "Opportunity"), ": hit chance, reviews per game and few rivals"),
      h("span", h("b", "Growth"), " on top, colored by where the niche is heading:")),
    h("div.mm-legend", ...dirLegend("Growth"),
      h("span", h("i.mm-key.mm-key-selbox"), "The tag you picked (click a bar, dot or row to pick one)")),
    h("div.mm-hscroll", svg),
    h("p.mm-small.mm-tight", h("b", "Opportunity score. "), SCORE_TEXT, ` The dashed line is the median score of all ${rows.length} listed tags. Hover a bar for the full breakdown. Click a bar to pick that tag.`));
  wireChart(svg, box, ".mm-barg");
  return box;
}

// Hover tooltips and click-to-pick for the bars and the dots.
function wireChart(svg, box, sel) {
  const tip = tipFor(box);
  const find = (ev) => ev.target.closest?.(sel)?.__row || ev.target.closest?.(".mm-dl")?.__row;
  svg.addEventListener("pointermove", (ev) => { const r = find(ev); if (!r) return tip.hide(); tip.show(tagTip(r), ev); });
  svg.addEventListener("pointerleave", () => tip.hide());
  svg.addEventListener("click", (ev) => { const r = find(ev); if (r) selectTag(r.tag); });
  svg.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { const r = find(ev); if (r) { ev.preventDefault(); selectTag(r.tag); } } });
}

// --- The scatter: every tag as a dot sized by a typical game's reviews, brightness by review pace ---

// Dot radius: area grows with a typical game's reviews (sqrt scale), with a floor so 0 still shows.
const R_MIN = 3, R_MAX = 13;
const dotR = (v, vmax) => Math.sqrt(R_MIN ** 2 + (R_MAX ** 2 - R_MIN ** 2) * clamp((v || 0) / Math.max(1, vmax)));

function scatterCard(rows, base) {
  const h = C.h, svgEl = C.svgEl, sel = rows.find((r) => r.tag === st.sel) || null;
  if (!rows.length) return null;
  const pace = st.files.games ? reviewPace() : null;
  const W = 760, H = 440, M = { top: 16, right: 64, bottom: 52, left: 58 };
  const xs = rows.map((r) => Math.max(1, r.releases));
  const lx0 = Math.log10(Math.max(1, Math.min(...xs) * 0.8)), lx1 = Math.log10(Math.max(...xs) * 1.2);
  const ymax = niceMax(Math.max(...rows.map((r) => r.hitRate), base * 2) * 1.06);
  const vmax = Math.max(...rows.map((r) => r.medianReviews || 0), 1);
  const x = (v) => M.left + ((Math.log10(Math.max(1, v)) - lx0) / (lx1 - lx0)) * (W - M.left - M.right);
  const y = (v) => H - M.bottom - (v / ymax) * (H - M.top - M.bottom);
  const xSplit = median(xs), ySplit = base * 1.5;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-svg", role: "img", "aria-label": "Every tag: new games in 90 days against hit chance; dot size is a typical game's reviews, how solid a dot is shows how fast new games collect reviews" });
  const text = (attrs, s) => { const el = svgEl("text", attrs); el.textContent = s; svg.append(el); return el; };
  // The most attractive corner: few rivals, high hit chance. Named in the legend, never written on.
  svg.append(svgEl("rect", { x: M.left, y: M.top, width: x(xSplit) - M.left, height: y(ySplit) - M.top, rx: 8, class: "mm-gapzone" }));
  const yStep = ymax / 5;
  for (let k = 0; k <= 5; k++) {
    const v = yStep * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mm-grid" : "mm-base" }));
    text({ x: M.left - 7, y: y(v) + 4, "text-anchor": "end", class: "mm-axis" }, pct(v));
  }
  for (const v of [10, 20, 50, 100, 200, 500, 1000, 2000, 5000]) {
    if (Math.log10(v) < lx0 || Math.log10(v) > lx1) continue;
    svg.append(svgEl("line", { x1: x(v), x2: x(v), y1: M.top, y2: H - M.bottom, class: "mm-grid" }));
    text({ x: x(v), y: H - M.bottom + 16, "text-anchor": "middle", class: "mm-axis" }, fmtK(v));
  }
  text({ x: (M.left + W - M.right) / 2, y: H - 8, "text-anchor": "middle", class: "mm-axis mm-axis-title" }, "New games with the tag in the last 90 days (log scale)");
  text({ x: M.left, y: H - 8, class: "mm-axis mm-axis-end" }, "← fewer rivals");
  text({ x: W - M.right, y: H - 8, "text-anchor": "end", class: "mm-axis mm-axis-end" }, "more rivals →");
  const yt = (M.top + H - M.bottom) / 2;
  text({ x: 14, y: yt, "text-anchor": "middle", transform: `rotate(-90 14 ${yt})`, class: "mm-axis mm-axis-title" }, "Hit chance (share of games that become hits)");
  svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(base), y2: y(base), class: "mm-ref" }));
  text({ x: W - M.right + 6, y: y(base) - 2, class: "mm-axis" }, "All Steam");
  text({ x: W - M.right + 6, y: y(base) + 11, class: "mm-axis" }, pct(base));
  // Dots: big ones first so small ones stay on top and clickable; the picked one last.
  const geo = new Map(rows.map((r) => [r, { cx: x(r.releases), cy: y(r.hitRate), r: dotR(r.medianReviews, vmax), lv: pace ? paceLevel(pace.tags.get(r.tag)?.ratio) : null }]));
  const dots = svgEl("g");
  const order0 = [...rows].sort((a, b) => geo.get(b).r - geo.get(a).r);
  for (const r of [...order0.filter((r) => r !== sel), ...(sel ? [sel] : [])]) {
    const { cx, cy, r: R, lv } = geo.get(r), on = r === sel;
    const g = svgEl("g", { class: `mm-dot${on ? " is-sel" : ""}`, "data-tag": r.tag, tabindex: "0", role: "button", "aria-label": `${r.name}: hit chance ${pct(r.hitRate)}, ${r.releases} new games in 90 days, typical game ${fmtK(r.medianReviews)} reviews. Pick it.` });
    if (on) g.append(svgEl("circle", { cx, cy, r: R + 7, class: "mm-sel-ring" }));
    g.append(svgEl("circle", { cx, cy, r: R, fill: on ? "var(--fb-accent)" : DIR_COLOR(r), class: "mm-dot-c", style: lv == null || on ? null : `--op:${PACE_OPACITY[lv]}` }));
    g.append(svgEl("circle", { cx, cy, r: Math.max(R + 3, 9), fill: "transparent" }));
    g.__row = r;
    dots.append(g);
  }
  svg.append(dots);
  // Labels: as many as fit, beside, above or below the dot, skipped where they'd cover another label
  // or a dot. Dots that sit almost on top of each other share one label ("FMV + Psychological Horror").
  // Order: the picked tag, then the most attractive corner (shared labels first; these may cover small
  // dots, on a halo), then the rest by score.
  const CH = 5.9, LH = 11;
  const inZone = (r) => r.releases <= xSplit && r.hitRate >= ySplit;
  const lead = new Map(), members = new Map();
  for (const r of order0) {
    const a = geo.get(r);
    const host = [...members.keys()].find((l) => { const b = geo.get(l); return Math.hypot(a.cx - b.cx, a.cy - b.cy) < 0.6 * Math.max(a.r, b.r); });
    if (host) { members.get(host).push(r); lead.set(r, host); } else { members.set(r, [r]); lead.set(r, r); }
  }
  // The label's wordings, longest first: a shared label falls back to "FMV + 1 more" where the full one won't fit.
  const labelTexts = (r) => {
    const g = members.get(r) || [r];
    if (g.length === 1) return [r.name];
    const rest = g.filter((m) => m !== r);
    return [rest.length === 1 ? `${r.name} + ${rest[0].name}` : `${r.name} + ${rest[0].name} + ${rest.length - 1} more`, `${r.name} + ${rest.length} more`];
  };
  const dotBoxes = rows.map((r) => { const { cx, cy, r: R } = geo.get(r); const e = R + 3; return [cx - e, cy - e, cx + e, cy + e, r]; });
  const bigBoxes = dotBoxes.filter((p) => geo.get(p[4]).r > 5);
  const hits = (b, boxes, own) => boxes.some((p) => !(own && own.includes(p[4])) && b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
  const placed = [];
  const leaders = rows.filter((r) => lead.get(r) === r);
  const selLead = sel ? lead.get(sel) : null;
  const order = [...(selLead ? [selLead] : []),
    ...leaders.filter((r) => r !== selLead && inZone(r)).sort((a, b) => members.get(b).length - members.get(a).length || b.score - a.score),
    ...leaders.filter((r) => r !== selLead && !inZone(r)).sort((a, b) => b.score - a.score)];
  for (const r of order) {
    const { cx, cy, r: R } = geo.get(r), on = r === selLead, zone = inZone(r), own = members.get(r);
    // Tries each wording in each spot, first keeping clear of dots; in the corner, then over any dot
    // (the halo keeps it readable), never over another label.
    let box = null, name = null;
    for (const avoid of zone ? [bigBoxes, []] : [dotBoxes]) {
      for (const t of labelTexts(r)) {
        const w = t.length * (on ? CH * 1.15 : CH) + 2;
        const spots = [[cx + R + 4, cy - LH / 2 - 1], [cx - R - 4 - w, cy - LH / 2 - 1], [cx - w / 2, cy - R - 3 - LH], [cx - w / 2, cy + R + 3]];
        for (const [left, top_] of spots) {
          const b = [left, top_, left + w, top_ + LH + 1, r];
          if (b[0] < M.left + 1 || b[2] > W - M.right - 1 || b[1] < M.top || b[3] > H - M.bottom) continue;
          if (!on && (hits(b, avoid, own) || hits(b, placed, null))) continue;
          box = b; break;
        }
        if (box) { name = t; break; }
      }
      if (box) break;
    }
    if (!box) continue;
    placed.push(box);
    const label = text({ x: box[0], y: box[1] + LH - 1.6, class: `mm-dl${on ? " mm-dl-sel" : ""}${zone ? " mm-dl-zone" : ""}` }, name);
    label.__row = r;
    const tt = svgEl("title");
    tt.textContent = own.map((m) => { const gl = glossary(m.name); return gl ? `${m.name}: ${gl}` : m.name; }).join("\n");
    label.append(tt);
  }
  // Keys: three example sizes, and the pace brightness at its levels, drawn with the same functions as the chart.
  const keySvg = (items) => {
    const k = svgEl("svg", { class: "mm-keysvg", viewBox: `0 0 ${items.length * 34} 34`, width: items.length * 34, height: 34, "aria-hidden": "true" });
    items.forEach((draw, i) => draw(k, 17 + i * 34, 17));
    return k;
  };
  const sizes = [...new Set([5, 20, Math.max(40, Math.round(vmax / 10) * 10)].filter((v) => v <= vmax * 1.2))];
  const sizeKey = h("span.mm-keygroup", h("span", h("b", "Dot size"), ": reviews a typical (median) game in the tag gets"),
    ...sizes.map((v) => h("span.mm-keyitem", keySvg([(k, cx, cy) => k.append(svgEl("circle", { cx, cy, r: dotR(v, vmax), class: "mm-key-dot" }))]), fmtK(v))));
  const ringKey = pace ? h("span.mm-keygroup", h("span", h("b", "Brightness"), `: how fast the tag's newest games (out 2 weeks to 3 months) are collecting reviews, against a typical new Steam game (${pace.base.toFixed(1)} reviews a month). More solid dot = reviews coming in faster.`),
    ...[0, 1, 2, 3].map((lv) => h("span.mm-keyitem", keySvg([(k, cx, cy) => {
      k.append(svgEl("circle", { cx, cy, r: 7, class: "mm-key-dot mm-key-pace", style: `--op:${PACE_OPACITY[lv]}` }));
    }]), PACE_WORDS[lv])))
    : h("span.mm-keygroup.mm-dim", "Brightness (review pace) appears once the release list has loaded.");
  const box = h("div.mm-chart",
    h("div.mm-legend",
      h("span", h("i.mm-key.mm-key-zone"), h("b", "Most attractive corner"), `: fewer new games than half the tags, and ${times(1.5)} Steam's hit chance or better`)),
    h("div.mm-legend",
      ...dirLegend("Dot"),
      h("span", h("i.mm-key.mm-key-sel"), "The tag you picked (click a dot, bar or row to pick one)")),
    h("div.mm-legend.mm-legend-keys", sizeKey, ringKey),
    h("div.mm-hscroll", svg),
    h("p.mm-small.mm-tight", `Each dot is a tag (${rows.length} shown). Labels show where they fit; hover any dot for its numbers.`),
    sel ? h("div.mm-picked", h("span", "Picked: ", h("b", sel.name), ` · score ${sel.score} · ${pct(sel.hitRate)} become hits · ${fmtK(sel.releases)} new in 90 days`),
      btn("Show in the table ↓", () => pickTag(sel.tag, { toggle: false })), btn("Clear", () => selectTag(sel.tag)))
      : h("p.mm-small.mm-tight", "Nothing picked: click a dot, a bar or a table row."));
  wireChart(svg, box, ".mm-dot");
  return box;
}

// --- The ranked niche table (a row click opens a line in plain words) ---

function nicheTable(all, t) {
  const h = C.h, win = t.supplyWindow || 90;
  const q = st.q.trim().toLowerCase();
  const rows = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
  const shown = rows.slice(0, q ? Math.max(40, st.shown) : st.shown);
  const maxHit = Math.max(t.baseHitRate * 2, ...all.slice(0, 200).map((r) => r.hitRate));
  const best = st.files.games ? bestRecent() : null;
  const arrow = (r) => r.dir > 0 ? h("span.mm-up", " ↑") : r.dir < 0 ? h("span.mm-down", " ↓") : h("span.mm-dim", " →");
  const COLS = 8;
  const body = [];
  for (const r of shown) {
    const on = r.tag === st.sel, gl = glossary(r.name);
    body.push(h("tr.mm-nrow", { "data-tag": String(r.tag), class: on ? "is-sel" : null, tabindex: "0", "aria-expanded": String(on),
      onclick: () => selectTag(r.tag), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTag(r.tag); } } },
      h("td.mm-num.mm-dim", String(all.indexOf(r) + 1)),
      h("td", { title: gl ? `${r.name}: ${gl}` : null }, h("b", r.name), gl ? h("span.mm-dim", " ⓘ") : null),
      h("td.mm-num", { title: SCORE_TEXT }, h("div.mm-barcell", h("span.mm-cbar.mm-cbar-w", h("i", { style: `width:${clamp(r.score / 100) * 100}%;background:var(--sw-1)` })), h("b", String(r.score)))),
      h("td.mm-num", { title: `${num(r.hits)} of ${num(r.hitGames)} recent games became hits; pulled toward Steam's rate for fairness.` },
        h("div.mm-barcell", h("span.mm-cbar.mm-vs", h("i", { style: `width:${clamp(r.hitRate / maxHit) * 100}%;background:${r.lift >= 1.5 ? "var(--sw-3)" : "var(--sw-1)"}` }), h("b", { style: `left:${clamp(t.baseHitRate / maxHit) * 100}%` })),
          h("span", h("b", pct(r.hitRate)), h("span.mm-dim", ` ${times(r.lift)}`)))),
      h("td.mm-num", fmtK(r.medianReviews)),
      h("td.mm-num", fmtK(r.topReviews)),
      h("td.mm-num", { title: `${fmtK(r.releasesYearAgo)} in the same ${win} days a year ago: ${growthWords(r.supply)}.` }, fmtK(r.releases), arrow(r)),
      h("td", confPill(r.conf, r.sure))));
    if (on) {
      const games = best?.get(r.tag) || [];
      body.push(h("tr.mm-ndetail", h("td", { colspan: COLS },
        gl ? h("p.mm-gloss", gl) : null,
        h("p", `${num(r.hits)} of its ${num(r.hitGames)} recent games became hits: about ${oneIn(r.hitRate)}, against ${oneIn(t.baseHitRate)} on Steam. A typical one gets ${plural(r.medianReviews, "review")}; one in its best 10% gets ${num(r.topReviews)}. ${num(r.releases)} came out in the last ${win} days (${num(r.releasesYearAgo)} a year ago): ${growthWords(r.supply)}. ${r.why}`),
        games.length ? h("p.mm-line", "Best recent games: ", ...games.flatMap((g, i) => [i ? ", " : "", link(storeUrl(g.appid), g.name), h("span.mm-dim", ` (${fmtK(g.reviews)} reviews, ${dayShort(g.day)} ${new Date(g.day * DAY * 1000).getUTCFullYear()})`)]), ".")
          : st.files.games ? null : h("p.mm-small.mm-tight", "Loading its best recent games…"),
        h("div.mm-controls", btn("Unpick", () => selectTag(r.tag))))));
    }
  }
  const cols = [
    { label: "#" }, { label: "Niche", tip: "Hover a name with ⓘ for what it means." },
    { label: "Score", num: true, tip: SCORE_TEXT },
    { label: "Hit chance", num: true, tip: `Share of its recent games in the top 10% of their release fortnight, against Steam's ${pct(t.baseHitRate)} (the black tick). ×: how many times Steam's.` },
    { label: "Typical game", num: true, tip: "Median reviews of its recent games: what an ordinary one gets." },
    { label: "Top 10%", num: true, tip: "Reviews of a game in its best 10%." },
    { label: `New in ${win} days`, num: true, tip: `Games released with the tag in the last ${win} days. Arrow: more (↑) or fewer (↓) than a year ago, as a share of Steam's releases.` },
    { label: "How sure", tip: "By how many games the hit chance stands on: solid 100+, likely 40+, thin data fewer. ± is a rough 90% range." },
  ];
  return section("Every niche, ranked",
    "Click a row for what its numbers mean and its best recent games.",
    h("div.mm-controls",
      seg([["best", "Best overall"], ["quiet", "Least crowded"]], st.sort, (v) => { st.sort = v; st.shown = 15; save("sort", v); }, "Sort niches"),
      h("input.mm-input", { type: "search", "data-key": "niche-q", value: st.q, placeholder: "Find a tag", "aria-label": "Find a tag", oninput: (e) => { st.q = e.target.value; redrawKeeping(e); } }),
      h("span.mm-small.mm-inline-note", st.sort === "quiet" ? `Fewest new games first, among tags with at least ${times(1.5)} Steam's hit chance.` : "Highest opportunity score first.")),
    rows.length ? sortTable(cols, body, null, null, "mm-ntable") : h("p.mm-note", "No tag matches."),
    q ? null : more(st.shown, rows.length, () => { st.shown += 15; }));
}

// The best recent games per tag (released in the last year, by reviews), for the table's detail lines.
function bestRecent() {
  return memo("bestRecent", () => {
    const d = today(), adult = adultIds(), out = new Map();
    for (const g of gamesList()) {
      if (d - g.day > 365 || d - g.day < 0 || isJoke(g.name) || g.top.some((t) => adult.has(t))) continue;
      for (const t of g.top) {
        let l = out.get(t);
        if (!l) out.set(t, l = []);
        if (l.length < 3 || g.reviews > l[2].reviews) { l.push(g); l.sort((a, b) => b.reviews - a.reviews); if (l.length > 3) l.pop(); }
      }
    }
    return out;
  });
}

// --- The gap finder lives in market-gaps.js ---

function gapBlock() {
  const h = C.h, title = "Tag pairs: the gap finder";
  if (st.errors.games) return section(title, null, h("p.mm-note", st.errors.games, " ", btn("Try again", () => load(["games"]))));
  if (!st.files.games) return section(title, null, h("p.mm-note", "Loading three years of releases (a few MB, once)…"));
  try { return gapView(C, { overview: st.files.overview, trends: st.files.trends, games: st.files.games }, { small: st.small }, draw); }
  catch (e) { console.error(e); return section(title, null, h("p.mm-note", `The gap finder couldn't draw: ${e.message}`)); }
}

// --- 3. How is Steam doing? ------------------------------------------------------------

function steamView() {
  const h = C.h, g = st.files.growth, s = growthNow();
  const out = [];
  if (!s) out.push(h("p.mm-note", "No player numbers yet."));
  else {
    const chart = lineChart({
      labels: s.years.map(String), yLabel: `${s.years[0]} = 100`, fmt: (v) => v == null ? "–" : String(Math.round(v)),
      series: [
        { name: "Games released", color: "var(--sw-1)", values: s.relIdx, raw: s.rel, rawFmt: (v) => `${num(v)} games`, pace: s.partial },
        { name: "Steam's peak players", color: "var(--sw-3)", values: s.usersIdx, raw: s.users, rawFmt: (v) => `${short(v)} players` },
        s.q ? { name: `Games with ${s.qMin}+ reviews`, color: "var(--sw-2)", values: s.qIdx, raw: s.q, rawFmt: (v) => `${num(v)} games`, pace: s.partial } : null,
      ].filter(Boolean),
      note: [
        s.partial ? `${s.years.at(-1)} is still going: its games lines are dashed, this year's pace for a whole year (${num(s.sofar)} out so far${s.q ? `, ${num(s.qSofar)} with ${s.qMin}+ reviews` : ""}).` : null,
        s.q ? `"Games with ${s.qMin}+ reviews" counts the real competition, not every low-effort release. Recent games have had less time to collect reviews, so the last year or two undercount.` : null,
      ].filter(Boolean).join(" ") || null,
    });
    out.push(section("More games, or more players?", null,
      h("p.mm-big", s.sentence),
      s.q || st.files.growth?.total?.q ? h("div.mm-controls", h("span.mm-small.mm-inline-note", "Third line: games with at least"),
        seg(REVIEW_STEPS.map((v) => [v, `${v} reviews`]), st.qMin, (v) => { st.qMin = v; save("qMin", String(v)); }, "Reviews needed")) : null,
      chartCard(chart),
      fold("sources", "Where the player numbers come from",
        h("p.mm-line", "Steam's all-time record of users online at once as of each year's end, as Valve reported it at the time (quoted in the press). From November 2026 the server keeps each day's peak from Steam's own stats feed."),
        h("ul.mm-sources", ...(g.users.records || []).map((r) => h("li", `${r.date}: ${short(r.users)} `, link(r.source, "source")))))));
  }
  out.push(releasesSection(), alertsFold());
  return h("div", ...out);
}

function releasesSection() {
  const h = C.h, f = st.rel, title = "What's doing well right now";
  if (st.errors.games) return section(title, null, h("p.mm-note", st.errors.games, " ", btn("Try again", () => load(["games"]))));
  if (!st.files.games) return section(title, null, h("p.mm-note", "Loading the recent releases (a few MB, once)…"));
  const d = today();
  const list = memo(`releases:${JSON.stringify(f)}`, () => releasesList(gamesList(), d, f, adultIds()));
  const names = tagNames();
  const set = (k, v) => { f[k] = v; st.relShown = 25; save("rel", f); };
  const rows = list.slice(0, st.relShown).map((g) => h("tr",
    h("td", link(storeUrl(g.appid), g.name), g.flags & F.godot ? badge("Godot", "godot") : null),
    barCell(g.hit / 100, String(g.hit), g.hit >= 99 ? "var(--sw-3)" : "var(--sw-1)"),
    h("td.mm-num", fmtK(g.reviews)), h("td.mm-num", g.pos ? `${g.pos}%` : "–"),
    h("td", dayDate(g.day), h("span.mm-dim", ` · ${d - g.day} d`)), h("td.mm-num", money(g.price)),
    h("td", g.flags & F.self ? badge("Self", "self") : h("span.mm-dim", "publisher")),
    h("td.mm-dim", g.top.filter((t) => t !== INDIE).slice(0, 3).map((t) => names[t]).filter(Boolean).join(", "))));
  const cols = [
    { label: "Game", tip: "The release, with a Godot mark when detected." },
    { label: "Hit index", num: true, tip: "Its review count as a percentile among games released within a week of it: 99 = more reviews than 99% of them. 90+ counts as a hit." },
    { label: "Reviews", num: true }, { label: "Positive", num: true }, { label: "Released" }, { label: "Price", num: true },
    { label: "Publisher", tip: "Self = self-published." }, { label: "Tags" },
  ];
  const hits = list.filter((g) => g.hit >= 90).length, breaks = list.filter((g) => g.hit >= 99).length;
  return section(title,
    "New releases ranked by the hit index: how many reviews they got against the games that came out the same week (99 = more than 99% of them; 90+ is a hit). Good for seeing what's working; released hits are rarely signable.",
    h("div.mm-controls",
      seg([[7, "7 days"], [30, "30 days"], [90, "90 days"]], f.days, (v) => set("days", v), "Released within"),
      toggle("Indie", f.indie, () => set("indie", !f.indie)),
      toggle("Self-published", f.self, () => set("self", !f.self)),
      toggle("Godot", f.godot, () => set("godot", !f.godot)),
      toggle("Adult and joke games", f.adult, () => set("adult", !f.adult))),
    h("p.mm-small", `${num(list.length)} released in the last ${f.days} days with these filters; ${num(hits)} hits (top 10% of their week), ${num(breaks)} breakouts (top 1%).`),
    list.length ? sortTable(cols, rows, null, null) : h("p.mm-note", "Nothing with these filters."),
    more(st.relShown, list.length, () => { st.relShown += 25; }));
}

function alertsFold() {
  const h = C.h, t = st.files.trends;
  if (!t) return null;
  const alerts = memo("alerts", () => rankAlerts(t, st.files.godot?.games));
  return fold("alerts", `All of today's alerts (${alerts.length})`,
    h("p.mm-small.mm-tight", "Ranked for a publisher: rising niches first (what to make), then self-published Godot games taking off (who to talk to), then breakouts (what to study), then Godot games that already have a publisher."),
    alerts.length ? h("ol.mm-alerts", ...alerts.map((a) => h("li.mm-alert", { class: `mm-g${a.group}` },
      h("span.mm-kind", a.label),
      h("div", h("b", a.kind === "tag" ? h("button.mm-linkbtn", { type: "button", onclick: () => pickTag(a.tag, { toggle: false }) }, a.head) : link(storeUrl(a.appid), a.head)),
        h("p", a.plain))))) : h("p.mm-note", "No alerts today."));
}

// --- Charts ----------------------------------------------------------------------------

function chartCard(chart) {
  const card = C.h("div.mm-chart", chart.legend, chart.svg, chart.tip, chart.note ? C.h("p.mm-small.mm-tight", chart.note) : null, chart.table);
  chart.attach(card);
  return card;
}

// Lines over evenly spaced labels, labeled at their ends, with a crosshair readout and a data table.
// A series with `pace` draws its last step dashed (this year, extrapolated to a whole year).
function lineChart({ labels, series, fmt, yLabel, note }) {
  const h = C.h, svgEl = C.svgEl;
  const W = 760, H = 280, M = { top: 18, right: 200, bottom: 30, left: 50 };
  const vals = series.flatMap((s) => s.values).filter((v) => v != null);
  const max = niceMax(Math.max(...vals, 0) * 1.05 || 1);
  const n = labels.length;
  const x = (i) => M.left + (n === 1 ? 0 : (i / (n - 1)) * (W - M.left - M.right));
  const y = (v) => H - M.bottom - (v / max) * (H - M.top - M.bottom);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "mm-svg", role: "img", "aria-label": series.map((s) => s.name).join(" and ") });
  const text = (attrs, s) => { const t = svgEl("text", attrs); t.textContent = s; svg.append(t); return t; };
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    svg.append(svgEl("line", { x1: M.left, x2: W - M.right, y1: y(v), y2: y(v), class: k ? "mm-grid" : "mm-base" }));
    text({ x: M.left - 8, y: y(v) + 4, "text-anchor": "end", class: "mm-axis" }, fmt(v));
  }
  text({ x: M.left, y: 12, class: "mm-axis mm-axis-title" }, yLabel || "");
  const every = Math.max(1, Math.ceil(n / 9));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) text({ x: x(i), y: H - 8, "text-anchor": "middle", class: "mm-axis" }, l); });
  const isPace = (s, i) => s.pace && i === n - 1;
  // End labels, pushed apart when they'd overlap.
  const ends = series.map((s) => { const i = s.values.findLastIndex((v) => v != null); return { s, i, y: y(s.values[i]) }; }).sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 36) ends[k].y = ends[k - 1].y + 36;
  for (const s of series) {
    const solidTo = s.pace ? n - 2 : n - 1;
    let d = "";
    s.values.forEach((v, i) => { if (v != null && i <= solidTo) d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    if (s.pace && n > 1 && s.values[n - 2] != null && s.values[n - 1] != null)
      svg.append(svgEl("path", { d: `M${x(n - 2).toFixed(1)},${y(s.values[n - 2]).toFixed(1)}L${x(n - 1).toFixed(1)},${y(s.values[n - 1]).toFixed(1)}`, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-dasharray": "5 4", "stroke-linecap": "round" }));
  }
  for (const e of ends) {
    const paced = isPace(e.s, e.i);
    svg.append(svgEl("circle", { cx: x(e.i), cy: y(e.s.values[e.i]), r: 4, fill: paced ? "var(--fb-card)" : e.s.color, stroke: paced ? e.s.color : "var(--fb-card)", "stroke-width": 2 }));
    // An index alone reads like a count ("256" games?): say it as times-2018 with the real number next to it.
    const v = e.s.values[e.i];
    text({ x: x(e.i) + 10, y: e.y + 4, class: "mm-endlabel" }, e.s.raw && v != null
      ? `×${(v / 100).toFixed(1)} · ${e.s.rawFmt(e.s.raw[e.i])}` : `${fmt(v)}`);
    text({ x: x(e.i) + 10, y: e.y + 18, class: "mm-endname" }, paced ? `${e.s.name} (pace)` : e.s.name);
  }
  const cross = svgEl("line", { y1: M.top, y2: H - M.bottom, class: "mm-cross", visibility: "hidden" });
  const dots = series.map((s) => svgEl("circle", { r: 5, fill: s.color, stroke: "var(--fb-card)", "stroke-width": 2, visibility: "hidden" }));
  svg.append(cross, ...dots);
  const tip = h("div.mm-tip", { role: "status" });
  const legend = h("div.mm-legend", ...series.map((s) => h("span", h("i.mm-line-key", { style: `background:${s.color}` }), s.name)),
    series.some((s) => s.pace) ? h("span", h("i.mm-line-key.mm-dash-key"), "this year's pace") : null);
  const rawText = (s, i) => s.raw ? `${s.rawFmt(s.raw[i])}${isPace(s, i) ? " (pace)" : ""}` : "";
  const table = fold(`table:${yLabel}`, "Data table", h("div.mm-scroll", h("table.mm-table",
    h("thead", h("tr", h("th", ""), ...series.map((s) => h("th", s.name)))),
    h("tbody", ...labels.map((l, i) => h("tr", h("td", l), ...series.map((s) => h("td", fmt(s.values[i]), s.raw ? ` (${rawText(s, i)})` : "")))).reverse()))));
  return {
    svg, tip, legend, table, note,
    attach(card) {
      const move = (ev) => {
        const box = svg.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * W;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        series.forEach((s, k) => { const v = s.values[i]; dots[k].setAttribute("visibility", v == null ? "hidden" : "visible"); if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); } });
        tip.replaceChildren(h("div.mm-tip-t", labels[i]), ...series.map((s) => h("div", h("i.mm-line-key", { style: `background:${s.color}` }), h("b", fmt(s.values[i])), ` ${s.name}`, s.raw ? h("span.mm-tip-raw", ` · ${rawText(s, i)}`) : null)));
        tip.style.display = "block";
        const cbox = card.getBoundingClientRect();
        let left = box.left - cbox.left + (x(i) / W) * box.width + 14;
        if (left + tip.offsetWidth > cbox.width - 8) left -= tip.offsetWidth + 28;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${box.top - cbox.top + 10}px`;
      };
      const hide = () => { tip.style.display = "none"; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerdown", move);
      svg.addEventListener("pointerleave", hide);
    },
  };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * p).find((m) => m >= v - 1e-12);
}

// --- Style -----------------------------------------------------------------------------

const CSS = `
.mkv-merged { color: var(--fb-ink); font-size: 15px; line-height: 1.5; max-width: 980px; margin: 0 auto; padding-bottom: 20px; }
.mkv-merged *, .mkv-merged *::before, .mkv-merged *::after { box-sizing: border-box; }
.mkv-merged h2 { font-size: 1.25rem; line-height: 1.3; margin: 0 0 4px; color: var(--fb-title); font-weight: 700; }
.mkv-merged h3 { font-size: 1.04rem; line-height: 1.3; margin: 0; color: var(--fb-title); font-weight: 650; overflow-wrap: anywhere; }
.mkv-merged p { margin: 0; }
.mkv-merged a.mm-link { color: var(--fb-link); text-decoration: none; }
.mkv-merged a.mm-link:hover { text-decoration: underline; }
.mkv-merged .mm-sub { color: var(--fb-ink-2); font-size: 0.93rem; max-width: 80ch; margin-bottom: 8px; }
.mkv-merged .mm-small { color: var(--fb-muted); font-size: 0.86rem; margin: 6px 0 8px; max-width: 80ch; }
.mkv-merged .mm-tight { margin: 4px 0 0; }
.mkv-merged .mm-inline-note { margin: 0; }
.mkv-merged .mm-note { color: var(--fb-ink-2); padding: 10px 0; }
.mkv-merged .mm-foot { color: var(--fb-muted); font-size: 0.82rem; margin-top: 16px; border-top: 1px solid var(--fb-line); padding-top: 8px; }
.mkv-merged .mm-big { font-size: 1.02rem; line-height: 1.5; color: var(--fb-ink); margin: 6px 0; max-width: 72ch; }
.mkv-merged .mm-line { color: var(--fb-ink-2); margin-top: 3px; font-size: 0.94rem; }
.mkv-merged .mm-strong { color: var(--fb-ink); font-weight: 550; }
.mkv-merged .mm-dim { color: var(--fb-muted); font-weight: 400; }

.mkv-merged .mm-today { background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 14px; padding: 12px 16px 6px; margin: 0 0 12px; }
.mkv-merged .mm-today-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.mkv-merged .mm-today-head .mm-sub { margin: 0; }
.mkv-merged .mm-today-list { list-style: none; margin: 0; padding: 0; }
.mkv-merged .mm-today-list > li { display: grid; grid-template-columns: 82px 1fr; gap: 10px; padding: 7px 0; border-top: 1px solid var(--fb-line); line-height: 1.45; }
.mkv-merged .mm-today-list > li:first-child { border-top: 0; }
.mkv-merged .mm-today-sub { margin: 3px 0 2px; padding-left: 20px; font-size: 0.93rem; }
.mkv-merged .mm-today-sub li { padding: 1px 0; }
.mkv-merged .mm-today-sub a { margin-left: 0; white-space: normal; font-weight: 600; }
.mkv-merged .mm-kind { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fb-muted); padding-top: 3px; }
.mkv-merged .mm-kind.k-niche { color: var(--sw-1); }
.mkv-merged .mm-kind.k-rising { color: var(--sw-3); }
.mkv-merged .mm-kind.k-lead { color: var(--fb-good-text); }
.mkv-merged .mm-kind.k-breakout { color: var(--fb-warning); }
.mkv-merged .mm-today-text a { margin-left: 4px; white-space: nowrap; }
.mkv-merged .mm-new { display: inline-block; font-size: 0.68rem; font-weight: 750; letter-spacing: 0.04em; text-transform: uppercase; line-height: 1.5; padding: 0 6px; margin-right: 7px; border-radius: 999px; background: var(--fb-accent); color: var(--fb-card); vertical-align: 1px; }
.mkv-merged .mm-today-fold > summary { cursor: pointer; list-style: none; font-weight: 600; color: var(--fb-ink); }
.mkv-merged .mm-today-fold > summary::-webkit-details-marker { display: none; }
.mkv-merged .mm-today-fold > summary::after { content: " ▸"; color: var(--fb-link); }
.mkv-merged .mm-today-fold[open] > summary::after { content: " ▾"; }
.mkv-merged .mm-today-fold > summary:hover { color: var(--fb-link); }

.mkv-merged .mm-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0 0 16px; }
.mkv-merged .mm-tab { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; text-align: left; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); font: inherit; cursor: pointer; }
.mkv-merged .mm-tab:hover { background: var(--fb-hover); }
.mkv-merged .mm-tab[aria-selected="true"] { border-color: var(--fb-accent); box-shadow: inset 0 0 0 1px var(--fb-accent); }
.mkv-merged .mm-tab-n { grid-row: span 2; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; background: var(--fb-card-2); color: var(--fb-ink-2); font-weight: 700; font-size: 0.85rem; }
.mkv-merged .mm-tab[aria-selected="true"] .mm-tab-n { background: var(--fb-accent); color: var(--fb-card); }
.mkv-merged .mm-tab-q { font-weight: 700; font-size: 1rem; line-height: 1.3; color: var(--fb-title); }
.mkv-merged .mm-tab-sub { color: var(--fb-muted); font-size: 0.84rem; line-height: 1.3; }

.mkv-merged .mm-section { margin: 0 0 22px; }
.mkv-merged .mm-controls { display: flex; flex-wrap: wrap; gap: 6px 8px; align-items: center; margin: 6px 0 8px; }
.mkv-merged .mm-seg { display: inline-flex; flex-wrap: wrap; border: 1px solid var(--fb-line); border-radius: 9px; overflow: hidden; background: var(--fb-card); }
.mkv-merged .mm-seg button { font: inherit; font-size: 0.88rem; padding: 5px 10px; border: 0; background: transparent; color: var(--fb-ink-2); cursor: pointer; border-right: 1px solid var(--fb-line); }
.mkv-merged .mm-seg button:last-child { border-right: 0; }
.mkv-merged .mm-seg button[aria-pressed="true"] { background: var(--fb-accent); color: var(--fb-card); font-weight: 600; }
.mkv-merged .mm-toggle, .mkv-merged .mm-btn { font: inherit; font-size: 0.88rem; padding: 5px 10px; border-radius: 9px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.mkv-merged .mm-toggle:hover, .mkv-merged .mm-btn:hover { background: var(--fb-hover); }
.mkv-merged .mm-check { width: 15px; height: 15px; border-radius: 4px; border: 1.5px solid var(--fb-muted); display: inline-grid; place-items: center; font-size: 10px; line-height: 1; }
.mkv-merged .mm-toggle[aria-pressed="true"] .mm-check { background: var(--fb-accent); border-color: var(--fb-accent); color: var(--fb-card); }
.mkv-merged .mm-btn.mm-inline { padding: 0 8px; font-size: 0.82rem; margin-left: 6px; vertical-align: 1px; }
.mkv-merged .mm-btn.mm-more { margin-top: 8px; }
.mkv-merged .mm-linkbtn { font: inherit; font-weight: 700; color: var(--fb-link); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
.mkv-merged .mm-linkbtn:hover { text-decoration: underline; }
.mkv-merged .mm-input { font: inherit; font-size: 0.9rem; padding: 5px 10px; border-radius: 9px; border: 1px solid var(--fb-line); background: var(--fb-card); color: var(--fb-ink); min-width: 0; width: 210px; max-width: 100%; }
.mkv-merged .mm-num-in { width: 110px; }
.mkv-merged .mm-field { display: inline-flex; align-items: center; gap: 6px; color: var(--fb-ink-2); font-size: 0.9rem; }

.mkv-merged .mm-conf { font-size: 0.76rem; font-weight: 650; border-radius: 999px; padding: 1px 8px; border: 1px solid currentColor; white-space: nowrap; }
.mkv-merged .mm-conf.is-solid { color: var(--fb-good-text); }
.mkv-merged .mm-conf.is-likely { color: var(--fb-ink-2); }
.mkv-merged .mm-conf.is-thin { color: var(--fb-warning); }
.mkv-merged .mm-gloss { color: var(--fb-muted); font-size: 0.84rem; font-style: italic; margin-top: 2px; line-height: 1.35; }
.mkv-merged .mm-filterbar { position: sticky; top: 0; z-index: 4; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 8px 12px; margin: 0 0 14px; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; }
.mkv-merged .mm-filterbar-t { color: var(--fb-ink-2); font-size: 0.86rem; flex: 1 1 260px; }
.mkv-merged .mm-filterbar-t b { color: var(--fb-title); font-weight: 650; }

.mkv-merged .mm-rise { list-style: none; margin: 4px 0 0; padding: 0; border: 1px solid var(--fb-line); border-radius: 12px; background: var(--fb-card); overflow: hidden; }
.mkv-merged .mm-rise-row { display: grid; grid-template-columns: 150px minmax(0, 1fr) 124px; gap: 4px 12px; align-items: center; padding: 8px 12px; border-top: 1px solid var(--fb-line); }
.mkv-merged .mm-rise-side { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.mkv-merged .mm-rise-n { width: 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center; background: var(--fb-card-2); color: var(--fb-ink-2); font-size: 0.78rem; font-weight: 700; }
.mkv-merged .mm-rise-act { font-size: 0.88rem; line-height: 1.35; margin-top: 2px; color: var(--fb-ink); }
.mkv-merged .mm-rise-act.is-early b { color: var(--fb-good-text); }
.mkv-merged .mm-rise-act.is-crowded b { color: var(--fb-warning); }
.mkv-merged .mm-rise-act.is-late b { color: var(--fb-negative); }
.mkv-merged .mm-rise-row:first-child { border-top: 0; }
.mkv-merged details.mm-details:has(.mm-late-arrow) { margin-top: 8px; }
.mkv-merged details.mm-details:has(.mm-late-arrow) > summary { list-style: none; cursor: pointer; padding: 6px 2px; color: var(--fb-negative); }
.mkv-merged details.mm-details:has(.mm-late-arrow) > summary::-webkit-details-marker { display: none; }
.mkv-merged details.mm-details:has(.mm-late-arrow) > summary .mm-dim { color: var(--fb-muted); font-size: 0.86rem; }
.mkv-merged .mm-late-arrow { display: inline-block; transition: transform .15s; }
.mkv-merged details[open] > summary .mm-late-arrow { transform: rotate(90deg); }
.mkv-merged .mm-rise-row.is-sel { background: var(--fb-hover); box-shadow: inset 3px 0 0 var(--fb-accent); }
.mkv-merged .mm-rise-main { min-width: 0; }
.mkv-merged .mm-rise-words { color: var(--fb-ink-2); font-size: 0.88rem; line-height: 1.35; }
.mkv-merged .mm-stage { justify-self: start; font-size: 0.74rem; font-weight: 700; border-radius: 999px; padding: 1px 9px; border: 1px solid currentColor; white-space: nowrap; cursor: help; }
.mkv-merged .mm-stage.is-early { color: var(--fb-good-text); }
.mkv-merged .mm-stage.is-crowded { color: var(--fb-warning); }
.mkv-merged .mm-stage.is-late { color: var(--fb-negative); }
.mkv-merged .mm-stage.is-big { color: var(--fb-muted); border-style: dashed; }
.mkv-merged .mm-spark { width: 120px; height: 30px; display: block; }
.mkv-merged .mm-spark-line { fill: none; stroke: var(--sw-3); stroke-width: 1.8; stroke-linejoin: round; }
.mkv-merged .mm-spark-area { fill: var(--sw-3); opacity: .12; }
.mkv-merged .mm-spark-now { fill: var(--fb-ink); opacity: .06; }
.mkv-merged .mm-spark-dot { fill: var(--sw-3); }

.mkv-merged .mm-hscroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.mkv-merged .mm-hscroll > .mm-svg { min-width: 620px; }
.mkv-merged .mm-barg { cursor: pointer; outline: none; }
.mkv-merged .mm-barval { fill: #fff; font-size: 11.5px; font-weight: 700; pointer-events: none; }
.mkv-merged .mm-barval-out { fill: var(--fb-ink); font-size: 11.5px; font-weight: 700; }
.mkv-merged .mm-bar-seg { stroke: var(--fb-card); stroke-width: 1; }
.mkv-merged .mm-bar-selbox { fill: none; stroke: var(--fb-title); stroke-width: 2; pointer-events: none; }
.mkv-merged .mm-barg:hover .mm-bar-seg, .mkv-merged .mm-barg:focus .mm-bar-seg { filter: brightness(1.12); }
.mkv-merged .mm-key-selbox { background: none; box-shadow: inset 0 0 0 2px var(--fb-title); }
.mkv-merged .mm-barname { fill: var(--fb-ink-2); font-size: 11.5px; }
.mkv-merged .mm-barname.is-sel { fill: var(--fb-title); font-weight: 700; }

.mkv-merged .mm-dot { cursor: pointer; outline: none; }
.mkv-merged .mm-dot-c { stroke: none; fill-opacity: var(--op, .72); }
.mkv-merged .mm-dot:hover .mm-dot-c, .mkv-merged .mm-dot:focus .mm-dot-c { stroke: var(--fb-ink); stroke-width: 1.5; fill-opacity: 1; }
.mkv-merged .mm-sel-ring { fill: var(--fb-accent); fill-opacity: .22; stroke: var(--fb-accent); stroke-width: 2; }
.mkv-merged .mm-axis-end { fill: var(--fb-muted); font-style: italic; }
.mkv-merged .mm-key-sel { background: var(--fb-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--fb-accent) 30%, transparent); }
.mkv-merged .mm-picked { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-top: 6px; padding: 6px 10px; border-radius: 9px; background: var(--fb-card-2); font-size: 0.88rem; color: var(--fb-ink-2); }
.mkv-merged .mm-picked b { color: var(--fb-title); }

.mkv-merged .mm-ntable .mm-nrow { cursor: pointer; scroll-margin: 90px; }
.mkv-merged .mm-ntable .mm-nrow:hover td { background: var(--fb-hover); }
.mkv-merged .mm-ntable .mm-nrow:focus-visible { outline: 2px solid var(--fb-accent); outline-offset: -2px; }
.mkv-merged .mm-ntable .mm-nrow.is-sel td { background: var(--fb-hover); border-bottom-color: transparent; }
.mkv-merged .mm-ntable .mm-nrow.is-sel td:first-child { box-shadow: inset 3px 0 0 var(--fb-accent); }
.mkv-merged .mm-ntable .mm-ndetail td { white-space: normal; background: var(--fb-hover); padding: 2px 12px 10px; box-shadow: inset 3px 0 0 var(--fb-accent); }
.mkv-merged .mm-ntable .mm-ndetail p { max-width: 90ch; font-size: 0.9rem; color: var(--fb-ink); margin-top: 4px; }
.mkv-merged .mm-ntable .mm-ndetail .mm-line { color: var(--fb-ink-2); }
.mkv-merged .mm-cbar-w { width: 64px; }
.mkv-merged .mm-vs { position: relative; overflow: visible; width: 64px; }
.mkv-merged .mm-vs > b { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--fb-ink); }
.mkv-merged .mm-explain { color: var(--fb-ink-2); font-size: 0.9rem; max-width: 86ch; margin: 6px 0; padding: 7px 10px; border-left: 3px solid var(--fb-accent); background: var(--fb-card); border-radius: 0 8px 8px 0; }
.mkv-merged .mm-explain b { color: var(--fb-title); }

.mkv-merged .mm-details { margin-top: 8px; }
.mkv-merged .mm-details > summary { cursor: pointer; color: var(--fb-link); font-size: 0.92rem; padding: 3px 0; }
.mkv-merged .mm-scroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; }
.mkv-merged .mm-table { border-collapse: collapse; width: 100%; font-size: 0.88rem; margin-top: 4px; font-variant-numeric: tabular-nums; }
.mkv-merged .mm-table th { text-align: left; color: var(--fb-muted); font-weight: 600; padding: 5px 8px; border-bottom: 1px solid var(--fb-line); white-space: nowrap; vertical-align: bottom; }
.mkv-merged .mm-table th[title] { cursor: help; }
.mkv-merged .mm-table th button { appearance: none; background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.mkv-merged .mm-table th[aria-sort] { color: var(--fb-title); }
.mkv-merged .mm-table td { padding: 5px 8px; border-bottom: 1px solid var(--fb-line); color: var(--fb-ink); white-space: nowrap; }
.mkv-merged .mm-table .mm-num { text-align: right; }
.mkv-merged .mm-barcell { display: inline-flex; align-items: center; gap: 6px; justify-content: flex-end; }
.mkv-merged .mm-cbar { display: inline-block; width: 52px; height: 6px; border-radius: 3px; background: var(--fb-card-2); overflow: hidden; }
.mkv-merged .mm-cbar i { display: block; height: 100%; border-radius: 3px; }
.mkv-merged .mm-up { color: var(--sw-2); }
.mkv-merged .mm-down { color: var(--fb-good-text); }
.mkv-merged .mm-badge { display: inline-block; font-size: 0.7rem; font-weight: 600; padding: 0 6px; margin-left: 6px; border-radius: 10px; border: 1px solid var(--fb-line); color: var(--fb-ink-2); white-space: nowrap; vertical-align: 1px; }
.mkv-merged td > .mm-badge:first-child { margin-left: 0; }
.mkv-merged .mm-b-self { border-color: var(--fb-good-text); color: var(--fb-good-text); }
.mkv-merged .mm-b-godot { border-color: var(--sw-1); color: var(--fb-link); }
.mkv-merged .mm-sources { color: var(--fb-ink-2); font-size: 0.88rem; padding-left: 20px; margin: 4px 0; }

.mkv-merged .mm-alerts { list-style: none; padding: 0; margin: 6px 0 0; display: flex; flex-direction: column; gap: 6px; }
.mkv-merged .mm-alert { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 10px; padding: 7px 10px; border-radius: 8px; background: var(--fb-card); border: 1px solid var(--fb-line); border-left: 3px solid var(--fb-warning); }
.mkv-merged .mm-alert.mm-g1 { border-left-color: var(--fb-good-text); }
.mkv-merged .mm-alert.mm-g2 { border-left-color: var(--sw-1); }
.mkv-merged .mm-alert.mm-g3 { border-left-color: var(--fb-line); }
.mkv-merged .mm-alert p { margin: 2px 0 0; font-size: 0.88rem; color: var(--fb-ink-2); line-height: 1.4; }
.mkv-merged .mm-alert a { color: var(--fb-link); text-decoration: none; }

.mkv-merged .mm-chart { position: relative; background: var(--fb-card); border: 1px solid var(--fb-line); border-radius: 12px; padding: 10px 12px 8px; margin: 6px 0 10px; }
.mkv-merged .mm-svg { display: block; width: 100%; height: auto; touch-action: pan-y; overflow: visible; }
.mkv-merged .mm-svg text { font-family: inherit; }
.mkv-merged .mm-grid { stroke: var(--fb-line); stroke-width: 1; }
.mkv-merged .mm-base { stroke: var(--fb-muted); stroke-width: 1; }
.mkv-merged .mm-cross { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.mkv-merged .mm-ref { stroke: var(--fb-muted); stroke-width: 1; stroke-dasharray: 4 3; }
.mkv-merged .mm-ref-bars { stroke: var(--fb-ink); stroke-opacity: .7; stroke-width: 1.2; pointer-events: none; }
.mkv-merged .mm-gapzone { fill: var(--sw-3); opacity: .11; }
.mkv-merged .mm-axis { fill: var(--fb-muted); font-size: 12px; }
.mkv-merged .mm-axis-title { fill: var(--fb-ink-2); font-weight: 600; }
.mkv-merged .mm-dl { fill: var(--fb-ink-2); font-size: 10.5px; font-weight: 500; cursor: pointer; paint-order: stroke; stroke: var(--fb-card); stroke-width: 2.5px; stroke-linejoin: round; }
.mkv-merged .mm-dl-zone { fill: var(--fb-ink); }
.mkv-merged .mm-dl-sel { fill: var(--fb-title); font-size: 12px; font-weight: 750; paint-order: stroke; stroke: var(--fb-card); stroke-width: 3px; stroke-linejoin: round; }
.mkv-merged .mm-dot { cursor: pointer; outline: none; }
.mkv-merged .mm-endlabel { fill: var(--fb-ink); font-size: 14px; font-weight: 700; }
.mkv-merged .mm-endname { fill: var(--fb-ink-2); font-size: 12px; }
.mkv-merged .mm-legend { display: flex; flex-wrap: wrap; gap: 3px 14px; font-size: 0.84rem; color: var(--fb-ink-2); margin-bottom: 4px; }
.mkv-merged .mm-key { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
.mkv-merged .mm-legend-keys { gap: 4px 22px; align-items: center; }
.mkv-merged .mm-keygroup { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; max-width: 100%; }
.mkv-merged .mm-keyitem { display: inline-flex; align-items: center; gap: 2px; color: var(--fb-muted); font-size: 0.8rem; }
.mkv-merged .mm-keysvg { display: block; overflow: visible; }
.mkv-merged .mm-key-dot { fill: var(--fb-muted); fill-opacity: .55; }
.mkv-merged .mm-key-pace { fill: var(--fb-ink-2); fill-opacity: var(--op); }
.mkv-merged .mm-key-zone { background: var(--sw-3); opacity: .3; border-radius: 2px; width: 12px; height: 12px; }
.mkv-merged .mm-line-key { display: inline-block; width: 12px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.mkv-merged .mm-dash-key { background: repeating-linear-gradient(90deg, var(--fb-ink-2) 0 4px, transparent 4px 7px); }
.mkv-merged .mm-tip { display: none; position: absolute; pointer-events: none; z-index: 5; background: var(--fb-card); color: var(--fb-ink); border: 1px solid var(--fb-line); border-radius: 8px; padding: 6px 10px; font-size: 0.84rem; line-height: 1.45; box-shadow: 0 6px 20px rgba(0,0,0,0.18); max-width: 300px; }
.mkv-merged .mm-tip-t { font-weight: 700; color: var(--fb-title); margin-bottom: 1px; }
.mkv-merged .mm-tip-raw { color: var(--fb-muted); }

@media (max-width: 900px) {
  .mkv-merged .mm-tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .mkv-merged .mm-tabs { grid-template-columns: 1fr; gap: 6px; }
  .mkv-merged .mm-tab { padding: 8px 12px; }
  .mkv-merged .mm-today { padding: 10px 12px 4px; }
  .mkv-merged .mm-today-list > li { grid-template-columns: 1fr; gap: 0; }
  .mkv-merged .mm-input { width: 100%; }
  .mkv-merged .mm-chart { padding: 8px 6px 6px; }
  .mkv-merged .mm-alert { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .mkv-merged .mm-axis { font-size: 15px; }
  .mkv-merged .mm-hscroll .mm-axis { font-size: 12px; }
  .mkv-merged .mm-rise-row { grid-template-columns: minmax(0, 1fr) auto; padding: 7px 10px; }
  .mkv-merged .mm-rise-side { grid-column: 1 / -1; }
  .mkv-merged .mm-spark { width: 90px; }
  .mkv-merged .mm-filterbar { position: static; }
}
`;

function injectStyle() {
  if (document.getElementById("mk-merged-style")) return;
  const el = document.createElement("style");
  el.id = "mk-merged-style";
  el.textContent = CSS;
  document.head.append(el);
}

export const _test = { tagReviewPace, paceLevel, opportunityScores, risingNow, riseAction, glossary, oneIn, confidence, spread, sureLabel, isJoke, rankNiches, unpackGames, unpackUpcoming, upcomingLeads, releasedLeads, steamGrowth, releasesList, rankAlerts, todayItems, releaseText };
