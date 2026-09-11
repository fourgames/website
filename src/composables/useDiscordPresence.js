import { onBeforeUnmount, onMounted, reactive } from "vue";
import { SITE } from "@/data/site.js";

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
		try {
			const res = await fetch(`https://discord.com/api/guilds/${SITE.discord.guildId}/widget.json`, {
				credentials: "omit",
				signal: AbortSignal.timeout(6000),
			});
			if (!res.ok) return;
			const widget = await res.json();
			state.name = widget.name ?? state.name;
			state.count = widget.presence_count ?? state.count;
			state.members = (widget.members ?? [])
				.filter((m) => m.avatar_url)
				.slice(0, 12)
				.map((m) => ({ avatarUrl: m.avatar_url }));
			state.live = true;
		} catch {
			// Offline, blocked or timed out — keep the snapshot.
		}
	}

	return state;
}
