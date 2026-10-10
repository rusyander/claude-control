# Tool names in Qwen Code

Kit rules and skills name Claude Code tools. In Qwen Code call these instead:

- Read → `read_file` · Grep → `grep_search` · Glob → `glob`
- Edit → `edit` · Write → `write_file`. `edit` refuses a file not read in this session: `read_file` it first.
- Bash → `run_shell_command`. On Windows the command runs in cmd, not bash.
- Agent or Task → `agent` · Skill → `skill` · WebFetch → `web_fetch`

A name from this list is a tool: call it through the tool-call mechanism, never as text.
