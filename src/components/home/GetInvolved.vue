<script setup>
import { ref } from "vue";
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import InvolveColumnArt from "./InvolveColumnArt.vue";
import { useDiscordPresence } from "@/composables/useDiscordPresence.js";
import { INVOLVE } from "@/data/involve.js";
import discord from "@/data/generated/discord.json";

// The "Get involved" layout from godotengine.org: three centered columns, a piece of art, one
// paragraph and a raised CTA. The art reuses the membership perk cards so the two sections match.
// The Discord column carries its own live count, so there's no separate pulse row here.
const section = ref(null);
const presence = useDiscordPresence(discord, section);
const ART = { discord: "chat", youtube: "learn", jobs: "collaborate" };
</script>

<template>
	<Section
		id="community"
		title="Get involved"
		description="Join the community and help shape the games and tutorials we make."
	>
		<ul ref="section" class="grid gap-12 text-center md:grid-cols-3 md:gap-8">
			<li v-for="item in INVOLVE" :key="item.id" class="flex flex-col items-center">
				<InvolveColumnArt
					:kind="ART[item.id]"
					:members="presence.members"
					:count="presence.count"
					:live="presence.live"
				/>
				<h3 class="mt-6 text-2xl">{{ item.title }}</h3>
				<p class="mt-3 max-w-xs">{{ item.text }}</p>
				<!-- flex-1 + items-end keeps the three CTAs on one baseline; mt-6 guarantees a gap
				     in the tallest column, where there's no slack left to distribute. -->
				<div class="mt-6 flex flex-1 items-end">
					<Button :to="item.to" :href="item.href" variant="ghost" class="bg-card shadow-card">
						{{ item.cta }}
					</Button>
				</div>
			</li>
		</ul>
	</Section>
</template>
