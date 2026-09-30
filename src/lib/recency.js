// Our games as one timeline, newest first: the furthest-out thing leads (the home page gives it the
// big card), and each game slides down the list as it announces, launches and ages out.
// Steam's releaseDate is a display string, not a date ("Nov 20, 2024", "Q1 2026", "Coming soon"),
// so Date.parse is expected to fail here: an undated announcement ranks above a dated one, and an
// unparseable release date sinks to the bottom. Sort is stable, so ties keep the build's order.
//
// No imports on purpose: scripts/fetch-data.mjs runs this on the raw Steam data in plain Node.
const STATUS_RANK = { unlisted: 0, upcoming: 1, released: 2 };
const releaseKey = (game) => Date.parse(game.releaseDate) || (game.status === "upcoming" ? Infinity : 0);

export function byRecency(a, b) {
	const rank = (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3);
	if (rank !== 0) return rank;
	const [keyA, keyB] = [releaseKey(a), releaseKey(b)];
	return keyA === keyB ? 0 : keyB - keyA;
}

// The newest game you can actually play — the hero's "Play latest" button.
export function latestReleased(games) {
	return games.filter((g) => g.status === "released").sort(byRecency)[0] ?? null;
}

// The game whose screenshots fill the hero: the "Play latest" one, so the backdrop always matches
// the button. Before anything has launched, the newest announced game stands in. Unlisted games
// never do — their only art is a local placeholder, not a 1920px shot.
export function heroGame(games) {
	return latestReleased(games) ?? games.filter((g) => g.status === "upcoming").sort(byRecency)[0] ?? null;
}
