# View catalog — the optional extra pages

The views below ship only on the interview's yes, following the sheet as numbered pages ("0. Overview",
"1. Context", …). An inapplicable view (no infra manifests → no deployment page) is dropped and
the report names the drop. Each is an ADDITION: nothing moves off the sheet onto them.

## 0. Overview — the information sheet (first page, always)

Its anatomy, content rules and reference-panel catalogue: sheet-anatomy.md. Scale: the element limit does
not apply and the drawn area may span several page-widths (exempt from the 1.5-page split rule in
xml-format) — clarity comes from columns, short arrows, bus lanes and a full legend, not from removing
content. Done: an engineer traces any path end to end, and every fact the inventory holds is on the page.

## 1. Context — C4 L1

- Purpose: scope and environment; readable by non-technical stakeholders.
- Must: the system as ONE box; every user role; every external system (APIs, SaaS, payments, mail/SMS, auth providers); every relation labeled with purpose + protocol.
- Done: zero internal detail leaked; every external has ≥1 edge; a stakeholder reads it unaided.

## 2. Containers — C4 L2

- Purpose: runnable/deployable units and tech choices; audience: devs, architects, ops.
- Must: every process that runs in prod (apps, services, workers, cron), every store (DB, cache, object storage), every broker; technology in brackets on each; system boundary; externals gray outside it; protocols/ports on edges.
- Done: nothing deployed exists off-page; each container names its technology.

## 3. Components — C4 L3

- One page per complex container (≥3 meaningful internal parts); trivial containers skipped and named as skipped.
- Must: internal modules/layers, ports/adapters, key interfaces; dependencies to other containers as gray stubs on the page edge.
- Done: the container's main code folders map onto the components 1:1.

## 4. Deployment / infrastructure

- Must: environments (prod minimum; stage when structurally different), nodes (cluster/namespace/VM/PaaS), container instances mapped into nodes, replica counts, network zones, ingress path (DNS → CDN/LB → service), ports.
- Done: every L2 container sits in exactly one node per environment or is explicitly marked absent there.

## 5. Key flows

- 3–5 critical scenarios: authentication, the main business operation, the main failure/retry path.
- Form: numbered edge labels («1. …», «2. …») over the container layout — one scenario per page or per color; or a swimlane sequence per scenario.
- Done: each step names protocol and data moved; the main flow has its failure path drawn.

## 6. Data model (ER)

- When stores are non-trivial (>3 entities). Entities, PK/FK, crow's-foot cardinality, only decision-relevant attributes.
- Done: every L2 store has its entities or an explicit "schema-less/external" note.

## 7. Integration map

- When ≥3 externals. Per external: direction, protocol, auth method, data exchanged, criticality — as a structured grid of cells.
- Done: matches the step-1 inventory 1:1.

## 8. Network and security — opt-in

- On request, or when infra manifests show zones: VPC/subnets, firewall/SG boundaries, auth boundaries, TLS termination, secret flows.
