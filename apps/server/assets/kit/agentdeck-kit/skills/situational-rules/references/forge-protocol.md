# Forge and tracker protocol — a GitLab/GitHub, Jira or Confluence call is about to run

Routes, in order of preference:

- **Jira / Confluence** → the panel's bridge MCP (`agentdeck-atlassian`): `jira_search`, `jira_issue`,
  `jira_comment`, `jira_create_issue`, `confluence_search`, `confluence_page`, `confluence_create_page`,
  `confluence_update_page`. Credentials live in the panel's encrypted store; the token never reaches
  this process. Bridge absent or refusing → say "not connected — connect it in Settings → Integrations"
  and continue without it. Never ask the user for a token, never write one to a file or `.env`.
- **GitLab / GitHub** → the user's own `glab` / `gh` login (or a forge MCP the user attached). Not
  logged in → say so ("`glab auth status` / `gh auth status` shows no login") and continue degraded.

1. Announce the route BEFORE each call — one line + a browser-openable link. After any create/change →
   direct link to the result. Name issues, MRs and branches by TITLE in everything the user reads, the
   link wrapped in the name; the id rides inside the name, never stands in for it.
2. Reads are free. Any write (create/edit/comment/push/attach/transition) → a few-word question naming
   exactly what, then wait for an explicit yes. Silence or evasion is not a yes.
3. New tracker issue: always ask, arrive with a ready proposal (title, description, type). Assignee and
   status follow the project's convention; unknown → ask once.
4. Merging is forbidden always, even on a direct ask — the user merges. Branches: may create, ask the
   name each time. Commits: one at a time, confirm each. Review replies are writes (confirm).
5. Tracker deletion is forbidden outright; status moves and backlog reshuffles only on an explicit ask.
6. 401/403 → no silent retry; name which login or connection failed and where it is renewed (Settings →
   Integrations for the bridge, `glab auth login` / `gh auth login` for the forge).
7. A tool that "does not exist" → list the server's tools before saying so; some servers expose whole
   categories (pipelines, job logs, wiki) only after activation. Reading a job log is a read: free —
   a red job is diagnosed from its trace, never statically.
8. Pipelines are NOT watched unless the user asked in THIS task: no polling loop, no `sleep` between
   reads, no background watcher. A read is a snapshot: `created`/`pending`/`running` is reported as that
   state, never as ok; only `success` on the MR head sha is green.
9. Tracker text: wiki markup reads text between two `!` as an image macro — two `!NNN` MR refs in one
   Jira comment swallow everything between them. Write MR refs as `[MR 825 — <title>](<url>)`. After
   every comment/description write, read it back against the draft: every link and number present, no
   macro the draft lacked; broken → fix it in the same turn.
10. Anything attached to a tracker issue (link, comment, description) points at the MR/PR, never the
    branch: the branch is deleted on merge and its URL rots.
