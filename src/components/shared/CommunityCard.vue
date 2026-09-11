<script setup>
import { computed, ref } from "vue";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import { useDiscordPresence } from "@/composables/useDiscordPresence.js";
import { SITE } from "@/data/site.js";
import discord from "@/data/generated/discord.json";

const props = defineProps({
	title: { type: String, default: "Join our Discord" },
	text: {
		type: String,
		default: "Chat with us, get help with your Godot projects and be first to hear about new games.",
	},
	headingLevel: { type: String, default: "h3" },
});

const card = ref(null);
const presence = useDiscordPresence(discord, card);

const avatars = computed(() => presence.members.slice(0, 7));
const extra = computed(() => Math.max(0, (presence.count ?? 0) - avatars.value.length));

function hideAvatar(event) {
	event.target.hidden = true;
}
</script>

<template>
	<article ref="card" v-spotlight class="surface-card spotlight flex h-full flex-col overflow-hidden p-6 sm:p-8">
		<div
			aria-hidden="true"
			class="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-[radial-gradient(closest-side,rgb(88_101_242/0.28),transparent)]"
		></div>

		<div class="flex items-center gap-4">
			<span class="grid size-12 shrink-0 place-items-center rounded-xl border border-[#5865f2]/30 bg-[#5865f2]/15 text-[#a5acff]">
				<Icon name="discord" class="size-6" />
			</span>
			<div class="min-w-0">
				<component :is="props.headingLevel" class="text-xl font-semibold tracking-tight">{{ title }}</component>
				<p class="text-sm text-subtle">{{ presence.name ?? "Four Games" }} community</p>
			</div>
		</div>

		<p class="mt-5 text-muted">{{ text }}</p>

		<div class="mt-8 flex min-h-10 flex-wrap items-center gap-x-4 gap-y-3">
			<div v-if="avatars.length" class="flex items-center" aria-hidden="true">
				<img
					v-for="(member, i) in avatars"
					:key="member.avatarUrl"
					:src="member.avatarUrl"
					width="32"
					height="32"
					alt=""
					loading="lazy"
					decoding="async"
					crossorigin="anonymous"
					referrerpolicy="no-referrer"
					class="-ml-2 size-8 rounded-full border-2 border-card bg-elevated object-cover first:ml-0"
					:style="{ zIndex: avatars.length - i }"
					@error="hideAvatar"
				/>
				<span
					v-if="extra"
					class="-ml-2 grid h-8 min-w-8 place-items-center rounded-full border-2 border-card bg-elevated px-1.5 text-[0.6875rem] font-medium text-muted tabular-nums"
				>
					+{{ extra }}
				</span>
			</div>
			<p v-if="presence.count !== null" class="inline-flex items-center gap-2 text-sm text-muted">
				<span class="relative flex size-2.5" aria-hidden="true">
					<span v-if="presence.live" class="absolute inset-0 rounded-full bg-success motion-safe:animate-pulse-dot"></span>
					<span class="relative size-2.5 rounded-full bg-success"></span>
				</span>
				<span><span class="font-medium text-fg tabular-nums">{{ presence.count }}</span> online now</span>
			</p>
		</div>

		<div class="mt-auto pt-8">
			<Button :href="SITE.links.discord" icon="discord">Join server</Button>
		</div>
	</article>
</template>
