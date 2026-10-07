# Slicing an oversized task (Phase 2, on demand)

Most entries in a raw batch are already atomic. When one is not — it spans schema, API and UI, or
won't fit a single fresh context window — break it into subtasks T<N>.1, T<N>.2 under the parent:

- **Vertical, not horizontal.** Each slice is a **tracer bullet**: a narrow but _complete_ path through
  every layer, demoable on its own. "All the types, then all the endpoints, then all the UI" is the
  horizontal cut that leaves nothing verifiable until the end.
- **Declare blocking edges.** Each subtask names which siblings must land first; one with none can start
  immediately. Work the **frontier** — anything whose blockers are done. Record the edges in the entry;
  they are what makes the order reconstructable after a compaction.
- **Prefactor first.** "Make the change easy, then make the easy change" — a preparatory slice that
  makes the rest trivial is its own subtask, blocking the others.

## Wide refactors are the exception

A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose blast
radius fans across the codebase, so a single edit breaks thousands of call sites and no vertical slice
can land green. Sequence it **expand → migrate → contract** instead:

1. **Expand** — add the new form beside the old; nothing breaks, gate stays green.
2. **Migrate** — move call sites over in batches sized by blast radius (per package, per directory),
   each batch its own subtask blocked by the expand. The old form still exists, so every batch is green.
3. **Contract** — delete the old form once no caller remains, blocked by every migrate batch.

When even a batch can't stay green alone, keep the sequence but say so in the entry: green is promised
only at a final integrate-and-verify subtask that every batch blocks.
