import * as k8s from '@kubernetes/client-node';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import logger from '../../logger';
import {
    ACTION_MANAGED_BY_LABEL_KEY,
    ACTION_MANAGED_BY_LABEL_VALUE,
    getCoreV1Api,
    getKubeConfig,
    isNodeReadySchedulable,
    localityGpuNodeLabelSelector,
    localityNodeLabelSelector,
} from '../helper/kube-client';
import { parseBytes, parseCpuMilli, parseGpuCount } from '../helper/pod-requests';
import { effectivePodRequest, emptyVector } from './capacity';
import { dispatcherEnabled } from './dispatcher.config';
import type { PodSnapshot, ResourceVector } from './types';

export interface NodeInfo {
    name: string;
    allocatable: ResourceVector;
    isGpu: boolean;
}

type ChangeListener = () => void;
type NodeInformer = k8s.Informer<k8s.V1Node> & k8s.ObjectCache<k8s.V1Node>;
type PodInformer = k8s.Informer<k8s.V1Pod> & k8s.ObjectCache<k8s.V1Pod>;

/**
 * Keeps the dispatcher's view of eligible Nodes and cluster-wide Pods in
 * sync via informer caches, so the dispatch cycle never lists these
 * resources itself (spec §10.1: "Never list these resources per cycle.
 * Informer caches are the source of truth between events").
 *
 * The Pod informer is intentionally cluster-wide across all namespaces
 * (not scoped to the Actions namespace), because capacity accounting must
 * count every pod bound to an eligible node - DaemonSets, system pods,
 * anything else - not just Kleinkram's own (spec §7). This needs a
 * cluster-wide pods read grant beyond what the Action Operator's existing
 * namespaced RoleBinding provides (see helm/kleinkram/templates/rbac/,
 * added in the dispatcher's Helm phase).
 */
