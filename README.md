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

## Deployment

`.github/workflows/static.yml` deploys to GitHub Pages on every push to `main`, on demand, and once a day.

## License

MIT — see [LICENSE.md](LICENSE.md). Montserrat is licensed under the SIL Open Font License (`public/fonts/LICENSE-Montserrat.txt`). The clover icon is "Clover" by [Lorc](https://game-icons.net/), CC BY 3.0. Interface icons follow [Lucide](https://lucide.dev/); platform icons are from godotengine.org.
