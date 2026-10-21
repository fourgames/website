import { onBeforeUnmount, onMounted, reactive } from "vue";
import { SITE } from "@/data/site.js";

// One widget request per page load, shared by every card on the page. Several components ask for
// presence (the membership band and each Get involved variant), and they all want the exact same
// JSON — firing one request each only competed for connections and risked Discord rate-limiting us.
let widget = null;

function fetchWidget() {
	widget ??= fetch(`https://discord.com/api/guilds/${SITE.discord.guildId}/widget.json`, {
		credentials: "omit",
		signal: AbortSignal.timeout(6000),
	})
		.then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
		.catch(() => {
			// Offline, blocked or timed out. Forget it so a card mounting later can try again.
			widget = null;
			return null;
		});
	return widget;
}

// Starts from the build-time snapshot (so prerendered HTML and hydration match), then — once the
// card scrolls into view — fetches the public widget once for a live online count. Any failure
// silently keeps the snapshot.
export function useDiscordPresence(snapshot, targetRef) {
	const state = reactive({
		name: snapshot?.name ?? null,
		count: snapshot?.presenceCount ?? null,
		members: snapshot?.members ?? [],
		live: false,
	});

	let observer;
	onMounted(() => {
		if (!targetRef.value || typeof IntersectionObserver === "undefined") return;
		observer = new IntersectionObserver(
			([entry]) => {
				if (!entry.isIntersecting) return;
				observer.disconnect();
				refresh();
			},
			{ rootMargin: "200px" },
		);
		observer.observe(targetRef.value);
	});
	onBeforeUnmount(() => observer?.disconnect());

	async function refresh() {
		const data = await fetchWidget();
		if (!data) return; // Offline, blocked or timed out — keep the snapshot.
		state.name = data.name ?? state.name;
		state.count = data.presence_count ?? state.count;
		state.members = (data.members ?? [])
			.filter((m) => m.avatar_url)
			.slice(0, 12)
			.map((m) => ({ avatarUrl: m.avatar_url }));
		state.live = true;
	}

	return state;
}
