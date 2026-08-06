import type { DlpBuiltinPattern, DlpRule } from '@claude-control/contracts';

/**
 * Работа со списком правил на стороне панели: заготовки, замена, удаление.
 *
 * Здесь же лежит стартовый набор. Пустой раздел был бы худшим из вариантов:
 * человек включил бы прокси, увидел «работает» и получил пересылку без единой
 * проверки — то есть ложное спокойствие вместо защиты. Поэтому первый заход
 * предлагает готовые образцы с контрольными суммами, а свои словари человек
 * добавляет к ним.
 */

/** Встроенные образцы в порядке, в котором их показываем. */
export const DLP_BUILTINS: DlpBuiltinPattern[] = [
  'email',
  'phone_ru',
  'inn',
  'snils',
  'card',
  'secret_key',
];

/** Метка по умолчанию для каждого образца — она попадёт в текст вместо значения. */
const BUILTIN_LABELS: Record<DlpBuiltinPattern, string> = {
  email: 'ПОЧТА',
  phone_ru: 'ТЕЛЕФОН',
  inn: 'ИНН',
  snils: 'СНИЛС',
  card: 'КАРТА',
  secret_key: 'КЛЮЧ',
};

export function newRuleId(): string {
  // `crypto.randomUUID` требует защищённого контекста, а панель открывают и по
  // http на 127.0.0.1 — поэтому время плюс случайный хвост.
  return `dlp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newTermsRule(name: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'terms',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ДАННЫЕ',
  };
}

export function newBuiltinRule(builtin: DlpBuiltinPattern, name: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'builtin',
    builtin,
    terms: [],
    pattern: '',
    // Ключ уходит наружу целиком или не уходит вовсе: замена меткой сохранила бы
    // осмысленный запрос, но модель всё равно не сможет им воспользоваться, а
    // человек решил бы, что ключ ушёл безопасно.
    action: builtin === 'secret_key' ? 'block' : 'mask',
    label: BUILTIN_LABELS[builtin],
  };
}

export function newRegexRule(name: string): DlpRule {
  return {
    id: newRuleId(),
    name,
    enabled: true,
    kind: 'regex',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ДАННЫЕ',
  };
}

/** Стартовый набор: все встроенные образцы плюс пустой словарь под свои имена. */
export function starterRules(names: Record<DlpBuiltinPattern | 'terms', string>): DlpRule[] {
  return [
    ...DLP_BUILTINS.map((builtin) => newBuiltinRule(builtin, names[builtin])),
    newTermsRule(names.terms),
  ];
}

export function replaceRule(rules: DlpRule[], next: DlpRule): DlpRule[] {
  return rules.map((rule) => (rule.id === next.id ? next : rule));
}

export function removeRule(rules: DlpRule[], id: string): DlpRule[] {
  return rules.filter((rule) => rule.id !== id);
}

/**
 * Готово ли правило к работе. Незаполненное правило не «почти работает», а не
 * работает вовсе — и раздел обязан сказать это до того, как прокси поднимут.
 */
export function isRuleComplete(rule: DlpRule): boolean {
  if (rule.kind === 'builtin') return Boolean(rule.builtin);
  if (rule.kind === 'terms') return rule.terms.some((term) => term.trim().length > 0);
  return rule.pattern.trim().length > 0;
}
