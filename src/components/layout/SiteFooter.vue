<script setup>
import Icon from "@/components/ui/Icon.vue";
import I18nT from "@/components/ui/I18nT.vue";
import NavLink from "@/components/ui/NavLink.vue";
import { FOOTER_COLUMNS } from "@/data/footer.js";
import { SITE, SOCIALS } from "@/data/site.js";
import { useI18n } from "@/i18n/index.js";

const { t } = useI18n();
const year = __BUILD_YEAR__;
</script>

<template>
	<footer class="bg-footer text-footer-fg">
		<div class="container-page grid gap-10 pt-14 pb-12 sm:grid-cols-2 lg:grid-cols-4">
			<nav v-for="column in FOOTER_COLUMNS" :key="column.id" :aria-labelledby="`footer-${column.id}`">
				<h2 :id="`footer-${column.id}`" class="text-lg text-white">{{ t(column.heading) }}</h2>
				<ul class="mt-4 space-y-2 text-sm">
					<li v-for="link in column.links" :key="link.label">
						<NavLink v-if="link.to" :to="link.to" class="inline-block py-0.5 transition-colors hover:text-white">
							{{ t(link.label) }}
						</NavLink>
						<a
							v-else
							:href="link.href"
							target="_blank"
							rel="noopener noreferrer"
							class="inline-block py-0.5 transition-colors hover:text-white"
						>
							{{ t(link.label) }}<span class="sr-only"> {{ t("a11y.newTab") }}</span>
						</a>
					</li>
				</ul>
			</nav>
		</div>

		<div class="border-t border-white/10">
			<div class="container-page flex flex-col gap-4 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
				<p>
					<I18nT keypath="footer.copyright" :params="{ year, name: SITE.name }">
						<template #author>
							<a href="https://game-icons.net/" target="_blank" rel="noopener noreferrer" class="underline hover:text-white"
								>Lorc<span class="sr-only"> {{ t("a11y.newTab") }}</span></a
							>
						</template>
					</I18nT>
				</p>
				<ul class="flex flex-wrap items-center gap-1" :aria-label="t('a11y.socialLinks')">
					<li v-for="social in SOCIALS" :key="social.label">
						<a
							:href="social.href"
							target="_blank"
							rel="noopener noreferrer"
							class="grid size-10 place-items-center rounded-lg transition-colors hover:bg-white/10 hover:text-white"
						>
							<Icon :name="social.icon" class="size-5" />
							<span class="sr-only">{{ social.label }} {{ t("a11y.newTab") }}</span>
						</a>
					</li>
				</ul>
			</div>
		</div>
	</footer>
</template>
