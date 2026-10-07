---
name: verify-by-running
description: Use after any code change, before saying the task is done — find and run the project's real check and report its output.
---

# Verify by running

1. Find the project's check: `package.json` scripts (`test`, `type-check`, `lint`), `Makefile`, `pyproject.toml`,
   `go test ./...`, or a script the README names.
2. Run the narrowest check that executes the changed code (one test file before the whole suite).
3. Red: read the first error, fix the cause, run the same command again.
4. Green: say which command ran and quote its summary line. Nothing ran → say so and why.
