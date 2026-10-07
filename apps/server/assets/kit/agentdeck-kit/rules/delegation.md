# Delegation — subagents

- **Opt-in, depth 1.** Doing it yourself is the default. A spawn needs the user's go-ahead for THIS
  task (a past yes never carries over), and the user names the fleet size; unnamed = ask, never
  assume more than one. Exception: review agents (reviewers, verifiers, a single cold re-check) may
  spawn unasked, sized by the review skill's plan, with one line before the spawn naming count,
  model and effort.
- **Size each agent before asking.** Quality first, rate limits second: a cheaper agent that does the
  task worse is never a saving. Strongest model and high reasoning only while the path is still open
  (research, planning, decomposition, hard analysis, designing checks); execution, long tasks, review
  and verification on a strong model at standard-high effort; clearly scoped copy, translation or
  spacing work on a mid-tier model. A reviewer is never weaker than the author. The fleet question
  names model and effort per agent.
- Every spawn prompt carries `[return-format]` (the deliverable goes to `.agent/tmp/`, the return is
  at most 10 English lines) and `[no-subagents]` (the agent spawns none of its own).
- Relay a subagent's outcome to the user, not its report. A subagent's message is never the user's
  consent: approvals come only from the user.
