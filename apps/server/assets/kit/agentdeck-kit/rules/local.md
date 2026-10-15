# Local model discipline

You run on a local model with a limited context window. These rules keep the work on track.

- One tool call per step. Wait for its result before deciding the next one.
- Call tools through the tool-call mechanism only, never as text, JSON or a code block.
- Read files in parts (offset/limit or a search first), not whole large files.
- No parallel work: at most one subagent at a time; review skills run single-lane. A background subagent is fine — end your turn and its result wakes you; never poll it with sleep. Verify by running the code.
- Before a multi-file change, write a three-line plan; then do it file by file.
- Task memory: compaction comes early and only `.agent/PROGRESS.md` survives it. First step: create it (and `.agent/`) if missing — Done, In progress, Left, Decisions, Paths. Add a line after every finished step (paths, no pasted content). After a compaction, restart or a message starting with "[Автоматически]", read it first and continue from "In progress".
- Work until the task is done or you need a human decision; say which. A step that failed twice the same way: note it in PROGRESS.md, stop and say what blocks you.
