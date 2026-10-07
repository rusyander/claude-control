# Docker — one shared instance per service, never a per-agent copy

An image is read-only and its layers are shared: ONE image backs unlimited containers at zero extra
disk. A second running instance buys nothing either — Postgres serves hundreds of concurrent
clients, Redis thousands of connections. Agents are isolated logically, not by spawning their own DB.

## The rule

- ONE Postgres + ONE Redis per machine. Need a DB → use the running one, never `docker run` a second.
- Isolation: Postgres → own DATABASE or schema per project. Redis → logical DB (`SELECT 0..15`) or a
  `<project>:` key prefix. Never FLUSHALL / FLUSHDB / DROP DATABASE on a shared instance.
- One tag per engine in local dev compose. `redis` and `valkey` are one slot, pick one.
- Legitimately its own container: stdio MCP servers (one process per client, by design), and a
  version-specific repro (`--rm --label claude.ephemeral=1`, gone at task close). A destructive test
  gets its own DATABASE inside the shared Postgres, not its own container.

## `docker ps` and `docker system df` are BLIND to Kubernetes

Docker Desktop's Kubernetes (any containerd `k8s.io` namespace) runs containers the docker CLI cannot
see. `docker system df -v` prints CONTAINERS=0 for an image a pod is actively serving from. **That 0
is not evidence an image is unused.** Before calling any image a duplicate or removing it:
`kubectl get pods -A -o jsonpath='{range .items[*]}{.spec.containers[*].image}{"\n"}{end}' | sort -u`

Two majors of one engine are usually two components, each pinned deliberately — find the pin and read
the comment above it before proposing to collapse them. Source of a locally built image:
`docker buildx history ls`, then `inspect <id>` prints the build context path and VCS repo.

Doubled rows in `docker images` with the SAME id+digest are a containerd store artifact (tag record
plus tag@digest), not duplicates: zero extra disk, `rmi` cannot remove them.

## Ephemeral one-offs — labelled, or they outlive the task

- A one-off check ALWAYS runs `docker run --rm --label claude.ephemeral=1` — task closed = gone.
- Never a throwaway NAMED volume for one.
- A container you started for the task is stopped at task close, in the same turn; one you did not
  start is never touched unasked.

## Never on your own initiative

`rmi` / `prune` / `volume rm` / `down -v` / removing a container are destructive: name the exact
target, get a yes, one op at a time. Volumes are data. Build cache newer than the last build is not
garbage — pruning it costs a full rebuild of every image that used it.
