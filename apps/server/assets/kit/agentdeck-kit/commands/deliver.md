---
description: Pipeline — understand, plan, implement, verify and report one task end to end.
argument-hint: <task>
---

Run this pipeline for the task: $ARGUMENTS

1. Understand. Restate the task in two lines. If two readings lead to different work, ask one question and wait;
   otherwise state your assumption and continue.
2. Plan. List the files to change and the check that will prove the result (skill `agentdeck-kit:one-step-at-a-time`).
3. Implement file by file, reading before editing (skill `agentdeck-kit:read-before-edit`).
4. Verify with the project's real checks (skill `agentdeck-kit:verify-by-running`). Red → fix the cause and run again.
5. Review your own diff once for leftovers: debug output, commented-out code, unrelated edits.
6. Report (skill `agentdeck-kit:report-honestly`). Do not commit unless asked.
