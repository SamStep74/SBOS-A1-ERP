# K8s deploy — operator runbook

> **Audience:** SBOS-A1-ERP
> operators deploying the
> bootable HTTP server on a
> Kubernetes cluster.
>
> **Status:** Production-ready.
> The 6 manifests in this
> directory are the
> production-grade K8s deploy
> for a single-cluster,
> multi-replica deploy.
>
> **Related:** [DEPLOY.md](../DEPLOY.md)
> — the bare metal / Docker /
> systemd deploy story;
> [STATUS-2026-06-21.md](../STATUS-2026-06-21.md)
> — the manager's status
> report.

---

## 1. Quick start

```bash
# 1. Apply the manifests
kubectl apply -f k8s/

# 2. Wait for the first pod to
#    boot + mint the admin token
kubectl wait --for=condition=ready \
    pod -l app.kubernetes.io/name=sbos-a1-erp \
    -n sbos-a1-erp --timeout=120s

# 3. Capture the admin token
#    (printed on first boot, or
#    read from the PVC)
kubectl logs -n sbos-a1-erp \
    -l app.kubernetes.io/name=sbos-a1-erp \
    --tail=50 | grep "admin session token"

# 4. Smoke-check (port-forward
#    to the pod)
kubectl port-forward -n sbos-a1-erp \
    svc/sbos-a1-erp 8080:80 &

ADMIN_TOKEN=$(kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    cat /var/lib/sbos-a1-erp/admin-token)

SBOS_BASE_URL=http://127.0.0.1:8080 \
SBOS_ADMIN_TOKEN="$ADMIN_TOKEN" \
    bash scripts/deploy-smoke.sh
```

The smoke check is the
green-light gate. If it
exits 0, the deploy is
production-ready.

## 2. The 6 manifests

| File | Purpose | Notes |
|------|---------|-------|
| `00-namespace.yaml` | Dedicated `sbos-a1-erp` namespace | All resources live here |
| `10-configmap.yaml` | Non-secret env vars | `NODE_ENV`, `PORT`, `HOST`, `SBOS_AUTH_MODE`, `SBOS_DB`, `SBOS_ADMIN_TOKEN_FILE`, `SBOS_LOCALE` |
| `20-secret.yaml` | Admin session token | Optional (the server mints + persists to the PVC on first boot) |
| `30-pvc.yaml` | 10Gi persistent volume for the SQLite + admin token | ReadWriteOnce (use ReadWriteMany for multi-replica with shared storage) |
| `40-deployment.yaml` | 3-replica Deployment with liveness + readiness probes | Topology-spread across nodes; rolling update |
| `50-service.yaml` | ClusterIP Service | Routes to the pods' `http` port (3000) |
| `60-ingress.yaml` | NGINX Ingress (TLS + external access) | Operator tunes the host + TLS cert |

**The 6 files deploy in
order.** `kubectl apply -f k8s/`
applies them alphabetically;
the namespace must exist
before the ConfigMap can be
created in it, etc. The
manifests are designed to be
applied in this order.

## 3. Env-var contract

The server reads these env
vars on boot. The
`10-configmap.yaml` sets
the non-secret ones; the
`20-secret.yaml` sets the
admin token (if injected).

| Env var | Source | Default | Purpose |
|---------|--------|---------|---------|
| `NODE_ENV` | ConfigMap | `production` | Production mode (stricter logging) |
| `PORT` | ConfigMap | `3000` | HTTP listen port inside the pod |
| `HOST` | ConfigMap | `0.0.0.0` | Listen on all pod interfaces |
| `SBOS_AUTH_MODE` | ConfigMap | `real` | Real auth (not stub) |
| `SBOS_DB` | ConfigMap | `/var/lib/sbos-a1-erp/sbos.db` | SQLite path |
| `SBOS_ADMIN_TOKEN_FILE` | ConfigMap | `/var/lib/sbos-a1-erp/admin-token` | Admin token path |
| `SBOS_LOCALE` | ConfigMap | `en` | Default locale |
| `SBOS_ADMIN_TOKEN` | Secret | (minted on first boot) | Optional: pre-existing admin token to inject |

**Production checklist:**

- [ ] `NODE_ENV=production`
- [ ] `SBOS_AUTH_MODE=real`
- [ ] PVC is provisioned
      (`kubectl get pvc -n
      sbos-a1-erp`)
- [ ] Admin token captured
      (printed on first boot, or
      injected via Secret)
- [ ] Liveness + readiness
      probes pass
      (`kubectl get pods -n
      sbos-a1-erp` → all
      `Ready 1/1`)
- [ ] Smoke check exits 0
- [ ] Backup cron configured
      (see §6)

## 4. Deploy paths

### 4.1 Single cluster (the standard case)

The 6 manifests deploy the
SBOS-A1-ERP to a single
cluster. The PVC is
ReadWriteOnce; all 3 pods
mount the same volume. This
works for most operators.

