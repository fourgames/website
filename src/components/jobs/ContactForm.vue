<script setup>
import { onMounted, ref, useId } from "vue";
import Button from "@/components/ui/Button.vue";
import Icon from "@/components/ui/Icon.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

// Reused by the press kit, which passes its own subtitle, placeholder and subject tag.
const props = defineProps({
	subtitle: { type: String, default: null },
	placeholder: { type: String, default: null },
	topic: { type: String, default: null },
});

// Posts to our own backend (server/contact), which mails the message to support@. It needs JS: the
// script adds _elapsed (ms since the form appeared), which the backend checks against bots.
const { t, code } = useI18n();
const emailId = useId();
const messageId = useId();
const fileId = useId();
const fileErrorId = useId();

// Matches the backend's CONTACT_MAX_ATTACHMENT_MB (default 5).
const MAX_FILE_MB = 5;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

const email = ref("");
const message = ref("");
const isSubmitting = ref(false);
const status = ref(null); // null | "success" | "error"
const file = ref(null); // the chosen PDF, or null
const fileError = ref(""); // the inline error for the file, or ""
const fileInput = ref(null);
const removeButton = ref(null);
let resetTimer;
let shownAt = 0;

onMounted(() => (shownAt = performance.now()));

// The same rule as the backend, which goes by the name (and the file's first bytes), not the type.
function isPdf(chosen) {
	return chosen.name.toLowerCase().endsWith(".pdf");
}

function chooseFile(event) {
	// A wrong file stays shown with its error (and the remove button) until it's removed or replaced.
	const chosen = event.target.files?.[0] ?? null;
	file.value = chosen;
	fileError.value = "";
	if (!chosen) return;
	if (!isPdf(chosen)) fileError.value = t("form.fileNotPdf");
	else if (chosen.size > MAX_FILE_BYTES) fileError.value = t("form.fileTooBig", { max: MAX_FILE_MB });
}

function removeFile() {
	file.value = null;
	fileError.value = "";
	if (fileInput.value) fileInput.value.value = "";
}

async function submit(event) {
	clearTimeout(resetTimer);
	if (fileError.value) {
		removeButton.value?.focus();
		return;
	}
	isSubmitting.value = true;
	status.value = null;
	try {
		const body = new FormData(event.target);
		body.set("_elapsed", String(Math.round(performance.now() - shownAt)));
		body.delete("attachment");
		if (file.value) body.set("attachment", file.value, file.value.name);
		const response = await fetch(SITE.contact, {
			method: "POST",
			body,
			headers: { Accept: "application/json" },
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok || !result.ok) throw new Error(`HTTP ${response.status}`);
		status.value = "success";
		email.value = "";
		message.value = "";
		removeFile();
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
	<form :action="SITE.contact" method="POST" class="card flex h-full flex-col p-6 sm:p-8" @submit.prevent="submit">
		<h3 class="text-xl">{{ t("form.title") }}</h3>
		<p class="mt-1 text-sm text-date">{{ props.subtitle ?? t("form.subtitle") }}</p>

		<input type="hidden" name="_subject" :value="`New ${props.topic ? `${props.topic} ` : ''}message from fourgames.se (${code})`" />
		<input type="hidden" name="_elapsed" value="" />
		<!-- Honeypot for bots: hidden from people and assistive tech. -->
		<div class="hidden" aria-hidden="true">
			<label>{{ t("form.honeypot") }} <input type="text" name="_gotcha" tabindex="-1" autocomplete="off" /></label>
		</div>

		<div class="mt-6 space-y-5">
			<div>
				<label :for="emailId" class="mb-2 block text-sm font-semibold">{{ t("form.email") }}</label>
				<input
					:id="emailId"
					v-model="email"
					type="email"
					name="email"
					autocomplete="email"
					inputmode="email"
					required
					:placeholder="t('form.emailPlaceholder')"
					:disabled="isSubmitting"
					:class="[fieldClass, 'h-12']"
				/>
			</div>
			<div>
				<label :for="messageId" class="mb-2 block text-sm font-semibold">{{ t("form.message") }}</label>
				<textarea
					:id="messageId"
					v-model="message"
					name="message"
					rows="5"
					required
					:placeholder="props.placeholder ?? t('form.messagePlaceholder')"
					:disabled="isSubmitting"
					:class="[fieldClass, 'min-h-36 resize-y py-3']"
				></textarea>
			</div>
			<div>
				<label :for="fileId" class="mb-2 block text-sm font-semibold">{{ t("form.file", { max: MAX_FILE_MB }) }}</label>
				<input
					v-show="!file"
					:id="fileId"
					ref="fileInput"
					type="file"
					name="attachment"
					accept="application/pdf,.pdf"
					:disabled="isSubmitting"
					:class="[
						fieldClass,
						'py-3 file:mr-4 file:cursor-pointer file:rounded-btn file:border-0 file:bg-line file:px-3 file:py-1 file:text-sm file:font-semibold file:text-fg',
					]"
					@change="chooseFile"
				/>
				<div
					v-if="file"
					:aria-describedby="fileError ? fileErrorId : undefined"
					:class="[fieldClass, 'flex h-12 items-center gap-3', fileError && 'border-danger']"
				>
					<span class="min-w-0 flex-1 truncate">{{ file.name }}</span>
					<button
						ref="removeButton"
						type="button"
						class="-mr-2 inline-flex size-8 shrink-0 items-center justify-center rounded-btn text-date transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-primary/40 disabled:opacity-60"
						:aria-label="t('form.fileRemove', { name: file.name })"
						:title="t('form.fileRemove', { name: file.name })"
						:disabled="isSubmitting"
						@click="removeFile"
					>
						<Icon name="close" class="size-4" />
					</button>
				</div>
				<p v-if="fileError" :id="fileErrorId" role="alert" class="mt-2 flex items-start gap-2 text-sm text-danger">
					<Icon name="alert" class="mt-0.5 size-4" />
					{{ fileError }}
				</p>
			</div>
		</div>

		<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
			<Button type="submit" variant="blue" :disabled="isSubmitting" :icon="isSubmitting ? undefined : 'send'">
				<Icon v-if="isSubmitting" name="loader" class="size-4 motion-safe:animate-spin" />
				{{ isSubmitting ? t("form.sending") : t("form.send") }}
			</Button>
			<p class="text-xs text-date">{{ t("form.quicker") }}</p>
		</div>

		<!-- Always present so screen readers pick up changes. -->
		<div class="mt-5 min-h-6 text-sm" role="status" aria-live="polite">
			<p v-if="status === 'success'" class="flex items-center gap-2 text-success">
				<Icon name="check-circle" class="size-4" />
				{{ t("form.success") }}
			</p>
		</div>
		<p v-if="status === 'error'" role="alert" class="flex items-start gap-2 text-sm text-danger">
			<Icon name="alert" class="mt-0.5 size-4" />
			{{ t("form.error") }}
		</p>
	</form>
</template>
