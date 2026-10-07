# Analyst annex — evidence-backed marks

Marks that turn a correct diagram into a decision-grade one for architects and analysts. Apply every mark the step-1 evidence supports — a mark without an inventory row behind it is invented content. Every mark kind used on a page gets a legend line. Default placement: the master page; per-layer pages reuse the same forms.

## Criticality / SLA

Critical-path edge: `strokeWidth=2` on top of its flow color; the label carries the target: "Calls [HTTPS, p95 < 200 ms]". A degradable call names its fallback in the label tail: "…[HTTPS; fallback: cache]".

## Data sensitivity

Store holding personal data: label suffix "(PII)"; encrypted at rest → "(PII, enc)". An edge moving personal data appends ", PII" to its technology bracket. Legend line: "PII — personal data".

## Delivery semantics (async)

An async edge label carries what is known: "Publishes events [Kafka, orders.v1, at-least-once, retry ×3 → DLQ]". Verified consumer-side idempotency joins the consumer component's description, not the edge.

## Flow step numbers

The main business scenario numbers its edge labels «1. », «2. », … in the flow's own color — one sequence per flow color; a failure branch continues as «3a.», «3b.». Numbers only where the inventory pins the order.

## Scale / capacity

Replica count on the card header («×3»); measured or contracted throughput on the edge that carries it («2k rps»). Environment differences (prod vs stage) belong to the Deployment page, not the master.
