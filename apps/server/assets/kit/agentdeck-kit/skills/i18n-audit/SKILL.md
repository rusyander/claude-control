---
name: i18n-audit
description: 'Use when fixing localization or on untranslated UI text — hardcoded JSX strings, locale drift, unused/raw keys.'
---

# i18n audit

## 1. How i18n is wired here

From the code: library (i18next/…), locale list, file layout (`locales/{lang}/{ns}.json`), key
convention (namespace, nesting), call style (`t('ns:key')`, `useTranslation('ns')`). Note the
DEFAULT locale — it decides what hardcode looks like. Existing calls are the precedent — follow
them, don't invent a second style.

## 2. Four checks

1. **Hardcoded UI strings**: user-visible text in JSX/templates bypassing `t()`. Grep for text in
   the default locale's language (an EN-source project hardcodes in English, a RU one in Cyrillic)
   and for string literals in markup — technical identifiers are not hardcode. Text on its own line
   between tags escapes a `>text<` grep: sweep `^\s*\p{L}` restricted to the default language's letters (e.g. `[\u0400-\u04FF]` for Cyrillic)
   over `.tsx` too. Also the half-hardcode: `defaultValue` with no key in the locales, concatenation
   instead of interpolation. NOT hardcode: a literal used as logic currency (`status !== 'Resolved'`
   compared against a backend value) — that is a data contract; report it separately as "logic keyed
   on a display string", never translate it.
2. **Locale drift**: keys present in one locale and missing in another.
   Gate: `node <kit>/tools/i18n-keydiff.mjs <localesDir>` prints `0 missing` for every locale;
   paste the output into the report. Plural-aware (Intl.PluralRules): ru `_few`/`_many` against en
   `_one`/`_other` is not drift — a naive set-diff called 36 correct helpdesk keys missing.
3. **Raw keys at runtime**: drive the live pages (Playwright) in each locale and search the DOM for
   raw-key patterns (`ns.key`, `key.subkey`) and text from the wrong locale; per locale also read
   `document.documentElement.lang` — it must follow `i18n.resolvedLanguage` (screen-reader voice,
   hyphenation), set on `languageChanged`. No runnable stand → the check is reported as skipped,
   with the reason.
4. **Dead keys**: locale keys with no reference in code. Before deleting, check for dynamic
   assembly — `t(\`x.${var}\`)` makes a key look unused when it is not.

## 3. Report & fixes

- Table: file → problem → proposal (key + translations for **every** locale).
- On approval: create the key in all locales, replace the hardcode with `t()`. Translations must be
  meaningful, not transliterated; unsure about wording → ask.
- Verify: the project gate (typecheck + lint, the project's own commands), the §2.2 key-diff Gate
  re-run to `0 missing`, and the §2.3 Playwright pass per locale over the affected pages — zero
  raw-key hits in the DOM.

## Red flags — run against the finished audit

- Deleted an "unused" key that is assembled dynamically from a variable.
- Added a key to one locale only — that is new drift, not a fix.
- Compared locales by eye instead of running the key-diff Gate.
- Greped only Cyrillic in a project whose default locale is English.
