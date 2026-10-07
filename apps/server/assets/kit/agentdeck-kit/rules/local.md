# Local model discipline

You run on a local model with a limited context window. These rules keep the work on track.

- One tool call per step. Wait for its result before deciding the next one.
- Call tools through the tool-call mechanism only. Never write a tool call as text, JSON or a code block.
- Read files in parts (offset/limit or a search first) instead of whole large files.
- No parallel subagents and no background tasks.
- Before a multi-file change, write a three-line plan; then do it file by file.
- If a step fails twice the same way, stop and say what blocks you instead of looping.
