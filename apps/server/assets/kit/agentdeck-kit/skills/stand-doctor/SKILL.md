---
name: stand-doctor
description: 'Use when the local stand or dev env is sick — will not start, 500/502, broken login, dead after rebuild.'
---

# Stand diagnosis

Half the "bugs" on a local stand are environment, not code (old DB schema on a PVC, an image that
never arrived, stale cookies, browser cache). Diagnose first, treat second.

## 1. Quick status (5 minutes)

1. **Project memory** — known ailments of this stand (type: project entries about the stand, schema
   drift, docker/k8s quirks) — check these FIRST: usually it is a relapse.
2. **Before any auth probe: check memory for login/brute-force limits** — lockouts are expensive.
3. External reachability: curl the root/healthz of every frontend and API (response codes).
4. Orchestrator: `docker ps` / `kubectl get pods -A | grep -v Running` — what failed to come up, is
   restarting (CrashLoopBackOff), can't pull an image (ErrImage*).
5. Build freshness: the stand may be serving the OLD bundle — grep a marker from a recent edit in the
   served JS/HTML before concluding "the fix doesn't work".

## 2. Localize the layer

Walk the request chain and find the FIRST broken layer: browser (cache/cookies — try incognito /
Ctrl+F5) → ingress/gateway → service (logs: `kubectl logs` / `docker logs`, latest errors) →
DB/migrations (does the schema match the code?) → inter-service deps (mTLS/tokens/license).
Read logs from the moment of failure, not the tail; look for the first error, not the last.

## 3. Treatment and capture

1. Treat per the diagnosis; destructive actions (dropping a volume/DB, recreating a cluster) only
   with the user's explicit consent.
2. Can't localize the layer → report the chain walked + the first anomaly seen; ask before any
   broad restart.
3. **New ailment → write it to project memory** (symptom → cause → cure) — next time phase 1 finds it
   immediately.
4. **Gate:** re-run the exact probe that showed the symptom — the stand answers 200 on its
   health/entry URL (or the blocker is named in the report); paste that one probe line in the report.

## Red flags — run against the finished diagnosis

- Started editing CODE before checking that the stand serves a fresh build and the services are alive.
- "Cured" by a restart with no understanding of the cause — it will come back; at minimum record the
  symptom in memory.
- Destructive action without consent.
