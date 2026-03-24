import { defineConfig } from "vite";
import purgecss from "vite-plugin-purgecss";

export default defineConfig({
	plugins: [
		// purgecss({
		// 	content: ["./index.html", "./src/**/*.{js,ts}", "./main.js"],
		// 	variables: true,
		// 	keyframes: true,
		// 	// safelist: { standard: [/is-/, /has-/] } <-- Testa att ta bort denna tillfälligt
		// }),
	],
});
