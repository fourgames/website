<script setup>
import { useId } from "vue";
import { useI18n } from "@/i18n/index.js";

// The factsheet as a side panel, like the details box beside a Steam store page: art on top
// (`media` slot), then label/value rows journalists can skim, then actions (default slot).
// A row is { label, value } or { label, links: [{ label, href }] }; rows without either are left out.
defineProps({
	title: { type: String, required: true },
	rows: { type: Array, required: true },
});

const { t } = useI18n();
const headingId = useId();
const isExternal = (href) => /^https?:\/\//.test(href);
</script>

<template>
	<aside class="card overflow-hidden" :aria-labelledby="headingId">
		<slot name="media" />
		<div class="p-5">
			<h2 :id="headingId" class="text-xl">{{ title }}</h2>
			<dl class="mt-4 flex flex-col gap-3 text-sm">
				<template v-for="row in rows" :key="row.label">
					<div v-if="row.value || row.links?.length" class="grid gap-0.5">
						<dt class="text-xs font-semibold tracking-wide text-date uppercase">{{ row.label }}</dt>
						<dd v-if="row.links?.length" class="min-w-0 break-words">
							<template v-for="(link, i) in row.links" :key="link.href">
								<a
									:href="link.href"
									class="link"
									:target="isExternal(link.href) ? '_blank' : undefined"
									:rel="isExternal(link.href) ? 'noopener noreferrer' : undefined"
									>{{ link.label }}<span v-if="isExternal(link.href)" class="sr-only"> {{ t("a11y.newTab") }}</span></a
								><span v-if="i < row.links.length - 1">, </span>
							</template>
						</dd>
						<dd v-else class="min-w-0 break-words">{{ row.value }}</dd>
					</div>
				</template>
			</dl>
			<div v-if="$slots.default" class="mt-5 flex flex-wrap gap-3">
				<slot />
			</div>
		</div>
	</aside>
</template>
