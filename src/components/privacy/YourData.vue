<script setup>
import { computed, onMounted, ref, useId } from "vue";
import Button from "@/components/ui/Button.vue";
import I18nT from "@/components/ui/I18nT.vue";
import Icon from "@/components/ui/Icon.vue";
import PolicyText from "@/components/privacy/PolicyText.vue";
import { SITE } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";
import { formatDate, formatNumber } from "@/lib/format.js";
import { getGames } from "@/lib/games.js";

// "Your data": the player endpoints of server/gamedata (SPEC.md → Player endpoints). Signing in is
// a plain link to Steam's OpenID via our server, which sets an HttpOnly cookie on api.fourgames.se
// (1 h) and sends the player back here; everything else is fetch() with that cookie.
// The prerendered HTML (and the first client render, so hydration matches) is the signed-out card
// with the sign-in button; the real state is asked for after mount.
const i18n = useI18n();
const { t, path, locale } = i18n;
const API = SITE.gamedata;
const signInUrl = `${API}/auth/steam?return=${path("/privacy")}`;

const state = ref("signedOut"); // signedOut | loading | signedIn | unreachable | error
const notice = ref(null); // null | "expired" | "signedOut" | "anonymised" (shown on the signed-out card)
const me = ref(null);
const busy = ref(null); // null | "optout" | "export" | "anonymise" | "signout"
const actionError = ref(null); // null | message key
const saved = ref(""); // polite live message after an opt-out change
const dialog = ref(null);
const dialogTitleId = useId();
const dialogTextId = useId();
const switchId = useId();
const switchHintId = useId();

const names = new Map(getGames(i18n).map((g) => [g.appId, g.name]));
const games = computed(() =>
	(me.value?.games ?? []).map((g) => ({
		...g,
		name: names.get(Number(g.app_id)) ?? t("privacy.data.unknownGame", { id: g.app_id }),
	})),
);

// The server's timestamps: ISO strings or Unix seconds/milliseconds.
function date(value) {
	if (value == null || value === "") return "–";
	const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
	return Number.isNaN(d.getTime()) ? "–" : formatDate(d.toISOString(), locale.intl);
}

function playtime(seconds) {
	const total = Math.max(0, Math.round(Number(seconds) || 0) / 60);
	const h = Math.floor(total / 60);
	const m = Math.round(total % 60);
	return h ? t("privacy.data.hoursMinutes", { h: formatNumber(h, locale.intl), m }) : t("privacy.data.minutes", { m });
}

