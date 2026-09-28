List the run counts a person could tune in one agent skill: how many review rounds, agents per
round, verifiers, parallel lanes, comparison passes against a design, retries and the like. Only
numbers that say HOW MANY TIMES or HOW MANY WORKERS the skill runs something. Skip thresholds,
sizes, limits, percentages, dates, versions, line or file counts, ports and examples.

For each number give:
- `key`: a short stable id in lowercase latin with dashes, e.g. `review-rounds`;
- `label`: what it counts, in Russian (`ru`) and English (`en`), two to five words;
- `default`: the number the skill text uses now;
- `min` and `max`: a sensible range around it (min at least 0; max no more than four times the
  default, and at least the default);
- `quote`: the line of the skill text where the number stands, copied EXACTLY, character for
  character, up to 200 characters. It must contain the default number.

Numbers written as words count the same as digits: "exactly **two** review subagents",
"ревью двумя агентами" give `default` 2, and the quote keeps the word as written.

Under the skill text there may be a list of lines that look like run counts. Check each one: a
line that says how many times or how many workers the skill runs something becomes a number, quoted
from the skill text; a line that only mentions a number in passing does not.

At most six numbers. No such numbers in the text — an empty list. Never invent a number that is not
in the text.

Answer with EXACTLY ONE code block in the language {{block}} containing JSON like
{"knobs":[{"key":"review-rounds","label":{"ru":"Кругов ревью","en":"Review rounds"},"default":2,"min":1,"max":5,"quote":"Run 2 review rounds"}]}
and nothing after it.
