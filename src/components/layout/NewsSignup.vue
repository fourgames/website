<script setup>
import { onMounted, ref, useId } from "vue";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import I18nT from "@/components/ui/I18nT.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// The fan mailing list's signup (server/news). Double opt-in: the server emails a confirm link, and
// only addresses confirmed from it are on the list. Like the contact form it needs JS for _elapsed,
// which the server checks against bots.
const { t, code } = useI18n();
const emailId = useId();
const noteId = useId();

const email = ref("");
const isSubmitting = ref(false);
const status = ref(null); // null | "success" | "error"
let shownAt = 0;

onMounted(() => (shownAt = performance.now()));

async function submit(event) {
	isSubmitting.value = true;
	status.value = null;
	try {
		const form = new FormData(event.target);
		const response = await fetch(`${SITE.news}/subscribe`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				email: email.value.trim(),
				lang: code,
				_gotcha: form.get("_gotcha") || "",
				_elapsed: String(Math.round(performance.now() - shownAt)),
			}),
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok || !result.ok) throw new Error(`HTTP ${response.status}`);
		status.value = "success";
		email.value = "";
	} catch {
		status.value = "error";
	} finally {
		isSubmitting.value = false;
	}
}
</script>

<template>
	<div class="container-page grid gap-6 py-10 lg:grid-cols-2 lg:items-center lg:gap-10">
		<div>
			<h2 class="text-lg text-white">{{ t("footer.news.heading") }}</h2>
			<p :id="noteId" class="mt-2 max-w-prose text-sm">
				<I18nT keypath="footer.news.note">
					<template #privacy>
						<NavLink to="/privacy" class="underline hover:text-white">{{ t("footer.news.privacy") }}</NavLink>
					</template>
				</I18nT>
			</p>
		</div>

		<form :action="`${SITE.news}/subscribe`" method="POST" @submit.prevent="submit">
			<!-- Honeypot for bots: hidden from people and assistive tech. -->
			<div class="hidden" aria-hidden="true">
				<label>{{ t("form.honeypot") }} <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" /></label>
			</div>
			<div class="flex flex-col gap-3 sm:flex-row">
				<label :for="emailId" class="sr-only">{{ t("footer.news.label") }}</label>
				<input
					:id="emailId"
					v-model="email"
					type="email"
					name="email"
					autocomplete="email"
					inputmode="email"
					required
					:placeholder="t('footer.news.placeholder')"
					:aria-describedby="noteId"
					:disabled="isSubmitting"
					class="block h-11 w-full min-w-0 rounded-btn sm:flex-1 border border-white/15 bg-white/5 px-4 text-base text-white transition-colors placeholder:text-footer-fg focus:border-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-primary/40 disabled:opacity-60"
				/>
				<Button type="submit" variant="blue" :disabled="isSubmitting" :icon="isSubmitting ? undefined : 'send'" class="shrink-0">
					<Icon v-if="isSubmitting" name="loader" class="size-4 motion-safe:animate-spin" />
					{{ isSubmitting ? t("footer.news.sending") : t("footer.news.button") }}
				</Button>
			</div>
			<!-- Always present so screen readers pick up changes. -->
			<div class="mt-3 min-h-5 text-sm" role="status" aria-live="polite">
				<p v-if="status === 'success'" class="flex items-start gap-2 text-white">
					<Icon name="check-circle" class="mt-0.5 size-4 shrink-0 text-success" />
					{{ t("footer.news.success") }}
				</p>
				<p v-else-if="status === 'error'" class="flex items-start gap-2 text-white">
					<Icon name="alert" class="mt-0.5 size-4 shrink-0 text-danger" />
					{{ t("footer.news.error") }}
				</p>
			</div>
		</form>
	</div>
</template>
