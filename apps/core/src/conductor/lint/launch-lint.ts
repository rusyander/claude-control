import type { LaunchLintWarning, UserLayerInventory } from '@agentdeck/contracts/core/user-layer';
import { FRONTMATTER_INSTEAD, PROCESS_RULES } from './lint-rules.ts';

/**
 * Линт запуска (06:121-129, G-h, 07:23-24): строки слоя человека (инструкции, правила, навыки —
 * с кодом внутри), которые просят сессию пушить, открывать MR, ждать CI, гонять весь набор,
 * мержить или одобрять, — с номером строки и тем, что ядро делает вместо этого; ключи
 * frontmatter навыка, которые ядро не читает (`extraKeys`, G4). Чистая функция: тексты читает
 * вызывающий, маску DLP даёт он же. Итог только показывается — ни одно решение его не читает (P36).
 */

export interface LayerText {
  /** Путь файла слоя — тот же, что в описи. */
  path: string;
  text: string;
}

const TEXT_MAX = 200;

const clip = (line: string): string => {
  const t = line.trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
};

/** Строки по LF и CRLF (и одинокому CR): номер строки тот же, что видит редактор человека. */
const linesOf = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** Строка frontmatter, где назван ключ (`key:` в начале строки), иначе 1. */
function keyLine(text: string | undefined, key: string): number {
  if (text === undefined) return 1;
  const lines = linesOf(text);
  const top = key.split('.')[0] ?? key;
  const at = lines.findIndex((l) => l.trimStart().startsWith(`${top}:`));
  return at >= 0 ? at + 1 : 1;
}

export function launchLint(
  inventory: UserLayerInventory,
  texts: readonly LayerText[],
  mask: (text: string) => string,
): LaunchLintWarning[] {
  const out: LaunchLintWarning[] = [];
  for (const file of texts) {
    linesOf(file.text).forEach((line, index) => {
      for (const def of PROCESS_RULES) {
        if (!def.patterns.some((p) => p.test(line))) continue;
        out.push({
          rule: def.rule,
          source: file.path,
          line: index + 1,
          text: mask(clip(line)),
          instead: def.instead,
        });
      }
    });
  }
  const textOf = new Map(texts.map((t) => [t.path, t.text]));
  for (const skill of inventory.skills) {
    for (const key of skill.extraKeys) {
      out.push({
        rule: 'frontmatter-key',
        source: skill.path,
        line: keyLine(textOf.get(skill.path), key),
        text: mask(clip(key)),
        instead: FRONTMATTER_INSTEAD,
      });
    }
  }
  return out;
}
