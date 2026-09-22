<script setup>
import { ref, useId } from "vue";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import { SITE } from "@/data/site.js";

// Posts to Formspree. Works without JS (plain form POST); with JS it submits in-page.
const emailId = useId();
const messageId = useId();

const email = ref("");
const message = ref("");
const isSubmitting = ref(false);
const status = ref(null); // null | "success" | "error"
let resetTimer;

async function submit(event) {
	clearTimeout(resetTimer);
	isSubmitting.value = true;
	status.value = null;
	try {
		const response = await fetch(SITE.formspree, {
			method: "POST",
			body: new FormData(event.target),
			headers: { Accept: "application/json" },
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		status.value = "success";
		email.value = "";
		message.value = "";
		resetTimer = setTimeout(() => (status.value = null), 8000);
	} catch {
		status.value = "error";
	} finally {
		isSubmitting.value = false;
	}
}

const fieldClass =
	"block w-full rounded-btn border border-line bg-bg px-4 text-base text-fg placeholder:text-date transition-colors focus:border-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/40 user-invalid:border-danger disabled:opacity-60";
</script>

<template>
	<form :action="SITE.formspree" method="POST" class="card flex h-full flex-col p-6 sm:p-8" @submit.prevent="submit">
		<h3 class="text-xl">Send us a message</h3>
		<p class="mt-1 text-sm text-date">Tell us about your project or partnership idea.</p>

		<input type="hidden" name="_subject" value="New message from fourgames.se" />
		<!-- Honeypot for bots: hidden from people and assistive tech. -->
		<div class="hidden" aria-hidden="true">
			<label>Leave this empty <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" /></label>
		</div>

		<div class="mt-6 space-y-5">
			<div>
				<label :for="emailId" class="mb-2 block text-sm font-semibold">Email</label>
				<input
					:id="emailId"
					v-model="email"
					type="email"
					name="email"
					autocomplete="email"
					inputmode="email"
					required
					placeholder="you@studio.com"
					:disabled="isSubmitting"
					:class="[fieldClass, 'h-12']"
				/>
			</div>
			<div>
				<label :for="messageId" class="mb-2 block text-sm font-semibold">Message</label>
				<textarea
					:id="messageId"
					v-model="message"
					name="message"
					rows="5"
					required
					placeholder="Hi Four Games, we'd love to…"
					:disabled="isSubmitting"
					:class="[fieldClass, 'min-h-36 resize-y py-3']"
				></textarea>
			</div>
		</div>

		<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
			<Button type="submit" variant="blue" :disabled="isSubmitting" :icon="isSubmitting ? undefined : 'send'">
				<Icon v-if="isSubmitting" name="loader" class="size-4 motion-safe:animate-spin" />
				{{ isSubmitting ? "Sending…" : "Send message" }}
			</Button>
			<p class="text-xs text-date">Prefer a quicker reply? Ask us on Discord.</p>
		</div>

		<!-- Always present so screen readers pick up changes. -->
		<div class="mt-5 min-h-6 text-sm" role="status" aria-live="polite">
			<p v-if="status === 'success'" class="flex items-center gap-2 text-success">
				<Icon name="check-circle" class="size-4" />
				Thanks! Your message has been sent. We'll get back to you soon.
			</p>
		</div>
		<p v-if="status === 'error'" role="alert" class="flex items-start gap-2 text-sm text-danger">
			<Icon name="alert" class="mt-0.5 size-4" />
			Something went wrong sending your message. Please try again, or reach us on Discord.
		</p>
	</form>
</template>
