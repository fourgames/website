#!/usr/bin/env node
/**
 * Screenshots the prerendered home page into dist/og/og-default.jpg — the link-preview image Discord,
 * X, Slack etc. show. Runs after prerender, so every daily rebuild's card shows that day's hero,
 * games and videos. If Playwright or its browser is missing, the static public/og/og-default.jpg
 * (already copied into dist/) is kept and the build carries on.
 */
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "dist/og/og-default.jpg");
const PORT = 4179;

let chromium;
try {
	({ chromium } = await import("playwright"));
} catch {
	console.log("og-image: playwright is not installed — keeping the static share image");
	process.exit(0);
}

const server = spawn(process.execPath, [path.join(ROOT, "scripts/preview.mjs")], {
	env: { ...process.env, PORT: String(PORT) },
	stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
	server.stdout.once("data", resolve);
	server.once("exit", () => reject(new Error("preview server exited")));
});

let browser;
try {
	browser = await chromium.launch();
	const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: "dark", reducedMotion: "reduce" });
	await page.goto(`http://localhost:${PORT}/`, { waitUntil: "networkidle" });
	await page.evaluate(() => document.fonts.ready);
	await page.waitForFunction(() => [...document.images].every((img) => img.complete), null, { timeout: 10_000 }).catch(() => {});
	await page.screenshot({ path: OUT, type: "jpeg", quality: 85 });
	console.log("og-image: dist/og/og-default.jpg ← screenshot of /");
} catch (error) {
	console.log(`og-image: screenshot failed (${error.message.split("\n")[0]}) — keeping the static share image`);
} finally {
	await browser?.close();
	server.kill();
}
