<script setup>
import Button from "@/components/ui/Button.vue";
import LogoMark from "@/components/ui/LogoMark.vue";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
</script>

<template>
	<!-- Navy call-to-action band, like the Godot Foundation band on godotengine.org -->
	<section aria-labelledby="band-title" class="bg-dark text-white">
		<div class="container-page padded text-center">
			<LogoMark class="mx-auto size-16" />
			<h2 id="band-title" class="mt-4 text-white">Support {{ SITE.name }}</h2>
			<p class="mx-auto mt-3 max-w-2xl text-white/85">
				You don't need to be a game developer to help. Become a {{ MEMBERSHIP.tier }} on YouTube and keep the games
				and free tutorials coming.
			</p>
			<div class="mt-7">
				<Button :href="SITE.links.youtubeJoin" size="lg" icon="heart">Donate</Button>
			</div>
		</div>
	</section>
</template>