// A failed request: no answer or a 5xx from Caddy is "unreachable"; 401 means the hour is up.
class ApiError extends Error {
	constructor(status) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

async function api(endpoint, { method = "GET", body } = {}) {
	let response;
	try {
		response = await fetch(`${API}${endpoint}`, {
			method,
			credentials: "include",
			headers: body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		});
	} catch {
		throw new ApiError(0);
	}
	if (!response.ok) throw new ApiError(response.status);
	return response;
}

const isUnreachable = (error) => error.status === 0 || error.status === 502 || error.status === 503 || error.status === 504;

function signedOut(why) {
	me.value = null;
	notice.value = why;
	state.value = "signedOut";
	dialog.value?.close();
}

// For the actions: an expired sign-in goes back to the sign-in card, anything else stays inline.
function actionFailed(error) {
	if (error.status === 401) return signedOut("expired");
	actionError.value = isUnreachable(error) ? "privacy.data.actionUnreachable" : "privacy.data.actionError";
}

async function load() {
	state.value = "loading";
	try {
		const data = await (await api("/me")).json();
		if (!data.signed_in) {
			if (state.value === "loading") state.value = "signedOut";
			return;
		}
		me.value = data;
		notice.value = null;
		state.value = "signedIn";
	} catch (error) {
		if (error.status === 401) state.value = "signedOut";
		else state.value = isUnreachable(error) ? "unreachable" : "error";
	}
}

async function setOptOut(optedOut) {
	busy.value = "optout";
	actionError.value = null;
	saved.value = "";
	try {
		const result = await (await api("/me/optout", { method: "POST", body: { opted_out: optedOut } })).json().catch(() => ({}));
		me.value = { ...me.value, opted_out: result.opted_out ?? optedOut };
		saved.value = t(me.value.opted_out ? "privacy.data.savedOff" : "privacy.data.savedOn");
	} catch (error) {
		actionFailed(error);
	} finally {
		busy.value = null;
	}
}

async function download() {
	busy.value = "export";
	actionError.value = null;
	try {
		const blob = await (await api("/me/export")).blob();
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "fourgames-my-data.zip";
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	} catch (error) {
		actionFailed(error);
	} finally {
		busy.value = null;
	}
}

function askAnonymise() {
	actionError.value = null;
	dialog.value?.showModal();
}

async function anonymise() {
	busy.value = "anonymise";
	actionError.value = null;
	try {
		await api("/me/anonymise", { method: "POST", body: { confirm: true } });
		signedOut("anonymised");
	} catch (error) {
		dialog.value?.close();
		actionFailed(error);
	} finally {
		busy.value = null;
	}
}

async function signOut() {
	busy.value = "signout";
	actionError.value = null;
	try {
		await api("/auth/signout", { method: "POST", body: {} });
		signedOut("signedOut");
	} catch (error) {
		actionFailed(error);
	} finally {
		busy.value = null;
	}
}

onMounted(load);

const dangerButton =
	"group/btn inline-flex h-11 items-center justify-center gap-2 rounded-btn px-5 font-heading text-base font-extrabold whitespace-nowrap transition-[background-color,color,transform] duration-150 active:scale-[.98] disabled:pointer-events-none disabled:opacity-60";
</script>

<template>
	<div class="card max-w-3xl p-6 sm:p-8" :aria-busy="state === 'loading' || busy ? 'true' : 'false'">
		<!-- Signed out (also what the prerendered page shows). -->
		<template v-if="state === 'signedOut' || state === 'loading'">
			<div role="status" aria-live="polite">
				<p v-if="notice" class="mb-6 flex items-start gap-2 rounded-btn bg-bg p-4 text-sm">
					<Icon :name="notice === 'expired' ? 'clock' : 'check-circle'" :class="['mt-0.5 size-4', notice !== 'expired' && 'text-success']" />
					<span>{{ t(`privacy.data.notice.${notice}`) }}</span>
				</p>
			</div>
			<h3 class="text-xl">{{ t("privacy.data.signInTitle") }}</h3>
			<p class="mt-3">{{ t("privacy.data.signInText") }}</p>
			<div class="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3">
				<!-- Valve's "Sign in through Steam" button, drawn in CSS: Steam's dark navy with the Steam mark. -->
				<a
					:href="signInUrl"
					class="inline-flex h-12 items-center gap-3 rounded-btn bg-[#171a21] px-5 font-semibold text-white shadow-card ring-1 ring-white/10 transition-colors hover:bg-[#2a475e]"
				>
					<Icon name="steam" class="size-6" />
					<span>{{ t("privacy.data.signIn") }}</span>
				</a>
				<p v-if="state === 'loading'" class="flex items-center gap-2 text-sm text-date">
					<Icon name="loader" class="size-4 motion-safe:animate-spin" />
					{{ t("privacy.data.checking") }}
				</p>
			</div>
			<p class="mt-4 text-sm text-date">{{ t("privacy.data.signInNote") }}</p>
		</template>

