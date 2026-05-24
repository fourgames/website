<script setup>
import { ref, onMounted } from "vue";
import ContainerWrapper from "../common/ContainerWrapper.vue";

// Define the repositories you want to showcase
const repoNames = ["fourgames/template", "fourgames/resources"]; 
const repositories = ref([]);
const loading = ref(true);

onMounted(async () => {
	try {
		// Fetch data from GitHub's public API
		const requests = repoNames.map(repo => 
			fetch(`https://api.github.com/repos/${repo}`).then(res => res.json())
		);
		repositories.value = await Promise.all(requests);
	} catch (error) {
		console.error("Error fetching GitHub repositories:", error);
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<ContainerWrapper title="Our Repositories">
		<div class="grid grid-cols-1 md:grid-cols-2 gap-4 p-2">
			
			<template v-if="loading">
				<div v-for="n in repoNames.length" :key="n" class="skeleton h-40 w-full rounded-xl"></div>
			</template>

			<template v-else>
				<div v-for="repo in repositories" :key="repo.id" class="w-full">
					<a 
						:href="repo.html_url" 
						target="_blank" 
						rel="noopener noreferrer"
						class="card bg-base-100 border border-base-300 shadow-sm hover:shadow-md hover:border-base-content/20 transition-all duration-200 h-full group"
					>
						<div class="card-body p-5 justify-between">
							<div>
								<div class="flex items-center gap-2 mb-2">
									<svg class="w-5 h-5 text-base-content/50 group-hover:text-base-content transition-colors" viewBox="0 0 16 16" fill="currentColor">
										<path d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"></path>
									</svg>
									<h3 class="card-title text-md group-hover:text-primary transition-colors">
										{{ repo.name }}
									</h3>
								</div>

								<p class="text-sm text-base-content/70 line-clamp-2 mb-4">
									{{ repo.description || 'No description provided.' }}
								</p>
							</div>

							<div class="card-actions justify-start items-center gap-4 text-xs font-semibold text-base-content/60">
								<div v-if="repo.language" class="badge badge-primary badge-outline gap-1.5">
									<span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
									{{ repo.language }}
								</div>

								<div class="flex items-center gap-1" title="Stars">
									<svg class="w-4 h-4 stroke-current" fill="none" stroke-width="2" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
									</svg>
									<span>{{ repo.stargazers_count.toLocaleString() }}</span>
								</div>

								<div class="flex items-center gap-1" title="Forks">
									<svg class="w-4 h-4 stroke-current" fill="none" stroke-width="2" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
									</svg>
									<span>{{ repo.forks_count.toLocaleString() }}</span>
								</div>
							</div>
						</div>
					</a>
				</div>
			</template>

		</div>
	</ContainerWrapper>
</template>