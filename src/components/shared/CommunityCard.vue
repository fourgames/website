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
	<article ref="card" class="card flex h-full flex-col p-6 sm:p-8">
		<div class="flex items-center gap-4">
			<span class="grid size-12 shrink-0 place-items-center rounded-full bg-[#5865f2]/15 text-[#5865f2]">
				<Icon name="discord" class="size-6" />
			</span>
			<div class="min-w-0">
				<component :is="props.headingLevel" class="text-xl">{{ title }}</component>
				<p class="text-sm text-date">{{ presence.name ?? "Four Games" }} community</p>
			</div>
		</div>

		<p class="mt-5">{{ text }}</p>

		<div class="mt-6 flex min-h-10 flex-wrap items-center gap-x-4 gap-y-3">
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
					class="-ml-2 size-8 rounded-full border-2 border-card bg-surface object-cover first:ml-0"
					:style="{ zIndex: avatars.length - i }"
					@error="hideAvatar"
				/>
				<span
					v-if="extra"
					class="-ml-2 grid h-8 min-w-8 place-items-center rounded-full border-2 border-card bg-surface px-1.5 text-[0.6875rem] font-semibold tabular-nums"
				>
					+{{ extra }}
				</span>
			</div>
			<p v-if="presence.count !== null" class="inline-flex items-center gap-2 text-sm text-date">
				<span class="relative flex size-2.5" aria-hidden="true">
					<span v-if="presence.live" class="absolute inset-0 rounded-full bg-success motion-safe:animate-pulse-dot"></span>
					<span class="relative size-2.5 rounded-full bg-success"></span>
				</span>
				<span><span class="font-semibold text-fg tabular-nums">{{ presence.count }}</span> online now</span>
			</p>
		</div>

		<div class="mt-auto pt-6">
			<Button :href="SITE.links.discord" variant="blue" icon="discord">Join server</Button>
		</div>
	</article>
</template>
