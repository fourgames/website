<script setup>
import { ref } from "vue";
import Hamburger from "./Hamburger.vue";
import ThemeToggle from "./ThemeToggle.vue";

const isOpen = ref(false);
</script>

<template>
	<div
		class="max-lg:collapse bg-base-200 shadow-none w-full rounded-none relative"
		:class="{ 'collapse-open': isOpen, 'z-30': isOpen }"
	>
		<div v-if="isOpen" @click="isOpen = false" class="fixed inset-0 z-10 lg:hidden bg-transparent"></div>

		<div class="collapse-title navbar relative z-20">
			<div class="navbar-start">
				<Hamburger v-model="isOpen" class="lg:hidden" />
				<button class="btn btn-ghost text-xl ml-2"><RouterLink to="/">Four Games</RouterLink></button>
			</div>
			<div class="navbar-center hidden lg:flex">
				<ul class="menu menu-horizontal px-1">
					<li>
						<button><RouterLink to="/">Home</RouterLink></button>
					</li>
					<li>
						<button><RouterLink to="/code">Open Source</RouterLink></button>
					</li>
					<li>
						<button><RouterLink to="/jobs">Work With Us</RouterLink></button>
					</li>
					<!-- <li>
						<button><RouterLink to="/test">404</RouterLink></button>
					</li> -->
					<!-- <li>
						<details>
							<summary>Contact</summary>
							<ul class="p-2 bg-base-100 w-40 z-1">
								<li>
									<button>
										<a href="http://discord.fourgames.se/" target="_blank">Help & Support</a>
									</button>
								</li>
								<li>
									<button><RouterLink to="/jobs">Work With Us</RouterLink></button>
								</li>
							</ul>
						</details>
					</li> -->
				</ul>
			</div>
			<div class="navbar-end">
				<ThemeToggle />
			</div>
		</div>

		<div class="collapse-content lg:hidden relative z-20">
			<ul class="menu">
				<li>
					<button><RouterLink to="/">Home</RouterLink></button>
				</li>
				<li>
					<button><RouterLink to="/code">Open Source</RouterLink></button>
				</li>
				<li>
					<button><RouterLink to="/jobs">Work With Us</RouterLink></button>
				</li>
				<!-- <li>
					<button class="pointer-events-none">Contact</button>
					<ul>
						<li>
							<button><a href="http://discord.fourgames.se/" target="_blank">Help & Support</a></button>
						</li>
						<li>
							<button><RouterLink to="/jobs">Work With Us</RouterLink></button>
						</li>
					</ul>
				</li> -->
			</ul>
		</div>
	</div>
</template>
