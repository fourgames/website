// Prints the site's Steam publisher config as JSON for feedback/steam.py, so the feedback system
// follows the same game list as the website (src/data/site.js and src/data/games.js).
import { SITE } from "../src/data/site.js";
import { GAMES } from "../src/data/games.js";

console.log(
	JSON.stringify({
		publisher: SITE.steam?.publisher ?? null,
		developer: SITE.steam?.developer ?? null,
		appIds: GAMES.map((g) => g.appId),
	}),
);
