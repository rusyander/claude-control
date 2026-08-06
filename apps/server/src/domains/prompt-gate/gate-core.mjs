/**
 * Ядро гейта на промпте: поиск по правилам БЕЗ диска, сети и состояния.
 *
 * Это единственная копия логики поиска, которая уезжает в сгенерированный хук:
 * файл читается целиком и вставляется в скрипт при установке (см. `script.ts`),
 * поэтому установленный хук ни от чего не зависит — ни от панели, ни от путей
 * внутри неё. Обычный `.mjs` без импортов именно поэтому.
 *
 * Поведение обязано совпадать с `../dlp/rules.ts` — это проверяется в
 * `../prompt-gate.test.ts`, который гоняет один набор примеров через обе
 * реализации. Расходятся — падает сборка, а не защита пользователя.
 */

const BUILTIN = {
  email: { source: '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+' },
  phone_ru: { source: '(?:\\+7|8)[ \\-(]*\\d{3}[ \\-)]*\\d{3}[ \\-]?\\d{2}[ \\-]?\\d{2}' },
  inn: { source: '\\b\\d{10}\\b|\\b\\d{12}\\b', validate: isValidInn },
  snils: { source: '\\b\\d{3}[- ]?\\d{3}[- ]?\\d{3}[- ]?\\d{2}\\b', validate: isValidSnils },
  card: { source: '\\b(?:\\d[ -]?){12,18}\\d\\b', validate: isValidCard },
  secret_key: {
    source: [
      'sk-[A-Za-z0-9_-]{16,}',
      'gh[pousr]_[A-Za-z0-9]{20,}',
      'AKIA[0-9A-Z]{16}',
      'xox[baprs]-[A-Za-z0-9-]{10,}',
      '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    ].join('|'),
  },
};

const ENDINGS =
  '(?:ами|ями|ыми|ими|ого|его|ему|ому|ов|ев|ей|ой|ом|ем|ым|им|их|ах|ях|ам|ям|ую|ью|а|у|е|ы|и|я|ю|о)?';

/** Поля правила могут отсутствовать в файле — считаем их по умолчанию. */
export function normalizeRule(rule) {
  return {
    id: String(rule?.id ?? ''),
    name: String(rule?.name ?? ''),
    enabled: rule?.enabled !== false,
    kind: rule?.kind ?? 'terms',
    builtin: rule?.builtin,
    terms: Array.isArray(rule?.terms) ? rule.terms : [],
    pattern: typeof rule?.pattern === 'string' ? rule.pattern : '',
    action: rule?.action ?? 'mask',
    label: typeof rule?.label === 'string' ? rule.label : 'ДАННЫЕ',
  };
}

export function compilePattern(pattern) {
  try {
    return new RegExp(pattern, 'gu');
  } catch {
    return undefined;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordPattern(word) {
  const escaped = escapeRegExp(word);
  if (word.length >= 4) return escaped + ENDINGS;
  return escaped;
}

function termPattern(term) {
  const body = term.trim().split(/\s+/).map(wordPattern).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\d])${body}(?![\\p{L}\\d])`, 'giu');
}

function weightOf(match) {
  if (match.action === 'block') return 2;
  if (match.action === 'mask') return 1;
  return 0;
}

function digitsOf(value) {
  return [...value].filter((char) => char >= '0' && char <= '9').map(Number);
}

function isValidInn(value) {
  const digits = digitsOf(value);
  const check = (weights, upTo) => {
    const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
    return (sum % 11) % 10 === (digits[upTo] ?? -1);
  };

  if (digits.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  if (digits.length === 12) {
    return (
      check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11)
    );
  }
  return false;
}

function isValidSnils(value) {
  const digits = digitsOf(value);
  if (digits.length !== 11) return false;

  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (9 - index), 0);
  const control = (digits[9] ?? 0) * 10 + (digits[10] ?? 0);

  if (sum < 100) return sum === control;
  if (sum === 100 || sum === 101) return control === 0;
  const rest = sum % 101;
  if (rest === 100) return control === 0;
  return rest === control;
}

function isValidCard(value) {
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

function matchesOf(text, rule) {
  const out = [];
  const push = (start, value) => {
    out.push({
      ruleId: rule.id,
      ruleName: rule.name,
      label: rule.label,
      action: rule.action,
      start,
      end: start + value.length,
    });
  };

  if (rule.kind === 'terms') {
    for (const term of rule.terms) {
      const trimmed = String(term).trim();
      if (!trimmed) continue;
      for (const match of text.matchAll(termPattern(trimmed))) push(match.index, match[0]);
    }
    return out;
  }

  const builtin = rule.kind === 'builtin' ? BUILTIN[rule.builtin] : undefined;
  const source = rule.kind === 'builtin' ? builtin?.source : rule.pattern;
  if (!source) return out;

  const expression = compilePattern(source);
  if (!expression) return out;

  for (const match of text.matchAll(expression)) {
    if (!match[0]) continue;
    if (builtin?.validate && !builtin.validate(match[0])) continue;
    push(match.index, match[0]);
  }
  return out;
}

/**
 * Что нашлось в тексте. Перекрытия сняты так же, как в прокси: левее — раньше,
 * при равном начале сперва «отклонить», затем более длинное.
 *
 * Возвращаются ТОЛЬКО координаты и правило — самих значений в результате нет:
 * их некуда девать, кроме журнала и сообщения, а туда им нельзя.
 */
export function scanPrompt(text, rules) {
  const found = [];
  for (const raw of rules) {
    const rule = normalizeRule(raw);
    if (!rule.enabled) continue;
    for (const match of matchesOf(text, rule)) found.push(match);
  }

  found.sort((a, b) => a.start - b.start || weightOf(b) - weightOf(a) || b.end - a.end);

  const kept = [];
  let boundary = -1;
  for (const match of found) {
    if (match.start < boundary) continue;
    kept.push(match);
    boundary = match.end;
  }
  return kept;
}

/** Сводка по правилам: сколько раз сработало каждое. Без значений. */
export function summarize(matches) {
  const byRule = new Map();
  for (const match of matches) {
    const current = byRule.get(match.ruleId);
    if (current) current.count += 1;
    else byRule.set(match.ruleId, { ...match, count: 1 });
  }
  return [...byRule.values()].map((item) => ({
    ruleId: item.ruleId,
    ruleName: item.ruleName,
    action: item.action,
    placeholder: '',
    count: item.count,
  }));
}
