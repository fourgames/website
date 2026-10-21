<script setup>
import Button from "@/components/ui/Button.vue";
import LogoMark from "@/components/ui/LogoMark.vue";
import { MEMBERSHIP } from "@/data/membership.js";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();
</script>

<template>
	<!-- Navy call-to-action band, like the Godot Foundation band on godotengine.org -->
	<section aria-labelledby="band-title" class="bg-dark text-white">
		<div class="container-page padded text-center">
			<LogoMark class="mx-auto size-16" />
			<h2 id="band-title" class="mt-4 text-white">{{ t("membership.band.title", { name: SITE.name }) }}</h2>
			<p class="mx-auto mt-3 max-w-2xl text-white/85">
				{{ t("membership.band.text", { tier: MEMBERSHIP.tier }) }}
			</p>
			<div class="mt-7">
				<Button :href="SITE.links.youtubeJoin" size="lg" icon="heart">{{ t("nav.donate") }}</Button>
			</div>
		</div>
	</section>
</template>
