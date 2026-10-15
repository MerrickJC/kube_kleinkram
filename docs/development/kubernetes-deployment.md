# Kubernetes Deployment

Kleinkram can be deployed to a Kubernetes cluster via the Helm chart at [`helm/kleinkram`](https://github.com/leggedrobotics/kleinkram/tree/main/helm/kleinkram) in the repository root. This is the larger/production-scale deployment but [Docker Compose](./try-locally.md) remains the supported default for trying Kleinkram locally or running a small self-hosted instance.

> **WARNING: Action execution is Kubernetes-only!**<br>
> Actions (user-defined batch jobs) run as [Argo Workflows](https://argoproj.github.io/argo-workflows/), dispatched by Kleinkram's own locality dispatcher (not Kueue - see [The locality dispatcher](#the-locality-dispatcher) below). A Docker Compose deployment still runs the API, frontend, and file/metadata processing pipeline, but **cannot dispatch or run Actions** -- that part of Kleinkram requires the Kubernetes setup described here.

## Prerequisites

This chart only deploys Kleinkram's own application resources and the namespace-scoped objects that bind it to cluster infrastructure. There are a number of applications which are assumed to have be installed and configured outside of the helm chart. This is mainly because they represent large applications with application lifecycles independent of just this chart. The following are assumed to already be installed and configured:

- A Kubernetes cluster (development was done against K3s with Traefik as the ingress controller)
- [Argo Workflows](https://argoproj.github.io/argo-workflows/) (workflow controller, and the Argo Server if you want its UI). The chart only configures the S3 artifact-repository the Argo workflows use
- Postgres reachable from the cluster, with non-secret connection details (host, port, database) provided via `values.yaml`
- An S3-compatible store (SeaweedFS in the reference stack), reachable from the cluster, with non-secret connection details (host, port, bucket names) provided via `values.yaml`
- Prometheus, Loki, and Tempo (plus whatever log-shipping agent, e.g. Promtail, feeds Loki), if you want Action resource-usage metrics and log querying
- A GPU node pool with the NVIDIA device plugin installed, if any `ActionTemplate` declares `gpuMemory > 0`
- (Optional) A policy engine (Kyverno or Gatekeeper), if you want the image-registry allow-list policy in `templates/policy/` enforced, but this is not assumed installed by default
- The `Secret`s the app reads at runtime (DB/S3/JWT/OAuth credentials, the Google service-account JSON, the Argo artifact-repository credentials). See [Secrets](#secrets) below for more info

## What the chart deploys

- `Deployment`/`Service`/`HorizontalPodAutoscaler` for `api-server`, `frontend`, `documentation`, and `queue-consumer`
- The locality dispatcher's singleton `Deployment` (`action-dispatcher`, `replicas: 1`, `strategy: Recreate`, no HPA) - the same `queue-consumer` image with `ACTION_DISPATCHER_ENABLED=true`
- An in-cluster Redis `StatefulSet` configured via `redis.enabled`, default `true`. If disabled, you will need to provide a connection to an existing Redis instance
- A `ConfigMap` covering non-secret environment variables
- An optional `Ingress` for `frontend`/`api-server`/`documentation`
- The `kleinkram-actions` namespace
- The Argo S3 artifact-repository `ConfigMap` Action Workflows stage their `/out` output through (its credentials `Secret` is also referenced, but must be created manually)
- RBAC (`ServiceAccount`/`ClusterRole`/`RoleBinding`) for `queue-consumer` and for `action-dispatcher` (the latter's includes a cluster-wide, read-only `pods` grant across all namespaces - see [The locality dispatcher](#the-locality-dispatcher) below)
- A separate `ServiceAccount` that Action containers run as
- A `NetworkPolicy` restricting Action pod egress, and an optional Kyverno `ClusterPolicy` restricting which image registries Action images can be pulled from

The chart's values.yaml contains the full set of configurable values, some of which are required to work correctly and will not work with default values.

## The locality dispatcher

Actions are not admitted onto the cluster by Kueue or any other Kubernetes-level admission controller. Instead, `queueConsumer/src/actions/dispatcher` runs as its own singleton Deployment (`action-dispatcher`) that holds the Action backlog in Postgres and only submits a Workflow - hard-pinned to a specific node via `nodeSelector` - once that node's free capacity has actually been confirmed. There is no pending-pod backlog for a quota or admission controller to gate, and no eviction/retry loop: a job that doesn't fit anywhere yet simply waits in the dispatcher's own queue, visible as `PENDING` on the `ActionEntity` row, until capacity frees up.

Each Action is ranked by rendezvous (highest-random-weight) hashing on its mission UUID against the eligible node pool (nodes labeled `locality.nodeLabelSelector`, default `cache-tier=true` - whichever nodes run a node-local JuiceFS gateway with a cache disk) to a **home node**, so repeated runs against the same mission consistently prefer the same node for cache locality. On each dispatch cycle the dispatcher first fills a node from its own queue (a **local** dispatch - the cache hit case), then considers **stealing** a job queued on another node only if that job's expected wait at its home node exceeds the cost of a cache miss elsewhere (`dispatcher.missPenaltySeconds`/`avgRuntimeSeconds` in `values.yaml`). A **head-of-line guard** (`dispatcher.reserveAfterSeconds`/`maxBlockedNodes`) stops a large job from being starved forever by a stream of smaller ones backfilling around it. See `_my_thoughts/data-locality-scheduling.md` for the full design, and `queueConsumer/src/actions/dispatcher/{placement,capacity,job-queue}.ts` for the implementation.

Because the dispatcher's own `ClusterStateService` does this capacity accounting itself (from live Node/Pod state, not Kubernetes admission), it needs to watch pods across **every** namespace, not just `kleinkram-actions` - otherwise it couldn't see DaemonSet/system pods also consuming capacity on an eligible node. This is a genuine, deliberate privilege increase over a Kueue-based design (Kueue needs no such grant, since it does its own accounting) - see the RBAC comment on `templates/rbac/action-dispatcher-pods-clusterrole.yaml`.

Exactly one dispatcher replica may be active at a time (`replicas: 1`, `strategy: Recreate`, plus a Redis/Redlock-based leader lock as a second guard) - the Deployment is not autoscaled.

**Action containers should still be idempotent where practical.** The dispatcher never deliberately re-runs a job that's already been placed, but crash recovery (a dispatcher restart mid-dispatch, or a pod stuck `Pending` past `dispatcher.pendingTimeoutSeconds`) can still requeue and retry a run up to `dispatcher.maxAttempts` times before it's marked `UNPROCESSABLE`.

**Measuring whether scheduling is actually landing on the desired nodes.** `queue-consumer`/`action-dispatcher` expose a Prometheus `/metrics` endpoint on their existing port (`3000`), including a counter `kleinkram_action_locality_landed_rank_total{rank}` (see `WorkflowWatchService.recordLocalityLandedRank`) and a family of `kleinkram_dispatch_*` metrics from the dispatcher itself (queue depth, cycle duration, dispatch counts by kind, etc. - see `queueConsumer/src/actions/dispatcher/dispatcher.metrics.ts`). Once per Action run, as soon as its pod is confirmed `Running`, `WorkflowWatchService` resolves the actual node it landed on and compares it against the `kleinkram.local/home-node` label the dispatcher set on the Workflow, then increments the counter with:

- `rank="1"` - the pod landed on its home node (a cache hit)
- `rank="other"` - the pod landed elsewhere (a steal, or a legacy/unconstrained submission with no home-node label at all)
- `rank="unknown"` - the scheduled node couldn't be resolved (the Pod lookup failed)

The label is a rank position, not a node name or `action_run_uuid` - this keeps cardinality fixed regardless of cluster size or run volume, so it's safe to leave this metric running indefinitely. A `sum by (rank) (increase(kleinkram_action_locality_landed_rank_total[1h]))` (or similar, bucketed over whatever window you want) gives a per-rank count suitable for a Grafana bar/stacked-area panel. For per-run drill-down (which specific action landed where), use the existing Loki logs instead, keyed by the `action_run_uuid` pod label.

These metrics aren't scraped by anything yet - this chart doesn't deploy Prometheus or its scrape config (see [Prerequisites](#prerequisites)), the same gap that already exists for `api-server`'s own `/metrics`. Either add scrape targets pointing at `queue-consumer:3000/metrics` and `action-dispatcher:3000/metrics` the same way you already scrape (or would scrape) `api-server`, or set `queueConsumer.podAnnotations`/`dispatcher.podAnnotations` in `values.yaml` to the `prometheus.io/scrape`/`prometheus.io/port`/`prometheus.io/path` annotations if your Prometheus uses annotation-based pod discovery.

## Secrets

This chart does not create `Secret` objects or holds secret material for configuring connections to prerequisite services, it only references Secret names in its Deployments. The chart's values.yaml defines a `secretNames` field with references to Secret names as well as `argo.artifactRepository.credentialsSecretName`. You need to create each of the Secrets yourself using the keys documented next to each value in `values.yaml`. It would be advisable to use some sort of Secret management tool such as [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets), [External Secrets Operator](https://external-secrets.io/), or [SOPS](https://getsops.io/).

## Observability

Prometheus, Loki, and Tempo are not deployed by this chart since their lifecycle is considered independent of this application. If Prometheus is reachable, point `values.yaml`'s `observability.prometheusUrl` at it to enable Action resource-usage metrics. For log querying, the log-shipping agent (e.g. Promtail) you are running in the cluster must relabel Pod labels (`action_run_uuid`, `action_template_uuid`, `mission_uuid`, `action_trigger_uuid`, which are already set on each Action Workflow's Pod) into identically-named Loki stream labels, since `ActionService.getLogs` queries Loki directly with those label names.
