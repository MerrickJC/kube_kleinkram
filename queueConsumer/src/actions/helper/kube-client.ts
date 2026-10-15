import * as k8s from '@kubernetes/client-node';

let kubeConfig: k8s.KubeConfig | undefined;

export function getKubeConfig(): k8s.KubeConfig {
    kubeConfig ??= (() => {
        const config = new k8s.KubeConfig();
        config.loadFromCluster();
        return config;
    })();
    return kubeConfig;
}

export function getCoreV1Api(): k8s.CoreV1Api {
    return getKubeConfig().makeApiClient(k8s.CoreV1Api);
}

export function getCustomObjectsApi(): k8s.CustomObjectsApi {
    return getKubeConfig().makeApiClient(k8s.CustomObjectsApi);
}

// Cluster-autoscaler taints marking a node as already on its way out -
// never worth dispatching to even if it still reports Ready (spec §6.1)
const AUTOSCALER_DELETION_TAINT_KEYS = new Set([
    'ToBeDeletedByClusterAutoscaler',
    'DeletionCandidateOfClusterAutoscaler',
]);

// The taint GPU nodes carry so nothing lands there by accident (matches
// helm/kleinkram/values.yaml's locality.gpuTaintKey). Eligibility only
// tolerates this one specific taint; any other NoSchedule/NoExecute taint
// still excludes the node. WorkflowDispatchService adds the matching
// toleration directly to GPU Actions' pods.
export function gpuTaintKey(): string {
    return process.env.LOCALITY_GPU_TAINT_KEY ?? 'nvidia.com/gpu';
}

/**
 * Drops nodes that are cordoned, not currently Ready, marked for removal by
 * the cluster autoscaler, or carrying any other NoSchedule/NoExecute taint
 * (other than the tolerated GPU taint) - so dispatch is never attempted
 * against a node already known to be unusable
 */
export function isNodeReadySchedulable(node: k8s.V1Node): boolean {
    if (node.spec?.unschedulable) return false;
    const ready =
        node.status?.conditions?.some(
            (condition) =>
                condition.type === 'Ready' && condition.status === 'True',
        ) ?? false;
    if (!ready) return false;

    const tolerated = gpuTaintKey();
    for (const taint of node.spec?.taints ?? []) {
        if (!taint.key) continue;
        if (AUTOSCALER_DELETION_TAINT_KEYS.has(taint.key)) return false;
        const blocks = taint.effect === 'NoSchedule' || taint.effect === 'NoExecute';
        if (blocks && taint.key !== tolerated) return false;
    }
    return true;
}

export const ARGO_GROUP = 'argoproj.io';
export const ARGO_VERSION = 'v1alpha1';
export const WORKFLOW_PLURAL = 'workflows';

export function actionsNamespace(): string {
    return process.env.KUBE_NAMESPACE_ACTIONS ?? 'kleinkram-actions';
}

// The identity that Action containers run as which carries imagePullSecrets
// for private-registry Action images
export function actionPodServiceAccount(): string {
    return process.env.ACTION_POD_SERVICE_ACCOUNT ?? 'kleinkram-action-pod';
}

// The identity Argo's own init/wait (argoexec) containers run as. Kept
// separate from actionPodServiceAccount since that SA has no Kubernetes API
// token mounted (so user-supplied Action images can't reach the API), but
// argoexec needs one to patch WorkflowTaskResult objects. Set via Workflow
// spec.executor.serviceAccountName, which Argo mounts only into its own
// system containers, not the main container
export function actionExecutorServiceAccount(): string {
    return (
        process.env.ACTION_EXECUTOR_SERVICE_ACCOUNT ??
        'kleinkram-action-executor'
    );
}

export function workflowNameForAction(actionUuid: string): string {
    return `action-${actionUuid}`;
}

export function apiKeySecretNameForAction(actionUuid: string): string {
    return `action-${actionUuid}-apikey`;
}

export const ACTION_MANAGED_BY_LABEL_KEY = 'app.kubernetes.io/managed-by';
export const ACTION_MANAGED_BY_LABEL_VALUE = 'kleinkram-action-operator';
export const ACTION_MANAGED_BY_LABEL_SELECTOR = `${ACTION_MANAGED_BY_LABEL_KEY}=${ACTION_MANAGED_BY_LABEL_VALUE}`;
export const ACTION_UUID_LABEL = 'kleinkram.local/action-uuid';

// The cache-tier node pool the locality dispatcher ranks and dispatches
// against (spec §6.1's NODE_SELECTOR) - nodes running a node-local JuiceFS
// gateway, per cluster-state.service.ts and workflow-dispatch.service.ts's
// wantsGpu check.
export function localityNodeLabelSelector(): string {
    return process.env.LOCALITY_NODE_LABEL_SELECTOR ?? 'cache-tier=true';
}

// Must match the label applied to the GPU node pool
// (helm/kleinkram/values.yaml's locality.gpuNodeLabelSelector)
export function localityGpuNodeLabelSelector(): string {
    return process.env.LOCALITY_GPU_NODE_LABEL_SELECTOR ?? 'gpu=true';
}
