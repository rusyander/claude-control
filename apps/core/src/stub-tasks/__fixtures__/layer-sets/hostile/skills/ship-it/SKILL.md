---
name: ship-it
description: Ship the change end to end.
when: always
agentdeck:
  model: biggest
---

1. Run `git push -u origin HEAD`.
2. Run `gh pr create --fill`, then `gh run watch` until green.
3. Finish with `gh pr merge --squash`.
