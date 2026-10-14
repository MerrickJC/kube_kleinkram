# Kubernetes Deployment

Kleinkram can be deployed to a Kubernetes cluster via the Helm chart at [`helm/kleinkram`](https://github.com/leggedrobotics/kleinkram/tree/main/helm/kleinkram) in the repository root. This is the larger/production-scale deployment but [Docker Compose](./try-locally.md) remains the supported default for trying Kleinkram locally or running a small self-hosted instance.

> **WARNING: Action execution is Kubernetes-only!**<br>
> Actions (user-defined batch jobs) run as [Argo Workflows](https://argoproj.github.io/argo-workflows/) admitted onto the cluster through [Kueue](https://kueue.sigs.k8s.io/). A Docker Compose deployment still runs the API, frontend, and file/metadata processing pipeline, but **cannot dispatch or run Actions** -- that part of Kleinkram requires the Kubernetes setup described here.

## Prerequisites

This chart only deploys Kleinkram's own application resources and the namespace-scoped objects that bind it to cluster infrastructure. There are a number of applications which are assumed to have be installed and configured outside of the helm chart. This is mainly because they represent large applications with application lifecycles independent of just this chart. The following are assumed to already be installed and configured:

- A Kubernetes cluster (development was done against K3s with Traefik as the ingress controller)
- [Kueue](https://kueue.sigs.k8s.io/) (controller + CRDs). The chart creates Kleinkram-specific `ResourceFlavor`/`ClusterQueue`/`LocalQueue` objects, but doesn't deploy Kueue itself, and doesn't configure the controller-manager-level `waitForPodsReady` setting that node-locality scheduling depends on - see [Node-locality scheduling for Actions](#node-locality-scheduling-for-actions) below
- [Argo Workflows](https://argoproj.github.io/argo-workflows/) (workflow controller, and the Argo Server if you want its UI). The chart only configures the S3 artifact-repository the Argo workflows use
- Postgres reachable from the cluster, with non-secret connection details (host, port, database) provided via `values.yaml`
- An S3-compatible store (SeaweedFS in the reference stack), reachable from the cluster, with non-secret connection details (host, port, bucket names) provided via `values.yaml`
- Prometheus, Loki, and Tempo (plus whatever log-shipping agent, e.g. Promtail, feeds Loki), if you want Action resource-usage metrics and log querying
- A GPU node pool with the NVIDIA device plugin installed, if any `ActionTemplate` declares `gpuMemory > 0`
- (Optional) A policy engine (Kyverno or Gatekeeper), if you want the image-registry allow-list policy in `templates/policy/` enforced, but this is not assumed installed by default
- The `Secret`s the app reads at runtime (DB/S3/JWT/OAuth credentials, the Google service-account JSON, the Argo artifact-repository credentials). See [Secrets](#secrets) below for more info

## What the chart deploys

- `Deployment`/`Service`/`HorizontalPodAutoscaler` for `api-server`, `frontend`, `documentation`, and `queue-consumer`
- An in-cluster Redis `StatefulSet` configured via `redis.enabled`, default `true`. If disabled, you will need to provide a connection to an existing Redis instance
- A `ConfigMap` covering non-secret environment variables
- An optional `Ingress` for `frontend`/`api-server`/`documentation`
- `kleinkram-actions` namespace plus the `ResourceFlavor`/`ClusterQueue`/`LocalQueue` Kueue used for queuing Actions
- The Argo S3 artifact-repository `ConfigMap` Action Workflows stage their `/out` output through (its credentials `Secret` is also referenced, but must be created manually)
- RBAC (`ServiceAccount`/`ClusterRole`/`RoleBinding`) for `queue-consumer`
- A separate `ServiceAccount` that Action containers run as
- A `NetworkPolicy` restricting Action pod egress, and an optional Kyverno `ClusterPolicy` restricting which image registries Action images can be pulled from

The chart's values.yaml contains the full set of configurable values, some of which are required to work correctly and will not work with default values.

## Node-locality scheduling for Actions

Action pods carry a required, tiered node affinity toward whichever node's local JuiceFS gateway already caches the mission's data (see `queueConsumer/src/actions/services/workflow-dispatch.service.ts`): an Action run is submitted as a strict step targeting its single best-ranked cache-tier node, widening to the top 2, then top 4, then any node still labeled with `locality.nodeLabelSelector` (default `cache-tier=true`) if those stay unschedulable. Every tier also carries the same weighted preference across its allowed nodes on top of that hard requirement, so if several of a tier's nodes happen to free up at once (e.g. the top 2 and top 4 nodes all become schedulable together), the best-ranked one among them still wins rather than the scheduler picking arbitrarily. A pod never spills onto nodes outside the cache-tier pool - core Kleinkram/cluster services aren't competed with - so if the cache-tier pool itself is full, the final tier waits and retries there rather than running anywhere else.

This only works end-to-end if the cluster's Kueue installation has `waitForPodsReady` configured, since that's what evicts a pod stuck on an unschedulable tier so Argo can retry it into the next one. **This chart does not configure this** (see [Prerequisites](#prerequisites)) - it's a property of the externally-managed Kueue controller-manager, not a namespace-scoped object this chart owns. Apply something equivalent to the following to that installation's configuration (exact mechanism depends on your Kueue version - see the [Kueue docs](https://kueue.sigs.k8s.io/docs/tasks/manage/setup_wait_for_pods_ready/)):

```yaml
waitForPodsReady:
  enable: true
  timeout: 3m             # start around cold image-pull + container-start time; this is
                           # measured from Workload admission and includes the pull, so too
                           # short a value widens tiers for no reason
  recoveryTimeout: 0s      # don't evict a pod that was Ready and later becomes not Ready
  blockAdmission: false    # true would admit only one workload at a time cluster-wide
```

Also confirm the plain-`pod` integration's `managedJobsNamespaceSelector` covers the `kleinkram-actions` namespace (the only namespace Action pods run in) - otherwise Kueue never applies `waitForPodsReady` to them at all.

**Quota must reflect real cluster capacity.** Kueue only enforces quota against the `ClusterQueue`'s `nominalQuota` (`values.yaml`'s `kueue.quota`); it has no visibility into per-node fit. If quota is set higher than the cluster can actually run, excess pods go `Pending` in the scheduler instead of waiting gated in Kueue - and a pod stuck in the scheduler is invisible to `waitForPodsReady`, so it never gets evicted/retried into a wider tier. Size each covered resource as:

```
nominalQuota ≈ sum(node.status.allocatable[resource] for nodes the ResourceFlavor's nodeSelector matches)
               - sum(DaemonSet pod requests on those nodes)
               - headroom margin (e.g. 10-20%)
```

Re-measure and update `values.yaml`'s `kueue.quota` whenever nodes are added to or removed from the pool(s) each `ResourceFlavor` selects.

**Action containers should be idempotent.** A genuine Action failure (bad download, non-zero exit) doesn't end a tier step in `Succeeded` any more than a Kueue eviction does, so it also widens through the remaining tiers before the run is finally reported as failed - up to one attempt per configured tier plus the fallback's retries. Don't rely on an Action running exactly once.

## Secrets

This chart does not create `Secret` objects or holds secret material for configuring connections to prerequisite services, it only references Secret names in its Deployments. The chart's values.yaml defines a `secretNames` field with references to Secret names as well as `argo.artifactRepository.credentialsSecretName`. You need to create each of the Secrets yourself using the keys documented next to each value in `values.yaml`. It would be advisable to use some sort of Secret management tool such as [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets), [External Secrets Operator](https://external-secrets.io/), or [SOPS](https://getsops.io/).

## Observability

Prometheus, Loki, and Tempo are not deployed by this chart since their lifecycle is considered independent of this application. If Prometheus is reachable, point `values.yaml`'s `observability.prometheusUrl` at it to enable Action resource-usage metrics. For log querying, the log-shipping agent (e.g. Promtail) you are running in the cluster must relabel Pod labels (`action_run_uuid`, `action_template_uuid`, `mission_uuid`, `action_trigger_uuid`, which are already set on each Action Workflow's Pod) into identically-named Loki stream labels, since `ActionService.getLogs` queries Loki directly with those label names.
