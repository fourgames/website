import { defineConfig } from "vite";
import purgecss from "vite-plugin-purgecss";

export default defineConfig({
	base: "/", // VIKTIGT: Bara ett snedstreck här!
});

// export default defineConfig({
// 	base: "/", // Detta gör alla sökvägar relativa, vilket fungerar överallt
// 	// ... dina andra inställningar
// 	plugins: [
// 		// purgecss({
// 		// 	content: ["./index.html", "./src/**/*.{js,ts}", "./main.js"],
// 		// 	variables: true,
// 		// 	keyframes: true,
// 		// 	// safelist: { standard: [/is-/, /has-/] } <-- Testa att ta bort denna tillfälligt
// 		// }),
// 	],
// });
