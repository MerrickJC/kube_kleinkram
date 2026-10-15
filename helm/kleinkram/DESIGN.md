# Design: what this chart owns (and what it doesn't)

This chart deploys **only Kleinkram's own application resources**, plus wiring to connect it to the cluster infrastructure it depends on. It does not (and should not) deploy that infrastructure itself, since that infrastructure should be reusable, robust and has its own lifecycle.

## Goal

This chart only owns the resources whose lifecycle it controls. Shared cluster infrastructure should be deployed and versioned independently so that helm chart changes for this application do not cause failures for unrelated applications using the same infrastructure.

## Implementation

**The following are assumed to be already installed in the cluster and are not deployed here:**

- Kubernetes (development of this application used K3s + Traefik)
- [Argo Workflows](https://argoproj.github.io/argo-workflows/) (controller, optionally the Argo Server UI)
- A Postgres database
- An S3-compatible object store (SeaweedFS was used for development)
- Prometheus, Loki, Tempo, and whatever log-shipping agent (e.g. Promtail) feeds Loki, if you want Action resource-usage metrics and log querying
- A policy engine (Kyverno/Gatekeeper), if the image-registry allow-list policy under `templates/policy/` is enabled
- The NVIDIA device plugin on any GPU node pool
- Every `Secret` this app reads (`values.yaml`'s `secretNames.*`/`argo.artifactRepository.credentialsSecretName`). The chart only references Secret names, it never creates or contains secret material itself. The key names expected inside each Secret default to the app's own env var names but can be overriden using `secretKeys.*`/`argo.artifactRepository.credentialsSecretKeys` if the secret keys are different. `secretNames.dbDump` is deliberately separate from `secretNames.db` and should be a minimally-privileged Postgres role (`CONNECT` and the built-in `pg_read_all_data` role is sufficient for `pg_dump`), not the api-server/queue-consumer's full-access DB user.

**Deployed by this chart:** the app's own `Deployment`/`Service`/`HPA` set (api-server, frontend, documentation, queue-consumer), the locality dispatcher's singleton `Deployment` (action-dispatcher - see `queueConsumer/src/actions/dispatcher`), an app-owned Redis `StatefulSet`, `ConfigMap`, RBAC for `queue-consumer` and `action-dispatcher` (the latter includes a cluster-wide, read-only `pods` grant the dispatcher needs for its own capacity accounting - see the comment on `templates/rbac/action-dispatcher-pods-clusterrole.yaml`), a `ServiceAccount` for the Action containers, `NetworkPolicy`, a `db-migrate` pre-install/pre-upgrade hook `Job`, a `db-dump` `CronJob`, and the namespace-scoped objects that bind the app to the infrastructure above: the Argo S3 artifact-repository `ConfigMap`, and (optionally) the Kyverno `ClusterPolicy`. Scheduling/admission for Action Workflows is handled entirely by the dispatcher's own capacity accounting against live Node/Pod state, not by any Kubernetes-level admission controller - Kueue is not used.

Redis is the one exception that ignores this goal. The Redis queue is owned and accessed exclusively by this application. If this application is deleted, the Redis queue should be deleted too and if another application intends to use Redis then they should not use this instance and should instead create their own instance. That makes the Redis queue different and justifies having its deployment be part of the helm template instead of independently managed infrastructure.

If you want the observability stack (Prometheus/Loki/Tempo/Promtail), deploy it independently and point `observability.prometheusUrl` at it. More info on this can be found in the [values.yaml](./values.yaml) file.
