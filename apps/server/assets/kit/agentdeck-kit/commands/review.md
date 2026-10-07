---
description: Pipeline — review the current changes for defects before they are committed.
argument-hint: [path or ref, default = uncommitted changes]
---

Review the changes: $ARGUMENTS (empty = the uncommitted changes, `git diff` and `git diff --staged`).

1. Read every changed hunk together with the code around it.
2. Look for real defects: wrong logic, unhandled errors and empty states, broken contracts between caller and callee,
   missing tests for the changed behaviour, secrets or debug leftovers.
3. For each finding give the file and line, what goes wrong with a concrete input, and the fix.
4. Run the project's checks once (skill `agentdeck-kit:verify-by-running`) and include the result.
5. No findings → say so plainly. Do not edit files unless the user asks.
