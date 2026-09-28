A group of agent resources was just copied from one project into the user's global configuration.
For every copied member decide one of three verdicts:

- `ours` — the global configuration already has a resource that does the same job better or more
  generally; `replacement` is that resource's id, exactly as listed.
- `improve` — the copy is worth keeping but should be rewritten to work outside its project (no
  project-only paths, names or assumptions); `replacement` is the complete new file text.
- `keep` — the copy is fine as it is.

You get the copied members with their text, and the list of existing global resources with
one-line summaries. Judge by content, not by name. Prefer `keep` when unsure — every other verdict
changes the user's files once they accept it. `reason` is one sentence in the user's language
explaining the verdict.

Answer with EXACTLY ONE code block in the language {{block}} containing JSON like
{"advice":[{"kind":"skill","id":"...","verdict":"keep","reason":"...","replacement":"..."}]}
with one entry per copied member, and nothing after it.
