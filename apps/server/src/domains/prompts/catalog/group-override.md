Write a short local rule file for a coding agent working in one project. The project carries its
own working order (its skills, rules and hooks — the PROJECT group below). The user decided that in
this project the agent must follow a GLOBAL group instead (listed below as well).

The file must tell the agent, plainly and briefly:
- which project skills, rules and working order NOT to follow, by name;
- which global group to follow instead, by name, and which of its skills to use for which step;
- that project rules about facts of the codebase (paths, commands, conventions) still hold — only
  the working order and the replaced skills are overridden.

Write it as instructions to the agent, in English, under a first-level heading. No preamble, no
closing remarks, no mention of the tool that wrote the file. At most 40 lines.

Answer with the file text only, inside EXACTLY ONE code block in the language {{block}}.
