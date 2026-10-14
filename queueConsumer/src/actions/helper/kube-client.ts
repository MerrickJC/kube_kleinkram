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

/**
 * Lists nodes matching `labelSelector`, e.g. the cache-tier label a cluster
 * operator applies to nodes running a node-local JuiceFS gateway
 */
export async function listCacheTierNodes(
    labelSelector: string,
): Promise<k8s.V1Node[]> {
    const response = await getCoreV1Api().listNode({ labelSelector });
    return response.items;
}

/**
 * Drops nodes that are cordoned or not currently Ready, so a strict locality
 * tier never pins a pod to a node already known to be unusable - which
 * would otherwise waste a full Kueue waitForPodsReady timeout before the
 * workflow can widen to the next tier
 */
export function isNodeReadySchedulable(node: k8s.V1Node): boolean {
    if (node.spec?.unschedulable) return false;
    return (
        node.status?.conditions?.some(
            (condition) =>
                condition.type === 'Ready' && condition.status === 'True',
        ) ?? false
    );
}

export interface NodeSelectorRequirement {
    key: string;
    operator: 'In';
    values: string[];
}

/**
 * Parses a comma-separated `key=value` label selector string (the same
 * format `LOCALITY_NODE_LABEL_SELECTOR`/`LOCALITY_GPU_NODE_LABEL_SELECTOR`
 * and the Kueue ResourceFlavor nodeSelectors in helm/kleinkram/values.yaml
 * already use) into nodeAffinity matchExpressions. Used for the final
 * locality tier so it tracks the cache-tier node pool live instead of
 * freezing a point-in-time node list into the pod spec
 */
export function labelSelectorToMatchExpressions(
    selector: string,
): NodeSelectorRequirement[] {
    return selector
        .split(',')
        .map((pair) => pair.trim())
        .filter((pair) => pair.length > 0)
        .map((pair) => {
            const eqIndex = pair.indexOf('=');
            const key = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
            const value = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);
            return { key, operator: 'In' as const, values: [value] };
        });
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

// Locality-aware scheduling: required node affinity, tiered and widened on
// failure, toward whichever node's local JuiceFS gateway already caches a
// mission's data. "No eligible nodes found" is already safe, but this flag
// gives an explicit off switch
export function localityEnabled(): boolean {
    return (process.env.LOCALITY_ENABLED ?? 'true') === 'true';
}

export function localityNodeLabelSelector(): string {
    return process.env.LOCALITY_NODE_LABEL_SELECTOR ?? 'cache-tier=true';
}

// Match whatever label the deployment's GPU Kueue ResourceFlavor
// actually selects on (helm/kleinkram/values.yaml's
// kueue.resourceFlavors.gpu.nodeSelector)
export function localityGpuNodeLabelSelector(): string {
    return process.env.LOCALITY_GPU_NODE_LABEL_SELECTOR ?? 'gpu=true';
}

// Ascending sizes of the strict, ranked-hostname tiers (top 1, top 2,
// top 4, ...) a locality-widening Action run steps through before
// falling back to the full cache-tier node pool. Each size is capped at
// the number of eligible nodes actually found
export function localityTierSizes(): number[] {
    const raw = process.env.LOCALITY_TIER_SIZES ?? '1,2,4';
    const sizes = raw
        .split(',')
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((size) => Number.isInteger(size) && size >= 1);
    return sizes.length > 0 ? sizes : [1, 2, 4];
}

// Retry limit for the final ("any cache-tier node") locality tier, which
// keeps retrying in place on a Kueue waitForPodsReady eviction rather than
// failing the workflow once the cache-tier pool is momentarily full
export function localityFallbackRetryLimit(): number {
    const raw = Number.parseInt(
        process.env.LOCALITY_FALLBACK_RETRY_LIMIT ?? '20',
        10,
    );
    return Number.isNaN(raw) || raw < 1 ? 20 : raw;
}
