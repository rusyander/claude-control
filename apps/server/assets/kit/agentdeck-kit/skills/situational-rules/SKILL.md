---
name: situational-rules
description: Rules that apply only at one moment — a git write, a published text, a forge/tracker call, a test or check about to run, a review, a live stand run, docker, a local model, a PDF, a hook or config edit, a doc being placed, a visible UI fix. Load the matching reference before that action. On Claude Code the kit's rule-injector hook delivers them by itself; on a CLI without that hook, read the reference by hand.
---

# Situational rules

Each rule below is needed at exactly one moment, so it is not loaded every turn. Before the action in
the left column, read the reference on the right (once per session, again after a compaction).

| About to…                                                                        | Read                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| commit, push, rebase, reset, branch, tag, stash; any `gh`/`glab` write           | [git-writes](references/git-writes.md)                 |
| write a commit message, MR/PR text, issue, review comment, changelog, docs       | [published-text](references/published-text.md)         |
| call a forge or tracker (GitLab/GitHub, Jira/Confluence, the panel bridge)       | [forge-protocol](references/forge-protocol.md)         |
| write or run a test, a check script, `risk-tier`, `mustfail`                     | [verification-depth](references/verification-depth.md) |
| read a diff for review (`git diff a...b`, an MR/PR diff) or publish review notes | [review-depth](references/review-depth.md)             |
| drive a browser, start a stand or dev server, call a local API                   | [live-check](references/live-check.md)                 |
| open or edit a UI source file for a visible fix                                  | [visible-fix-shots](references/visible-fix-shots.md)   |
| `docker run/up/pull/rmi/prune`, edit a compose file                              | [docker-shared](references/docker-shared.md)           |
| start or stop a local model (ollama, llama.cpp, LM Studio)                       | [local-models](references/local-models.md)             |
| render a PDF or write print CSS                                                  | [pdf-layout](references/pdf-layout.md)                 |
| write a Markdown file (where it goes, which language)                            | [doc-classification](references/doc-classification.md) |
| edit a hook script or hook wiring                                                | [hook-authoring](references/hook-authoring.md)         |
| edit an instruction file, skill, agent, rule, MCP or plugin config               | [config-work](references/config-work.md)               |

`<kit>` in a reference is the root of this kit (the folder holding `skills/` and `tools/`).
