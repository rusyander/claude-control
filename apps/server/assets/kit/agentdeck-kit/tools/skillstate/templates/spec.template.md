<!-- P — the procedure every worker follows. English, compressed. One worker sees: this file,
the compact shared state, ONE unit. It has NO other context — spell out everything it needs. -->

# Task

<what this batch does and why, 1-3 sentences>

# Unit procedure

Every step must be safe to run twice — a retry starts on whatever the failed attempt left in the tree,
and an interrupted run re-opens its unit. Write steps that check the current state and converge
("ensure the import block reads X"), never ones that blindly append or assume a clean file.

For the unit given in "Current unit":

1. <step — concrete, with real paths/commands>
2. <step>
3. Verify: <per-unit check the worker MUST run/read before answering "done">

# Conventions

<code style, naming, patterns to follow. If you discover a convention future units need,
record it via state_patch.conventions — that is the ONLY channel to later units.>

# Out of scope

<what a worker must not touch — files, layers, kinds of change>
