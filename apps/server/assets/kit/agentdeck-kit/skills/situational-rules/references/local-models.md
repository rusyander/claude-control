# Local model about to run (ollama / llama.cpp / LM Studio)

One machine, one GPU, and it is the user's desktop. A 14B run holds ~9 GB of VRAM; a leaked runner has
frozen a desktop for ~15 minutes while the agent kept working. Treat GPU memory as the user's.

## Before starting

- **Say what is being loaded and whether it fits**: model, its size, free VRAM (`nvidia-smi
--query-gpu=memory.used,memory.total --format=csv`). Prefer the smallest model that answers the
  question; a 7B that proves the path beats a 14B that proves it prettier.
- **One at a time.** No parallel runs, no second model "to compare", no warm spare. Never leave a
  server running past the measurement.
- A script that starts a local model carries a lock (`ALLOW_OLLAMA=1` or the like) so it cannot be
  re-run out of habit, and its header says the measurement is already done.
- A model the panel itself serves (its local-model variant) is the panel's to manage — do not stop it.

## After finishing — same turn, in this order

1. Unload the model: `ollama stop <model>` (or a request with `keep_alive: 0`). Killing the server
   first is what orphans the runner child and keeps the VRAM.
2. `ollama ps` — must be empty.
3. Stop the server you started (`taskkill //IM ollama.exe //F` on Windows) — only one you started.
4. `tasklist | grep -i ollama` — nothing of yours left.
5. `nvidia-smi` — the VRAM is actually back. **Report the number**; "should be freed" is not a check.

## What this is not

Not a ban. Local models are the honest way to measure whether a mid-tier model obeys a protocol, and
that measurement is worth running. The rule is only that the desktop comes back in the state it was
in — before the next step, not eventually.
