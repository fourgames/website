<script setup>
import Navbar from "./components/layout/Navbar.vue";
import Hero from "./components/layout/Hero.vue";
import Footer from "./components/layout/Footer.vue";
</script>

<template>
	<Navbar />
	<Hero />
	<router-view />
	<Footer />
</template>
