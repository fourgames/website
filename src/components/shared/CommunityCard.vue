<script setup>
import { ref } from "vue";
import Button from "@/components/ui/Button.vue";
import DiscordArt from "@/components/home/DiscordArt.vue";
import { useDiscordPresence } from "@/composables/useDiscordPresence.js";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import discord from "@/data/generated/discord.json";

// Same feature card as the membership perks: a 250px art well over a navy body. The art carries
// the avatars, the live dot and the online count, so the body stays text + CTA.
// The well is bg-bg (not bg-surface like the perk cards): this card sits on a surface band, and it
// has to read as part of the card rather than as a hole in the section.
const props = defineProps({
	// Default to the translated "Join our Discord" card copy.
	title: { type: String, default: undefined },
	text: { type: String, default: undefined },
	headingLevel: { type: String, default: "h3" },
});

const { t } = useI18n();
const card = ref(null);
const presence = useDiscordPresence(discord, card);
</script>

<template>
	<article ref="card" class="flex h-full flex-col overflow-hidden rounded-lg bg-dark text-white shadow-card">
		<span aria-hidden="true" class="@container relative block h-[250px] shrink-0 overflow-hidden bg-bg">
			<DiscordArt :tier="null" frame-class="border-bg" :members="presence.members" :count="presence.count" :live="presence.live" />
		</span>

		<div class="flex flex-1 flex-col p-6 sm:p-8">
			<component :is="props.headingLevel" class="text-xl text-white">{{ title ?? t("discord.title") }}</component>
			<p class="mt-1 text-sm text-white/70">{{ t("discord.community", { name: presence.name ?? SITE.name }) }}</p>
			<p class="mt-5 text-white/85">{{ text ?? t("discord.text") }}</p>

			<div class="mt-auto pt-6">
				<Button :href="SITE.links.discord" variant="blue" icon="discord">{{ t("discord.join") }}</Button>
			</div>
		</div>
	</article>
</template>
