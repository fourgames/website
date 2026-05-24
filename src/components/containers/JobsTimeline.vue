<script setup>
import ContainerWrapper from "../common/ContainerWrapper.vue";
</script>

<template>
	<div class="space-y-6">
		<ContainerWrapper title="Our Collaborations">
			<div class="p-6 max-w-3xl mx-auto">
				<ul class="timeline timeline-snap-icon max-md:timeline-compact timeline-vertical">
					<li>
						<div class="timeline-middle grid place-items-center w-6 h-6">
							<span class="col-start-1 row-start-1 w-5 h-5 rounded-full bg-error/40 animate-ping"></span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="2.5"
								stroke="currentColor"
								class="col-start-1 row-start-1 h-5 w-5 text-error z-10"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
								/>
							</svg>
						</div>
						<div class="timeline-start mb-10 md:text-end md:pr-4">
							<span class="badge badge-error text-white badge-sm font-mono font-bold tracking-wide"
								>YouTube Creators</span
							>
							<div class="text-lg font-bold mt-2 text-error">Guest Series</div>
							<p class="text-sm text-base-content/70 mt-1">
								Featuring educational series on our channel to provide exposure to your work.
							</p>
						</div>
						<hr class="bg-error" />
					</li>

					<li>
						<hr class="bg-error" />
						<div class="timeline-middle grid place-items-center w-6 h-6">
							<span class="col-start-1 row-start-1 w-5 h-5 rounded-full bg-info/40 animate-ping"></span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="2.5"
								stroke="currentColor"
								class="col-start-1 row-start-1 h-5 w-5 text-info z-10"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 12V5.25"
								/>
							</svg>
						</div>
						<div class="timeline-end mb-10 md:pl-4">
							<span class="badge badge-info text-white badge-sm font-mono font-bold tracking-wide"
								>Indie Studios</span
							>
							<div class="text-lg font-bold mt-2 text-info">Co-Development & Publishing</div>
							<p class="text-sm text-base-content/70 mt-1">
								We partner with experienced developers to co-develop or publish new titles.
							</p>
						</div>
						<hr class="bg-info" />
					</li>

					<li>
						<hr class="bg-info" />
						<div class="timeline-middle grid place-items-center w-6 h-6">
							<span
								class="col-start-1 row-start-1 w-5 h-5 rounded-full bg-warning/40 animate-ping"
							></span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="2.5"
								stroke="currentColor"
								class="col-start-1 row-start-1 h-5 w-5 text-warning z-10"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M11.48 3.499c.151-.312.558-.312.709 0l2.36 4.782a1 1 0 0 0 .753.547l5.277.768c.345.05.483.474.233.723l-3.818 3.72a1 1 0 0 0-.287.885l.901 5.258c.059.344-.303.608-.611.446l-4.718-2.48a1 1 0 0 0-.936 0l-4.718 2.48c-.308.162-.67-.102-.611-.446l.901-5.258a1 1 0 0 0-.287-.885l-3.818-3.72c-.25-.249-.111-.674.233-.723l5.277-.768a1 1 0 0 0 .753-.547l2.36-4.782Z"
								/>
							</svg>
						</div>
						<div class="timeline-start mb-10 md:text-end md:pr-4">
							<span class="badge badge-warning text-base-100 badge-sm font-mono font-bold tracking-wide"
								>Brands & IPs</span
							>
							<div class="text-lg font-bold mt-2 text-warning">Franchise Collaborations</div>
							<p class="text-sm text-base-content/70 mt-1">
								We aim to develop licensed games for Nintendo, LEGO, and anime properties.
							</p>
						</div>
						<hr class="bg-warning" />
					</li>

					<li>
						<hr class="bg-warning" />
						<div class="timeline-middle grid place-items-center w-6 h-6">
							<span
								class="col-start-1 row-start-1 w-5 h-5 rounded-full bg-success/40 animate-ping"
							></span>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								stroke-width="2.5"
								stroke="currentColor"
								class="col-start-1 row-start-1 h-5 w-5 text-success z-10"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z"
								/>
							</svg>
						</div>
						<div class="timeline-end mb-10 md:pl-4">
							<span class="badge badge-success text-white badge-sm font-mono font-bold tracking-wide"
								>Community Trust</span
							>
							<div class="text-lg font-bold mt-2 text-success">Zero Sponsorships</div>
							<p class="text-sm text-base-content/70 mt-1">
								We have never and will never accept sponsorships or paid brand deals.
							</p>
						</div>
					</li>
				</ul>
			</div>
		</ContainerWrapper>
	</div>
</template>
