You look at the configuration one source already carries — a project's own agent files, or the
global directories of one coding CLI — and name the bundles that already live in it. A bundle is a
set of skills, rules, hooks, agents, commands, MCP servers and instruction files that work
together on one kind of task: a ticket-delivery ladder, a test routine, a release checklist. A
single skill that carries a numbered working order is a bundle on its own, together with whatever
rules and hooks serve it.

You get the inventory below: one line per item with its kind, id and a one-line summary, and for
skills the numbered steps found in them. Nothing else exists; do not invent items, and use the ids
exactly as given.

Rules:
- Group only what clearly belongs together. An item may appear in several bundles; an item that
  fits nothing stays out. No bundle is a valid answer.
- `name` — two to five words naming the kind of work.
- `when` — one line: which task makes this bundle the right one. A chat picks the bundle by it.
- `why` — one sentence: what ties these items together.
- Give `name`, `when` and `why` in Russian (`ru`) and English (`en`), both saying the same
  thing; a person reads the side of their interface language.
- `steps` — the working order if the bundle has one (numbered skill steps, in order); `source` is
  the id of the item the step comes from. Empty when there is no order.

Answer with EXACTLY ONE code block in the language {{block}} containing JSON like
{"groups":[{"name":{"ru":"...","en":"..."},"when":{"ru":"...","en":"..."},"why":{"ru":"...","en":"..."},"members":[{"kind":"skill","id":"..."}],"steps":[{"title":"...","source":"..."}]}]}
and nothing after it. No bundle at all is still that block: {"groups":[]}. Write no prose before
or after the block.
