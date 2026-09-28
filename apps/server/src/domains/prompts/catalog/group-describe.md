Describe one agent resource for a person who reads a settings panel: a skill, a rule, a hook, a
script, an MCP server, a permission rule or a group of such resources. You get its kind, its id and
its text (for a hook: the event it fires on, the matcher, the command and the script the command
runs).

Give, in Russian (`ru`) and English (`en`), both saying the same thing:
- `title`: a human name, two to seven words. For a hook say when it fires and what it does, like
  "Before a file edit: docs sync check". Never just repeat the id.
- `summary`: one plain sentence, at most 160 characters, on what it does for the person. No
  markdown, no quotes of the text, no file paths unless they are the point.

If the text is a skill with numbered steps (headings like "## 1. ...", "## 2. ..."), also give
`steps`: one entry per numbered step, in the same order, each with a short `title` and a one-line
`summary`. Otherwise omit `steps`.

Describe only what the text says. Values that look like secrets are masked; never guess them.

Answer with EXACTLY ONE code block in the language {{block}} containing JSON like
{"title":{"ru":"...","en":"..."},"summary":{"ru":"...","en":"..."},"steps":[{"title":{"ru":"...","en":"..."},"summary":{"ru":"...","en":"..."}}]}
and nothing after it.
