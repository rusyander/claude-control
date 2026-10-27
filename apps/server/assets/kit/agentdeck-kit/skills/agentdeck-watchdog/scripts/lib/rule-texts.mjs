// Rule texts of the panel's group watcher (R1…): the source module in the panel's repo and the snapshot shipped
// beside the scripts for a watch started outside that repo. One parser for both the reader and the snapshot writer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The i18n module the panel renders its watcher signals from, relative to the repo root. */
export const RULE_TEXTS_SRC = path.join('apps', 'web', 'src', 'shared', 'config', 'i18n', 'group-watch', 'en.ts');
/** The snapshot: scripts/rule-texts.json. */
export const RULE_TEXTS_JSON = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'rule-texts.json');

/**
 * `    R12: 'text',` entries of the module → { R12: 'text' } (escapes kept as written: the panel shows them so). A
 * variant (`R38done`, `R16slow`) is its own entry, and a long text sits on the next line — both were skipped, and
 * a WSIG of a variant showed the base rule's text.
 */
export function parseRuleTexts(src) {
  const out = {};
  for (const m of String(src ?? '').matchAll(/^ {4}(R\d+[A-Za-z]*):\s*'((?:[^'\\\n]|\\.)*)',$/gm)) out[m[1]] = m[2];
  return out;
}
