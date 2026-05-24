<script setup>
import ContainerWrapper from "../components/common/ContainerWrapper.vue";
</script>

<template>
	<ContainerWrapper title="404 - Page not found">
		<div class="max-w-lg mx-auto text-center space-y-10">
			<div class="flex justify-center py-8">
				<div class="grid place-items-center w-24 h-24">
					<span class="col-start-1 row-start-1 w-20 h-20 rounded-full bg-error/40 animate-ping"></span>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="col-start-1 row-start-1 h-20 w-20 text-error z-10"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						stroke-width="1.5"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
				</div>
			</div>

			<div class="space-y-4">
				<h3 class="font-bold text-lg">Explore</h3>
				<ul class="menu menu-horizontal justify-center gap-2">
					<li>
						<button><RouterLink to="/">Home</RouterLink></button>
					</li>
					<li>
						<button><RouterLink to="/code">Open Source</RouterLink></button>
					</li>
					<!-- <li>
						<button>
							<a href="http://discord.fourgames.se/" target="_blank">Help & Support</a>
						</button>
					</li> -->
					<li>
						<button><RouterLink to="/jobs">Work With Us</RouterLink></button>
					</li>
				</ul>
			</div>

			<div class="text-sm text-base-content/60 pt-4 border-t border-base-200">
				To report an issue with the website, please
				<a href="https://github.com/fourgames/website/issues/new" target="_blank" class="link link-error"
					>open an issue on GitHub</a
				>.
			</div>
		</div>
	</ContainerWrapper>
</template>
