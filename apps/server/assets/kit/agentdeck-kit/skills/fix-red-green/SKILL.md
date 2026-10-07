---
name: fix-red-green
description: Use when fixing a bug — reproduce it on the real path first (red), fix the cause, show the same check green.
---

# Fix: red before, green after

1. Reproduce the bug through the same entry point the reporter used (UI, API call, CLI command). Write down the exact
   steps and what came out.
2. Turn the reproduction into a check that fails now: a test, or a script that exits non-zero. Run it and see it red.
3. Find the cause, not the symptom: read the code path the failing check executes.
4. Fix the cause with the smallest change. Run the same check: it must be green.
5. Run the neighbouring checks of the touched module, so the fix broke nothing next to it.
6. Report: the red output, the change, the green output.
