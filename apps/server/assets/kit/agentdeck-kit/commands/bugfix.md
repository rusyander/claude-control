---
description: Pipeline — reproduce a bug, prove it red, fix the cause, prove it green.
argument-hint: <bug description>
---

Fix this bug: $ARGUMENTS

Follow skill `agentdeck-kit:fix-red-green` step by step. Do not change code before the reproduction is red. At the end report the
red output, the fix, the green output and the neighbouring checks that ran (skill `agentdeck-kit:report-honestly`).
