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