@Injectable()
export class ClusterStateService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(ClusterStateService.name);
    private nodeInformer: NodeInformer | undefined;
    private podInformer: PodInformer | undefined;
    private nodeSynced = false;
    private podSynced = false;
    private readonly listeners: ChangeListener[] = [];

    async onModuleInit(): Promise<void> {
        // Guarded here (rather than by conditional NestJS module
        // registration) so DispatcherModule can be wired into app.module.ts
        // unconditionally and simply do nothing on a deployment that isn't
        // running as the action-dispatcher (see dispatcher.config.ts).
        if (!dispatcherEnabled()) return;

        const kubeConfig = getKubeConfig();
        const nodeLabelSelector = localityNodeLabelSelector();

        this.nodeInformer = k8s.makeInformer<k8s.V1Node>(
            kubeConfig,
            '/api/v1/nodes',
            () => getCoreV1Api().listNode({ labelSelector: nodeLabelSelector }),
            nodeLabelSelector,
        );
        this.wireInformer(this.nodeInformer, 'Node', () => {
            this.nodeSynced = true;
        });

        this.podInformer = k8s.makeInformer<k8s.V1Pod>(
            kubeConfig,
            '/api/v1/pods',
            () => getCoreV1Api().listPodForAllNamespaces(),
        );
        this.wireInformer(this.podInformer, 'Pod', () => {
            this.podSynced = true;
        });

        await Promise.all([this.nodeInformer.start(), this.podInformer.start()]);
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all([this.nodeInformer?.stop(), this.podInformer?.stop()]);
    }

    /** Fires on every Node or Pod add/update/delete seen by either informer */
    onChange(listener: ChangeListener): void {
        this.listeners.push(listener);
    }

    isSynced(): boolean {
        return this.nodeSynced && this.podSynced;
    }

    /** Eligible nodes (spec §6.1): Ready, schedulable, matching the cache-tier selector */
    eligibleNodes(): NodeInfo[] {
        if (!this.nodeInformer) return [];
        const { key: gpuLabelKey, value: gpuLabelValue } = splitLabelSelector(
            localityGpuNodeLabelSelector(),
        );

        const infos: NodeInfo[] = [];
        for (const node of this.nodeInformer.list()) {
            if (!isNodeReadySchedulable(node)) continue;
            const info = this.toNodeInfo(node, gpuLabelKey, gpuLabelValue);
            if (info) infos.push(info);
        }
        return infos;
    }

    /** Every pod in the cluster, stripped to what capacity accounting needs (spec §7) */
    podSnapshots(): PodSnapshot[] {
        if (!this.podInformer) return [];
        return this.podInformer.list().map((pod) => this.toPodSnapshot(pod));
    }

    /**
     * Running-pod count per node for our own Action pods only (identified
     * by the Action Operator's managed-by label) - the concurrency proxy
     * placement.ts's throughput estimate needs (spec §8.3 "concurrency
     * estimate"). Deliberately not all pods: a node full of unrelated
     * DaemonSet/system pods shouldn't look like it has high Action
     * throughput.
     */
    runningActionCountByNode(): Map<string, number> {
        const counts = new Map<string, number>();
        for (const snapshot of this.podSnapshots()) {
            if (snapshot.phase !== 'Running') continue;
            if (snapshot.labels[ACTION_MANAGED_BY_LABEL_KEY] !== ACTION_MANAGED_BY_LABEL_VALUE) {
                continue;
            }
            counts.set(snapshot.nodeName, (counts.get(snapshot.nodeName) ?? 0) + 1);
        }
        return counts;
    }

    private toNodeInfo(
        node: k8s.V1Node,
        gpuLabelKey: string,
        gpuLabelValue: string,
    ): NodeInfo | undefined {
        const name = node.metadata?.labels?.['kubernetes.io/hostname'] ?? node.metadata?.name;
        if (!name) return undefined;
        const allocatable = node.status?.allocatable ?? {};
        return {
            name,
            isGpu: node.metadata?.labels?.[gpuLabelKey] === gpuLabelValue,
            allocatable: {
                cpuMilli: parseCpuMilli(allocatable.cpu),
                memBytes: parseBytes(allocatable.memory),
                ephemeralBytes: parseBytes(allocatable['ephemeral-storage']),
                gpu: parseGpuCount(allocatable['nvidia.com/gpu']),
            },
        };
    }

    private toPodSnapshot(pod: k8s.V1Pod): PodSnapshot {
        const containerRequests = (pod.spec?.containers ?? []).map((container) =>
            this.toResourceVector(container.resources?.requests),
        );
        const initContainerRequests = (pod.spec?.initContainers ?? []).map((container) =>
            this.toResourceVector(container.resources?.requests),
        );
        const overhead = this.toResourceVector(pod.spec?.overhead);

        return {
            nodeName: pod.spec?.nodeName ?? '',
            phase: pod.status?.phase ?? 'Unknown',
            request: effectivePodRequest(containerRequests, initContainerRequests, overhead),
            labels: pod.metadata?.labels ?? {},
        };
    }

    private toResourceVector(requests: Record<string, string> | undefined): ResourceVector {
        if (!requests) return emptyVector();
        return {
            cpuMilli: parseCpuMilli(requests.cpu),
            memBytes: parseBytes(requests.memory),
            ephemeralBytes: parseBytes(requests['ephemeral-storage']),
            gpu: parseGpuCount(requests['nvidia.com/gpu']),
        };
    }

    private wireInformer<T extends k8s.KubernetesObject>(
        informer: k8s.Informer<T>,
        kind: string,
        onFirstEvent: () => void,
    ): void {
        let seenFirstEvent = false;
        const handleEvent = (): void => {
            if (!seenFirstEvent) {
                seenFirstEvent = true;
                onFirstEvent();
            }
            this.notify();
        };
        informer.on('add', handleEvent);
        informer.on('update', handleEvent);
        informer.on('delete', handleEvent);
        informer.on('error', (error: unknown) => {
            this.logger.error(`${kind} informer error, client auto-retries: ${String(error)}`);
            logger.error(`${kind} informer error, client auto-retries: ${String(error)}`);
        });
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }
}

function splitLabelSelector(selector: string): { key: string; value: string } {
    const eqIndex = selector.indexOf('=');
    return eqIndex === -1
        ? { key: selector, value: '' }
        : { key: selector.slice(0, eqIndex), value: selector.slice(eqIndex + 1) };
}
