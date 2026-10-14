<template>
    <AppInput label="Runtime" :model-value="runtimeString" readonly />
</template>

<script setup lang="ts">
import type { ActionDto } from '@kleinkram/api-dto/types/actions/action.dto';
import { ActionState } from '@kleinkram/shared';
import AppInput from 'components/common/app-input.vue';
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

const lastServerRuntime = ref<number | undefined>(props.action.runtime);
const lastServerUpdate = ref<number>(Date.now());

watch(
    () => props.action.runtime,
    (newValue) => {
        // Prevent resetting the optimistic timer if the server value hasn't actually changed
        if (newValue === lastServerRuntime.value) return;

        lastServerRuntime.value = newValue;
        lastServerUpdate.value = Date.now();
    },
    { immediate: true },
);

const runtimeString = computed(() => {
    // `runtime` is only populated once the Action's container has actually
    // started (see actionEntityToDto) — before that it's still queued, which
    // is reported separately by ActionQueueWait.
    if (lastServerRuntime.value === undefined) return 'N/A';

    let currentRuntime = lastServerRuntime.value;

    // If the action is running, add the time elapsed since the last server update
    if (props.action.state === ActionState.PROCESSING) {
        const elapsedSinceUpdate = (now.value - lastServerUpdate.value) / 1000;
        currentRuntime += elapsedSinceUpdate;
    }

    const secondsProxy = currentRuntime.toFixed(0);
    if (secondsProxy === '0') return 'N/A';
    return `${secondsProxy} second${secondsProxy === '1' ? '' : 's'}`;
});
</script>
