<script setup>
import Button from "@/components/ui/Button.vue";
import Section from "@/components/ui/Section.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import CommunityCard from "@/components/shared/CommunityCard.vue";
import ContactForm from "@/components/jobs/ContactForm.vue";
import PartnerGrid from "@/components/jobs/PartnerGrid.vue";
</script>

<template>
	<PageHeader
		title="Work with us"
		description="We collaborate with creators, studios and brands who care about great games as much as we do."
	>
		<Button to="/jobs#contact" variant="blue" icon="mail">Get in touch</Button>
	</PageHeader>

	<Section id="collaborations" title="Ways to work with us">
		<PartnerGrid />
	</Section>

	<Section
		id="contact"
		tone="surface"
		title="Get in touch"
		description="The fastest way to reach us is Discord. Prefer email? Send us a message and we'll reply there."
	>
		<div class="grid gap-5 lg:grid-cols-2">
			<CommunityCard
				title="Chat with us on Discord"
				text="Drop a message in the server. It's where we answer fastest."
			/>
			<ContactForm />
		</div>
	</Section>
</template>
