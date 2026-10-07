# Red flags — run against the finished investigation

- Diagnosed from the last error instead of the first in the chain.
- Hypotheses built before a red-capable command existed (phase 3 gate skipped).
- One hypothesis pursued to the end instead of 3–5 ranked and falsifiable.
- No working analog compared — the one difference that mattered was never listed.
- A fourth fix attempted after three left the loop red.
- Reading current code when an older version was the one that crashed.
- "Root cause found" but it explains half the symptoms — keep looking.
- One copy fixed; the cause's shape (same function, file, parallel handler, other callers) never
  grepped — the second copy is what the human reviewer finds.
- Touched or restarted the live system before the evidence was captured.
- `[DEBUG-...]` instrumentation left in the diff.
