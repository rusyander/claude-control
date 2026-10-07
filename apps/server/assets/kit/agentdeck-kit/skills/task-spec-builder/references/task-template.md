# Task entry template & acceptance-criteria bar

TASKS.md is HUMAN-facing → entries are written in the user's language. The template below is the literal structure — keep fields, order and status icons; translate the labels into that language once per file and keep them stable.

## Entry template

```markdown
### T<N>. <Short name>

- **Source:** screenshot N / in words, DD.MM · **Where:** <subproject, URL/route>
- **Symptom:** <as the user described it + what the screenshot shows>
- **Code:** <files:lines, components — after exploration>
- **Cause:** <hypothesis → replace with the confirmed one after diagnosis>
- **Expected (acceptance criteria):**
  - [ ] <verifiable criterion 1>
  - [ ] <criterion 2>
- **Verification:** <how it is verified: live run/script/type-check; for UI — before/after>
- **Status:** ⏳ analysis | 🔧 in progress | ✅ done | ⚠️ partial (what exactly) | ❌ blocked (by what)
- **Solution:** <after the work: changed files, the fix in 1-2 phrases, what confirmed it>
```

## Quality bar

- Acceptance criteria must be **verifiable** ("the list opens upwards and scrolls at VH=320"), never vague ("works correctly").
- Think through the verification plan up front — it is what you later recheck against and report by.
- Task numbering follows the USER'S numbering ("task 1" = T1) — their numbers matter for cross-references.
- Capture the symptom close to the user's own words + what the screenshot shows.
- Keep each entry ~10-15 lines; diagnostic detail belongs in chat, not the file.
