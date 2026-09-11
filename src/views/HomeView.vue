<script setup>
import CommunityCard from "@/components/shared/CommunityCard.vue";
import Section from "@/components/ui/Section.vue";
import GamesSection from "@/components/home/GamesSection.vue";
import HeroIntro from "@/components/home/HeroIntro.vue";
import MembershipCTA from "@/components/home/MembershipCTA.vue";
import VideosSection from "@/components/home/VideosSection.vue";
</script>

<template>
	<HeroIntro />
	<GamesSection />
	<VideosSection />
	<Section
		id="community"
		eyebrow="Community"
		title="Hang out with us"
		description="Ask questions, share what you're building, and help shape our games."
	>
		<div class="grid gap-4 sm:gap-6 lg:grid-cols-2">
			<div v-reveal><CommunityCard /></div>
			<div v-reveal="100"><MembershipCTA /></div>
		</div>
	</Section>
</template>
