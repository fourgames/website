<script setup>
import { onMounted, ref } from "vue";
import { formatDate, formatRelative } from "@/lib/format.js";

// Prerendered HTML shows a fixed date (so hydration matches); the browser then switches to "3 days ago".
const props = defineProps({ datetime: { type: String, required: true } });
const label = ref(formatDate(props.datetime));
onMounted(() => {
	label.value = formatRelative(props.datetime);
});
</script>

<template>
	<time :datetime="datetime" :title="formatDate(datetime)">{{ label }}</time>
</template>
