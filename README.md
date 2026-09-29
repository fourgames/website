# fourgames.se

The website of **Four Games** — an indie studio making games in Godot, sharing free tutorials and open-sourcing our tools. Vue 3 + Vite + Tailwind CSS v4, prerendered to static HTML and hosted on GitHub Pages.

## Development

Requires Node 22.12+ (see `.nvmrc`).

```bash
npm install
npm run dev       # dev server on http://localhost:5173
npm run data      # fetch fresh Steam / YouTube / GitHub / Discord data
npm run build     # build + prerender every page into dist/
npm run preview   # serve dist/ like GitHub Pages does, on http://localhost:4173
```

`dev` and `build` work offline and without API keys — sections just show their empty states until you run `npm run data`.

## Content

Most edits are data, not components: everything in `src/data/` (games, membership, nav, footer, links), plus page titles and meta descriptions in `src/router/routes.js`. Steam, YouTube, GitHub and Discord data is fetched at build time into `src/data/generated/`.

## Languages

The site ships in English, 日本語, 한국어, 中文（简体） and 中文（繁體）, with godotengine.org's URL scheme: English at `/`, the others under `/ja/`, `/ko/`, `/zh-cn/` and `/zh-tw/`. Every page is prerendered once per language, with `hreflang` alternates and a multilingual sitemap.

- **Text** lives in `src/i18n/messages/<lang>.js` — every visible string, page titles and meta descriptions included. Add a key to `en.js` first, then to the other four; `npm run build` warns about any key a language is missing (it falls back to English). The translations are written by hand, not machine-translated, and follow godotengine.org's own terms in each language.
- **Games**: Steam's store translations (blurb, genres, release date) are fetched per language at build time; `tagline` in `src/data/games.js` covers languages the Steam page isn't translated into.
- **Auto-detect**: an English page sends a first-time visitor whose browser prefers one of the other languages there (`src/i18n/detect.js`). Picking a language in the navbar menu is remembered and always wins, English included.
- **Adding a language**: add it to `src/i18n/locales.js`, add `src/i18n/messages/<code>.js`, its Steam name in `STEAM_LANGUAGES` (`scripts/fetch-data.mjs`) and, for a new script, a font stack in `src/style.css`.

## Deployment

`.github/workflows/static.yml` deploys to GitHub Pages on every push to `main`, on demand, and once a day.

## License

MIT — see [LICENSE.md](LICENSE.md). Montserrat is licensed under the SIL Open Font License (`public/fonts/LICENSE-Montserrat.txt`). The clover icon is "Clover" by [Lorc](https://game-icons.net/), CC BY 3.0. Interface icons follow [Lucide](https://lucide.dev/); platform icons are from godotengine.org.
