/**
 * Какую пустоту показывать разделу «Правила», когда карточек нет.
 *
 * «0 правил» на живом CLAUDE.md почти всегда значит не «файл пуст», а «файл
 * размечен обычными `## ` разделами, а панель считает правилом только
 * «## ПРАВИЛО: …»». Одна заглушка на оба случая читалась как поломка счётчика,
 * поэтому решение принимается по самому файлу — той же линейкой, что и разбор
 * на сервере (`contracts/rule-format`).
 */
import { summarizeRuleFile } from '@claude-control/contracts/rule-format';

export type RulesEmptyKind =
  /** Файла нет или в нём только пробелы — обычное «правил пока нет». */
  | 'blank'
  /** Файл непустой, правил в формате панели нет — объясняем формат и считаем разделы. */
  | 'unformatted';

export interface RulesEmptyState {
  kind: RulesEmptyKind;
  /** Обычных разделов `## …` в файле (для 'blank' всегда 0). */
  plainSections: number;
}

/**
 * `content` — текст файла инструкций; `undefined`, пока он не загружен или
 * недоступен (провайдер без раздела инструкций, ошибка сети). Без текста
 * объяснить нечего — остаётся обычная заглушка.
 */
export function resolveRulesEmptyState(content: string | undefined): RulesEmptyState {
  if (content === undefined) return { kind: 'blank', plainSections: 0 };
  const summary = summarizeRuleFile(content);
  if (!summary.hasContent) return { kind: 'blank', plainSections: 0 };
  return { kind: 'unformatted', plainSections: summary.plainSections };
}