```bash
# 1. Create the namespace
kubectl apply -f k8s/00-namespace.yaml

# 2. Apply the rest
kubectl apply -f k8s/10-configmap.yaml
kubectl apply -f k8s/20-secret.yaml
kubectl apply -f k8s/30-pvc.yaml
kubectl apply -f k8s/40-deployment.yaml
kubectl apply -f k8s/50-service.yaml
kubectl apply -f k8s/60-ingress.yaml

# 3. Watch the roll-out
kubectl rollout status deployment/sbos-a1-erp \
    -n sbos-a1-erp

# 4. Smoke-check
kubectl port-forward -n sbos-a1-erp \
    svc/sbos-a1-erp 8080:80 &
ADMIN_TOKEN=$(kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    cat /var/lib/sbos-a1-erp/admin-token)
SBOS_BASE_URL=http://127.0.0.1:8080 \
SBOS_ADMIN_TOKEN="$ADMIN_TOKEN" \
    bash scripts/deploy-smoke.sh
```

### 4.2 Multi-cluster (the HA case)

For a multi-cluster deploy
(e.g., one K8s cluster per
region), the PVC can't be
shared across clusters. The
admin token is **regenerated
per cluster** (each cluster
mints its own token on first
boot). The clients (the
operator's CI/CD, the operator's
scripts) need to know about
**each cluster's token
separately**.

For multi-cluster, also
consider:
- **ReadWriteMany PVC** — a
  network-attached volume
  (NFS / Longhorn / EFS) that
  all clusters can mount. This
  is a heavier deploy (more
  network hops + storage cost)
  but unifies the data.
- **Per-cluster sqlite + ETL**
  — each cluster has its own
  sqlite; a periodic ETL job
  syncs the data to a central
  store. The simplest multi-
  cluster story; the ETL is
  a follow-up plan.

### 4.3 Multi-replica with ReadWriteMany (the cluster-wide HA case)

For 3+ replicas in a single
cluster with shared storage
(e.g., Longhorn, EFS, NFS):

1. Provision a StorageClass
   with `volumeBindingMode:
   Immediate` and
   `allowVolumeExpansion: true`.
2. Update `30-pvc.yaml` to
   reference the new
   storageClassName.
3. Update
   `accessModes: [ReadWriteMany]`.
4. Apply.

The 3 pods then share the
same SQLite file via the
RWX storage class. SQLite's
write locking ensures
consistency.

**Caveat:** SQLite's
network-attached storage
performance is **slower** than
local SSD. For a high-write
workload, consider migrating
to a real DB (postgres) — see
`docs/STATUS-2026-06-21.md` §
"What's blocked" for the pg
adapter story.

## 5. Upgrade

The image tag is in
`40-deployment.yaml`:
```yaml
image: ghcr.io/armosphera/sbos-a1-erp:dev
```

For a production upgrade:

```bash
# 1. Update the image tag
sed -i 's/:dev/:v0.2.0/g' \
    k8s/40-deployment.yaml

# 2. Apply (the rolling-update
#    strategy updates 1 pod at
#    a time)
kubectl apply -f k8s/40-deployment.yaml

# 3. Watch the roll-out
kubectl rollout status deployment/sbos-a1-erp \
    -n sbos-a1-erp

# 4. Smoke-check
ADMIN_TOKEN=$(kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    cat /var/lib/sbos-a1-erp/admin-token)
kubectl port-forward -n sbos-a1-erp \
    svc/sbos-a1-erp 8080:80 &
SBOS_BASE_URL=http://127.0.0.1:8080 \
SBOS_ADMIN_TOKEN="$ADMIN_TOKEN" \
    bash scripts/deploy-smoke.sh

# 5. Rollback if needed
kubectl rollout undo deployment/sbos-a1-erp \
    -n sbos-a1-erp
```

The `RollingUpdate` strategy
with `maxUnavailable: 0` +
`maxSurge: 1` ensures zero
downtime during the upgrade.

## 6. Backup

For K8s, the backup story is
the same as bare metal: use
`scripts/backup-sbos.sh` to
do an online-safe sqlite
backup. The script can run
as a CronJob:

```yaml
# k8s/70-backup-cronjob.yaml (add to the manifest set)
apiVersion: batch/v1
kind: CronJob
metadata:
  name: sbos-a1-erp-backup
  namespace: sbos-a1-erp
spec:
  schedule: "0 2 * * *"  # daily at 02:00
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: ghcr.io/armosphera/sbos-a1-erp:dev
              command: ["bash", "-c", "scripts/backup-sbos.sh"]
              volumeMounts:
                - name: data
                  mountPath: /var/lib/sbos-a1-erp
              envFrom:
                - configMapRef:
                    name: sbos-a1-erp-config
          volumes:
            - name: data
              persistentVolumeClaim:
                claimName: sbos-a1-erp-data
```

