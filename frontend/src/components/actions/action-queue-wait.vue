<template>
    <AppInput label="Queued For" :model-value="queueWaitString" readonly />
</template>

<script setup lang="ts">
import type { ActionDto } from '@kleinkram/api-dto/types/actions/action.dto';
import { ActionState } from '@kleinkram/shared';
import AppInput from 'components/common/app-input.vue';
import { formatDuration } from 'src/services/date-formating';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ action: ActionDto }>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
    timer = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});

onBeforeUnmount(() => {
    clearInterval(timer);
});

const lastServerQueueWait = ref<number | undefined>(
    props.action.queueWaitSeconds,
);
const lastServerUpdate = ref<number>(Date.now());

watch(
    () => props.action.queueWaitSeconds,
    (newValue) => {
        // Prevent resetting the optimistic timer if the server value hasn't actually changed
        if (newValue === lastServerQueueWait.value) return;

        lastServerQueueWait.value = newValue;
        lastServerUpdate.value = Date.now();
    },
    { immediate: true },
);

const isQueued = (state: ActionState) =>
    state === ActionState.PENDING || state === ActionState.STARTING;

const queueWaitString = computed(() => {
    if (lastServerQueueWait.value === undefined) return 'N/A';

    let currentWait = lastServerQueueWait.value;

    // While still queued, add the time elapsed since the last server update
    if (isQueued(props.action.state)) {
        currentWait += (now.value - lastServerUpdate.value) / 1000;
    }

    return formatDuration(currentWait);
});
</script>
