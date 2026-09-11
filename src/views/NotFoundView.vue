<script setup>
import Button from "@/components/ui/Button.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import { SITE } from "@/data/site.js";
</script>

<template>
	<PageHeader
		eyebrow="404"
		title="This page wandered off"
		description="The page you're looking for doesn't exist or has moved. Here are some places to go instead."
	>
		<div class="flex flex-wrap gap-3">
			<Button to="/">Back to home</Button>
			<Button to="/code" variant="secondary">Open Source</Button>
			<Button to="/jobs" variant="secondary">Work with us</Button>
		</div>
		<p class="mt-10 text-sm text-subtle">
			Think this is a bug?
			<a :href="SITE.links.issues" target="_blank" rel="noopener noreferrer" class="link">
				Report a website issue<span class="sr-only"> (opens in new tab)</span>
			</a>
		</p>
	</PageHeader>
	<div class="h-24 sm:h-32"></div>
</template>
