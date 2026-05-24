<script setup>
import { ref } from "vue";
import ContainerWrapper from "../common/ContainerWrapper.vue";

// Reactive form fields using v-model
const email = ref("");
const message = ref("");

// Reactive states for managing form submission
const isSubmitting = ref(false);
const submitStatus = ref(null); // 'success' or 'error'
let timeoutId = null;

const handleSubmit = async () => {
	// Clear any active auto-reset timeouts before sending again
	if (timeoutId) clearTimeout(timeoutId);

	isSubmitting.value = true;
	submitStatus.value = null;

	// Use modern URLSearchParams or FormData with v-model bindings
	const formData = new FormData();
	formData.append("email", email.value);
	formData.append("message", message.value);

	try {
		const response = await fetch("https://formspree.io/f/mbdplgvl", {
			method: "POST",
			body: formData,
			headers: {
				Accept: "application/json",
			},
		});

		if (response.ok) {
			submitStatus.value = "success";
			// Clear the reactive form fields on success
			email.value = "";
			message.value = "";

			// Automatically revert back to the helpful Discord note after 5 seconds
			timeoutId = setTimeout(() => {
				submitStatus.value = null;
			}, 5000);
		} else {
			submitStatus.value = "error";
		}
	} catch (error) {
		submitStatus.value = "error";
	} finally {
		isSubmitting.value = false;
	}
};
</script>

<template>
	<div class="space-y-6">
		<ContainerWrapper title="Contact Us">
			<div class="p-6 max-w-xl mx-auto space-y-6">
				<div class="relative overflow-hidden min-h-[4rem]">
					<Transition name="alert-fade" mode="out-in">
						<div
							v-if="submitStatus === 'success'"
							key="success"
							role="alert"
							class="alert alert-success text-sm shadow-sm flex items-start gap-3 w-full"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="stroke-current shrink-0 h-5 w-5 mt-0.5"
								fill="none"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<div>
								<span class="font-bold">Thank you!</span> Your message has been sent successfully. We'll
								get back to you soon.
							</div>
						</div>

						<div
							v-else-if="submitStatus === 'error'"
							key="error"
							role="alert"
							class="alert alert-error text-sm shadow-sm flex items-start gap-3 w-full"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								class="stroke-current shrink-0 h-5 w-5 mt-0.5"
								fill="none"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							<div>
								<span class="font-bold">Error!</span> Something went wrong. Please try again or head
								over to Discord.
							</div>
						</div>

						<div
							v-else
							key="note"
							role="alert"
							class="alert alert-info text-sm shadow-sm flex items-start gap-3 w-full"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								fill="none"
								viewBox="0 0 24 24"
								class="stroke-current shrink-0 h-5 w-5 mt-0.5"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								></path>
							</svg>
							<div>
								<span class="font-bold">Note:</span> The fastest way to get in touch is via joining our
								Discord above. Response times here may vary.
							</div>
						</div>
					</Transition>
				</div>

				<form @submit.prevent="handleSubmit" class="space-y-4 w-full">
					<div class="form-control w-full">
						<label class="label">
							<span class="label-text font-semibold text-base-content/80">Your Email</span>
						</label>
						<input
							v-model="email"
							type="email"
							name="email"
							placeholder="you@example.com"
							required
							class="input input-bordered w-full focus:input-neutral transition-colors"
							:disabled="isSubmitting"
						/>
					</div>

					<div class="form-control w-full">
						<label class="label">
							<span class="label-text font-semibold text-base-content/80">Your Message</span>
						</label>
						<textarea
							v-model="message"
							name="message"
							placeholder="Tell us about your project or partnership idea..."
							rows="5"
							required
							class="textarea textarea-bordered w-full h-32 focus:textarea-neutral transition-colors"
							:disabled="isSubmitting"
						></textarea>
					</div>

					<div class="pt-2">
						<button type="submit" class="btn btn-neutral w-full shadow-md" :disabled="isSubmitting">
							<span v-if="isSubmitting" class="loading loading-spinner"></span>
							{{ isSubmitting ? "Sending..." : "Send Message" }}
						</button>
					</div>
				</form>
			</div>
		</ContainerWrapper>
	</div>
</template>

<style scoped>
/* Smooth crossfade and minor slide transitions for changing alerts */
.alert-fade-enter-active,
.alert-fade-leave-active {
	transition: all 0.25s ease-in-out;
}

.alert-fade-enter-from {
	opacity: 0;
	transform: translateY(-4px);
}

.alert-fade-leave-to {
	opacity: 0;
	transform: translateY(4px);
}
</style>
