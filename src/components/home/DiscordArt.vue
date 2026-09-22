<script setup>
import { computed } from "vue";
import OnlinePill from "@/components/ui/OnlinePill.vue";

// Art for the "Discord role" perk card: a stack of members who are online right now (from the public
// Discord widget), the live online count and the gold member role. No usernames, only avatars.
const props = defineProps({
	tier: { type: String, default: "Supporter" }, // null hides the role pill
	members: { type: Array, default: () => [] },
	count: { type: Number, default: null },
	live: { type: Boolean, default: false },
	// Ring colour between the overlapping avatars: it has to match whatever the stack sits on,
	// which is the perk card's art well by default and the bare section band in "Get involved".
	frameClass: { type: String, default: "border-surface" },
});
const avatars = computed(() => props.members.filter((m) => m.avatarUrl).slice(0, 6));
const online = computed(() => props.count ?? avatars.value.length);

function hideAvatar(event) {
	event.target.hidden = true;
}
</script>

<template>
	<div class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-5 text-fg">
		<div class="flex items-center">
			<img
				v-for="m in avatars"
				:key="m.avatarUrl"
				:src="m.avatarUrl"
				width="44"
				height="44"
				alt=""
				loading="lazy"
				decoding="async"
				crossorigin="anonymous"
				referrerpolicy="no-referrer"
				:class="['-ml-3 size-11 rounded-full border-[3px] bg-card object-cover first:ml-0', frameClass]"
				@error="hideAvatar"
			/>
			<span
				v-for="n in Math.max(0, 6 - avatars.length)"
				:key="n"
				:class="['-ml-3 size-11 rounded-full border-[3px] bg-card first:ml-0', frameClass]"
			></span>
		</div>
		<OnlinePill :count="online" :live="live" />
		<span v-if="tier" class="inline-flex items-center rounded-full bg-[#f2c94c]/20 px-3 py-1 text-xs font-semibold text-[#b8860b] dark:text-[#f2c94c]">
			{{ tier }}
		</span>
	</div>
</template>
