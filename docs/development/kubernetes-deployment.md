# Kubernetes Deployment

Kleinkram can be deployed to a Kubernetes cluster via the Helm chart at [`helm/kleinkram`](https://github.com/leggedrobotics/kleinkram/tree/main/helm/kleinkram) in the repository root. This is the larger/production-scale deployment but [Docker Compose](./try-locally.md) remains the supported default for trying Kleinkram locally or running a small self-hosted instance.

> **WARNING: Action execution is Kubernetes-only!**<br>
> Actions (user-defined batch jobs) run as [Argo Workflows](https://argoproj.github.io/argo-workflows/) admitted onto the cluster through [Kueue](https://kueue.sigs.k8s.io/). A Docker Compose deployment still runs the API, frontend, and file/metadata processing pipeline, but **cannot dispatch or run Actions** -- that part of Kleinkram requires the Kubernetes setup described here.

## Prerequisites

This chart only deploys Kleinkram's own application resources and the namespace-scoped objects that bind it to cluster infrastructure. There are a number of applications which are assumed to have be installed and configured outside of the helm chart. This is mainly because they represent large applications with application lifecycles independent of just this chart. The following are assumed to already be installed and configured:

- A Kubernetes cluster (development was done against K3s with Traefik as the ingress controller)
- [Kueue](https://kueue.sigs.k8s.io/) (controller + CRDs). The chart creates Kleinkram-specific `ResourceFlavor`/`ClusterQueue`/`LocalQueue` objects, but doesn't deploy Kueue itself
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

## Secrets

This chart does not create `Secret` objects or holds secret material for configuring connections to prerequisite services, it only references Secret names in its Deployments. The chart's values.yaml defines a `secretNames` field with references to Secret names as well as `argo.artifactRepository.credentialsSecretName`. You need to create each of the Secrets yourself using the keys documented next to each value in `values.yaml`. It would be advisable to use some sort of Secret management tool such as [Sealed Secrets](https://github.com/bitnami-labs/sealed-secrets), [External Secrets Operator](https://external-secrets.io/), or [SOPS](https://getsops.io/).

## Observability

Prometheus, Loki, and Tempo are not deployed by this chart since their lifecycle is considered independent of this application. If Prometheus is reachable, point `values.yaml`'s `observability.prometheusUrl` at it to enable Action resource-usage metrics. For log querying, the log-shipping agent (e.g. Promtail) you are running in the cluster must relabel Pod labels (`action_run_uuid`, `action_template_uuid`, `mission_uuid`, `action_trigger_uuid`, which are already set on each Action Workflow's Pod) into identically-named Loki stream labels, since `ActionService.getLogs` queries Loki directly with those label names.
