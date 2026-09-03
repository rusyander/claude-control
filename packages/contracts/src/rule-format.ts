/**
 * Формат правила в CLAUDE.md — контракт панели, ОДИН для сервера и клиента.
 *
 * Правилом считается только раздел с заголовком «## ПРАВИЛО: …». Прочие
 * заголовки второго уровня (`## Обзор`) панель не трогает и в список не берёт:
 * иначе сборка навесила бы им префикс и молча испортила соседний markdown.
 * Оборотная сторона — файл, размеченный обычными `## `, показывает «0 правил»,
 * и странице нужно уметь это объяснить: сколько таких разделов в файле и какой
 * заголовок ждёт панель. Считать разделы клиент должен той же линейкой, какой
 * сервер отбирает правила, поэтому регулярные выражения живут здесь, а не в
 * двух копиях (см. `domains/rules.ts` и `pages/Rules/model`).
 *
 * Модуль самодостаточен и без zod: сервер под `--experimental-strip-types`
 * импортирует его напрямую через точку экспорта `@claude-control/contracts/rule-format`.
 */

/** Заголовок правила: «## ПРАВИЛО: …», регистр слова не важен, хвостовые пробелы срезаются при разборе. */
export const RULE_HEADING = /^##\s+ПРАВИЛО:\s*(.+)$/i;
/** Префикс, который снимается с заголовка выключенного правила при разборе служебного раздела. */
export const RULE_PREFIX = /^ПРАВИЛО:\s*/i;
/** Служебный раздел выключенных правил — заголовок второго уровня, но не правило и не «обычный» раздел. */
export const DISABLED_SECTION = '## Отключённые правила (Claude Control)';
/** Пример заголовка в ожидаемом формате — показывается в подсказках. */
export const RULE_HEADING_EXAMPLE = '## ПРАВИЛО: Отвечать по-русски';

/** Любой заголовок второго уровня по правилам markdown: `## ` с пробелом, но не `###`. */
const H2_HEADING = /^##\s+\S/;

export function isRuleHeading(line: string): boolean {
  return RULE_HEADING.test(line);
}

/**
 * Обычный раздел `## …`, который панель правилом НЕ считает: не «ПРАВИЛО:» и не
 * служебный раздел выключенных. Ровно эти строки объясняют пользователю «0 правил»
 * в непустом файле.
 */
export function isPlainSectionHeading(line: string): boolean {
  const trimmed = line.trimEnd();
  return H2_HEADING.test(trimmed) && !RULE_HEADING.test(trimmed) && trimmed !== DISABLED_SECTION;
}

export interface RuleFileSummary {
  /** В файле есть хоть что-то кроме пробелов и переводов строк. */
  hasContent: boolean;
  /** Заголовков «## ПРАВИЛО:» — столько карточек покажет раздел. */
  ruleHeadings: number;
  /** Обычных разделов `## …`, которые панель правилами не считает. */
  plainSections: number;
}

/**
 * Сводка по файлу той же линейкой, что и разбор на сервере: построчно, без
 * учёта code-fence — сервер их тоже не различает, а сводка обязана совпадать с
 * тем, что он покажет, иначе объяснение «0 правил» само станет неверным.
 */
export function summarizeRuleFile(markdown: string): RuleFileSummary {
  let ruleHeadings = 0;
  let plainSections = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (isRuleHeading(line)) ruleHeadings += 1;
    else if (isPlainSectionHeading(line)) plainSections += 1;
  }
  return { hasContent: markdown.trim().length > 0, ruleHeadings, plainSections };
}
