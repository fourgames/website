<script setup>
import Button from "@/components/ui/Button.vue";
import PageHeader from "@/components/layout/PageHeader.vue";
import { SITE } from "@/data/site.js";
</script>

<template>
	<PageHeader
		title="404: page not found"
		description="The page you're looking for doesn't exist or has moved. Here are some places to go instead."
	>
		<div class="flex flex-wrap gap-3">
			<Button to="/" variant="blue">Back to home</Button>
			<Button to="/games">Games</Button>
			<Button to="/videos">Videos</Button>
		</div>
		<p class="mt-8 text-sm text-date">
			Think this is a bug?
			<a :href="SITE.links.issues" target="_blank" rel="noopener noreferrer" class="link">
				Report a website issue<span class="sr-only"> (opens in new tab)</span>
			</a>
		</p>
	</PageHeader>
	<div class="h-24 sm:h-32"></div>
</template>
