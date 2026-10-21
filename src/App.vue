<script setup>
import SiteFooter from "./components/layout/SiteFooter.vue";
import SiteHeader from "./components/layout/SiteHeader.vue";
import SkipLink from "./components/layout/SkipLink.vue";
</script>

<template>
	<SkipLink />
	<SiteHeader />
	<main id="main" tabindex="-1">
		<RouterView />
	</main>
	<SiteFooter />
</template>