		<!-- The server didn't answer: calm, with a retry. -->
		<template v-else-if="state === 'unreachable' || state === 'error'">
			<h3 class="flex items-center gap-2 text-xl">
				<Icon name="clock" class="size-5 text-date" />
				{{ t(state === "unreachable" ? "privacy.data.unreachableTitle" : "privacy.data.errorTitle") }}
			</h3>
			<p class="mt-3">
				<PolicyText :keypath="state === 'unreachable' ? 'privacy.data.unreachable' : 'privacy.data.error'" />
			</p>
			<p v-if="state === 'unreachable'" class="mt-3">
				<I18nT keypath="privacy.data.status">
					<template #status>
						<a :href="SITE.status" target="_blank" rel="noopener noreferrer" class="link"
							>{{ SITE.status.replace(/^https:\/\//, "") }}<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
						>
					</template>
				</I18nT>
			</p>
			<div class="mt-6">
				<Button icon="arrow-right" @click="load">{{ t("privacy.data.retry") }}</Button>
			</div>
		</template>

		<!-- Signed in. -->
		<template v-else-if="state === 'signedIn' && me">
			<div class="flex flex-wrap items-center justify-between gap-3">
				<p class="flex items-center gap-2 font-semibold">
					<Icon name="steam" class="size-5" />
					{{ t("privacy.data.signedIn") }}
				</p>
				<Button variant="ghost" size="sm" icon="log-out" :disabled="busy !== null" @click="signOut">{{ t("privacy.data.signOut") }}</Button>
			</div>

			<!-- Data collection on/off for this Steam account, in every game. -->
			<div class="mt-6 flex items-start justify-between gap-4 rounded-btn border border-line p-4">
				<div>
					<label :for="switchId" class="font-semibold">{{ t("privacy.data.collect") }}</label>
					<p :id="switchHintId" class="mt-1 text-sm text-date">
						{{ t(me.opted_out ? "privacy.data.collectOff" : "privacy.data.collectOn") }}
					</p>
				</div>
				<button
					:id="switchId"
					type="button"
					role="switch"
					:aria-checked="me.opted_out ? 'false' : 'true'"
					:aria-describedby="switchHintId"
					:disabled="busy !== null"
					:class="[
						'relative inline-flex h-8 w-14 shrink-0 items-center rounded-full transition-colors disabled:opacity-60',
						me.opted_out ? 'bg-line-strong' : 'bg-primary',
					]"
					@click="setOptOut(!me.opted_out)"
				>
					<span
						aria-hidden="true"
						:class="[
							'inline-block size-6 rounded-full bg-white shadow-card transition-transform motion-reduce:transition-none',
							me.opted_out ? 'translate-x-1' : 'translate-x-7',
						]"
					></span>
				</button>
			</div>
			<p class="mt-2 min-h-5 text-sm text-success" role="status" aria-live="polite">{{ saved }}</p>

			<h3 class="mt-6 text-xl">{{ t("privacy.data.gamesTitle") }}</h3>
			<p v-if="!games.length" class="mt-3">{{ t("privacy.data.noData") }}</p>
			<ul v-else class="mt-4 space-y-3">
				<li v-for="game in games" :key="game.app_id" class="rounded-btn bg-bg p-4">
					<p class="font-heading font-extrabold">{{ game.name }}</p>
					<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
						<div>
							<dt class="text-date">{{ t("privacy.data.sessions") }}</dt>
							<dd class="font-semibold">{{ formatNumber(game.sessions ?? 0, locale.intl) }}</dd>
						</div>
						<div>
							<dt class="text-date">{{ t("privacy.data.playtime") }}</dt>
							<dd class="font-semibold">{{ playtime(game.playtime_s) }}</dd>
						</div>
						<div>
							<dt class="text-date">{{ t("privacy.data.firstSeen") }}</dt>
							<dd class="font-semibold">{{ date(game.first_seen) }}</dd>
						</div>
						<div>
							<dt class="text-date">{{ t("privacy.data.lastSeen") }}</dt>
							<dd class="font-semibold">{{ date(game.last_seen) }}</dd>
						</div>
					</dl>
				</li>
			</ul>

			<div class="mt-8 flex flex-wrap gap-3">
				<Button variant="blue" :disabled="busy !== null" :icon="busy === 'export' ? undefined : 'download'" @click="download">
					<Icon v-if="busy === 'export'" name="loader" class="size-4 motion-safe:animate-spin" />
					{{ busy === "export" ? t("privacy.data.downloading") : t("privacy.data.download") }}
				</Button>
				<button
					type="button"
					:class="[dangerButton, 'border border-danger/60 text-danger hover:bg-danger/10']"
					:disabled="busy !== null"
					@click="askAnonymise"
				>
					<Icon name="user-x" class="size-[1.15em]" />
					{{ t("privacy.data.anonymise") }}
				</button>
			</div>
			<p class="mt-3 text-sm text-date">{{ t("privacy.data.downloadNote") }}</p>
		</template>

		<p v-if="actionError" role="alert" class="mt-5 flex items-start gap-2 text-sm text-danger">
			<Icon name="alert" class="mt-0.5 size-4" />
			{{ t(actionError) }}
		</p>
	</div>

	<!-- The anonymise confirmation. Cancel has the focus, so Enter never deletes by accident. -->
	<dialog
		ref="dialog"
		:aria-labelledby="dialogTitleId"
		:aria-describedby="dialogTextId"
		class="m-auto w-[calc(100%-2rem)] max-w-lg rounded-card border-0 bg-card p-6 text-fg shadow-card sm:p-8"
	>
		<h2 :id="dialogTitleId" class="text-2xl">{{ t("privacy.data.confirm.title") }}</h2>
		<div :id="dialogTextId" class="mt-4 space-y-3">
			<p>{{ t("privacy.data.confirm.what") }}</p>
			<p class="font-semibold">{{ t("privacy.data.confirm.final") }}</p>
			<p class="text-sm text-date">{{ t("privacy.data.confirm.copy") }}</p>
		</div>
		<div class="mt-6 flex flex-wrap justify-end gap-3">
			<Button autofocus :disabled="busy === 'anonymise'" @click="dialog?.close()">{{ t("privacy.data.confirm.cancel") }}</Button>
			<button type="button" :class="[dangerButton, 'bg-danger text-white shadow-card hover:bg-danger/90']" :disabled="busy === 'anonymise'" @click="anonymise">
				<Icon :name="busy === 'anonymise' ? 'loader' : 'user-x'" :class="['size-[1.15em]', busy === 'anonymise' && 'motion-safe:animate-spin']" />
				{{ t("privacy.data.confirm.yes") }}
			</button>
		</div>
	</dialog>
</template>
