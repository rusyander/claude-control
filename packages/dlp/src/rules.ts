import type { DlpRule } from '@agentdeck/contracts';
import { DLP_BUILTINS, type DlpBuiltinId } from './builtins.mjs';

/**
 * Правила защиты данных: что считать чувствительным в теле запроса.
 *
 * Три источника совпадений и ровно один принцип отбора — ложное срабатывание
 * здесь хуже пропуска. Пропуск оставляет систему такой же, какой она была без
 * прокси; ложное срабатывание ломает работу агента (подменяет путь к файлу,
 * номер версии, идентификатор) и учит выключать защиту целиком. Поэтому у
 * форматов с контрольной суммой — ИНН, СНИЛС, номер карты, IBAN, ОГРН —
 * проверяется именно она, а не длина числа. Сами образцы — в `builtins.mjs`,
 * одной копией на прокси, шлюз и хук.
 *
 * Модуль чистый: ни диска, ни сети, ни состояния между вызовами.
 */

/** Одно найденное место в тексте. */
export interface RuleMatch {
  ruleId: string;
  ruleName: string;
  label: string;
  action: DlpRule['action'];
  start: number;
  end: number;
  value: string;
  /**
   * Кто это, независимо от формы написания: для словаря — сама запись словаря,
   * для остальных правил — найденное значение. По ней метки разных падежей
   * одного человека получают общий номер.
   */
  identity: string;
}

/** Проверить своё выражение до сохранения правила: разбирается ли оно вообще. */
export function compileRulePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'gu');
  } catch {
    return undefined;
  }
}

/**
 * Найти в тексте всё, что подпадает под правила. Перекрытия сняты: побеждает
 * самое левое совпадение, при равном начале — самое длинное. Иначе одна и та же
 * строка попала бы под два правила и была бы заменена дважды.
 */
export function scanText(text: string, rules: readonly DlpRule[]): RuleMatch[] {
  const found: RuleMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const match of matchesOf(text, rule)) found.push(match);
  }

  // Порядок разрешения перекрытий: левее — раньше; при равном начале сперва
  // «отклонить» (запрет обязан пережить замену, иначе его отменяло бы любое
  // правило маскирования, попавшее на то же место), затем более длинное.
  found.sort((a, b) => a.start - b.start || weightOf(b) - weightOf(a) || b.end - a.end);

  const kept: RuleMatch[] = [];
  let boundary = -1;
  for (const match of found) {
    if (match.start < boundary) continue;
    kept.push(match);
    boundary = match.end;
  }
  return kept;
}

function weightOf(match: RuleMatch): number {
  return match.action === 'block' ? 2 : match.action === 'mask' ? 1 : 0;
}

/**
 * Русские окончания, которые разрешено дописать к слову словаря: «Урманов» и
 * «Урманова» — одна и та же фамилия, и словарь, ловящий только именительный
 * падеж, в русском тексте бесполезен.
 *
 * Список закрытый и короткий именно для того, чтобы не поймать другое слово с
 * тем же началом: у «Ивановский» продолжение «ский» сюда не входит, и правило
 * его не тронет (проверено тестом).
 */
const ENDINGS =
  '(?:ами|ями|ыми|ими|ого|его|ему|ому|ов|ев|ей|ой|ом|ем|ым|им|их|ах|ях|ам|ям|ую|ью|а|у|е|ы|и|я|ю|о)?';

/** Слово короче четырёх букв склонять опасно: там половина языка. */
function wordPattern(word: string): string {
  const escaped = escapeRegExp(word);
  return word.length >= 4 ? escaped + ENDINGS : escaped;
}

/**
 * Выражение для одной записи словаря. Каждое слово получает своё окончание —
 * «Рустам Урманов» обязан находиться и как «Рустама Урманова».
 */
function termPattern(term: string): RegExp {
  const body = term.trim().split(/\s+/).map(wordPattern).join('\\s+');
  // Границы по буквам и цифрам, а не `\b`: `\b` в юникоде считает границей
  // стык латиницы и кириллицы, и «Иванов» находился бы внутри «xИванов».
  return new RegExp(`(?<![\\p{L}\\d])${body}(?![\\p{L}\\d])`, 'giu');
}

function matchesOf(text: string, rule: DlpRule): RuleMatch[] {
  const out: RuleMatch[] = [];
  const push = (start: number, value: string, identity?: string): void => {
    out.push({
      ruleId: rule.id,
      ruleName: rule.name,
      label: rule.label,
      action: rule.action,
      start,
      end: start + value.length,
      value,
      identity: identity ?? value,
    });
  };

  if (rule.kind === 'terms') {
    for (const term of rule.terms) {
      const trimmed = term.trim();
      if (!trimmed) continue;
      // Без учёта регистра, по границам слова и с русскими окончаниями:
      // «Иванов» ловит «Иванова», но не «Ивановский».
      for (const match of text.matchAll(termPattern(trimmed))) {
        push(match.index, match[0], trimmed);
      }
    }
    return out;
  }

  const source =
    rule.kind === 'builtin' ? DLP_BUILTINS[rule.builtin as DlpBuiltinId]?.source : rule.pattern;
  if (!source) return out;

  const expression = compileRulePattern(source);
  if (!expression) return out;

  const validate =
    rule.kind === 'builtin' ? DLP_BUILTINS[rule.builtin as DlpBuiltinId]?.validate : undefined;
  for (const match of text.matchAll(expression)) {
    if (!match[0]) continue;
    if (validate && !validate(match[0])) continue;
    push(match.index, match[0]);
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
