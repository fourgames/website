import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [vue({ features: { optionsAPI: false } }), tailwindcss()],
	resolve: {
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	define: {
		__BUILD_YEAR__: JSON.stringify(new Date().getUTCFullYear()),
		// Busts link-preview caches (Discord keys them on the image URL) when the daily rebuild re-shoots og-default.jpg.
		__BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
		// When this build was made and from which commit (the feedback dashboard shows "site built … ago").
		__BUILD_TIME__: JSON.stringify(Math.floor(Date.now() / 1000)),
		__BUILD_SHA__: JSON.stringify((process.env.GITHUB_SHA || "").slice(0, 7)),
	},
	build: {
		// One CSS file, so the prerender step can inline it into every page.
		cssCodeSplit: false,
	},
});
