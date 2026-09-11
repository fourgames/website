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
	},
	build: {
		// One CSS file, so the prerender step can inline it into every page.
		cssCodeSplit: false,
	},
});
