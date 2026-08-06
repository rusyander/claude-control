import type { DlpBuiltinPattern, DlpRule } from '@claude-control/contracts';

/**
 * Правила защиты данных: что считать чувствительным в теле запроса.
 *
 * Три источника совпадений и ровно один принцип отбора — ложное срабатывание
 * здесь хуже пропуска. Пропуск оставляет систему такой же, какой она была без
 * прокси; ложное срабатывание ломает работу агента (подменяет путь к файлу,
 * номер версии, идентификатор) и учит выключать защиту целиком. Поэтому у
 * форматов с контрольной суммой — ИНН, СНИЛС, номер карты — проверяется именно
 * она, а не длина числа.
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

/**
 * Встроенные образцы. Выражения намеренно широкие: отсев делает проверка
 * `validate`, а не сама регулярка — так видно, ГДЕ принимается решение.
 */
const BUILTIN: Record<
  DlpBuiltinPattern,
  { source: string; validate?: (value: string) => boolean }
> = {
  email: { source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+` },
  // Российский номер в бытовых написаниях: +7, 8, скобки, дефисы, пробелы.
  phone_ru: { source: String.raw`(?:\+7|8)[ \-(]*\d{3}[ \-)]*\d{3}[ \-]?\d{2}[ \-]?\d{2}` },
  inn: { source: String.raw`\b\d{10}\b|\b\d{12}\b`, validate: isValidInn },
  snils: { source: String.raw`\b\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}\b`, validate: isValidSnils },
  card: { source: String.raw`\b(?:\d[ -]?){12,18}\d\b`, validate: isValidCard },
  // Ключи с опознаваемым началом: у них форма задана самим вендором, гадать не
  // приходится. Общего «длинная строка из букв и цифр» здесь нет намеренно —
  // под него попадает половина хешей и идентификаторов в любом коде.
  secret_key: {
    source: [
      String.raw`sk-[A-Za-z0-9_-]{16,}`,
      String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
      String.raw`AKIA[0-9A-Z]{16}`,
      String.raw`xox[baprs]-[A-Za-z0-9-]{10,}`,
      String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    ].join('|'),
  },
};

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
    rule.kind === 'builtin' ? BUILTIN[rule.builtin as DlpBuiltinPattern]?.source : rule.pattern;
  if (!source) return out;

  const expression = compileRulePattern(source);
  if (!expression) return out;

  const validate =
    rule.kind === 'builtin' ? BUILTIN[rule.builtin as DlpBuiltinPattern]?.validate : undefined;
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

function digitsOf(value: string): number[] {
  return [...value].filter((char) => char >= '0' && char <= '9').map(Number);
}

/**
 * ИНН: контрольные разряды считаются по опубликованным ФНС коэффициентам —
 * один для десятизначного (физлицо-ИП/организация), два для двенадцатизначного.
 */
function isValidInn(value: string): boolean {
  const digits = digitsOf(value);
  const check = (weights: number[], upTo: number): number =>
    (weights.reduce((sum, weight, index) => sum + weight * (digits[index] ?? 0), 0) % 11) % 10 ===
    (digits[upTo] ?? -1)
      ? 1
      : 0;

  if (digits.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9) === 1;
  if (digits.length === 12) {
    const first = check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) === 1;
    const second = check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11) === 1;
    return first && second;
  }
  return false;
}

/**
 * СНИЛС: сумма первых девяти цифр с весами 9…1, дальше правило остатка,
 * описанное в порядке ведения ПФР (100 и 101 дают контрольное «00»).
 */
function isValidSnils(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length !== 11) return false;

  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (9 - index), 0);
  const control = (digits[9] ?? 0) * 10 + (digits[10] ?? 0);

  if (sum < 100) return sum === control;
  if (sum === 100 || sum === 101) return control === 0;
  const rest = sum % 101;
  return rest === 100 ? control === 0 : rest === control;
}

/** Номер карты — алгоритм Луна плюс разумная длина (13…19 цифр). */
function isValidCard(value: string): boolean {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits[index] ?? 0;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