The backup CronJob is not in
the default manifest set
(add it as `k8s/70-backup-cronjob.yaml`
when you need it). The backup
output goes to stdout (collected
by the cluster's log driver);
operators should configure
their log retention to keep
the backup output for N days.

## 7. Inject a pre-existing admin token

When restoring from a backup,
you may want to reuse the
original admin token instead
of minting a new one. The
flow:

```bash
# 1. Read the token from the
#    backup (the backup script
#    doesn't back up the token
#    file by default; back it
#    up manually as part of the
#    pre-backup step)
cat /var/backups/sbos-a1-erp/admin-token-20260621.db
# > eyJ... (the JWT-style token)

# 2. Create the Secret from the
#    file
kubectl create secret generic \
    sbos-a1-erp-admin-token \
    --from-file=admin-token=./admin-token \
    -n sbos-a1-erp

# 3. Restart the Deployment so
#    the new Secret is mounted
kubectl rollout restart deployment/sbos-a1-erp \
    -n sbos-a1-erp

# 4. Verify the token
kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    cat /var/lib/sbos-a1-erp/admin-token
```

The token from the Secret
overrides the PVC's first-boot
token (the server reads the
file at startup, not the env
var).

## 8. Troubleshooting

### 8.1 Pod stuck in `Pending`

The PVC can't be bound
(no PV available, or the
storage class is missing).

```bash
# Check the PVC
kubectl describe pvc sbos-a1-erp-data \
    -n sbos-a1-erp

# Check the storage classes
kubectl get storageclass
```

If the storage class is
missing, install a
StorageClass (or use the
cluster default).

### 8.2 Pod stuck in `CrashLoopBackOff`

The server is crashing on
boot. Check the logs:

```bash
kubectl logs -n sbos-a1-erp \
    -l app.kubernetes.io/name=sbos-a1-erp \
    --tail=200
```

Common causes:
- `SBOS_DB` is not writable
  by the pod's user
  (the `securityContext` runs
  as UID 1000; the PVC must
  be readable/writable by
  UID 1000).
- The DB schema is out of
  date (re-deploy with the
  same image; the server
  runs migrations
  idempotently).
- A bad Secret value
  (the `SBOS_ADMIN_TOKEN`
  value is invalid; the
  server falls back to the
  PVC's first-boot token).

### 8.3 Pod is `Ready` but smoke check fails

The pod is healthy but a write
endpoint fails. Check the
endpoint:

```bash
# Port-forward to the pod
kubectl port-forward -n sbos-a1-erp \
    svc/sbos-a1-erp 8080:80 &

# Check the health endpoint
curl -i http://127.0.0.1:8080/api/health

# Check the admin endpoint
ADMIN_TOKEN=$(kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    cat /var/lib/sbos-a1-erp/admin-token)
curl -i -H "Authorization: Bearer $ADMIN_TOKEN" \
    http://127.0.0.1:8080/api/finance/dashboard
```

If `/api/health` returns 200
but a write endpoint returns
500, check the server logs:

```bash
kubectl logs -n sbos-a1-erp \
    -l app.kubernetes.io/name=sbos-a1-erp \
    --tail=200 | grep -i error
```

### 8.4 Liveness probe is failing

The liveness probe hits
`/api/health` every 30s. If
the pod is restarting
repeatedly, the liveness probe
might be misconfigured:

```bash
kubectl describe pod -l app.kubernetes.io/name=sbos-a1-erp \
    -n sbos-a1-erp
```

The probe timeout is 3s;
failure threshold is 3 (i.e.,
the pod is killed after 3
consecutive failures). If
the server is slow to start,
raise `initialDelaySeconds`
(the current value is 10s).

### 8.5 The admin token file is empty

The server hasn't booted yet,
or the PVC is mounted read-
only. Check:

```bash
# Check the pod's mount
kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    ls -la /var/lib/sbos-a1-erp/

# Check the PVC's permissions
kubectl describe pvc sbos-a1-erp-data \
    -n sbos-a1-erp
```

The PVC must be writable by
UID 1000 (the pod's user).
If the PVC was created with
a different owner, fix the
permissions:

```bash
kubectl exec -n sbos-a1-erp \
    deploy/sbos-a1-erp -- \
    chown -R 1000:1000 /var/lib/sbos-a1-erp
```

## 9. Production checklist

- [ ] All 6 manifests applied
- [ ] All 3 pods `Ready 1/1`
- [ ] `kubectl get pvc` shows
      `Bound`
- [ ] Admin token captured
- [ ] Smoke check exits 0
- [ ] Liveness + readiness
      probes pass
- [ ] Ingress resolves to a
      real hostname + TLS cert
- [ ] Backup CronJob scheduled
- [ ] `kubectl get events -n
      sbos-a1-erp --sort-by=.lastTimestamp`
      shows no warnings

## 10. See also

- [DEPLOY.md](../DEPLOY.md) —
  the bare metal / Docker /
  systemd deploy story
- [STATUS-2026-06-21.md](../STATUS-2026-06-21.md)
  — the manager's status
  report
- [CI.md](../CI.md) — the
  CI pipeline that gates
  every commit
- [RBAC_SYSTEM.md](../RBAC_SYSTEM.md)
  — the role / permission
  catalog
